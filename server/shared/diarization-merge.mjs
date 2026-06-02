// =============================================================================
// shared/diarization-merge.mjs
// Merge Speechmatics WORDS (the text + per-word timestamps) with pyannote
// SPEAKER SEGMENTS (superior "who spoke when"). Speechmatics gives the words;
// pyannote gives the speaker — we relabel each word by the pyannote speaker whose
// segment covers the word's midpoint, then regroup words into speaker turns.
// =============================================================================

// Build a fast lookup: for a given time, which pyannote speaker is active.
// segments: [{ speaker, start, end }] (continuous timeline, seconds).
function speakerAt(segments, t) {
  // Linear scan is fine (a debate has a few hundred segments). Pick the segment
  // that contains t; if several overlap, the one whose center is closest.
  let best = null, bestDist = Infinity;
  for (const s of segments) {
    if (t >= s.start && t <= s.end) {
      const dist = Math.abs((s.start + s.end) / 2 - t);
      if (dist < bestDist) { bestDist = dist; best = s; }
    }
  }
  if (best) return best.speaker;
  // No exact cover (gap): snap to the NEAREST pyannote segment, no distance cap.
  // pyannote is our source of truth for "who"; we never fall back to the STT's
  // speaker label (that reintroduces its over-splitting). Every word gets the
  // closest pyannote speaker so labels stay purely pyannote + consistent.
  let near = null, nearDist = Infinity;
  for (const s of segments) {
    const d = t < s.start ? s.start - t : t > s.end ? t - s.end : 0;
    if (d < nearDist) { nearDist = d; near = s; }
  }
  return near ? near.speaker : null;
}

// Map a raw pyannote label ("SPEAKER_00") to the app's "Speaker N" convention.
export function pyannoteLabelToSpeakerId(raw, mapping) {
  if (!mapping.has(raw)) mapping.set(raw, `Speaker ${mapping.size + 1}`);
  return mapping.get(raw);
}

/**
 * Relabel Speechmatics words by pyannote speakers, then regroup into turns.
 * @param {object[]} words  flat, time-ordered: { word, startSec, endSec, ... }
 * @param {object[]} segments pyannote: { speaker, start, end } (same clock as words)
 * @returns {object[]} turns: { speakerId, text, startSec, endSec, words }
 */
export function mergeWordsWithPyannoteSegments(words, segments, { pyannoteSpeakerSource = "pyannote" } = {}) {
  const labelMap = new Map();
  let lastSpeakerId = null;
  const labeled = words.map((w) => {
    const hasTime = Number.isFinite(Number(w.startSec)) && Number.isFinite(Number(w.endSec));
    if (!hasTime) {
      // Punctuation / timestamp-less tokens: inherit the previous word's speaker.
      const speakerId = lastSpeakerId || w.fallbackSpeakerId || w.speakerId || "Unassigned speaker";
      return { ...w, speakerId, pyannoteRaw: "", speakerSource: "inherited" };
    }
    const mid = (Number(w.startSec) + Number(w.endSec)) / 2;
    const raw = speakerAt(segments, mid);
    const speakerId = raw ? pyannoteLabelToSpeakerId(raw, labelMap) : (w.fallbackSpeakerId || w.speakerId || lastSpeakerId || "Unassigned speaker");
    lastSpeakerId = speakerId;
    return { ...w, speakerId, pyannoteRaw: raw || "", speakerSource: raw ? pyannoteSpeakerSource : "speechmatics_fallback" };
  });

  // Regroup consecutive same-speaker words into turns.
  const turns = [];
  for (const w of labeled) {
    const last = turns[turns.length - 1];
    if (last && last.speakerId === w.speakerId) {
      last.words.push(w);
      last.text += (/^[.,!?;:]/.test(w.word) ? "" : " ") + w.word;
      last.endSec = Number(w.endSec);
    } else {
      turns.push({
        speakerId: w.speakerId,
        text: w.word,
        startSec: Number(w.startSec),
        endSec: Number(w.endSec),
        words: [w],
        speakerSource: w.speakerSource
      });
    }
  }
  return turns;
}
