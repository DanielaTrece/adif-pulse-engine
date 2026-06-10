// pulse-publisher.js
// Poppins Agent OS · ADIF Weekly Pulse publisher
// ─────────────────────────────────────────────────────────────────────────
// Runs the trend agents, assembles the two-layer pulse, and drops a JSON file
// into Drive (via the service account). The live artifact reads that file
// through the Apps Script proxy.
//
// ESM assumed (package.json "type":"module"). If your OS is CommonJS, swap the
// imports for require() and export accordingly.
//
//   npm i @anthropic-ai/sdk googleapis
//   node agents/pulse-publisher.js
//
// Env:
//   ANTHROPIC_API_KEY           your key
//   GOOGLE_SERVICE_ACCOUNT_KEY  path to the poppins-agent-os service-account json
//   PULSE_FOLDER_ID             Drive folder to write into (in the De Beers shared Drive)
// ─────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

const authConfig = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? { credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/drive"] }
  : { keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "./service-account.json", scopes: ["https://www.googleapis.com/auth/drive"] };
const auth = new google.auth.GoogleAuth(authConfig);
const drive = google.drive({ version: "v3", auth });

const PULSE_FOLDER_ID = (process.env.PULSE_FOLDER_ID || '').trim();
const LATEST_NAME = "ADIF_Pulse_latest.json";

const today = new Date();
const week = today.toISOString().slice(0, 10);
const weekLabel = `Week of ${today.toLocaleDateString("en-GB", {
  day: "numeric", month: "long", year: "numeric",
})}`;
const fmt = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const weekStart = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
const WINDOW = `${fmt(weekStart)} → ${fmt(today)}`; // the only 7 days that count

// ── agent runner ───────────────────────────────────────────────────────────
async function runAgent(role, instructions, { maxSearches = 6 } = {}) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
    messages: [{ role: "user", content: `${role}\n\n${instructions}` }],
  });
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return extractJSON(text);
}

function extractJSON(text) {
  let t = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  // bracket-match to extract only the first complete array (model sometimes returns two)
  const start = t.indexOf("[");
  if (start !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (esc)            { esc = false; continue; }
      if (ch === "\\" && inStr) { esc = true; continue; }
      if (ch === '"')     { inStr = !inStr; continue; }
      if (inStr)          continue;
      if (ch === "[")     depth++;
      if (ch === "]" && --depth === 0) { t = t.slice(start, i + 1); break; }
    }
  }
  t = t.replace(/,(\s*[}\]])/g, "$1"); // repair trailing commas
  try {
    return JSON.parse(t);
  } catch (err) {
    // Repair unescaped double-quotes inside JSON string values (e.g. "title "Foo" bar")
    // Strategy: inside each string value, replace bare " with '
    const repaired = t.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, inner) => {
      // re-escape any unescaped quotes inside the captured value
      return '"' + inner.replace(/(?<!\\)"/g, "'") + '"';
    });
    try {
      return JSON.parse(repaired);
    } catch (err2) {
      const pos = parseInt((err.message.match(/position (\d+)/) || [])[1]) || 0;
      console.error("  JSON parse error near:", JSON.stringify(t.slice(Math.max(0, pos - 60), pos + 60)));
      throw err;
    }
  }
}

// ── item contract (must match the artifact) ─────────────────────────────────
const ITEM_SPEC = `Return ONLY a JSON array — no prose, no markdown, no code fences.
Return ONLY items that genuinely qualify, and NEVER pad to hit a number. If fewer qualify than the target, return fewer. Quality and recency beat quantity, always.
Each object: {
  "trend":   short punchy title,
  "signal":  the dated this-week catalyst + the evidence (max 24 words),
  "angle":   one concrete content or action idea for ADIF (max 24 words),
  "heat":    integer 1-3 where 3 is hottest,
  "catalystDate": "YYYY-MM-DD" — the actual date the catalyst happened/peaked. Be honest; do not back-date an old event to fit the window.
  "sources": [{"title":"","url":""}]  (1-2 real links; prefer dated news over evergreen "2026 trends" roundups)
}`;

const RECENCY = `HARD RECENCY RULE — this is a weekly pulse, not a "what's popular in 2026" list.
Only include a trend if its CATALYST — the specific post, sound, news moment, drop, or sharp spike that put it in feeds — happened or peaked WITHIN ${WINDOW}.
DISTINGUISH "breaking this week" from "the cultural backdrop." Backdrop is NOT eligible. Concrete examples of backdrop you must EXCLUDE unless there is a discrete brand-new event this week:
  - a film that opened weeks ago (e.g. a sequel now in week 3-4 of release)
  - a celebrity moment from a prior month or year (e.g. an engagement ring revealed last year)
  - an event that hasn't happened yet (e.g. a tournament that kicks off next month)
  - a market statistic or structural shift (e.g. "Gen Z drives X% of luxury")
Phrases like "still peaking", "still climbing", "re-exploding" are red flags that you are reaching for backdrop — drop those items.
The ONLY exception: an older topic is allowed if there is a genuinely NEW, dated development this week, and the signal must lead with that hook.
When searching, date-qualify your queries to the current week and prefer hard-dated news over evergreen "trends 2026" roundups.
Better to return 2 genuinely-this-week items than 5 with three of them backdrop.`;

const layer1 = () =>
  runAgent(
    "ROLE: You are a GENERAL social-media trends analyst writing a what's-hot-this-week briefing for a general audience. You do NOT work for a jewelry or luxury brand for the purpose of choosing trends. Pretend you've never heard of diamonds while selecting.",
    `Today is ${weekLabel}. List the biggest things genuinely HOT or BREAKING in social content in the last 7 days (${WINDOW}) — sounds, formats, memes, viral moments, creators, cultural beats moving across TikTok, Instagram and Pinterest.
HARD RULES on selection:
- Choose purely on how hot it is in social this week. Ignore jewelry/diamonds entirely while choosing.
- AT MOST ONE item may relate to jewelry, rings or diamonds. The rest must be unrelated general-interest trends. If you can't find 5 non-jewelry trends, return fewer — do not fill with jewelry.
- No future events (something that hasn't happened yet is not a trend).
- No celebrity moment whose origin is older than this window.
THEN, only after choosing, add the "angle": if a trend has a natural way for ADIF (a natural-diamond brand) to borrow the format, note it; if not, write "awareness only" — never force a diamond link or let the angle influence what you picked.
Aim for up to 5, only what genuinely qualifies.
${RECENCY}
${ITEM_SPEC}`
  );

const layer2 = () => {
  const cutoff7  = fmt(new Date(today.getTime() -  7 * 24 * 60 * 60 * 1000));
  const cutoff3  = fmt(new Date(today.getTime() -  3 * 24 * 60 * 60 * 1000));
  return runAgent(
    "ROLE: Celebrity & culture diamond correspondent. You scan entertainment news, tabloids, sports coverage and social media to find the hottest diamond and jewelry moments happening RIGHT NOW.",
    `Today is ${weekLabel}. You have 12 web searches — use ALL of them. Your job is to find 4-5 fresh, hot diamond and jewelry moments from the LAST 7 DAYS — and PREFER items from the LAST 3 DAYS over older items, even when the older items have more coverage.

CRITICAL FRESHNESS RULE: A story that broke this WEEKEND outranks a story that broke a WEEK AGO, even if the older story has 10× more articles indexed. Your job is to find what is breaking NOW, not what has the most coverage. Do not default to whichever name has the most search results — default to whatever happened most recently.

STEP 1 — RUN THESE SEARCHES (replace [DATE] with this week's actual dates):
1. "celebrity diamonds this week ${weekLabel}"
2. "celebrity engagement ring this week"
3. "celebrity wedding diamonds this week"
4. "red carpet diamonds June 2026"
5. "diamond jewelry viral last 7 days"
6. "natural diamond celebrity news"
7. Search the biggest live cultural event happening RIGHT NOW (search "what major sport / awards / fashion event is happening this week 2026"), then search "[that event] diamonds jewelry"
8. Search the most-covered celebrity ENGAGEMENT or WEDDING announced THIS WEEK, then add "diamonds"
9. Search any viral red-carpet moment from the LAST 3 DAYS + "jewelry"
10. Search tennis / sports / music news from the LAST 3 DAYS for diamond moments
11. Open queries to fill remaining 12 searches if leads emerge from above

STEP 2 — PICK YOUR 4-5 ITEMS using this priority:
- Items with a catalyst on or after ${cutoff3} (last 3 days) are preferred over items from ${cutoff7}–${cutoff3}
- A genuinely NEW development on a story is fine (e.g. a tournament FINAL is a new event even if the tournament started earlier)
- "More coverage" is NOT a tiebreaker — "more recent" is

HARD RULES:
- The catalystDate MUST be on or after ${cutoff7}. Items dated before ${cutoff7} are AUTO-REJECTED.
- Do NOT pick last week's headline story. If a story broke before ${cutoff7}, only include it if there is a genuinely NEW development this week (e.g. a sequel event, a new public statement, a new viral moment) and the signal must LEAD with that new development, not the original event.
- No corporate press releases. No brand launches. No industry reports.
- Every item must name a real person and a real event with a real date within the last 7 days.
- Return 4-5 items. Do not stop at 3.
${ITEM_SPEC}`,
    { maxSearches: 12 }
  );
};

// ── Drive write ──────────────────────────────────────────────────────────────
async function findLatestFile() {
  const q = `name='${LATEST_NAME}' and '${PULSE_FOLDER_ID}' in parents and trashed=false`;
  const r = await drive.files.list({
    q,
    fields: "files(id,name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return r.data.files?.[0]?.id || null;
}

async function writeJSON(name, fileId, content) {
  const media = { mimeType: "application/json", body: JSON.stringify(content, null, 2) };
  if (fileId) {
    await drive.files.update({ fileId, media, supportsAllDrives: true });
    return fileId;
  }
  const r = await drive.files.create({
    requestBody: { name, parents: [PULSE_FOLDER_ID], mimeType: "application/json" },
    media,
    fields: "id",
    supportsAllDrives: true,
  });
  return r.data.id;
}

// ── code-side recency guard (don't trust the model's self-assessment) ─────────
// Drops items that are stale/undated OR whose wording admits they're backdrop.
// Layer 1 (social trends): strict — "ongoing", "continues", "dominates" are all red flags.
// Layer 2 (jewelry/culture): looser — live tournaments, active red carpets and ongoing
//   celebrity moments are valid; only catch clear evergreen/future/faded-trend language.
const BACKDROP_TELLS_L1 = ["still ", "re-explod", "continues", "sustained", "ongoing", "remains", "dominates", "long-running", "evergreen", "kicks off", "will kick"];
const BACKDROP_TELLS_L2 = ["still peaking", "still climbing", "re-explod", "sustained popularity", "long-running", "evergreen", "kicks off next", "will kick", "has been popular"];
function looksLikeBackdrop(it, label) {
  const tells = label === "layer2" ? BACKDROP_TELLS_L2 : BACKDROP_TELLS_L1;
  const s = ((it.trend || "") + " " + (it.signal || "")).toLowerCase();
  return tells.find((p) => s.includes(p)) || null;
}
function enforceRecency(items, maxDays, label) {
  // Compare dates only (not timestamps) so items dated exactly at the boundary aren't dropped on timezone.
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays).getTime();
  const kept = [];
  for (const it of items || []) {
    const d = Date.parse(it.catalystDate);
    const stale = isNaN(d) || d < cutoff;
    const tell = looksLikeBackdrop(it, label);
    if (!stale && !tell) kept.push(it);
    else console.log(`  dropped (${label}, ${stale ? "stale/undated" : "backdrop:'" + tell + "'"}): "${it.trend}" [${it.catalystDate || "no date"}]`);
  }
  return kept;
}

// ── publish ──────────────────────────────────────────────────────────────────
async function publish() {
  if (!PULSE_FOLDER_ID) throw new Error("Set PULSE_FOLDER_ID to a Drive folder id.");
  console.log("Running pulse agents…");
  let [l1, l2] = await Promise.all([layer1(), layer2()]);

  // Both layers: 7-day window. Layer 2 sorts by recency THEN heat (freshness wins ties).
  const byHeat   = (a, b) => (b.heat || 0) - (a.heat || 0);
  const byRecent = (a, b) => (Date.parse(b.catalystDate) || 0) - (Date.parse(a.catalystDate) || 0);
  l1 = enforceRecency(l1, 7, "layer1").sort(byHeat).slice(0, 5);
  // For Layer 2, prefer freshest: sort by date first, then break ties by heat.
  l2 = enforceRecency(l2, 7, "layer2")
    .sort((a, b) => byRecent(a, b) || byHeat(a, b))
    .slice(0, 3);

  if (l1.length === 0) console.log("  ⚠  Layer 1 empty after filtering — genuinely quiet week, or sources too thin.");

  const payload = {
    week,
    weekLabel,
    generatedAt: new Date().toISOString(),
    source: "Poppins Agent OS · ADIF",
    layer1: l1,
    layer2: l2,
  };

  // dated archive copy
  await writeJSON(`ADIF_Pulse_${week}.json`, null, payload);
  // canonical "latest" — the file the artifact reads
  const latestId = await writeJSON(LATEST_NAME, await findLatestFile(), payload);

  console.log(`✓ Published pulse for ${week}`);
  console.log(`  latest file id: ${latestId}`);
  console.log(`  → paste this id into pulse-proxy.gs (PULSE_FILE_ID) once.`);
}

publish().catch((e) => {
  console.error("Publish failed:", e.message);
  process.exit(1);
});
