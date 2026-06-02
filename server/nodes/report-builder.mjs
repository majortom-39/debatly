// =============================================================================
// nodes/report-builder.mjs  —  THE REPORT BUILDER NODE (post-debate)
// =============================================================================
//
// JOB: when the user hits "Stop & generate report", turn the whole debate
// ledger into ONE audience-facing report. Runs ONCE, after the final packets
// have been flushed through the pipeline.
//
// SPLIT OF RESPONSIBILITY (on purpose):
//   • NUMBERS & CHARTS are computed in plain code from the ledger — the score
//     timeline, per-speaker stat chips/scores, the fact-check roundup, the
//     contradictions list. These can NEVER be hallucinated; they are the truth.
//   • PROSE is written by ONE AI call — the neutral verdict, each side's case
//     summary, the key moments, and a one-line read on each speaker (plus that
//     speaker's standout quote). The model only narrates; it never invents data.
//
// NEUTRALITY: we do NOT declare a winner. The verdict presents the facts and our
// reading (who is ahead on the credibility score, and why) and lets the
// audience deduce the rest. Tone is neutral / journalistic.
//
// INPUT: the clean live payload (buildLivePayload shape) + transcript + duration.
// OUTPUT: a DebateReport object the frontend renders below the live desk.
// =============================================================================

import { runAgent, stringifyAgentContext, NODE_THINKING_LEVEL } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";

const VISUAL_TIMELINE_CAP_MIN = 10; // x-axis fills out by 10 min; longer debates stay full-width

// Point values mirror the scoring engine (kept here only for labels).
const HEAVY_EVENT_KINDS = ["verified", "contradicted", "misleading", "inconsistencies"];

// -----------------------------------------------------------------------------
// PUBLIC ENTRY
// -----------------------------------------------------------------------------
export async function runReportBuilder({
  payload = {},
  transcriptTurns = [],
  durationMs = 0,
  sessionId = "",
  thinkingLevel = NODE_THINKING_LEVEL,
  trace = null
} = {}) {
  const blue = payload?.sides?.blue || {};
  const red = payload?.sides?.red || {};

  // --- Deterministic pieces (the truth) --------------------------------------
  const scoreTimeline = buildPivotalTimeline(payload?.scoreTimeline || [], durationMs);
  const speakers = buildSpeakerRows(payload);
  const speakerEntries = buildSpeakerEntries(payload, transcriptTurns, speakers);
  const factChecks = buildFactCheckRoundup(payload);
  const contradictions = buildContradictions(payload);
  const scoreboard = {
    blue: { score: Math.round(Number(blue.score || 0)), breakdown: blue.breakdown || null },
    red: { score: Math.round(Number(red.score || 0)), breakdown: red.breakdown || null }
  };

  // --- Prose (one AI call) ----------------------------------------------------
  let prose = {};
  try {
    prose = await writeReportProse({
      payload, speakers, factChecks, contradictions, scoreboard, thinkingLevel, trace
    });
  } catch (error) {
    logStep(trace, "ReportBuilder:prose-failed", { error: error instanceof Error ? error.message : String(error) });
    prose = {};
  }

  // Merge AI one-liners + standout quotes back onto the deterministic speaker rows.
  const speakerVerdicts = Array.isArray(prose.speakerVerdicts) ? prose.speakerVerdicts : [];
  const speakersWithProse = speakers.map((row) => {
    const match = speakerVerdicts.find((v) => String(v.speakerId) === String(row.speakerId)) || {};
    const { quotes: _quotes, ...rest } = row; // drop internal working quotes
    return {
      ...rest,
      verdict: cleanLine(match.verdict) || defaultSpeakerVerdict(row),
      standoutQuote: pickStandoutQuote(match.standoutQuote, row)
    };
  });

  return {
    id: `report-${Date.now().toString(36)}`,
    sessionId: String(sessionId || ""),
    generatedAt: new Date().toISOString(),
    topic: String(payload?.topic || ""),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    verdict: cleanBlock(prose.verdict) || defaultVerdict(scoreboard),
    blueSummary: cleanBlock(prose.blueSummary) || (blue.thesis || blue.position || ""),
    redSummary: cleanBlock(prose.redSummary) || (red.thesis || red.position || ""),
    scoreboard,
    scoreTimeline,
    speakerEntries,
    speakers: speakersWithProse,
    factChecks,
    contradictions,
    keyMoments: normalizeKeyMoments(prose.keyMoments)
  };
}

// When each (sided) speaker FIRST spoke, as the TRUE recording minute (so it lines
// up with the score chart's real-timecode x-axis).
function buildSpeakerEntries(payload, transcriptTurns, speakers) {
  const turns = (transcriptTurns || []).filter((t) => t && Number.isFinite(Number(t.startSec)));
  if (!turns.length || !speakers.length) return [];
  const sideOf = new Map(speakers.map((s) => [String(s.speakerId), s.side]));
  const firstBySpeaker = new Map();
  for (const t of turns) {
    const id = String(t.speakerId || "");
    if (!sideOf.has(id)) continue; // only speakers that took a side
    const sec = Number(t.startSec);
    if (!firstBySpeaker.has(id) || sec < firstBySpeaker.get(id)) firstBySpeaker.set(id, sec);
  }
  return [...firstBySpeaker.entries()]
    .map(([speakerId, sec]) => ({ speakerId, side: sideOf.get(speakerId) || null, minute: Math.max(0, Number((sec / 60).toFixed(2))) }))
    .sort((a, b) => a.minute - b.minute);
}

// -----------------------------------------------------------------------------
// DETERMINISTIC: SCORE TIMELINE  (pick only pivotal moments)
// -----------------------------------------------------------------------------
// A snapshot is pivotal if ANY of:
//   • it is the first (gate open, 0–0) or the last (final score)
//   • a HEAVY scoring event landed this packet (verified / contradicted /
//     misleading / inconsistency) on either side — small debate points ignored
//   • the lead changed hands (blue↔red, or even→led)
// Each pivotal point carries an `event` describing what moved the score.
function buildPivotalTimeline(snapshots, durationMs) {
  // X-axis uses the TRUE position in the recording (atSec → minute), so the chart
  // starts at the real minute the gate opened (the debate's start in the video),
  // not a synthetic 0. Falls back to the relative minute if atSec is absent.
  const clean = (snapshots || [])
    .filter((s) => s && (Number.isFinite(Number(s.atSec)) || Number.isFinite(Number(s.minute))))
    .map((s) => ({
      minute: Number.isFinite(Number(s.atSec)) ? Number((Number(s.atSec) / 60).toFixed(2)) : Number(s.minute),
      blue: Math.round(Number(s.blue || 0)),
      red: Math.round(Number(s.red || 0)),
      blueBreakdown: s.blueBreakdown || {},
      redBreakdown: s.redBreakdown || {}
    }));
  if (!clean.length) return { points: [], maxMinute: 0, debateStartMinute: 0, capMinute: VISUAL_TIMELINE_CAP_MIN };

  const points = [];
  let prev = null;
  clean.forEach((snap, index) => {
    const isFirst = index === 0;
    const isLast = index === clean.length - 1;
    const event = prev ? heavyEventBetween(prev, snap) : null;
    const leadFlip = prev ? leadChanged(prev, snap) : false;
    if (isFirst || isLast || event || leadFlip) {
      points.push({
        minute: snap.minute,
        blue: snap.blue,
        red: snap.red,
        pivotal: true,
        event: event || (leadFlip ? leadFlipEvent(snap) : isFirst ? { kind: "open", label: "Debate starts", side: null, delta: 0 } : isLast ? { kind: "final", label: "Final score", side: null, delta: 0 } : null)
      });
    }
    prev = snap;
  });

  const debateStartMinute = clean[0].minute;     // real minute the debate began
  const maxMinute = clean[clean.length - 1].minute;
  return {
    points,
    maxMinute,
    debateStartMinute,
    capMinute: VISUAL_TIMELINE_CAP_MIN
  };
}

function heavyEventBetween(prev, snap) {
  // Compare each side's heavy breakdown counts; report the biggest single change.
  let best = null;
  for (const side of ["blue", "red"]) {
    const a = side === "blue" ? prev.blueBreakdown : prev.redBreakdown;
    const b = side === "blue" ? snap.blueBreakdown : snap.redBreakdown;
    for (const kind of HEAVY_EVENT_KINDS) {
      const delta = Number(b?.[kind] || 0) - Number(a?.[kind] || 0);
      if (delta > 0) {
        const cand = { side, kind, label: eventLabel(side, kind, delta), delta: eventDelta(kind, delta), count: delta };
        if (!best || Math.abs(cand.delta) > Math.abs(best.delta)) best = cand;
      }
    }
  }
  return best;
}

function eventDelta(kind, count) {
  const per = { verified: 3, contradicted: -5, misleading: -2, inconsistencies: -4 }[kind] || 0;
  return per * count;
}

function eventLabel(side, kind, count) {
  const sideName = side === "blue" ? "Blue" : "Red";
  const n = count > 1 ? `${count} ` : "a ";
  switch (kind) {
    case "verified": return `${sideName} got ${count > 1 ? count + " claims" : "a claim"} verified`;
    case "contradicted": return `${sideName} was caught on ${count > 1 ? count + " false claims" : "a false claim"}`;
    case "misleading": return `${sideName} made ${n}misleading claim${count > 1 ? "s" : ""}`;
    case "inconsistencies": return `${sideName} contradicted itself`;
    default: return `${sideName} score moved`;
  }
}

function leadChanged(prev, snap) {
  return leadOf(prev) !== leadOf(snap);
}
function leadOf(s) {
  if (s.blue > s.red) return "blue";
  if (s.red > s.blue) return "red";
  return "even";
}
function leadFlipEvent(snap) {
  const lead = leadOf(snap);
  if (lead === "even") return { kind: "lead", label: "Sides level", side: null, delta: 0 };
  return { kind: "lead", label: `${lead === "blue" ? "Blue" : "Red"} takes the lead`, side: lead, delta: 0 };
}

// -----------------------------------------------------------------------------
// DETERMINISTIC: PER-SPEAKER ROWS (score + stat chips)
// -----------------------------------------------------------------------------
function buildSpeakerRows(payload) {
  const rows = [];
  for (const side of ["blue", "red"]) {
    const sideObj = payload?.sides?.[side] || {};
    const speakers = sideObj.speakers || {};
    for (const [speakerId, stat] of Object.entries(speakers)) {
      rows.push({
        speakerId,
        side,
        score: Math.round(Number(stat?.score || 0)),
        stats: {
          verified: Number(stat?.verified || 0),
          contradicted: Number(stat?.contradicted || 0),
          misleading: Number(stat?.misleading || 0),
          inconsistencies: Number(stat?.inconsistencies || 0),
          debatePoints: Number(stat?.debatePoints || 0)
        },
        quotes: collectSpeakerQuotes(payload, side, speakerId)
      });
    }
  }
  // Strongest first within each side.
  rows.sort((a, b) => (a.side === b.side ? b.score - a.score : a.side === "blue" ? -1 : 1));
  return rows;
}

// The actual fact-check verdict lives in `tag` (verified/contradicted/misleading/
// no_clear_source). `status` is just the lifecycle value ("done"), so never read it
// for the verdict.
function claimVerdict(c) {
  return c?.tag || (["verified", "contradicted", "misleading", "no_clear_source"].includes(c?.status) ? c.status : null);
}

function collectSpeakerQuotes(payload, side, speakerId) {
  const sideObj = payload?.sides?.[side] || {};
  const out = [];
  for (const c of sideObj.claims || []) {
    if (String(c.speakerId) === String(speakerId) && c.quote) {
      const v = claimVerdict(c);
      out.push({ text: String(c.quote), kind: v === "verified" ? "strength" : (v === "contradicted" || v === "misleading") ? "stumble" : "neutral" });
    }
  }
  for (const p of sideObj.debatePoints || []) {
    if (String(p.speakerId) === String(speakerId) && p.quote) out.push({ text: String(p.quote), kind: "neutral" });
  }
  return out.slice(0, 12);
}

// -----------------------------------------------------------------------------
// DETERMINISTIC: FACT-CHECK ROUNDUP (consequential first)
// -----------------------------------------------------------------------------
const STATUS_WEIGHT = { contradicted: 4, verified: 3, misleading: 2, no_clear_source: 1 };
function buildFactCheckRoundup(payload) {
  const all = [];
  for (const side of ["blue", "red"]) {
    for (const c of payload?.sides?.[side]?.claims || []) {
      const verdict = claimVerdict(c);
      if (!verdict) continue; // skip still-checking / unscored claims
      all.push({
        side,
        speakerId: c.speakerId,
        claim: String(c.claim || ""),
        quote: String(c.quote || ""),
        status: verdict,
        why: String(c.why || ""),
        sources: (c.sources || []).map((s) => ({ title: String(s.title || s.url || "source"), url: String(s.url || "") })).slice(0, 4)
      });
    }
  }
  all.sort((a, b) => (STATUS_WEIGHT[b.status] || 0) - (STATUS_WEIGHT[a.status] || 0));
  return all;
}

// -----------------------------------------------------------------------------
// DETERMINISTIC: CONTRADICTIONS
// -----------------------------------------------------------------------------
function buildContradictions(payload) {
  const out = [];
  for (const side of ["blue", "red"]) {
    for (const inc of payload?.sides?.[side]?.inconsistencies || []) {
      out.push({
        side,
        type: String(inc.type || ""),
        level: String(inc.level || ""),
        why: String(inc.why || ""),
        first: { speakerId: inc.firstSpeakerId || "", quote: String(inc.firstQuote || "") },
        second: { speakerId: inc.secondSpeakerId || "", quote: String(inc.secondQuote || "") }
      });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// AI: the prose layer
// -----------------------------------------------------------------------------
const REPORT_PROSE_PROMPT = [
  "You are debatly's Report Writer. The live debate has ended. Write the narrative layer of a post-debate report for the AUDIENCE.",
  "",
  "ABSOLUTE RULES:",
  "- TONE: neutral, journalistic, factual. Like a fact-check column, NOT a sports recap.",
  "- DO NOT declare a winner. Never say 'X wins' or crown a side. Present the facts and our reading (who is ahead on the credibility score, and WHY), and let the reader judge.",
  "- We score TRUTHFULNESS and CONSISTENCY, not whose opinion is morally right. Frame everything that way.",
  "- Use only the words 'Blue side' and 'Red side' for the sides. Never use real-world political labels.",
  "- Ground every statement in the provided artifacts (claims, fact-checks, contradictions, scores). Never invent facts, quotes, numbers, or sources.",
  "- Be concise. No filler, no hedging boilerplate, no restating the topic verbatim.",
  "",
  "WRITE THESE FIELDS (return STRICT JSON, this exact schema):",
  "{",
  '  "verdict": "1-2 short paragraphs: where each side stands on the credibility score and why (verified vs caught-out claims, self-contradictions). State who is ahead on the score WITHOUT declaring a winner.",',
  '  "blueSummary": "2-3 sentences: a fair, neutral summary of the Blue side\'s case and its strongest themes.",',
  '  "redSummary": "2-3 sentences: a fair, neutral summary of the Red side\'s case and its strongest themes.",',
  '  "keyMoments": [{"title":"short title","detail":"1-2 sentences on why this mattered","side":"blue|red|null","impact":"positive|negative","quote":"an EXACT quote from the artifacts, or empty"}],',
  '  "speakerVerdicts": [{"speakerId":"Speaker 1","verdict":"ONE line on how this speaker did (evidence, accuracy, consistency). Do NOT name the speaker in the text.","standoutQuote":{"text":"an EXACT quote this speaker actually said (from their listed quotes)","kind":"strength|stumble"}}]',
  "}",
  "",
  "GUIDANCE:",
  "- keyMoments: pick the 2-4 highest-impact moments (the most damaging false claim, the strongest verified point, the sharpest self-contradiction). Quote exactly or leave quote empty. Set `impact` from the named side's perspective: 'positive' if the moment helped that side's credibility (e.g. a verified claim), 'negative' if it hurt that side (a false/misleading claim, or a self-contradiction).",
  "- speakerVerdicts: include EVERY speaker listed in the data. The one-line verdict is about their performance on truth/consistency. standoutQuote MUST be chosen from that speaker's listed quotes (verbatim); if they have none, omit standoutQuote.",
  "- If a side has no checked claims or no contradictions, say so plainly rather than implying fault."
].join("\n");

async function writeReportProse({ payload, speakers, factChecks, contradictions, scoreboard, thinkingLevel, trace }) {
  const context = {
    topic: payload?.topic || "",
    scoreboard,
    blue: {
      thesis: payload?.sides?.blue?.thesis || "", position: payload?.sides?.blue?.position || "",
      debatePoints: (payload?.sides?.blue?.debatePoints || []).map((p) => ({ speakerId: p.speakerId, point: p.point, quote: p.quote, family: p.familyTitle })),
    },
    red: {
      thesis: payload?.sides?.red?.thesis || "", position: payload?.sides?.red?.position || "",
      debatePoints: (payload?.sides?.red?.debatePoints || []).map((p) => ({ speakerId: p.speakerId, point: p.point, quote: p.quote, family: p.familyTitle })),
    },
    factChecks: factChecks.map((f) => ({ side: f.side, speakerId: f.speakerId, claim: f.claim, quote: f.quote, status: f.status, why: f.why })),
    contradictions: contradictions.map((c) => ({ side: c.side, type: c.type, why: c.why, first: c.first, second: c.second })),
    speakers: speakers.map((s) => ({ speakerId: s.speakerId, side: s.side, score: s.score, stats: s.stats, quotes: s.quotes.map((q) => q.text) }))
  };

  const prompt = `${REPORT_PROSE_PROMPT}\n\nDebate data: ${stringifyAgentContext(context)}`;
  const { json } = await runAgent({
    agent: "Report Writer",
    prompt,
    thinkingLevel,
    responseMimeType: "application/json",
    maxOutputTokens: 4000,
    timeoutMs: 45000,
    trace,
    meta: { speakers: speakers.length, factChecks: factChecks.length }
  });
  return json || {};
}

// -----------------------------------------------------------------------------
// Small helpers + fallbacks
// -----------------------------------------------------------------------------
function cleanLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function cleanBlock(value) {
  return String(value || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function defaultSpeakerVerdict(row) {
  const { verified, contradicted, misleading, inconsistencies } = row.stats;
  const bits = [];
  if (verified) bits.push(`${verified} claim${verified > 1 ? "s" : ""} verified`);
  if (contradicted) bits.push(`${contradicted} caught false`);
  if (misleading) bits.push(`${misleading} misleading`);
  if (inconsistencies) bits.push(`${inconsistencies} self-contradiction${inconsistencies > 1 ? "s" : ""}`);
  return bits.length ? bits.join(", ") + "." : "No checkable claims flagged.";
}
function defaultVerdict(scoreboard) {
  const b = scoreboard.blue.score;
  const r = scoreboard.red.score;
  if (b === r) return "Both sides finish level on the credibility score. The reading is even.";
  const lead = b > r ? "Blue side" : "Red side";
  return `${lead} ends ahead on the credibility score (Blue ${b}, Red ${r}). This reflects verified claims against claims caught out and self-contradictions — not whose opinion is correct.`;
}
function pickStandoutQuote(aiQuote, row) {
  const text = cleanLine(aiQuote?.text);
  if (text) {
    // Trust only if the speaker actually said something close to it.
    const said = row.quotes.find((q) => quoteMatches(q.text, text));
    if (said) return { text: said.text, kind: aiQuote.kind === "stumble" ? "stumble" : aiQuote.kind === "strength" ? "strength" : said.kind };
  }
  // Fallback: their first strength quote, else first quote.
  const strength = row.quotes.find((q) => q.kind === "strength");
  const pick = strength || row.quotes[0];
  return pick ? { text: pick.text, kind: pick.kind === "neutral" ? "strength" : pick.kind } : null;
}
function quoteMatches(a, b) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}
function normalizeKeyMoments(moments) {
  if (!Array.isArray(moments)) return [];
  return moments.slice(0, 4).map((m) => ({
    title: cleanLine(m.title),
    detail: cleanBlock(m.detail),
    side: m.side === "blue" || m.side === "red" ? m.side : null,
    impact: m.impact === "positive" || m.impact === "negative" ? m.impact : "neutral",
    quote: cleanLine(m.quote)
  })).filter((m) => m.title || m.detail);
}
