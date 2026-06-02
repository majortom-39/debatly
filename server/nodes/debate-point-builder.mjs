// =============================================================================
// nodes/debate-point-builder.mjs  —  THE DEBATE POINT BUILDER NODE
// =============================================================================
//
// JOB (one job):
//   Read the side-sorted dialogue and extract DURABLE DEBATE POINTS — the real
//   arguments each speaker advances FOR or AGAINST the debate. Output clean cards.
//
// WHAT A GOOD DEBATE POINT IS:
//   • A claim with a STANCE (asserts something true/false or should/shouldn't).
//   • LOAD-BEARING — it actually moves the speaker's side's case.
//   • SELF-CONTAINED — a viewer reading just the card understands it.
//
// OWNERSHIP — the hard, intelligent part:
//   Only the speaker's OWN advanced points count. If a speaker REPEATS the
//   opponent's point to mock it, question it, or attack it, that is NOT their
//   point — it is a rebuttal of the opponent. The model must judge intent, since
//   the transcript carries no tone.
//
// DEDUP (meaning, not words):
//   Read the running ledger. Skip a candidate if the same argument is already on
//   the board, even in different words. If a point gets STRONGER later (e.g. a
//   source is attached), UPDATE the existing card via updatesPointId — do not add
//   a duplicate.
//
// TYPE TAGS (what KIND of move the point is):
//   foundation  — defines a term / sets a framework
//   evidence    — cites a fact, number, source, study
//   rebuttal    — directly attacks the other side's point  (ALWAYS carries the opposing quote)
//   principle   — a moral / values argument
//   precedent   — a historical or legal parallel
//   hypothetical— an "if X then Y" scenario  (carries opposing quote ONLY if responding to a specific opposing line)
//
// CARD SHAPE (lean — no redundant family/side label; UI already groups by those):
//   { pointId, speakerId, point, quote, turnIds, tag, reason, confidence,
//     opposingQuote, opposingSpeakerId,    // present for rebuttal (always) / hypothetical (when responding)
//     updatesPointId }                      // set when this strengthens an existing card
//
// This node is a PURE BRAIN. The pipeline/clerk decides what to keep, applies the
// meaningful-change rule, and assigns families (Family Merger, a separate node).
// =============================================================================

import { runAgent, stringifyAgentContext, NODE_THINKING_LEVEL } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";

export const DEBATE_POINT_TAGS = ["foundation", "evidence", "rebuttal", "principle", "precedent", "hypothetical"];

const DEBATE_POINT_PROMPT = [
  "You are debatly's Debate Point Builder, analyzing an ongoing LIVE debate one packet at a time.",
  "",
  "YOUR ONLY JOB: extract DURABLE DEBATE POINTS — the real arguments each assigned speaker advances FOR or AGAINST the debate — as clean cards.",
  "Do NOT create fact-check cards, clash cards, inconsistency cards, scores, families, or report prose. Those are other nodes' jobs.",
  "",
  "WHAT QUALIFIES AS A DEBATE POINT:",
  "- It takes a STANCE: asserts something is true/false, or should/should not happen.",
  "- It is LOAD-BEARING: it actually advances the speaker's side's case (not filler, not procedure).",
  "- It is SELF-CONTAINED: a viewer reading only this card understands the argument.",
  "",
  "OWNERSHIP — JUDGE INTENT CAREFULLY (the transcript has NO tone, so you must infer):",
  "- Only output a point when the speaker is advancing it AS THEIR OWN argument.",
  "- If a speaker repeats, echoes, or paraphrases the OPPONENT's point in order to MOCK it, question it, or attack it, that is NOT their point. Either output it as a 'rebuttal' (their counter to it) or skip it — never credit the opponent's argument to them.",
  "- A question is not a point unless the speaker embeds their own proposition inside it; if so, rewrite that proposition as the point.",
  "",
  "DEDUP BY MEANING, NOT WORDS (use the existing ledger):",
  "- Skip a candidate if the SAME argument is already on the board, even if worded differently.",
  "- If this packet makes an existing point STRONGER (adds a source, number, named example, sharper framing), do NOT add a new card — instead set updatesPointId to that existing point's id and return the improved version.",
  "- A side may legitimately make several DISTINCT points in one monologue — split a dense opening into its separate load-bearing points (a definition, a named precedent, a statistic, a policy, a rebuttal) rather than collapsing them into one.",
  "",
  "TYPE TAG — choose exactly one per point:",
  '  "foundation"   — defines a term or sets a framework.',
  '  "evidence"     — cites a fact, number, named source, study, report, or quote.',
  '  "rebuttal"     — directly attacks or refutes the other side\'s point.',
  '  "principle"    — a moral or values-based argument.',
  '  "precedent"    — a historical or legal parallel.',
  '  "hypothetical" — an "if X then Y" scenario.',
  "",
  "OPPOSING QUOTE (so a card can prove itself):",
  "- For EVERY \"rebuttal\": you MUST include opposingQuote (the exact opposing line being refuted) and opposingSpeakerId. If you cannot find the specific line it rebuts, it is not really a rebuttal — retag it.",
  "- For \"hypothetical\": include opposingQuote + opposingSpeakerId ONLY if the hypothetical is clearly responding to a specific opposing line. If it is a standalone 'what if', leave them empty.",
  "- For all other tags: leave opposingQuote and opposingSpeakerId empty.",
  "",
  "STRICT EXCLUSIONS — never output:",
  "- Moderator / host / interviewer talk, greetings, procedural lines, jokes, filler, partial fragments.",
  "- Ads, sponsor reads, product promotion, brand mentions, promo codes, commercial breaks.",
  "- Pure concessions ('fair enough'), pure emotion, motive guesses, personality/sincerity attacks.",
  "- Points from a speaker not assigned to Blue side or Red side.",
  "",
  "WRITING THE CARD:",
  "- point: one clean, standalone proposition in plain English. NOT 'Speaker says...', NOT 'the Blue side...'. State the argument itself.",
  "- quote: an EXACT line from that same speaker that supports the point.",
  "- Stay faithful to the quote — add no facts, names, or logic the speaker did not say.",
  "- A packet may legitimately produce ZERO new points. Prefer zero over filler or repeats.",
  "",
  "OUTPUT — STRICT JSON ONLY:",
  "{",
  '  "points": [{',
  '    "speakerId": "Speaker 1",',
  '    "point": "one complete standalone debate point",',
  '    "quote": "exact supporting quote from that speaker",',
  '    "turnIds": ["turn id"],',
  '    "tag": "foundation|evidence|rebuttal|principle|precedent|hypothetical",',
  '    "opposingQuote": "exact opposing line (rebuttal: required; hypothetical: if responding; else empty)",',
  '    "opposingSpeakerId": "Speaker 2 or empty",',
  '    "updatesPointId": "existing point id this strengthens, or empty",',
  '    "reason": "why this is a real, load-bearing debate point",',
  '    "confidence": 0.0',
  "  }]",
  "}"
].join("\n");

/**
 * Run the Debate Point Builder node.
 * @param {object[]} dialogueWindows  the current packet(s) of side-sorted dialogue
 * @param {object}   speakers         speakerId -> { side } map (only blue/red speakers count)
 * @param {object[]} existingPoints   the running debate-point ledger (for dedup / strengthen)
 * @param {string}   thinkingLevel    defaults to project-wide "medium"
 * @param {object}   trace            flight recorder (optional)
 * @returns parsed JSON { points: [...] } (or {} if nothing usable)
 */
export async function runDebatePointBuilder({
  dialogueWindows = [],
  speakers = {},
  existingPoints = [],
  thinkingLevel = NODE_THINKING_LEVEL,
  trace = null
} = {}) {
  if (!Array.isArray(dialogueWindows) || dialogueWindows.length === 0) {
    logStep(trace, "DebatePointBuilder:skipped", { reason: "no-dialogue-window" });
    return { points: [] };
  }

  // Compact the ledger so the model can dedup / strengthen against it cheaply.
  const ledger = (Array.isArray(existingPoints) ? existingPoints : []).map((p) => ({
    pointId: p.pointId,
    speakerId: p.speakerId,
    side: p.side,
    point: p.point,
    tag: p.tag
  }));

  const routedContext = { speakers, existingPoints: ledger, dialogueWindows };
  const prompt = `${DEBATE_POINT_PROMPT}\n\nRouted context for Debate Point Builder: ${stringifyAgentContext(routedContext)}`;

  const { json } = await runAgent({
    agent: "Debate Point Builder",
    prompt,
    thinkingLevel,
    responseMimeType: "application/json",
    maxOutputTokens: 4000,
    timeoutMs: 34000,
    trace,
    meta: { windows: dialogueWindows.length, ledgerPoints: ledger.length }
  });

  return json && Array.isArray(json.points) ? json : { points: [] };
}
