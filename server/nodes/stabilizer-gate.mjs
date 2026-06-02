// =============================================================================
// nodes/stabilizer-gate.mjs  —  THE STABILIZER GATE NODE
// =============================================================================
//
// WHERE IT SITS:
//   Live audio -> Speechmatics (transcribe + diarize) -> [STABILIZER GATE] ->
//   Side Builder -> (Debate Point / Claim / Inconsistency) -> Fact Queue/Checker
//
//   The gate is the bouncer at the door. Nothing reaches Side Builder until the
//   gate opens. Once open, it never closes — it just keeps watching and TAGS junk.
//
// TWO JOBS (one thinking node does both):
//   JOB A — DECIDE WHEN TO OPEN (only while still closed):
//     Open the moment ANY single speaker qualifies as a "debator" and produces a
//     stable bit of conversation. A debator = a speaker who clearly argues FOR or
//     AGAINST a topic. No clash needed, no second speaker needed, no back-and-forth
//     needed. Even a solo opening monologue counts. Even ~two solid argumentative
//     sentences from one qualifying speaker is enough.
//
//   JOB B — TAG JUNK (only after it has opened):
//     Watch every packet and tag any stretch that is NOT real debate:
//       "ad" | "promo" | "moderator" | "intro" | "off-topic"
//     It identifies junk from BOTH the speaker-label change AND the content itself.
//     Tagged content still flows downstream but is marked so later nodes skip it.
//     The gate NEVER closes again, no matter what (commercial breaks, feed cuts...).
//
// PRE-DEBATE TRANSCRIPT:
//   While still closed, the transcript is KEPT ON RECORD but marked pre-debate /
//   ignored (an opening statement before the official start may matter later).
//
// PURE BRAIN:
//   Like every node, this only reads and returns judgment. It does NOT save to the
//   debate's running memory. The plain-code "wiring" applies fixed rules: latch the
//   gate open once and never re-close it, and trust junk tags as given.
//
// MODEL: gemini-3.1-flash-lite, thinking medium (shared/ai.mjs).
//
// OUTPUT (parsed JSON):
//   {
//     "gateOpen": true|false,           // current decision for THIS packet
//     "openedThisPacket": true|false,   // did it flip from closed->open right now
//     "debatorSpeakerId": "Speaker 1",  // who qualified as the first debator (if opening)
//     "openReason": "why it opened, grounded in a quote",
//     "junkTags": [                      // only meaningful once open
//       { "kind":"ad|promo|moderator|intro|off-topic",
//         "speakerId":"Speaker 3",
//         "reason":"why this is junk",
//         "evidenceQuote":"exact line",
//         "turnIds":["t12"] }
//     ]
//   }
// =============================================================================

import { runAgent, stringifyAgentContext, NODE_THINKING_LEVEL } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";

const STABILIZER_GATE_PROMPT = [
  "You are debatly's Stabilizer Gate, watching an INCOMING LIVE audio transcript one 30-second packet at a time.",
  "You sit right after speech-to-text and right before everything else. You are the bouncer at the door.",
  "",
  "YOU HAVE TWO POSSIBLE JOBS DEPENDING ON gateAlreadyOpen:",
  "",
  "============================================================",
  "JOB A — DECIDE WHEN TO OPEN  (do this ONLY when gateAlreadyOpen is false)",
  "============================================================",
  "Decide whether the real debate has started yet.",
  "",
  "DEFINITION — a \"debator\" is a speaker who CLEARLY argues FOR or AGAINST a topic (takes a real position, makes a case).",
  "A debate has STARTED the moment ONE debator HOLDS THE FLOOR and develops a real, sustained position. Specifically:",
  "- You do NOT need two sides.",
  "- You do NOT need any clash or back-and-forth.",
  "- A single speaker arguing a position is enough — including a solo OPENING MONOLOGUE or OPENING STATEMENT.",
  "- THE BAR (judge MEANING, not sentence count): ONE speaker is holding the floor and developing a sustained argument or position — enough that you could state IN ONE LINE what they are arguing and roughly why. Do NOT count sentences; some formats pack a full case into one long sentence, others ramble without arguing anything. Ask only: is this a real, developing case, or a passing remark / greeting / question / fragment?",
  "- A passing remark, a greeting, a single question, a one-liner, or scattered fragments DO NOT meet the bar — stay closed.",
  "",
  "DECISIVE 'NOT STARTED — THIS IS A TEASER/INTRO' RULE (this OVERRIDES the holding-the-floor judgment):",
  "- A cold-open TEASER MONTAGE looks like: MANY different speakers (three or more) each appearing in the SAME packet in short, rapid, disconnected clips — punchy soundbites spliced together to preview the episode. This is how shows like Jubilee 'Surrounded', debate shows, and documentaries begin.",
  "- If a packet shows three or more different speakers trading short, jump-cut lines, treat the WHOLE packet as intro/teaser and STAY CLOSED — EVEN IF, when you stitch one speaker's clips together, it reads like a sustained argument. Stitched-together teaser soundbites are NOT a speaker holding the floor.",
  "- The real start looks DIFFERENT: ONE speaker holds the floor mostly uninterrupted and builds a connected argument over several sentences, typically right after a moderator hands off (e.g. 'let's begin', 'introduce yourself', 'make your claim').",
  "- When unsure between 'teaser montage' and 'real start', STAY CLOSED and wait. Opening one packet late costs almost nothing; opening on a teaser poisons the whole pipeline.",
  "",
  "USE THE LOOKAHEAD (context.nextPacketPreview) — peek before you commit:",
  "- You are given a PREVIEW of what is said in the NEXT packet, so you can decide like a human who hears a few seconds further.",
  "- If the current packet looks like a sustained argument BUT the next packet is a show intro, title card, channel branding, or a moderator formally welcoming/framing the show (e.g. 'From <Show>, this is...', 'I'm your host...', 'today we are...'), then the current packet was a COLD-OPEN TEASER. STAY CLOSED now — the real start comes after that intro.",
  "- Only commit to OPEN when BOTH the current packet shows a debator holding the floor AND the lookahead does NOT reveal an intro/branding/welcome that would reframe the current clip as a teaser.",
  "",
  "OTHER 'NOT STARTED' SIGNALS — stay CLOSED for:",
  "- Show intros, titles, channel branding, music, applause.",
  "- Ads, sponsor reads, promos, commercial breaks.",
  "- A moderator/host merely welcoming, framing, or introducing people (no argument of their own).",
  "- Greetings, small talk, mic checks, or unstable fragments where no one has argued anything yet.",
  "",
  "When gateAlreadyOpen is false, set gateOpen=true ONLY if ONE debator is truly holding the floor with a sustained argument AND the packet is not a multi-speaker teaser montage. If you open it now, set openedThisPacket=true, name the debatorSpeakerId, and give openReason grounded in an exact quote. Otherwise gateOpen=false and junkTags=[] (you do not tag junk while still closed).",
  "",
  "BACKTRACK TO THE TRUE START (important): you may open CAUTIOUSLY — a packet or two AFTER the debate truly began — to be sure it was not a teaser. When you DO open, look back across the CURRENT packet AND context.recentTranscript and find the EXACT earlier line where the real debate actually began (the first time the qualifying debator started developing their position). Return that exact line in realStartQuote so downstream can rewind to it and not lose the opening. If the real start is right here in this packet, realStartQuote is that opening line.",
  "",
  "============================================================",
  "JOB B — TAG JUNK  (do this ONLY when gateAlreadyOpen is true)",
  "============================================================",
  "The gate is already open and STAYS open forever — never close it. Always return gateOpen=true and openedThisPacket=false in this case.",
  "Your only job now is to TAG stretches of this packet that are NOT real debate, so downstream nodes can skip them.",
  "Tag each junk stretch with a kind from EXACTLY this list:",
  '  "ad"        — advertisement / sponsor read / product or service promotion / commercial.',
  '  "promo"     — channel/show self-promotion, subscribe prompts, upcoming-segment teases.',
  '  "moderator" — a moderator/host/interviewer/timekeeper speaking in their facilitation role (welcoming, framing, directing, asking questions) rather than arguing a side. Tag this EVERY time it appears, throughout the whole debate.',
  '  "intro"     — show intros, recaps, titles, or framing that is not argument.',
  '  "off-topic" — chatter, asides, technical issues, or content drastically unrelated to the debate topic.',
  "",
  "HOW TO IDENTIFY JUNK:",
  "- Use BOTH signals: the speaker-label change (a new/known non-debator speaker appears) AND the actual content of what is said.",
  "- A real debator briefly going off-topic can be tagged off-topic for that stretch; it does not make them junk forever.",
  "- If the entire packet is genuine debate, return junkTags=[] — that is the normal, common case. Do not invent junk.",
  "",
  "============================================================",
  "OUTPUT — STRICT JSON ONLY, this exact schema:",
  "============================================================",
  "{",
  '  "gateOpen": true,',
  '  "openedThisPacket": false,',
  '  "debatorSpeakerId": "Speaker 1 or empty",',
  '  "openReason": "short reason grounded in a quote, or empty",',
  '  "realStartQuote": "exact earlier line where the real debate began (only when opening), or empty",',
  '  "junkTags": [{"kind":"ad|promo|moderator|intro|off-topic","speakerId":"Speaker 3","reason":"why this is junk","evidenceQuote":"exact line","turnIds":["t12"]}]',
  "}",
  "",
  "FINAL RULES:",
  "- Prefer correctness over eagerness. Opening too early on an ad/intro poisons the whole pipeline; so does tagging real debate as junk.",
  "- Once open, never close. Never set gateOpen=false when gateAlreadyOpen is true.",
  "- Return only the JSON object, nothing else."
].join("\n");

/**
 * Run the Stabilizer Gate node.
 * @param {object[]} dialogueWindows  the current 30s packet(s) to judge
 * @param {boolean}  gateAlreadyOpen  has the gate opened on a previous packet?
 * @param {object}   context          running memory (speaker history, ledger) the pipeline assembles
 * @param {string}   thinkingLevel    defaults to project-wide "medium"
 * @param {object}   trace            flight recorder (optional)
 * @returns parsed JSON judgment (or a safe closed/empty default)
 */
export async function runStabilizerGate({
  dialogueWindows = [],
  gateAlreadyOpen = false,
  nextPacketPreview = null,
  context = {},
  thinkingLevel = NODE_THINKING_LEVEL,
  trace = null
} = {}) {
  // Safe default if there is nothing to read.
  if (!Array.isArray(dialogueWindows) || dialogueWindows.length === 0) {
    logStep(trace, "StabilizerGate:skipped", { reason: "no-dialogue-window", gateAlreadyOpen });
    return {
      gateOpen: Boolean(gateAlreadyOpen),
      openedThisPacket: false,
      debatorSpeakerId: "",
      openReason: "",
      junkTags: []
    };
  }

  // Lookahead: a compact preview of the NEXT packet (only useful while still
  // closed, to catch cold-open teasers whose intro lands in the following packet).
  const previewLines = !gateAlreadyOpen && nextPacketPreview
    ? (nextPacketPreview.speakerColumns || []).map((c) => ({ speakerId: c.speakerId, text: String(c.text || "").slice(0, 220) }))
    : [];

  const routedContext = { ...context, gateAlreadyOpen, dialogueWindows, nextPacketPreview: previewLines };
  const prompt = `${STABILIZER_GATE_PROMPT}\n\nRouted context for Stabilizer Gate (gateAlreadyOpen=${gateAlreadyOpen}): ${stringifyAgentContext(routedContext)}`;

  const { json } = await runAgent({
    agent: "Stabilizer Gate",
    prompt,
    thinkingLevel,
    responseMimeType: "application/json",
    maxOutputTokens: 2000,
    timeoutMs: 30000,
    trace,
    meta: { windows: dialogueWindows.length, gateAlreadyOpen }
  });

  // Normalize into the shape the wiring expects. The wiring still enforces the
  // hard latch (once open, never close) regardless of what the model says.
  const result = json || {};
  return {
    gateOpen: gateAlreadyOpen ? true : Boolean(result.gateOpen),
    openedThisPacket: gateAlreadyOpen ? false : Boolean(result.gateOpen),
    debatorSpeakerId: typeof result.debatorSpeakerId === "string" ? result.debatorSpeakerId : "",
    openReason: typeof result.openReason === "string" ? result.openReason : "",
    realStartQuote: typeof result.realStartQuote === "string" ? result.realStartQuote : "",
    junkTags: Array.isArray(result.junkTags) ? result.junkTags : []
  };
}
