// =============================================================================
// nodes/claim-builder.mjs  —  THE CLAIM BUILDER NODE
// =============================================================================
//
// JOB (one job):
//   Read the SIDE-SORTED dialogue (the 60s packet — it BRANCHES OFF the Side
//   Builder, NOT off the debate points) and extract STRONG, EXTERNALLY-CHECKABLE
//   factual claims — the statements a fact-checker could actually verify.
//
// WHAT QUALIFIES (the bar is HIGH on purpose):
//   A claim must name a CONCRETE, externally-verifiable fact: a number, date,
//   named source, named event, law, study, poll, report, court ruling, or
//   official action.
//     ✅ "Reuters reported 1,300 family bloodlines wiped out in Gaza."
//     ✅ "The ICJ ruled the Srebrenica massacre a genocide."
//     ❌ "Israel is committing genocide."   (opinion / legal judgment — NOT checkable)
//     ❌ "This is morally wrong."            (value judgment)
//     ❌ "If intent existed, it'd be genocide." (hypothetical)
//
// QUERY FRAMING (built in here — no broken transcript as a search query):
//   For each claim the node ALSO writes a clean searchQuery — a tight, keyword
//   search string with the named entities / numbers / sources spelled out — so
//   the fact-checker can hand it straight to Firecrawl. This is the deliberate
//   "frame the query properly" step you asked for, done at extraction time (no
//   extra model round-trip).
//
// OWNERSHIP: only claims a blue/red speaker asserts AS THEIR OWN. A speaker
//   repeating the opponent's claim to mock/question it is NOT their claim.
//
// DEDUP: read the running claim ledger; skip a claim already on the board, even
//   if worded differently. Different statements about the SAME fact = one claim.
//
// PURE BRAIN. The pipeline/clerk stores claims and feeds the fact-check queue.
//
// OUTPUT (parsed JSON):
//   { claims: [ { speakerId, claim, quote, turnIds, searchQuery, reason, confidence } ] }
// =============================================================================

import { runAgent, stringifyAgentContext, NODE_THINKING_LEVEL } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";

const CLAIM_BUILDER_PROMPT = [
  "You are debatly's Claim Builder, analyzing an ongoing LIVE debate one packet at a time.",
  "",
  "YOUR ONLY JOB: extract STRONG, EXTERNALLY-CHECKABLE FACTUAL CLAIMS from the side-sorted dialogue — statements an outside fact-checker could actually verify against sources.",
  "Do NOT create debate points, clashes, inconsistencies, scores, or verdicts. You only FIND checkable claims and FRAME a clean search query for each.",
  "",
  "THE BAR IS HIGH — a claim qualifies ONLY if it names a CONCRETE, externally-verifiable fact:",
  "- a number, statistic, date, or quantity;",
  "- a named source, study, poll, report, newspaper, agency, or institution;",
  "- a named event, law, treaty, court ruling, policy, program, or official action;",
  "- a specific public statement attributed to a named person or body.",
  "",
  "REJECT (these are NOT checkable claims):",
  "- Opinions, moral or value judgments ('this is wrong', 'this is genocide' as a label).",
  "- Legal/normative interpretations and motive guesses.",
  "- Hypotheticals and conditionals ('if X then Y', 'could happen').",
  "- Vague statements with no named subject, number, or source.",
  "- Pure rhetoric, predictions, questions, greetings, procedure, ads.",
  "- A claim whose best possible answer would be opinion or interpretation — if a search would likely end in 'cannot verify', do NOT output it.",
  "- SELF-REFERENTIAL / SHOW-SETUP claims: statements about THIS debate's own setting, format, host, venue, or the act of recording (e.g. 'I am surrounded by 20 activists here today', 'welcome to the show', 'this is a recorded debate'). These describe the scene, not an argument advanced in the debate — skip them entirely. Only extract claims about the OUTSIDE WORLD that carry the speaker's actual argument.",
  "- PRIVATE / PERSONAL claims about the PARTICIPANTS THEMSELVES — a speaker's own relationships, feelings, family, job, finances, or private life history, and personal anecdotes ('I've been with my partner for 10 years', 'I counsel abuse survivors', 'I was suicidal after being cheated on', 'my mother did X'). No external source can verify a private individual's personal life, so these are NOT checkable. ONLY extract claims about the PUBLIC, outside world: public figures, published studies/data, named institutions, laws, and public events.",
  "",
  "HARD RULE ON THE SUBJECT: the claim's subject must be a real, nameable public entity (a person in the public record, an institution, a place, a study, an event). NEVER write a claim whose subject is a 'Speaker N' label, or an 'I / me / my / we' that refers to a debate participant. If, after resolving pronouns, the only subject would be a participant or a 'Speaker N' placeholder, SKIP the claim — never put 'Speaker N' into the claim text or the searchQuery.",
  "",
  "OWNERSHIP: only output a claim a speaker asserts AS THEIR OWN. If a speaker repeats the opponent's claim to mock, question, or attack it, that is NOT their claim — skip it.",
  "",
  "DEDUP (use the existing claim ledger): skip a claim already on the board, even worded differently. Different statements about the SAME underlying fact = one claim, not several.",
  "",
  "FRAME THE SEARCH QUERY (critical — do NOT pass raw broken transcript):",
  "- For each claim, write searchQuery: a tight, clean keyword search string a search engine would handle well.",
  "- Spell out the named people, places, institutions, numbers, dates, and events explicitly. Resolve pronouns ('he', 'they', 'this') to the actual named subject from context.",
  "- No filler, no 'the speaker says', no partial fragments. Just the searchable facts.",
  "- Example claim: \"Reuters reported over 1,300 Palestinian family bloodlines wiped out in Gaza.\"",
  "  Good searchQuery: \"Reuters 1300 Palestinian family bloodlines wiped out Gaza\".",
  "",
  "WRITING THE CLAIM:",
  "- claim: one clean, standalone, factual sentence — exactly what should be checked. Preserve attribution faithfully; do not invent a source the speaker didn't name.",
  "- NAME THE ACTOR (resolve, never invent): if the claim describes an action, the claim must name WHO performed it. Resolve pronouns ('he', 'they', 'this administration') to the specific entity the debate context ALREADY names — within this packet's dialogue, the speaker's own words, or the existing claim ledger. Resolving a pronoun to an entity already present in the conversation is REQUIRED and does NOT count as inventing a subject. Use active voice naming that actor; never fall back to passive voice ('X was done') to dodge an unresolved pronoun. ONLY if nothing in the available context names the actor, SKIP the claim rather than emit a subjectless/passive version.",
  "- quote: the EXACT line from that speaker containing the claim.",
  "- If a quote bundles a broad accusation with a factual support, output ONLY the factual support.",
  "- A packet may legitimately produce ZERO claims. Prefer zero over weak or non-checkable output.",
  "",
  "OUTPUT — STRICT JSON ONLY:",
  "{",
  '  "claims": [{',
  '    "speakerId": "Speaker 1",',
  '    "claim": "one standalone externally-checkable factual statement",',
  '    "quote": "exact supporting quote from that speaker",',
  '    "turnIds": ["turn id"],',
  '    "searchQuery": "clean keyword search string with named entities and numbers spelled out",',
  '    "reason": "why this is externally checkable",',
  '    "confidence": 0.0',
  "  }]",
  "}"
].join("\n");

/**
 * Run the Claim Builder node (branches off Side Builder dialogue).
 * @param {object[]} dialogueWindows  the current side-sorted 60s packet(s)
 * @param {object}   speakers         speakerId -> { side } (only blue/red count)
 * @param {object[]} existingClaims   the running claim ledger (for dedup)
 * @param {string}   thinkingLevel    defaults to project-wide "medium"
 * @param {object}   trace            flight recorder (optional)
 * @returns parsed JSON { claims: [...] } (or { claims: [] })
 */
export async function runClaimBuilder({
  dialogueWindows = [],
  speakers = {},
  existingClaims = [],
  thinkingLevel = NODE_THINKING_LEVEL,
  trace = null
} = {}) {
  if (!Array.isArray(dialogueWindows) || dialogueWindows.length === 0) {
    logStep(trace, "ClaimBuilder:skipped", { reason: "no-dialogue-window" });
    return { claims: [] };
  }

  const ledger = (Array.isArray(existingClaims) ? existingClaims : []).map((c) => ({
    claimId: c.claimId,
    speakerId: c.speakerId,
    side: c.side,
    claim: c.claim
  }));

  const routedContext = { speakers, existingClaims: ledger, dialogueWindows };
  const prompt = `${CLAIM_BUILDER_PROMPT}\n\nRouted context for Claim Builder: ${stringifyAgentContext(routedContext)}`;

  const { json } = await runAgent({
    agent: "Claim Builder",
    prompt,
    thinkingLevel,
    responseMimeType: "application/json",
    maxOutputTokens: 3500,
    timeoutMs: 32000,
    trace,
    meta: { windows: dialogueWindows.length, ledgerClaims: ledger.length }
  });

  return json && Array.isArray(json.claims) ? json : { claims: [] };
}
