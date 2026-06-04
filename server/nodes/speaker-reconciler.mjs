// =============================================================================
// nodes/speaker-reconciler.mjs  —  CONSERVATIVE speaker-label correction.
// =============================================================================
//
// Real-time diarization (Speechmatics) sometimes mislabels speakers: it merges
// two people under one label, or splits one person across labels. There is no
// reliable live config fix (see docs/speechmatics-realtime.md). This node uses
// the transcript TEXT to correct labels — but ONLY on explicit verbal cues
// (introductions / greetings / hand-offs). It is deliberately conservative:
// when in doubt, it changes nothing. Reassignments may only target a speaker
// label that ALREADY appears in the window (never invents a speaker).
//
// Input  : { turns: [{ id, speaker, text }] }  (recent, in order)
// Output : { corrections: [{ turnId, correctedSpeaker, reason }] }
// =============================================================================

import { runAgent, stringifyAgentContext, NODE_THINKING_LEVEL } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";

const RECONCILE_PROMPT = [
  "You correct speaker labels on a LIVE debate transcript whose automatic speaker",
  "detection is imperfect. You are given consecutive turns, each with a speaker",
  "label and the words spoken.",
  "",
  "Reassign a turn's speaker ONLY when there is an EXPLICIT verbal cue that the",
  "current label is wrong, for example:",
  "  - a self-introduction / greeting showing a different person is now talking",
  '    ("hi, I\'m Scotty", "my name is...", "nice to meet you"),',
  "  - an explicit hand-off bringing in a new person,",
  "  - a clear question→answer exchange where the SAME label was given to both the",
  "    asker and a just-introduced answerer.",
  "",
  "HARD RULES:",
  "  - Be extremely conservative. If there is ANY doubt, do NOT correct that turn.",
  "  - NEVER decide who is speaking from the opinion/topic/side of the words — only",
  "    from explicit conversational cues about WHO is talking.",
  "  - You may only reassign to a speaker label that ALREADY appears in the turns",
  "    provided. Never invent a new label.",
  "  - Most turns should be left unchanged. Returning an empty list is correct when",
  "    there are no clear cues.",
  "",
  'Return STRICT JSON only: { "corrections": [ { "turnId": "<id>", "correctedSpeaker": "<existing label>", "reason": "<short>" } ] }'
].join("\n");

export async function runSpeakerReconciler({ turns = [], thinkingLevel = NODE_THINKING_LEVEL, trace = null } = {}) {
  const clean = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && t.id && String(t.text || "").trim())
    .map((t) => ({ turnId: String(t.id), speaker: String(t.speaker || ""), text: String(t.text || "").slice(0, 400) }));
  if (clean.length < 2) return { corrections: [] };

  const knownLabels = new Set(clean.map((t) => t.speaker).filter(Boolean));
  const knownIds = new Set(clean.map((t) => t.turnId));

  let json;
  try {
    ({ json } = await runAgent({
      agent: "Speaker Reconciler",
      prompt: `${RECONCILE_PROMPT}\n\nTurns: ${stringifyAgentContext(clean)}`,
      thinkingLevel,
      responseMimeType: "application/json",
      maxOutputTokens: 1200,
      timeoutMs: 22000,
      trace,
      meta: { turns: clean.length, labels: knownLabels.size }
    }));
  } catch (error) {
    logStep(trace, "SpeakerReconciler:error", { error: error instanceof Error ? error.message : String(error) });
    return { corrections: [] };
  }

  const raw = Array.isArray(json?.corrections) ? json.corrections : [];
  const corrections = [];
  for (const c of raw) {
    const turnId = String(c?.turnId || "");
    const correctedSpeaker = String(c?.correctedSpeaker || "").trim();
    if (!knownIds.has(turnId)) continue;                 // must be a real turn
    if (!knownLabels.has(correctedSpeaker)) continue;    // must be an existing label (never invent)
    const original = clean.find((t) => t.turnId === turnId);
    if (!original || original.speaker === correctedSpeaker) continue; // no-op
    corrections.push({ turnId, correctedSpeaker, reason: String(c?.reason || "").slice(0, 160) });
  }
  logStep(trace, "SpeakerReconciler:done", { in: clean.length, corrections: corrections.length });
  return { corrections };
}
