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
import { createTrace } from "./shared/trace.mjs";

export function createLiveAnalysisState() {
  const state = createPipelineState();
  state.processedPacketCount = 0;
  return state;
}

// Process any newly-settled packets from the session's accumulated turns.
// allTurns: [{ id, speakerId, text, startSec, endSec }] (final turns only).
// flush=true (on stop) also processes the last, still-filling packet.
export async function analyzeLive(state, allTurns, { flush = false, trace = null } = {}) {
  const packets = groupTurnsIntoPackets(allTurns);
  // Keep the last packet "open" while live (still filling); process it only on flush.
  const lastProcessable = flush ? packets.length : Math.max(0, packets.length - 1);

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
    counts: {
      debatePoints: state.debatePoints.length,
      claims: state.claims.length,
      inconsistencies: state.inconsistencies.length
    }
  };
}
