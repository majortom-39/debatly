// =============================================================================
// nodes/family-merger.mjs  —  THE FAMILY MERGER NODE
// =============================================================================
//
// JOB (one job):
//   Group the accumulated debate-point cards into FAMILIES — envelopes with a
//   common title (e.g. "Definition of genocide", "Civilian casualty figures").
//   It assigns each point a familyId; the UI draws an envelope per family.
//
// CADENCE: runs every ~2 minutes (every 2 packets at 60s), NOT every minute.
//   Families only shift meaningfully over a few minutes; running it slower avoids
//   churn and wasted calls. The Debate Point Builder stays fast (every minute);
//   this node is the slower curator.
//
// STICKY — THE MOST IMPORTANT RULE:
//   Families must NOT be renamed or reshuffled every run. Once a family exists
//   with a title and members, KEEP it. Only:
//     • create a NEW family for points that genuinely don't fit any existing one,
//     • add a new point to the BEST existing family,
//     • rename a family ONLY if its current title is clearly wrong for its members.
//   Never churn titles for cosmetic reasons. The clerk also enforces stickiness.
//
// SIDE-SCOPED: families are built PER SIDE (Blue families, Red families) — the UI
//   shows each side's families in that side's column. We run this per side.
//
// PURE BRAIN: returns family assignments; the pipeline/clerk applies them and
//   enforces the no-rename / no-reshuffle discipline.
//
// OUTPUT (parsed JSON):
//   { families: [ { familyId, title, pointIds: [...] } ] }
//   - familyId: reuse an existing id to keep a family stable; new id (e.g. "fam-new-1")
//     only for a genuinely new theme.
// =============================================================================

import { runAgent, stringifyAgentContext, NODE_THINKING_LEVEL } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";

const FAMILY_MERGER_PROMPT = [
  "You are debatly's Family Merger. You organize debate-point cards (for ONE side) into FAMILIES — themed groups with a short common title.",
  "You do NOT write debate points, claims, scores, or prose. You only GROUP existing points and TITLE the groups.",
  "",
  "STICKINESS — THIS IS YOUR MOST IMPORTANT RULE:",
  "- You are given the EXISTING families (their ids, titles, and member point ids). KEEP them stable.",
  "- Do NOT rename a family unless its current title is clearly wrong for what it now contains.",
  "- Do NOT reshuffle points between families for cosmetic reasons. Move a point only if it was clearly misfiled.",
  "- Reuse the existing familyId for any family you keep. Only mint a NEW id (like \"fam-new-1\", \"fam-new-2\") for a genuinely new theme that fits no existing family.",
  "- Stability matters more than perfection. A slightly imperfect but STABLE grouping beats constant re-titling.",
  "",
  "HOW TO GROUP:",
  "- Put points that argue about the SAME underlying issue/sub-topic together (e.g. a definition debate, a specific statistic dispute, a historical parallel).",
  "- A good family title is short, neutral, and descriptive of the shared issue — not a side's slogan.",
  "- Every provided point id must end up in exactly one family. Do not drop or invent point ids.",
  "- It is fine to have a family with a single point if it stands alone.",
  "",
  "OUTPUT — STRICT JSON ONLY:",
  "{",
  '  "families": [',
  '    { "familyId": "existing id or fam-new-N", "title": "short neutral theme title", "pointIds": ["dp-..."] }',
  "  ]",
  "}"
].join("\n");

/**
 * Run the Family Merger for ONE side.
 * @param {string}   side             "blue" | "red"
 * @param {object[]} points           that side's debate-point cards: { pointId, point, tag }
 * @param {object[]} existingFamilies current families for that side: { familyId, title, pointIds }
 * @param {string}   thinkingLevel    defaults to project-wide "medium"
 * @param {object}   trace            flight recorder (optional)
 * @returns parsed JSON { families: [...] } (or {} if nothing usable)
 */
export async function runFamilyMerger({
  side = "",
  points = [],
  existingFamilies = [],
  thinkingLevel = NODE_THINKING_LEVEL,
  trace = null
} = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    logStep(trace, "FamilyMerger:skipped", { reason: "no-points", side });
    return { families: existingFamilies || [] };
  }

  const compactPoints = points.map((p) => ({ pointId: p.pointId, point: p.point, tag: p.tag }));
  const routedContext = { side, points: compactPoints, existingFamilies };
  const prompt = `${FAMILY_MERGER_PROMPT}\n\nRouted context for Family Merger (side=${side}): ${stringifyAgentContext(routedContext)}`;

  const { json } = await runAgent({
    agent: "Family Merger",
    prompt,
    thinkingLevel,
    responseMimeType: "application/json",
    maxOutputTokens: 2500,
    timeoutMs: 30000,
    trace,
    meta: { side, points: compactPoints.length, existingFamilies: (existingFamilies || []).length }
  });

  return json && Array.isArray(json.families) ? json : { families: existingFamilies || [] };
}
