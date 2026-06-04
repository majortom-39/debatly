// =============================================================================
// live-runner.mjs  —  bridges the clean node pipeline to the LIVE session.
// =============================================================================
//
// The Speechmatics/WebSocket/audio plumbing stays in index.mjs (it works). This
// module owns ONLY the analysis: it takes the session's accumulated final turns,
// runs them through pipeline.mjs (gate → side builder → points/claims/incons →
// fact-check → scoring), and produces ONE clean payload for the frontend.
//
// Live vs replay: turns arrive incrementally. We regroup ALL turns into 60s
// packets each tick and process any packet that has become "settled" (its time
// window is fully in the past), keeping a cursor so we never reprocess. On stop
// we flush the final partial packet.
// =============================================================================

import { createPipelineState, runPacket, groupTurnsIntoPackets, PACKET_SECONDS } from "./pipeline.mjs";
import { explainScore } from "./nodes/scoring-engine.mjs";
import { runSpeakerReconciler } from "./nodes/speaker-reconciler.mjs";
import { createTrace } from "./shared/trace.mjs";

// Conservative LLM speaker-label correction (see nodes/speaker-reconciler.mjs).
// Set RECONCILE_SPEAKERS=false to disable instantly.
const RECONCILE_SPEAKERS = String(process.env.RECONCILE_SPEAKERS || "true").toLowerCase() !== "false";
const RECONCILE_WINDOW_TURNS = 60; // how many recent turns the reconciler looks at

export function createLiveAnalysisState() {
  const state = createPipelineState();
  state.processedPacketCount = 0;
  state.speakerCorrections = {}; // turnId -> corrected speaker label
  return state;
}

// Rewrite each turn's speaker to its corrected label (if any), keeping the
// original on rawSpeakerId so the UI can show the strike-through.
function applySpeakerCorrections(state, turns) {
  const map = state.speakerCorrections || {};
  return (turns || []).map((t) => {
    const corrected = map[t.id];
    return corrected && corrected !== t.speakerId
      ? { ...t, speakerId: corrected, rawSpeakerId: t.speakerId }
      : t;
  });
}

// Ask the reconciler about the recent window and merge any high-confidence
// corrections into the running map.
async function reconcileSpeakers(state, allTurns, trace) {
  const recent = (allTurns || []).slice(-RECONCILE_WINDOW_TURNS).map((t) => ({
    id: t.id,
    speaker: state.speakerCorrections?.[t.id] || t.speakerId, // current best label
    text: t.text
  }));
  const { corrections } = await runSpeakerReconciler({ turns: recent, trace }).catch(() => ({ corrections: [] }));
  for (const c of corrections) state.speakerCorrections[c.turnId] = c.correctedSpeaker;
}

// Process any newly-settled packets from the session's accumulated turns.
// allTurns: [{ id, speakerId, text, startSec, endSec }] (final turns only).
// flush=true (on stop) also processes the last, still-filling packet.
export async function analyzeLive(state, allTurns, { flush = false, trace = null } = {}) {
  if (!state.speakerCorrections) state.speakerCorrections = {};
  const rawPackets = groupTurnsIntoPackets(allTurns);
  const lastProcessable = flush ? rawPackets.length : Math.max(0, rawPackets.length - 1);
  const hasNewSettled = lastProcessable > state.processedPacketCount;

  // Discover speaker corrections only when new audio has settled (bounds cost to
  // ~one extra call per packet), then apply them so EVERY downstream node and the
  // artifacts use the corrected speaker labels.
  if (RECONCILE_SPEAKERS && (hasNewSettled || flush)) {
    await reconcileSpeakers(state, allTurns, trace || createTrace("live"));
  }
  const corrected = RECONCILE_SPEAKERS ? applySpeakerCorrections(state, allTurns) : allTurns;
  const packets = groupTurnsIntoPackets(corrected);

  for (let i = state.processedPacketCount; i < lastProcessable; i += 1) {
    await runPacket(state, packets[i], { trace: trace || createTrace("live"), nextPacket: packets[i + 1] || null });
    state.processedPacketCount = i + 1;
  }
  return buildLivePayload(state);
}

// The ONE clean shape the frontend consumes. No old-architecture fields.
export function buildLivePayload(state) {
  const blue = state.scores?.blue;
  const red = state.scores?.red;

  const sideView = (sideKey, sideScore) => ({
    position: state.sides[sideKey].position || "",
    thesis: state.sides[sideKey].thesis || "",
    score: sideScore ? sideScore.score : 0,
    breakdown: sideScore ? sideScore.breakdown : null,
    points: sideScore ? sideScore.points : null,
    explanation: sideScore ? explainScore(sideScore) : "",
    speakers: sideScore ? sideScore.speakers : {}
  });

  // Debate points per side, each tagged with its family (envelope) id+title.
  const familyTitle = (sideKey, familyId) =>
    (state.families[sideKey].find((f) => f.familyId === familyId) || {}).title || "";

  const pointsForSide = (sideKey) => state.debatePoints
    .filter((p) => p.side === sideKey)
    .map((p) => ({
      id: p.pointId, speakerId: p.speakerId, point: p.point, quote: p.quote,
      tag: p.tag, familyId: p.familyId, familyTitle: familyTitle(sideKey, p.familyId),
      opposingQuote: p.opposingQuote || "", opposingSpeakerId: p.opposingSpeakerId || ""
    }));

  const claimsForSide = (sideKey) => state.claims
    .filter((c) => c.side === sideKey)
    .map((c) => ({
      id: c.claimId, speakerId: c.speakerId, claim: c.claim, quote: c.quote,
      status: c.status, tag: c.tag, why: c.why, sources: c.sources || []
    }));

  const inconsForSide = (sideKey) => state.inconsistencies
    .filter((x) => x.side === sideKey)
    .map((x) => ({
      id: x.incId, type: x.type, level: x.level, why: x.why,
      firstSpeakerId: x.firstSpeakerId, firstQuote: x.firstQuote,
      secondSpeakerId: x.secondSpeakerId, secondQuote: x.secondQuote
    }));

  return {
    topic: state.topic || "",
    gateOpen: state.gateOpen,
    sides: {
      blue: {
        ...sideView("blue", blue),
        families: state.families.blue,
        debatePoints: pointsForSide("blue"),
        claims: claimsForSide("blue"),
        inconsistencies: inconsForSide("blue")
      },
      red: {
        ...sideView("red", red),
        families: state.families.red,
        debatePoints: pointsForSide("red"),
        claims: claimsForSide("red"),
        inconsistencies: inconsForSide("red")
      }
    },
    speakers: state.speakers,
    scoreTimeline: state.scoreTimeline || [],
    speakerCorrections: state.speakerCorrections || {},
    counts: {
      debatePoints: state.debatePoints.length,
      claims: state.claims.length,
      inconsistencies: state.inconsistencies.length
    }
  };
}
