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

const PULSE_FOLDER_ID = process.env.PULSE_FOLDER_ID;
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
async function runAgent(role, instructions) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
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
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s !== -1 && e !== -1) t = t.slice(s, e + 1);
  // repair trailing commas before } or ]
  t = t.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(t);
  } catch (err) {
    // log the region around the error for diagnosis
    const pos = parseInt((err.message.match(/position (\d+)/) || [])[1]) || 0;
    console.error("  JSON parse error near:", JSON.stringify(t.slice(Math.max(0, pos - 60), pos + 60)));
    throw err;
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

const layer2 = () =>
  runAgent(
    "ROLE: Research & Trends + Brand Guardian for A Diamond Is Forever. Natural-diamond-positive lens.",
    `Today is ${weekLabel}. Surface the TOP 3 trending news stories in the world of jewelry and diamonds right now — what's genuinely making noise in the category: industry and business moves (acquisitions, launches, collabs), notable celebrity or cultural diamond moments, and major shifts in the natural-vs-lab-grown conversation or the market. Rank by how much each is actually trending and return the 3 biggest; return fewer only if fewer than 3 genuinely qualify.
The selection driver is "what's the trending news," not aesthetics. The four hero pieces (studs, tennis bracelets, eternity bands, halo pendants) and jeweler-creators (Olivia Landau / The Clear Cut, Stephanie Gottlieb) are useful context, not the filter. Keep it on-brief and natural-diamond-positive.
${ITEM_SPEC}`
  );

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
const BACKDROP_TELLS = ["still ", "re-explod", "continues", "sustained", "ongoing", "remains", "dominates", "long-running", "evergreen", "kicks off", "will kick"];
function looksLikeBackdrop(it) {
  const s = ((it.trend || "") + " " + (it.signal || "")).toLowerCase();
  return BACKDROP_TELLS.find((p) => s.includes(p)) || null;
}
function enforceRecency(items, maxDays, label) {
  const cutoff = today.getTime() - maxDays * 24 * 60 * 60 * 1000;
  const kept = [];
  for (const it of items || []) {
    const d = Date.parse(it.catalystDate);
    const stale = isNaN(d) || d < cutoff;
    const tell = looksLikeBackdrop(it);
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

  // Layer 1 = breaking social: strict 10-day window. Layer 2 = jewelry news: 30-day window.
  const byHeat = (a, b) => (b.heat || 0) - (a.heat || 0);
  l1 = enforceRecency(l1, 10, "layer1").sort(byHeat).slice(0, 5);
  l2 = enforceRecency(l2, 30, "layer2").sort(byHeat).slice(0, 3); // top 3 news, hard cap

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
