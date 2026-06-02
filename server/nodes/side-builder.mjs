// =============================================================================
// nodes/side-builder.mjs  —  THE SIDE BUILDER NODE
// =============================================================================
//
// JOB (one job):
//   Read the diarized dialogue (after the gate has opened) and:
//     1. Sort speakers into two sides: Blue side and Red side.
//     2. Maintain a short, neutral topic.
//     3. Maintain each side's POSITION and a slightly fuller THESIS — but only
//        for a side that an actual speaker has filled. Never invent the empty
//        side's position/thesis before a real speaker takes it.
//
//   It does NOT extract claims, clashes, inconsistencies, sources, or scores.
//
// IMPORTANT — this node is a PURE BRAIN:
//   It only reads and returns its judgment. It does NOT save anything to the
//   debate's running memory. A separate plain-code "wiring" step inspects this
//   output against fixed rules (confidence cutoffs, evidence present, don't
//   overwrite a strong existing assignment) and decides what to actually keep.
//
// SIDE LABELS — de-politicized on purpose:
//   "Blue" and "Red" are just neutral on-screen colors for "first side" and
//   "second side". They carry NO political meaning. The prompt enforces this so
//   a political interview never biases the model.
//
// FIRST-SPEAKER RULE:
//   The first speaker who clearly takes/affirms a position = Blue side.
//   The side that forms in opposition = Red side.
//
// MEMORY:
//   The pipeline passes the full running ledger (every prior packet's dialogue +
//   the current side map + speaker history) in `context`. The node reads all of
//   it so it has continuity across the whole debate, not just this 30s packet.
//   (No summarization yet — we optimize cost/latency later.)
//
// OUTPUT (parsed JSON):
//   {
//     topic, bluePosition, redPosition, blueThesis, redThesis,
//     speakers[]:      { speakerId, side, confidence, reason, evidenceQuote },
//     speakerMemory[]: { speakerId, likelySide, confidence, stanceSummary, supportingEvidence[] }
//   }
// =============================================================================

import { runAgent, stringifyAgentContext, NODE_THINKING_LEVEL } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";

// --- The Side Builder's instructions (its "intelligence" lives here) ----------
const SIDE_BUILDER_PROMPT = [
  "You are debatly's Side Builder, analyzing an ONGOING LIVE debate one 30-second packet at a time.",
  "",
  "YOUR ONLY JOB:",
  "Maintain the debate setup as it unfolds: a neutral topic, a durable speaker-to-side map, and each side's position + thesis.",
  "Do NOT extract claim cards, clashes, inconsistencies, fact checks, scores, key moments, or report prose. Those are other nodes' jobs.",
  "",
  "THE TWO SIDES — READ THIS CAREFULLY:",
  "- There are exactly two sides: \"blue\" and \"red\". These are NEUTRAL ON-SCREEN COLOR LABELS ONLY.",
  "- They carry ZERO political, ideological, or partisan meaning. Blue does NOT mean left/liberal/Democrat. Red does NOT mean right/conservative/Republican.",
  "- Never let a speaker's real-world political affiliation influence which color you assign. Color = position in THIS debate, nothing else.",
  "- FIRST-SPEAKER RULE: the first speaker who clearly takes or affirms a position is assigned to \"blue\". The side that forms in opposition to them becomes \"red\".",
  "",
  "ASSIGN A SPEAKER TO A SIDE ONLY WHEN:",
  "- They advance, defend, or sustain a real position in their own words (not a one-off remark).",
  "- You can quote an exact line that proves it (evidenceQuote is mandatory; no quote means no assignment).",
  "",
  "DO NOT ASSIGN A SPEAKER WHEN:",
  "- They are a moderator, host, interviewer, timekeeper, narrator, audience member, or doing floor management. These are context only, FOREVER, even if they challenge a side sharply or ask pointed questions.",
  "- They have only asked a question, greeted, made a short challenge, or probed a side. Probing or challenging Blue does NOT make someone Red, and vice versa — wait until they state and sustain their OWN opposing position.",
  "- Their words are an ad, sponsor read, product promotion, brand mention, or commercial break (unless the debate's actual topic is advertising).",
  "",
  "NEVER INVENT THE EMPTY SIDE:",
  "- If only one side has a real speaker so far, fill ONLY that side's position and thesis.",
  "- Leave the other side's position and thesis EMPTY (\"\") until a real speaker actually takes it. Do not guess or assume what the opposition will argue.",
  "",
  "POSITION vs THESIS, and how they evolve:",
  "- position: a SHORT label of where the side stands (a few words, max ~60 characters).",
  "- thesis: a fuller plain-language summary of that side's core argument. Keep it ONE sentence, roughly 90-180 characters (about 15-28 words). Never exceed 200 characters. It must be a complete sentence — never cut off mid-thought.",
  "- Early packets: a rough first read is fine. Later packets: GENERALIZE and FIRM UP the thesis as the picture gets clearer — refine it, don't rewrite it from scratch.",
  "- Only change an existing side label/thesis when new dialogue gives clear, stronger evidence that your earlier read was wrong, or the debate's framing genuinely shifted.",
  "- TOPIC SHIFTS ARE REAL AND MUST BE REFLECTED: if a speaker or moderator announces or moves to a new topic/sub-topic (e.g. 'let's move on to...', 'now about...', a new question is posed, or the argument clearly pivots to a different subject), UPDATE the topic AND rewrite each side's thesis to reflect what they now argue on the NEW topic. Do not keep showing the old topic's thesis once the debate has clearly moved on. Use the ledger to carry over each side's stance, but the thesis must describe the CURRENT topic being debated.",
  "",
  "USE THE FULL RUNNING LEDGER (context.ledger) FOR CONTINUITY — debates take MANY formats:",
  "- 1-vs-1 with monologues, opening statements, and an initial moderator intro.",
  "- Jubilee / hot-seat style: one fixed person in the center while challengers rotate in one by one. The center person KEEPS their side across the whole debate; each new challenger is evaluated fresh. Use the ledger to remember the center person's established side instead of re-deciding every packet.",
  "- Panel or multi-speaker formats where several people share one side.",
  "- Formats where the thesis or sub-topic shifts at intervals (the speakers or moderator usually announce it). Track the shift using the ledger rather than treating it as a brand-new debate.",
  "- Because each packet is only a 30-second peephole, ALWAYS reconcile it against the ledger so you do not lose speakers, sides, or context you already established.",
  "",
  "OUTPUT — return STRICT JSON ONLY, this exact schema:",
  "{",
  '  "topic": "short neutral debate topic, or empty",',
  '  "bluePosition": "short Blue side position, or empty if no Blue speaker yet",',
  '  "redPosition": "short Red side position, or empty if no Red speaker yet",',
  '  "blueThesis": "fuller plain-language Blue thesis as expressed so far, or empty",',
  '  "redThesis": "fuller plain-language Red thesis as expressed so far, or empty",',
  '  "speakers": [{"speakerId":"Speaker 1","side":"blue|red","confidence":0.0,"reason":"specific reason grounded in stance/opposition/continuation","evidenceQuote":"exact quote that supports the assignment"}],',
  '  "speakerMemory": [{"speakerId":"Speaker 1","likelySide":"blue|red","confidence":0.0,"stanceSummary":"plain summary of what they argue","supportingEvidence":["short quote"]}]',
  "}",
  "",
  "FINAL RULES:",
  "- Use only the words \"Blue side\" and \"Red side\" in any prose you write.",
  "- Keep topic and positions short and topic-agnostic.",
  "- A packet may legitimately produce zero new assignments. Returning nothing new is correct when the evidence is not there yet.",
  "- Prefer correctness over eagerness. A wrong early assignment poisons the whole debate."
].join("\n");

/**
 * Run the Side Builder node.
 * @param {object[]} dialogueWindows  recent 30s side-builder packets to read
 * @param {object}   context          full running memory the pipeline assembles
 *                                     (existing side map, speaker history, and
 *                                      context.ledger = all prior packet dialogue)
 * @param {string}   thinkingLevel    defaults to project-wide "medium"
 * @param {object}   trace            flight recorder (optional)
 * @returns parsed JSON judgment (or {} if nothing usable came back)
 */
export async function runSideBuilder({
  dialogueWindows = [],
  context = {},
  thinkingLevel = NODE_THINKING_LEVEL,
  trace = null
} = {}) {
  // A node must be safe to call with no input.
  if (!Array.isArray(dialogueWindows) || dialogueWindows.length === 0) {
    logStep(trace, "SideBuilder:skipped", { reason: "no-ready-dialogue-window" });
    return {};
  }

  const routedContext = { ...context, dialogueWindows };
  const prompt = `${SIDE_BUILDER_PROMPT}\n\nRouted context for Side Builder: ${stringifyAgentContext(routedContext)}`;

  const { json } = await runAgent({
    agent: "Side Builder",
    prompt,
    thinkingLevel,
    responseMimeType: "application/json",
    maxOutputTokens: 3500,
    timeoutMs: 30000,
    trace,
    meta: {
      windows: dialogueWindows.length,
      ledgerWindows: Array.isArray(context?.ledger) ? context.ledger.length : 0
    }
  });

  return json || {};
}
