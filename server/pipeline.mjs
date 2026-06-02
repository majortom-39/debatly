// =============================================================================
// pipeline.mjs  —  THE WIRING ("the clerk")
// =============================================================================
//
// This is the ONLY place node order + bookkeeping rules live. Nodes are pure
// brains (they read and judge); this file decides what actually gets kept.
//
// FLOW (v1):
//   diarized turns  ->  group into 30-second packets  ->  Stabilizer Gate
//      -> (while CLOSED) keep transcript, mark "pre-debate", do nothing else
//      -> (when it OPENS) latch open forever
//      -> (while OPEN) Side Builder reads the packet + full running ledger
//
// CLERK RULES enforced here (plain code, never the model):
//   1. Gate latch: once open, always open. The model can never re-close it.
//   2. Pre-debate transcript is kept on record but flagged ignored.
//   3. Junk-tagged stretches are recorded but flagged so downstream skips them.
//   4. Side Builder runs ONLY after the gate is open.
//
// State here is a plain object the caller owns; we return the updated copy.
// =============================================================================

import { runStabilizerGate } from "./nodes/stabilizer-gate.mjs";
import { runSideBuilder } from "./nodes/side-builder.mjs";
import { runDebatePointBuilder, DEBATE_POINT_TAGS } from "./nodes/debate-point-builder.mjs";
import { runFamilyMerger } from "./nodes/family-merger.mjs";
import { runClaimBuilder } from "./nodes/claim-builder.mjs";
import { runFactCheckFirecrawl, runDeepCheck, FACT_CHECK_BATCH_SIZE } from "./nodes/fact-checker.mjs";
import { runInconsistencyBuilder, INCONSISTENCY_TYPES, INCONSISTENCY_LEVELS } from "./nodes/inconsistency-builder.mjs";
import { computeScores } from "./nodes/scoring-engine.mjs";
import { logStep } from "./shared/trace.mjs";

// Inconsistency Finder runs every Nth open packet (≈2 min) — it's strict and
// compares accumulated history, so it doesn't need to run every minute.
export const INCONSISTENCY_EVERY_N_PACKETS = 2;

// Family Merger runs every Nth OPEN packet (≈ every 2 minutes at 60s packets).
export const FAMILY_MERGER_EVERY_N_PACKETS = 2;

// --- Group diarized turns into fixed-size packets ----------------------------
// Each turn has { id, speakerId, text, startSec, endSec }. We bucket by start
// time into fixed windows, then shape each packet the way the nodes expect
// (speakerColumns = one merged block of text per speaker in that window).
//
// HEARTBEAT = 60s. One 60-second packet flows through the whole chain each beat:
// the same packet goes to the Stabilizer Gate and then to the downstream nodes.
// (For hour-long debates, one-minute updates are fast enough.)
export const PACKET_SECONDS = 60;
export const GATE_WINDOW_PACKETS = 1; // gate sees the current packet (60s)

// The gate is forbidden to LATCH OPEN during this opening warm-up window. This
// reliably absorbs cold-open teasers + show intros that always live at the very
// start. The lookahead guard (below) catches teasers that appear later.
export const GATE_WARMUP_HOLD_SECONDS = 60;

export function groupTurnsIntoPackets(turns = [], packetSeconds = PACKET_SECONDS) {
  const clean = (Array.isArray(turns) ? turns : []).filter((t) => t && String(t.text || "").trim());
  if (!clean.length) return [];

  // IMPORTANT: a live STT stream can RESET its internal clock several times over
  // a long recording (e.g. on reconnects), so `startSec` jumps back to ~0 mid-debate.
  // Turns still ARRIVE in true chronological order, so we walk them in order and
  // stitch a single continuous timeline: each time the clock jumps backward, we
  // add the previous segment's furthest end as an offset.
  const RESET_BACKWARD_SEC = 5;
  let offset = 0;
  let prevStart = -Infinity;
  let segmentMaxEnd = 0;
  const timed = clean.map((turn) => {
    let start = Number.isFinite(Number(turn.startSec)) ? Number(turn.startSec) : prevStart === -Infinity ? 0 : prevStart;
    const end = Number.isFinite(Number(turn.endSec)) ? Number(turn.endSec) : start;
    if (start < prevStart - RESET_BACKWARD_SEC) {
      offset += segmentMaxEnd;        // clock reset detected → continue the timeline
      segmentMaxEnd = 0;
    }
    prevStart = start;
    const absStart = start + offset;
    const absEnd = end + offset;
    segmentMaxEnd = Math.max(segmentMaxEnd, end);
    return { turn, absStart, absEnd };
  });

  const baseSec = timed[0].absStart;
  const buckets = new Map();
  for (const item of timed) {
    const idx = Math.max(0, Math.floor((item.absStart - baseSec) / packetSeconds));
    if (!buckets.has(idx)) buckets.set(idx, []);
    buckets.get(idx).push({ ...item.turn, _absStart: item.absStart, _absEnd: item.absEnd });
  }

  return [...buckets.keys()].sort((a, b) => a - b).map((idx) => {
    const packetTurns = buckets.get(idx);
    // Merge consecutive same-speaker text into one column per speaker appearance.
    const speakerColumns = [];
    for (const turn of packetTurns) {
      const last = speakerColumns[speakerColumns.length - 1];
      if (last && last.speakerId === turn.speakerId) {
        last.text += ` ${turn.text}`.trim();
        last.turnIds.push(turn.id);
      } else {
        speakerColumns.push({ speakerId: turn.speakerId, text: String(turn.text || "").trim(), turnIds: [turn.id] });
      }
    }
    return {
      windowId: `p${idx}`,
      startSec: baseSec + idx * packetSeconds,
      endSec: baseSec + (idx + 1) * packetSeconds,
      speakerColumns,
      turns: packetTurns.map((t) => ({ id: t.id, speakerId: t.speakerId, text: t.text, startSec: t._absStart, endSec: t._absEnd }))
    };
  });
}

// --- A fresh pipeline state --------------------------------------------------
export function createPipelineState() {
  return {
    gateOpen: false,
    gateOpenedAtSec: null,
    gateBacktrackedToSec: null, // true start the gate rewound to (≤ gateOpenedAtSec)
    realStartQuote: "",
    gateOpenReason: "",
    debatorSpeakerId: "",
    timelineStartSec: null, // start time of the first packet (warm-up anchor)
    prevPacket: null,       // previous 30s packet, for the gate's 60s window
    preDebatePackets: [],   // kept on record, ignored downstream
    junkTags: [],           // every tag the gate raised after opening
    ledger: [],             // every OPEN packet's dialogue (Side Builder memory)
    // Side Builder's running picture:
    topic: "",
    sides: { blue: { position: "", thesis: "" }, red: { position: "", thesis: "" } },
    speakers: {},           // speakerId -> { side, confidence, reason, evidenceQuote }
    // Debate Point Builder ledger (the cards the UI shows under each side):
    debatePoints: [],       // { pointId, speakerId, side, point, quote, turnIds, tag, opposingQuote, opposingSpeakerId, familyId, reason, confidence }
    // Family Merger (per-side themed envelopes):
    families: { blue: [], red: [] }, // side -> [ { familyId, title, pointIds } ]
    // Inconsistency Finder (cards filed under the offending side):
    inconsistencies: [],    // { incId, side, level, type, firstSpeakerId, firstQuote, secondSpeakerId, secondQuote, why }
    // Scoring engine (deterministic tally — recomputed live each packet):
    scores: { blue: null, red: null },
    // Clean per-packet score snapshots for the post-debate report timeline.
    // Each entry: { minute, atSec, blue, red, blueBreakdown, redBreakdown }.
    // Built ONLY from the clean pipeline scores (not the old debate object).
    scoreTimeline: [],
    // Claim Builder + Fact Checker:
    //   status: checking -> (firecrawl) -> verified/contradicted/misleading (final)
    //                    -> (unsettled) -> deep_checking -> (grounding) -> verified/contradicted/misleading/no_clear_source (final)
    //   tag is null until a FINAL state. "no_clear_source" only ever appears as a final answer.
    claims: [],             // { claimId, speakerId, side, claim, quote, searchQuery, status, tag, why, sources }
    factCheckQueue: [],     // claimIds awaiting STAGE 1 (Firecrawl)
    deepCheckQueue: [],     // claimIds awaiting STAGE 2 (Gemini grounding)
    openPacketCount: 0      // how many OPEN packets processed (drives the 2-min merger cadence)
  };
}

// --- The clerk rule for accepting a side assignment --------------------------
// Plain, predictable: must be a real side, with confidence + evidence, and we
// don't overwrite a strong existing assignment with a weaker new one.
const SIDE_CONFIDENCE_MIN = 0.55;
function acceptSpeakerAssignment(state, proposal) {
  const side = String(proposal?.side || "").toLowerCase();
  if (side !== "blue" && side !== "red") return false;          // drop nulls/garbage
  const confidence = Number(proposal?.confidence || 0);
  if (confidence < SIDE_CONFIDENCE_MIN) return false;
  if (!String(proposal?.evidenceQuote || "").trim()) return false;
  const existing = state.speakers[proposal.speakerId];
  if (existing && existing.side !== side && existing.confidence >= 0.86 && confidence < 0.94) return false;
  return true;
}

// --- Run ONE packet through the chain ----------------------------------------
// nextPacket (optional) = the following packet, used ONLY as gate lookahead
// while still closed, to catch cold-open teasers whose intro lands next.
export async function runPacket(state, packet, { trace = null, nextPacket = null } = {}) {
  if (state.timelineStartSec === null) state.timelineStartSec = Number(packet.startSec) || 0;

  // While closed, give the gate the recent pre-debate lines so it can backtrack
  // to the true start when it finally opens.
  const recentTranscript = state.gateOpen ? [] : recentPreDebateLines(state, 40);

  // GATE WINDOW: the gate reads the current packet PLUS the previous one (~60s)
  // for wider context. Downstream nodes still get only the current 30s packet.
  const gateWindow = [state.prevPacket, packet].filter(Boolean).slice(-GATE_WINDOW_PACKETS);
  state.prevPacket = packet; // remember for next packet's gate window

  const gateResult = await runStabilizerGate({
    dialogueWindows: gateWindow,
    gateAlreadyOpen: state.gateOpen,
    nextPacketPreview: state.gateOpen ? null : nextPacket,
    context: { ledger: state.ledger, speakers: state.speakers, recentTranscript },
    trace
  });

  // CLERK RULE 0 — WARM-UP HOLD: forbid opening during the opening window, no
  // matter what the model says. Cold-open teasers always live at the very start.
  const withinWarmup = Number(packet.startSec) < (state.timelineStartSec || 0) + GATE_WARMUP_HOLD_SECONDS;

  let justOpened = false;
  // CLERK RULE 1 — latch: once open, never close.
  if (!state.gateOpen && gateResult.openedThisPacket && withinWarmup) {
    logStep(trace, "Pipeline:gate-open-suppressed", { atSec: packet.startSec, reason: "warmup-hold", debator: gateResult.debatorSpeakerId });
  } else if (!state.gateOpen && gateResult.openedThisPacket) {
    state.gateOpen = true;
    state.gateOpenedAtSec = packet.startSec;
    state.gateOpenReason = gateResult.openReason;
    state.debatorSpeakerId = gateResult.debatorSpeakerId;
    state.realStartQuote = gateResult.realStartQuote || "";
    justOpened = true;
    logStep(trace, "Pipeline:gate-opened", { atSec: packet.startSec, debator: gateResult.debatorSpeakerId, reason: gateResult.openReason, realStartQuote: state.realStartQuote });
  }

  if (!state.gateOpen) {
    // CLERK RULE 2 — keep pre-debate transcript, flagged ignored.
    state.preDebatePackets.push({ ...packet, status: "pre-debate-ignored" });
    return state;
  }

  // CLERK RULE 5 — BACKTRACK: on the packet where we just opened, rewind to the
  // true start (realStartQuote) and replay the kept pre-debate packets from there
  // through Side Builder, so the opening argument is not lost.
  if (justOpened) {
    const caughtUp = await catchUpFromRealStart(state, gateResult.realStartQuote, trace);
    state.gateBacktrackedToSec = caughtUp;
  }

  // CLERK RULE 3 — record junk tags so downstream can skip those stretches.
  // Plain-code guard: only accept a tag whose speaker actually appears in THIS
  // packet. This drops stray tags the model sometimes invents by reaching back
  // into ledger context (e.g. tagging a speaker not present in the current 60s).
  if (Array.isArray(gateResult.junkTags) && gateResult.junkTags.length) {
    const packetSpeakers = new Set((packet.speakerColumns || []).map((c) => c.speakerId));
    for (const tag of gateResult.junkTags) {
      if (tag.speakerId && !packetSpeakers.has(tag.speakerId)) {
        logStep(trace, "Pipeline:junk-tag-dropped", { packetId: packet.windowId, speakerId: tag.speakerId, kind: tag.kind, reason: "speaker-not-in-packet" });
        continue;
      }
      state.junkTags.push({ ...tag, packetId: packet.windowId, atSec: packet.startSec });
    }
  }

  // The packet's dialogue joins the running ledger (Side Builder memory).
  state.ledger.push(packet);
  await runSideBuilderForPacket(state, packet, trace);

  state.openPacketCount += 1;

  // DEBATE POINT BUILDER — runs every OPEN packet (every ~1 min).
  await runDebatePointsForPacket(state, packet, trace);

  // CLAIM BUILDER — branches off the Side Builder dialogue (same packet), every
  // OPEN packet. New checkable claims are enqueued for the fact checker.
  await runClaimsForPacket(state, packet, trace);

  // FACT CHECKER — drain up to FACT_CHECK_BATCH_SIZE claims from the queue per
  // packet, so we never throttle the API or the live pipeline.
  await drainFactCheckQueue(state, trace);

  // FAMILY MERGER — runs every 2nd OPEN packet (every ~2 min), per side.
  if (state.openPacketCount % FAMILY_MERGER_EVERY_N_PACKETS === 0) {
    await runFamilyMergerForBothSides(state, trace);
  }

  // INCONSISTENCY FINDER — every 2nd OPEN packet (≈2 min). Strict; compares the
  // accumulated debate-point + claim ledgers for clear contradictions.
  if (state.openPacketCount % INCONSISTENCY_EVERY_N_PACKETS === 0) {
    await runInconsistenciesPass(state, trace);
  }

  // SCORING ENGINE — pure arithmetic, recomputed EVERY packet so the scoreboard
  // moves live. Just tallies the tags the other nodes already produced.
  state.scores = computeScores({
    claims: state.claims,
    debatePoints: state.debatePoints,
    inconsistencies: state.inconsistencies
  });
  logStep(trace, "ScoringEngine:updated", { blue: state.scores.blue?.score, red: state.scores.red?.score });

  // Snapshot this packet's scores for the report timeline. Minute is measured
  // from gate-open (debate start), capped at >= 0. We keep every packet's
  // snapshot; the report builder later picks only the pivotal ones to plot.
  recordScoreSnapshot(state, packet);

  return state;
}

// Record one score snapshot per packet for the report timeline. We store the
// running totals + the breakdown counts so the report builder can diff
// consecutive snapshots and label what changed (a verified claim, a
// contradiction, an inconsistency, etc.). Snapshots are kept only after the
// gate is open (a real debate is underway).
function recordScoreSnapshot(state, packet) {
  if (!state.gateOpen) return;
  const zeroSec = Number(state.gateOpenedAtSec ?? state.timelineStartSec ?? 0);
  const atSec = Number(packet?.endSec ?? 0);
  const minute = Math.max(0, Number(((atSec - zeroSec) / 60).toFixed(2)));
  const blue = Math.round(Number(state.scores?.blue?.score ?? 0));
  const red = Math.round(Number(state.scores?.red?.score ?? 0));
  const blueBreakdown = { ...(state.scores?.blue?.breakdown || {}) };
  const redBreakdown = { ...(state.scores?.red?.breakdown || {}) };
  const last = state.scoreTimeline[state.scoreTimeline.length - 1];
  const entry = { minute, atSec, blue, red, blueBreakdown, redBreakdown };
  // Replace the last entry if it's the same minute (later packet wins); else push.
  if (last && last.minute === minute) {
    state.scoreTimeline[state.scoreTimeline.length - 1] = entry;
  } else {
    state.scoreTimeline.push(entry);
  }
}

// Inconsistency Finder pass: scan ledgers → dedup → file under offending side.
async function runInconsistenciesPass(state, trace) {
  const result = await runInconsistencyBuilder({
    debatePoints: state.debatePoints,
    claims: state.claims,
    existingInconsistencies: state.inconsistencies,
    trace
  });
  for (const cand of Array.isArray(result.inconsistencies) ? result.inconsistencies : []) {
    applyInconsistency(state, cand, trace);
  }
}

// Clerk: validate + dedup an inconsistency card.
function applyInconsistency(state, cand, trace) {
  const side = String(cand?.side || "").toLowerCase();
  const level = String(cand?.level || "").toLowerCase();
  const type = String(cand?.type || "").toLowerCase();
  const firstQuote = String(cand?.firstQuote || "").trim();
  const secondQuote = String(cand?.secondQuote || "").trim();
  const firstSpeakerId = String(cand?.firstSpeakerId || "").trim();
  const secondSpeakerId = String(cand?.secondSpeakerId || "").trim();

  if (side !== "blue" && side !== "red") return;
  if (!INCONSISTENCY_LEVELS.includes(level)) return;
  if (!INCONSISTENCY_TYPES.includes(type)) return;
  if (!firstQuote || !secondQuote) return;

  // Rule: self-contradiction must be speaker-level with the SAME speaker.
  if (type === "self-contradiction") {
    if (level !== "speaker") { logStep(trace, "Inconsistency:dropped", { reason: "self-contradiction-not-speaker-level" }); return; }
    if (firstSpeakerId && secondSpeakerId && firstSpeakerId !== secondSpeakerId) {
      logStep(trace, "Inconsistency:dropped", { reason: "self-contradiction-different-speakers" });
      return;
    }
  }
  // Rule: side-level needs two different speakers.
  if (level === "side" && firstSpeakerId && secondSpeakerId && firstSpeakerId === secondSpeakerId) {
    logStep(trace, "Inconsistency:dropped", { reason: "side-level-same-speaker" });
    return;
  }

  // Dedup by the quote pair (order-independent) on the same side.
  const dup = state.inconsistencies.find((x) => x.side === side
    && ((wordOverlapScore(x.firstQuote, firstQuote) >= 0.7 && wordOverlapScore(x.secondQuote, secondQuote) >= 0.7)
      || (wordOverlapScore(x.firstQuote, secondQuote) >= 0.7 && wordOverlapScore(x.secondQuote, firstQuote) >= 0.7)));
  if (dup) { logStep(trace, "Inconsistency:dropped", { reason: "duplicate", incId: dup.incId }); return; }

  const incId = `inc-${state.inconsistencies.length + 1}-${Math.abs(hashString(firstQuote + secondQuote)).toString(36).slice(0, 6)}`;
  state.inconsistencies.push({
    incId, side, level, type,
    firstSpeakerId, firstQuote,
    secondSpeakerId: secondSpeakerId || firstSpeakerId,
    secondQuote,
    why: String(cand?.why || "").trim(),
    confidence: Number(cand?.confidence || 0)
  });
  logStep(trace, "Inconsistency:added", { incId, side, level, type });
}

// Claim Builder per packet: extract checkable claims → dedup → enqueue.
async function runClaimsForPacket(state, packet, trace) {
  const result = await runClaimBuilder({
    dialogueWindows: [packet],
    speakers: state.speakers,
    existingClaims: state.claims,
    trace
  });
  for (const cand of Array.isArray(result.claims) ? result.claims : []) {
    applyClaim(state, cand, packet, trace);
  }
}

// Clerk: accept a claim card and queue it for checking.
function applyClaim(state, cand, packet, trace) {
  const speakerId = String(cand?.speakerId || "").trim();
  const claim = String(cand?.claim || "").trim();
  const quote = String(cand?.quote || "").trim();
  if (!speakerId || !claim || !quote) return;

  // Safety net: never fact-check a claim whose SUBJECT is a "Speaker N" placeholder
  // (a private statement about a participant). Searching "Speaker 2" is meaningless.
  if (/(^|\b)speaker\s*\d+\b/i.test(claim) || /(^|\b)speaker\s*\d+\b/i.test(String(cand?.searchQuery || ""))) {
    logStep(trace, "Claim:dropped", { reason: "speaker-placeholder-subject", speakerId });
    return;
  }

  const side = state.speakers[speakerId]?.side;
  if (side !== "blue" && side !== "red") {
    logStep(trace, "Claim:dropped", { reason: "speaker-not-sided", speakerId });
    return;
  }
  // Dedup by meaning on the same side.
  const dup = state.claims.find((c) => c.side === side && wordOverlapScore(c.claim, claim) >= 0.7 && wordOverlapScore(claim, c.claim) >= 0.7);
  if (dup) {
    logStep(trace, "Claim:dropped", { reason: "duplicate", claimId: dup.claimId });
    return;
  }

  const claimId = `cl-${state.claims.length + 1}-${Math.abs(hashString(claim)).toString(36).slice(0, 6)}`;
  state.claims.push({
    claimId,
    speakerId,
    side,
    claim,
    quote,
    searchQuery: String(cand?.searchQuery || claim).trim(),
    turnIds: Array.isArray(cand?.turnIds) ? cand.turnIds : [],
    status: "queued",   // queued -> checking -> done
    tag: null,
    why: "",
    sources: [],
    atSec: packet.startSec
  });
  state.factCheckQueue.push(claimId);
  logStep(trace, "Claim:added", { claimId, side });
}

// Drain the fact-check queues. TWO STAGES so "no clear source" never shows early:
//   Stage 1 (Firecrawl): settles most claims to a final tag; the rest move to deep check.
//   Stage 2 (Grounding): resolves deep-checking claims to a FINAL tag.
async function drainFactCheckQueue(state, trace) {
  // STAGE 1 — Firecrawl
  if (state.factCheckQueue.length) {
    const ids = state.factCheckQueue.splice(0, FACT_CHECK_BATCH_SIZE);
    const batch = ids.map((id) => state.claims.find((c) => c.claimId === id)).filter(Boolean);
    for (const c of batch) c.status = "checking";

    const results = await runFactCheckFirecrawl({ claims: batch, trace });
    for (const r of results) {
      const card = state.claims.find((c) => c.claimId === r.claimId);
      if (!card) continue;
      if (r.settled) {
        card.status = "done";
        card.tag = r.tag;            // verified | contradicted | misleading (final)
        card.why = r.why;
        card.sources = r.sources || [];
        card.checkedVia = r.via;
      } else {
        // Firecrawl couldn't settle it -> DEEP CHECKING (no tag yet, never "no source" prematurely).
        card.status = "deep_checking";
        card.sources = r.sources || card.sources || []; // keep any sources found for later display
        state.deepCheckQueue.push(card.claimId);
      }
    }
  }

  // STAGE 2 — Gemini grounding for deep-checking claims
  if (state.deepCheckQueue.length) {
    const ids = state.deepCheckQueue.splice(0, FACT_CHECK_BATCH_SIZE);
    const batch = ids.map((id) => state.claims.find((c) => c.claimId === id)).filter(Boolean);
    const results = await runDeepCheck({ claims: batch, trace });
    for (const r of results) {
      const card = state.claims.find((c) => c.claimId === r.claimId);
      if (!card) continue;
      card.status = "done";
      card.tag = r.tag;              // verified | contradicted | misleading | no_clear_source (final)
      card.why = r.why;
      card.sources = r.sources || card.sources || [];
      card.checkedVia = r.via;
    }
  }
}

// Debate Point Builder per packet: extract → dedup/strengthen → store cards.
async function runDebatePointsForPacket(state, packet, trace) {
  const result = await runDebatePointBuilder({
    dialogueWindows: [packet],
    speakers: state.speakers,
    existingPoints: state.debatePoints,
    trace
  });
  for (const cand of Array.isArray(result.points) ? result.points : []) {
    applyDebatePoint(state, cand, packet, trace);
  }
}

// Clerk rules for accepting / updating a debate point card.
function applyDebatePoint(state, cand, packet, trace) {
  const speakerId = String(cand?.speakerId || "").trim();
  const tag = String(cand?.tag || "").toLowerCase();
  const point = String(cand?.point || "").trim();
  const quote = String(cand?.quote || "").trim();
  if (!speakerId || !point || !quote) return;

  // Only assigned blue/red speakers produce points.
  const side = state.speakers[speakerId]?.side;
  if (side !== "blue" && side !== "red") {
    logStep(trace, "DebatePoint:dropped", { reason: "speaker-not-sided", speakerId });
    return;
  }
  if (!DEBATE_POINT_TAGS.includes(tag)) {
    logStep(trace, "DebatePoint:dropped", { reason: "bad-tag", tag, speakerId });
    return;
  }
  // Rebuttal MUST carry the opposing quote (so the card can prove itself).
  const opposingQuote = String(cand?.opposingQuote || "").trim();
  if (tag === "rebuttal" && !opposingQuote) {
    logStep(trace, "DebatePoint:dropped", { reason: "rebuttal-without-opposing-quote", speakerId });
    return;
  }

  const card = {
    speakerId,
    side,
    point,
    quote,
    turnIds: Array.isArray(cand?.turnIds) ? cand.turnIds : [],
    tag,
    opposingQuote: tag === "rebuttal" || tag === "hypothetical" ? opposingQuote : "",
    opposingSpeakerId: (tag === "rebuttal" || tag === "hypothetical") ? String(cand?.opposingSpeakerId || "").trim() : "",
    reason: String(cand?.reason || "").trim(),
    confidence: Number(cand?.confidence || 0),
    atSec: packet.startSec
  };

  // STRENGTHEN: if the model says this updates an existing card, replace in place
  // (keeps the board clean — no duplicate). Keep the original id + family.
  const updatesId = String(cand?.updatesPointId || "").trim();
  if (updatesId) {
    const existing = state.debatePoints.find((p) => p.pointId === updatesId && p.side === side);
    if (existing) {
      Object.assign(existing, card, { pointId: existing.pointId, familyId: existing.familyId });
      logStep(trace, "DebatePoint:strengthened", { pointId: existing.pointId, tag });
      return;
    }
  }

  // DEDUP guard (plain code, in addition to the model's own dedup): skip if a very
  // similar point already exists on the SAME side.
  const dup = state.debatePoints.find((p) => p.side === side && wordOverlapScore(p.point, point) >= 0.7 && wordOverlapScore(point, p.point) >= 0.7);
  if (dup) {
    logStep(trace, "DebatePoint:dropped", { reason: "duplicate", pointId: dup.pointId });
    return;
  }

  card.pointId = `dp-${state.debatePoints.length + 1}-${Math.abs(hashString(point)).toString(36).slice(0, 6)}`;
  card.familyId = null; // assigned later by the Family Merger; floats until then
  state.debatePoints.push(card);
  logStep(trace, "DebatePoint:added", { pointId: card.pointId, side, tag });
}

// Family Merger for both sides (sticky — reuse existing families).
async function runFamilyMergerForBothSides(state, trace) {
  for (const side of ["blue", "red"]) {
    const sidePoints = state.debatePoints.filter((p) => p.side === side);
    if (!sidePoints.length) continue;
    const result = await runFamilyMerger({
      side,
      points: sidePoints,
      existingFamilies: state.families[side],
      trace
    });
    applyFamilies(state, side, result.families, trace);
  }
}

// Clerk: apply family assignments, enforcing stickiness (don't churn titles).
function applyFamilies(state, side, families, trace) {
  if (!Array.isArray(families)) return;
  const prev = state.families[side] || [];
  const prevById = new Map(prev.map((f) => [f.familyId, f]));
  const next = [];
  const validPointIds = new Set(state.debatePoints.filter((p) => p.side === side).map((p) => p.pointId));

  for (const fam of families) {
    const familyId = String(fam?.familyId || "").trim();
    const incomingTitle = String(fam?.title || "").trim();
    const pointIds = (Array.isArray(fam?.pointIds) ? fam.pointIds : []).filter((id) => validPointIds.has(id));
    if (!familyId || !pointIds.length) continue;

    const existing = prevById.get(familyId);
    // STICKY TITLE: keep the old title unless it changed MEANINGFULLY (not cosmetic).
    let title = incomingTitle || existing?.title || "Untitled";
    if (existing && incomingTitle) {
      const sim = Math.min(wordOverlapScore(existing.title, incomingTitle), wordOverlapScore(incomingTitle, existing.title));
      if (sim >= 0.5) title = existing.title; // basically the same theme → keep old title
    }
    next.push({ familyId, title, pointIds });
  }

  state.families[side] = next;
  // Stamp familyId back onto each point so cards know their envelope.
  const pointToFamily = new Map();
  for (const fam of next) for (const id of fam.pointIds) pointToFamily.set(id, fam.familyId);
  for (const p of state.debatePoints) if (p.side === side) p.familyId = pointToFamily.get(p.pointId) || null;
  logStep(trace, "FamilyMerger:applied", { side, families: next.length });
}

// Small stable string hash for point ids.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

// Pull the most recent pre-debate lines (for gate backtrack lookback).
function recentPreDebateLines(state, limit = 40) {
  const lines = [];
  for (const p of state.preDebatePackets) {
    for (const t of p.turns || []) lines.push({ speakerId: t.speakerId, text: t.text, startSec: t.startSec });
  }
  return lines.slice(-limit);
}

// Word-overlap score between two strings (0..1) — tolerant of small phrasing/STT
// differences so the backtrack match does not require an exact substring.
function wordOverlapScore(a, b) {
  const tokenize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const qa = tokenize(a);
  const qb = new Set(tokenize(b));
  if (!qa.length) return 0;
  let hits = 0;
  for (const w of qa) if (qb.has(w)) hits += 1;
  return hits / qa.length;
}

// Replay kept pre-debate packets from the true-start line into Side Builder.
async function catchUpFromRealStart(state, realStartQuote, trace) {
  if (!state.preDebatePackets.length) return state.gateOpenedAtSec;
  const quote = String(realStartQuote || "").trim();

  // Find which pre-debate packet contains the real-start line. Try exact substring
  // first, then fall back to fuzzy word-overlap (>=0.6 of the quote's words present
  // in a turn) so slight STT phrasing differences still locate the start.
  let startIdx = -1;
  if (quote) {
    const needle = quote.toLowerCase().slice(0, 40);
    for (let i = 0; i < state.preDebatePackets.length; i += 1) {
      const hit = (state.preDebatePackets[i].turns || []).some((t) => String(t.text || "").toLowerCase().includes(needle));
      if (hit) { startIdx = i; break; }
    }
    if (startIdx === -1) {
      let bestScore = 0;
      for (let i = 0; i < state.preDebatePackets.length; i += 1) {
        for (const t of state.preDebatePackets[i].turns || []) {
          const score = wordOverlapScore(quote, t.text);
          if (score > bestScore) { bestScore = score; if (score >= 0.6) startIdx = i; }
        }
        if (startIdx !== -1) break;
      }
      if (startIdx !== -1) logStep(trace, "Pipeline:backtrack-fuzzy-match", { bestScore: Number(bestScore.toFixed(2)) });
    }
  }
  if (startIdx === -1) {
    logStep(trace, "Pipeline:backtrack-skipped", { reason: quote ? "real-start-not-found" : "no-real-start-quote" });
    return state.gateOpenedAtSec;
  }

  const rewound = state.preDebatePackets.slice(startIdx);
  const rewoundFromSec = rewound[0]?.startSec ?? state.gateOpenedAtSec;
  logStep(trace, "Pipeline:backtrack", { fromSec: rewoundFromSec, openedAtSec: state.gateOpenedAtSec, packets: rewound.length });

  for (const p of rewound) {
    state.ledger.push(p);
    await runSideBuilderForPacket(state, p, trace);
  }
  return rewoundFromSec;
}

// Run Side Builder on one packet and apply its judgment (shared by normal + catch-up).
async function runSideBuilderForPacket(state, packet, trace) {
  const sideResult = await runSideBuilder({
    dialogueWindows: [packet],
    context: {
      ledger: state.ledger,
      topic: state.topic,
      sides: state.sides,
      speakers: state.speakers
    },
    trace
  });
  applySideBuilderResult(state, sideResult);
}

// How similar (0..1) two thesis/position strings are by shared words. Above the
// threshold we treat a new version as "just reworded" and DON'T update the UI,
// so the displayed thesis only changes when its MEANING meaningfully shifts.
// This kills the per-packet "shimmer" where wording changed but the point didn't.
const THESIS_STABLE_SIMILARITY = 0.8;

function meaningfullyDifferent(current, next) {
  const cur = String(current || "").trim();
  const nxt = String(next || "").trim();
  if (!nxt) return false;        // nothing new to show
  if (!cur) return true;         // first time we have one — always set it
  if (cur === nxt) return false; // identical
  // Symmetric overlap so neither growing nor shrinking text fools the check.
  const sim = Math.min(wordOverlapScore(cur, nxt), wordOverlapScore(nxt, cur));
  return sim < THESIS_STABLE_SIMILARITY;
}

// --- Apply Side Builder's judgment under the clerk rules ----------------------
function applySideBuilderResult(state, result = {}) {
  // Topic can change when the debate moves to a new subject (not just set once).
  if (meaningfullyDifferent(state.topic, result.topic)) state.topic = result.topic;
  // Only fill a side that an actual speaker has taken (node already leaves empty
  // sides blank; we just never blank out something we already have).
  // Position + thesis update ONLY when meaningfully different — not on rewording.
  if (meaningfullyDifferent(state.sides.blue.position, result.bluePosition)) state.sides.blue.position = result.bluePosition;
  if (meaningfullyDifferent(state.sides.red.position, result.redPosition)) state.sides.red.position = result.redPosition;
  if (meaningfullyDifferent(state.sides.blue.thesis, result.blueThesis)) state.sides.blue.thesis = result.blueThesis;
  if (meaningfullyDifferent(state.sides.red.thesis, result.redThesis)) state.sides.red.thesis = result.redThesis;

  for (const proposal of Array.isArray(result.speakers) ? result.speakers : []) {
    if (!acceptSpeakerAssignment(state, proposal)) continue;
    state.speakers[proposal.speakerId] = {
      side: String(proposal.side).toLowerCase(),
      confidence: Number(proposal.confidence || 0),
      reason: proposal.reason || "",
      evidenceQuote: proposal.evidenceQuote || ""
    };
  }
}

// --- Run a whole list of turns end-to-end ------------------------------------
export async function runPipelineOverTurns(turns, { trace = null, onPacket = null } = {}) {
  const state = createPipelineState();
  const packets = groupTurnsIntoPackets(turns);
  for (let i = 0; i < packets.length; i += 1) {
    await runPacket(state, packets[i], { trace, nextPacket: packets[i + 1] || null });
    if (onPacket) onPacket(i, packets[i], state);
  }
  return { state, packetCount: packets.length };
}
