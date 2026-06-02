// =============================================================================
// nodes/scoring-engine.mjs  —  THE SCORING ENGINE  (deterministic, NOT AI)
// =============================================================================
//
// PHILOSOPHY: a TRUTH & INTEGRITY score, not a "who-talked-more" score.
//   It does NOT re-judge anything. The AI nodes already decided the tags
//   (verified / contradicted / inconsistency...). This engine just TALLIES those
//   decisions with fixed point values — so the scoreboard is:
//     • TRANSPARENT: every point traces to a specific card the user can open.
//     • TRANSLATABLE: "Red is at 9 because 3 verified (+9), 1 misleading (−2)..."
//     • STABLE: same debate → same score, every time (pure arithmetic).
//
// BOTH SIDES START AT 0. A side can go negative (caught out more than proven).
//
// POINT VALUES (locked):
//   Fact-check (heaviest — truth matters most):
//     verified        +3
//     contradicted    −5   (being caught false hurts more than truth helps)
//     misleading      −2
//     no_clear_source  0   (unproven — neither rewarded nor punished)
//   Inconsistency (heavy — you undercut yourself):
//     self-contradiction / double-standard / hypocrisy   −4 each
//   Debate points (small + CAPPED — a flavor/tiebreaker, NOT a volume driver):
//     any strong point   +0.5, but the TOTAL debate-point bonus per side is
//     capped at DEBATE_POINT (absolute), so a side can't win just by talking more
//     (verified truth is +3 each and uncapped, so it always dominates).
//
// Scoring is PER SIDE. One weak debater costs their whole side — intended.
// A per-speaker breakdown is also produced for later UI (speaker-level scores).
// =============================================================================

export const SCORE_VALUES = {
  factCheck: { verified: 3, contradicted: -5, misleading: -2, no_clear_source: 0 },
  inconsistency: -4,        // any type
  debatePoint: 0.5
};

// Debate points always contribute a small bonus, but it's capped at an ABSOLUTE
// ceiling per side — so a wall of arguments can never outscore verified truth
// (verified claims are +3 each and uncapped), yet argument-heavy debates with few
// checkable facts still get a meaningful score. (Previously the cap was tied to a
// side's verified points, so debates with zero verified claims scored debate
// points at 0 — i.e. arguments counted for nothing.)
export const DEBATE_POINT_CAP = 6;

function emptySide() {
  return {
    score: 0,
    breakdown: { verified: 0, contradicted: 0, misleading: 0, inconsistencies: 0, debatePoints: 0 },
    points: { fromVerified: 0, fromContradicted: 0, fromMisleading: 0, fromInconsistencies: 0, fromDebatePoints: 0 },
    speakers: {} // speakerId -> { score, verified, contradicted, misleading, inconsistencies, debatePoints }
  };
}

function ensureSpeaker(side, speakerId) {
  if (!speakerId) return null;
  if (!side.speakers[speakerId]) {
    side.speakers[speakerId] = { score: 0, verified: 0, contradicted: 0, misleading: 0, inconsistencies: 0, debatePoints: 0 };
  }
  return side.speakers[speakerId];
}

/**
 * Compute the live scoreboard from the current ledgers. Pure function — give it
 * the state's claims, debatePoints, inconsistencies; get back per-side scores.
 *
 * @param {object[]} claims          [{ side, speakerId, tag }]  (tag may be null if still checking)
 * @param {object[]} debatePoints    [{ side, speakerId, tag }]
 * @param {object[]} inconsistencies [{ side, level, type, firstSpeakerId }]
 * @returns {object} { blue, red } each with score, breakdown, points, speakers
 */
export function computeScores({ claims = [], debatePoints = [], inconsistencies = [] } = {}) {
  const sides = { blue: emptySide(), red: emptySide() };

  // --- Fact-checked claims ---------------------------------------------------
  for (const c of claims) {
    const side = sides[c.side];
    if (!side) continue;
    const tag = c.tag; // only FINAL tags score; null/checking/deep_checking = 0 for now
    if (!tag || !(tag in SCORE_VALUES.factCheck)) continue;
    const v = SCORE_VALUES.factCheck[tag];
    const sp = ensureSpeaker(side, c.speakerId);
    if (tag === "verified") { side.breakdown.verified += 1; side.points.fromVerified += v; if (sp) sp.verified += 1; }
    else if (tag === "contradicted") { side.breakdown.contradicted += 1; side.points.fromContradicted += v; if (sp) sp.contradicted += 1; }
    else if (tag === "misleading") { side.breakdown.misleading += 1; side.points.fromMisleading += v; if (sp) sp.misleading += 1; }
    if (sp) sp.score += v;
  }

  // --- Inconsistencies (filed under the offending side) ----------------------
  for (const x of inconsistencies) {
    const side = sides[x.side];
    if (!side) continue;
    side.breakdown.inconsistencies += 1;
    side.points.fromInconsistencies += SCORE_VALUES.inconsistency;
    const sp = ensureSpeaker(side, x.firstSpeakerId);
    if (sp) { sp.inconsistencies += 1; sp.score += SCORE_VALUES.inconsistency; }
  }

  // --- Debate points (tiny, then CAPPED) -------------------------------------
  for (const p of debatePoints) {
    const side = sides[p.side];
    if (!side) continue;
    side.breakdown.debatePoints += 1;
    const sp = ensureSpeaker(side, p.speakerId);
    if (sp) sp.debatePoints += 1;
  }

  // --- Finalize each side's score with the debate-point cap ------------------
  for (const key of ["blue", "red"]) {
    const side = sides[key];
    const rawDebateBonus = side.breakdown.debatePoints * SCORE_VALUES.debatePoint;
    // Cap at an absolute ceiling (not tied to verified points) so debate points
    // always count, but can never outrun uncapped verified-truth points.
    const cappedDebateBonus = Math.min(rawDebateBonus, DEBATE_POINT_CAP);
    side.points.fromDebatePoints = Number(cappedDebateBonus.toFixed(2));

    side.score = Number((
      side.points.fromVerified +
      side.points.fromContradicted +
      side.points.fromMisleading +
      side.points.fromInconsistencies +
      side.points.fromDebatePoints
    ).toFixed(2));

    // Distribute the capped debate bonus proportionally into speaker scores.
    if (rawDebateBonus > 0) {
      const factor = cappedDebateBonus / rawDebateBonus;
      for (const sp of Object.values(side.speakers)) {
        sp.score = Number((sp.score + sp.debatePoints * SCORE_VALUES.debatePoint * factor).toFixed(2));
      }
    }
  }

  return sides;
}

// Human-readable one-line explanation of a side's score (for UI / transparency).
export function explainScore(side) {
  const p = side.points;
  const parts = [];
  if (side.breakdown.verified) parts.push(`${side.breakdown.verified} verified (+${p.fromVerified})`);
  if (side.breakdown.contradicted) parts.push(`${side.breakdown.contradicted} contradicted (${p.fromContradicted})`);
  if (side.breakdown.misleading) parts.push(`${side.breakdown.misleading} misleading (${p.fromMisleading})`);
  if (side.breakdown.inconsistencies) parts.push(`${side.breakdown.inconsistencies} inconsistencies (${p.fromInconsistencies})`);
  if (side.breakdown.debatePoints) parts.push(`${side.breakdown.debatePoints} points (+${p.fromDebatePoints} capped)`);
  return parts.join(", ") || "no scored items yet";
}
