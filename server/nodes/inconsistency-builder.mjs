// =============================================================================
// nodes/inconsistency-builder.mjs  —  THE INCONSISTENCY BUILDER NODE
// =============================================================================
//
// JOB (one job):
//   Find clear contradictions / double standards / hypocrisy and produce cards.
//   It reads the DEBATE-POINT ledger + the CLAIMS ledger (NOT raw dialogue), and
//   compares the NEWEST positions against the full accumulated ledger of the same
//   speaker / side.
//
// THE THREE TYPES (the "type" IS the card's tag — no separate tag system):
//   self-contradiction — same SPEAKER asserts two things that can't both be true.
//                        (speaker-level ONLY — one person vs themselves.)
//   double-standard    — applies a rule to one side but the opposite rule to the
//                        other on the SAME issue. (speaker-level OR side-level.)
//   hypocrisy          — a stated value clashes with what is defended/done.
//                        (speaker-level OR side-level.)
//
// LEVEL (separate field from type):
//   speaker — both clashing statements come from the SAME speaker.
//   side    — the two statements come from DIFFERENT speakers on the SAME side
//             (only valid for double-standard / hypocrisy, never self-contradiction).
//
// JUBILEE GUARD: in rotating formats the same side = many different people who may
//   simply DISAGREE with each other. That is NOT a side-level inconsistency. Only
//   flag side-level when the side applies an INCOMPATIBLE STANDARD on the same
//   issue — not mere difference in emphasis or opinion.
//
// STRICT BY DESIGN: inconsistencies must be RARE. Only flag clear, undeniable
//   contradictions. A wrong "gotcha" hurts credibility more than a missed one.
//   Most runs return zero. If two statements CAN both be true under one reading
//   (nuance, clarification, narrowing, different topic), DO NOT flag.
//
// PURE BRAIN. The pipeline/clerk stores cards (deduped) under the offending side.
//
// OUTPUT (parsed JSON):
//   { inconsistencies: [ {
//       side, level, type,
//       firstQuote, firstSpeakerId,
//       secondQuote, secondSpeakerId,
//       why, confidence
//   } ] }
// =============================================================================

import { runAgent, stringifyAgentContext, NODE_THINKING_LEVEL } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";

export const INCONSISTENCY_TYPES = ["self-contradiction", "double-standard", "hypocrisy"];
export const INCONSISTENCY_LEVELS = ["speaker", "side"];

const INCONSISTENCY_PROMPT = [
  "You are debatly's Inconsistency Finder, watching an ongoing LIVE debate.",
  "",
  "YOUR ONLY JOB: find CLEAR contradictions, double standards, or hypocrisy, by comparing the NEW debate points/claims against the FULL accumulated ledger of the same speaker or side.",
  "You read ONLY debate points and claims (already clean, owned positions). You do NOT read raw transcript.",
  "Do NOT produce debate points, claims, fact checks, or scores.",
  "",
  "THE THREE TYPES (this 'type' IS the card's tag):",
  '- "self-contradiction": the SAME speaker asserts two things that cannot both be true. (speaker-level ONLY.)',
  '- "double-standard": applies one rule to one side but the opposite rule to the other on the SAME issue. (speaker OR side level.)',
  '- "hypocrisy": a stated value/principle clashes with what the speaker/side defends or excuses. (speaker OR side level.)',
  "",
  "LEVEL (separate from type):",
  '- "speaker": both clashing statements are from the SAME speaker.',
  '- "side": the two statements are from DIFFERENT speakers on the SAME side. Valid ONLY for double-standard or hypocrisy — NEVER for self-contradiction.',
  "",
  "JUBILEE / ROTATING-FORMAT GUARD (critical):",
  "- In many debates one side = several DIFFERENT people. Different people on the same side simply DISAGREEING is NORMAL and is NOT an inconsistency.",
  "- Only flag a side-level inconsistency when the side applies an INCOMPATIBLE STANDARD on the SAME issue — not mere difference of emphasis, detail, or opinion.",
  "",
  "BE STRICT — inconsistencies must be RARE:",
  "- Only flag clear, undeniable contradictions. Most runs should return ZERO.",
  "- If the two statements CAN both be true under one reasonable reading (nuance, clarification, narrowing scope, a different topic, added detail), DO NOT flag.",
  "- Require TWO concrete positions that genuinely conflict. Quote BOTH exactly.",
  "- A side disagreeing with the OTHER side is a clash, NOT an inconsistency — never flag cross-side disagreement.",
  "- Do not flag a speaker for refining, conceding, or adding nuance to their own earlier point.",
  "",
  "OUTPUT — STRICT JSON ONLY:",
  "{",
  '  "inconsistencies": [{',
  '    "side": "blue|red",',
  '    "level": "speaker|side",',
  '    "type": "self-contradiction|double-standard|hypocrisy",',
  '    "firstSpeakerId": "Speaker 1",',
  '    "firstQuote": "exact earlier statement",',
  '    "secondSpeakerId": "Speaker 1 (same as first for speaker-level)",',
  '    "secondQuote": "exact later conflicting statement",',
  '    "why": "one clear plain-English sentence on why these conflict",',
  '    "confidence": 0.0',
  "  }]",
  "}"
].join("\n");

/**
 * Run the Inconsistency Finder.
 * @param {object[]} debatePoints   the full debate-point ledger { pointId, speakerId, side, point, quote, tag }
 * @param {object[]} claims         the full claims ledger { claimId, speakerId, side, claim, quote }
 * @param {object[]} existingInconsistencies  current cards (for dedup)
 * @param {string}   thinkingLevel  defaults to "medium"
 * @param {object}   trace
 * @returns parsed JSON { inconsistencies: [...] }
 */
export async function runInconsistencyBuilder({
  debatePoints = [],
  claims = [],
  existingInconsistencies = [],
  thinkingLevel = NODE_THINKING_LEVEL,
  trace = null
} = {}) {
  const points = Array.isArray(debatePoints) ? debatePoints : [];
  const claimList = Array.isArray(claims) ? claims : [];
  if (points.length + claimList.length < 2) {
    logStep(trace, "InconsistencyBuilder:skipped", { reason: "not-enough-positions" });
    return { inconsistencies: [] };
  }

  const compactPoints = points.map((p) => ({ speakerId: p.speakerId, side: p.side, statement: p.point, quote: p.quote }));
  const compactClaims = claimList.map((c) => ({ speakerId: c.speakerId, side: c.side, statement: c.claim, quote: c.quote }));
  const existing = (Array.isArray(existingInconsistencies) ? existingInconsistencies : []).map((x) => ({
    side: x.side, type: x.type, level: x.level, firstQuote: x.firstQuote, secondQuote: x.secondQuote
  }));

  const routedContext = { debatePoints: compactPoints, claims: compactClaims, existingInconsistencies: existing };
  const prompt = `${INCONSISTENCY_PROMPT}\n\nRouted context for Inconsistency Finder: ${stringifyAgentContext(routedContext)}`;

  const { json } = await runAgent({
    agent: "Inconsistency Finder",
    prompt,
    thinkingLevel,
    responseMimeType: "application/json",
    maxOutputTokens: 2500,
    timeoutMs: 30000,
    trace,
    meta: { points: compactPoints.length, claims: compactClaims.length, existing: existing.length }
  });

  return json && Array.isArray(json.inconsistencies) ? json : { inconsistencies: [] };
}
