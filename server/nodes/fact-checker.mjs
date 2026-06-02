// =============================================================================
// nodes/fact-checker.mjs  —  THE FACT CHECKER NODE
// =============================================================================
//
// JOB: take checkable claims (already framed with a clean searchQuery by the
//   Claim Builder) and produce a verdict + tag for each, with displayable sources.
//
// TWO-STAGE, FIRECRAWL-FIRST (proven faster + cleaner sources than Gemini grounding):
//   1. Firecrawl search on the framed query -> real source list (title + url + snippet).
//   2. A small Gemini "verdict" call reads ONLY those snippets (no re-searching)
//      and writes the verdict, tag, and one-line reason.
//   FALLBACK: if Firecrawl returns nothing usable, fall back to Gemini grounding
//      (googleSearch tool) for that one claim.
//
// TAGS (4):
//   verified        — sources confirm the claim as stated.
//   contradicted    — sources refute it.
//   misleading      — the core fact is real but mis-attributed, exaggerated,
//                     missing key context, or the number/source is wrong.
//   no_clear_source — no authoritative source found either way.
//
// BATCHING: the pipeline's fact-check QUEUE hands this node up to N claims per
//   cycle (default 3) so we never throttle the API or the live pipeline.
//
// PURE-ish: it performs I/O (search) but does not mutate debate state; the clerk
//   stores the verdicts.
// =============================================================================

import { runAgent, runAgentWithTools, stringifyAgentContext } from "../shared/ai.mjs";
import { logStep } from "../shared/trace.mjs";
import { config } from "../config.mjs";

export const FACT_CHECK_TAGS = ["verified", "contradicted", "misleading", "no_clear_source"];
export const FACT_CHECK_BATCH_SIZE = 3;

// --- Firecrawl search for one framed query -----------------------------------
async function firecrawlSearch(query, { timeoutMs = 12000 } = {}) {
  if (!config.firecrawlApiKey) throw new Error("FIRECRAWL_API_KEY not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 2000);
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.firecrawlApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        limit: Math.max(1, Math.min(8, config.firecrawlSearchLimit || 4)),
        sources: ["web"],
        country: "US",
        timeout: timeoutMs,
        ...(Array.isArray(config.firecrawlExcludedDomains) && config.firecrawlExcludedDomains.length
          ? { excludeDomains: config.firecrawlExcludedDomains } : {})
      }),
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`Firecrawl ${r.status}`);
    const j = await r.json();
    const web = j.data?.web || j.data || [];
    return (Array.isArray(web) ? web : []).slice(0, 4).map((s) => ({
      title: String(s.title || "").slice(0, 120),
      uri: s.url || s.uri || "",
      snippet: String(s.description || s.snippet || "").slice(0, 320)
    })).filter((s) => s.uri);
  } finally {
    clearTimeout(timer);
  }
}

// --- Gemini writes the verdict from the Firecrawl snippets (no re-searching) ---
async function verdictFromSnippets({ claim, quote, sources, trace }) {
  const prompt = [
    "You are debatly's source verdict writer.",
    "Use ONLY the supplied search snippets. Do not browse, search, or use outside knowledge beyond them.",
    "",
    "JUDGE THE CORE FACTUAL SUBSTANCE — the actual point the speaker is making — NOT trivial wording.",
    "Be TOLERANT of minor drift that does not change the argument:",
    "- A slightly wrong source name (said 'Reuters', was actually 'AP') → still VERIFIED if the underlying fact checks out.",
    "- A small number difference (said 1,300, was 1,200) → still VERIFIED; the point is the same in the larger picture.",
    "- 'doctors' vs 'healthcare professionals', rounded figures, paraphrased attributions → still VERIFIED if the substance holds.",
    "Do NOT penalize the fact that this is a recorded debate, nor anything about the show's own setting.",
    "",
    "BUT SCOPE IS NOT MINOR DRIFT — judge the claim AS STATED, including how broad/general it is:",
    "- If the snippets only support a NARROW or SPECIAL case (one state, one institution, one program, a specific group) but the claim is stated BROADLY or GENERALLY, that is MISLEADING (overstated / missing the limiting context) — NOT verified.",
    "- If a law/policy/ruling cited was REPEALED, STRUCK DOWN, partially invalidated, or applies only to a narrow setting, do NOT verify a broad, present-tense claim from it — that is MISLEADING.",
    "- Example: 'you can get in trouble for misgendering in California' when the only support is a narrow long-term-care-facility rule (partly struck down) → MISLEADING, not verified.",
    "- 'verified' means a fair reader would agree the claim is TRUE AS STATED, at the scope/strength stated — not merely that something vaguely related exists.",
    "",
    "Decide a tag for the claim's SUBSTANCE:",
    '- "verified": the snippets confirm the core fact AT THE SCOPE STATED, allowing only minor attribution/number/wording drift.',
    '- "contradicted": the snippets show the core fact is actually false.',
    '- "misleading": the core fact is real but the claim OVERSTATES it — too broad/general for the evidence, missing critical limiting context, exaggerated, or built on a repealed/narrow rule stated as general. Use this whenever scope or strength is materially overstated (but NOT for small wording, source-name, or number drift).',
    '- "no_clear_source": the snippets genuinely do not establish the core fact either way.',
    "When genuinely torn between verified and misleading, prefer MISLEADING — do not give the benefit of the doubt to an overstated claim.",
    "",
    "Return STRICT JSON only:",
    '{ "tag": "verified|contradicted|misleading|no_clear_source", "why": "one short sentence (note any minor drift but still judge by substance)", "sourceIndexes": [0,1] }',
    "sourceIndexes lists which provided snippets best support your verdict (by their index).",
    `Claim: ${claim}`,
    `Original quote: ${quote}`,
    `Snippets: ${stringifyAgentContext(sources.map((s, i) => ({ i, title: s.title, snippet: s.snippet })))}`
  ].join("\n");

  const { json } = await runAgent({
    agent: "Fact Verdict Writer",
    prompt,
    responseMimeType: "application/json",
    maxOutputTokens: 600,
    timeoutMs: 20000,
    trace,
    meta: { sources: sources.length }
  });
  return json || {};
}

// --- Gemini grounding fallback (only when Firecrawl found nothing) ------------
async function geminiGroundingFallback({ claim, trace }) {
  // Uses the googleSearch tool directly; minimal since it's the backup path.
  const res = await runAgentWithTools({
    agent: "Fact Checker Grounding",
    prompt: [
      "Fact-check this claim using web search. Judge it AS STATED, including its scope.",
      "- 'verified' = true as stated, at the scope/strength stated (minor wording/number/source drift is fine).",
      "- 'misleading' = the core fact is real but OVERSTATED — stated too broadly/generally for the evidence, missing critical limiting context, or built on a narrow/repealed/struck-down rule presented as general. When torn between verified and misleading, choose misleading.",
      "- 'contradicted' = the claim is actually false. 'no_clear_source' = nothing authoritative either way.",
      'Return STRICT JSON: {"tag":"verified|contradicted|misleading|no_clear_source","why":"one sentence","sources":[{"title":"","uri":""}]}',
      `Claim: ${claim}`
    ].join("\n"),
    tools: [{ googleSearch: {} }],
    timeoutMs: 20000,
    trace
  });
  return res.json || { tag: "no_clear_source", why: "No verdict produced.", sources: [] };
}

// =============================================================================
// TWO STAGES — so the card never shows a premature "no clear source":
//   STAGE 1 (Firecrawl):  settled=true  -> verified/contradicted/misleading (FINAL)
//                         settled=false -> card goes to "deep checking" (NO tag yet)
//   STAGE 2 (Grounding):  resolves a deep-checking card to a FINAL tag, which may
//                         finally be "no_clear_source".
// =============================================================================

/**
 * STAGE 1 — Firecrawl pass. Returns a verdict per claim with `settled`.
 *   settled:true  -> tag is final (verified | contradicted | misleading).
 *   settled:false -> Firecrawl couldn't decide; the claim should move to deep check.
 */
export async function runFactCheckFirecrawl({ claims = [], trace = null } = {}) {
  const batch = (Array.isArray(claims) ? claims : []).slice(0, FACT_CHECK_BATCH_SIZE);
  if (!batch.length) return [];

  return Promise.all(batch.map(async (c) => {
    const query = String(c.searchQuery || c.claim || "").trim();
    try {
      const sources = await firecrawlSearch(query).catch(() => []);
      if (!sources.length) {
        return { claimId: c.claimId, settled: false, sources: [] }; // nothing found -> deep check
      }
      const v = await verdictFromSnippets({ claim: c.claim, quote: c.quote || "", sources, trace });
      const tag = FACT_CHECK_TAGS.includes(v.tag) ? v.tag : "no_clear_source";
      const picked = Array.isArray(v.sourceIndexes) && v.sourceIndexes.length
        ? v.sourceIndexes.map((i) => sources[i]).filter(Boolean)
        : sources;

      if (tag === "no_clear_source") {
        // Firecrawl snippets couldn't settle it -> deep check (keep the sources to show later).
        logStep(trace, "FactChecker:firecrawl-unsettled", { claimId: c.claimId });
        return { claimId: c.claimId, settled: false, sources: picked.slice(0, 3) };
      }
      logStep(trace, "FactChecker:verdict", { claimId: c.claimId, tag, via: "firecrawl", stage: 1 });
      return { claimId: c.claimId, settled: true, tag, why: String(v.why || ""), sources: picked.slice(0, 3), via: "firecrawl" };
    } catch (error) {
      logStep(trace, "FactChecker:error", { claimId: c.claimId, stage: 1, error: error instanceof Error ? error.message : String(error) });
      return { claimId: c.claimId, settled: false, sources: [] }; // error -> let deep check try
    }
  }));
}

/**
 * STAGE 2 — Gemini grounding pass for the deep-checking claims. Returns FINAL
 * verdicts (which may be no_clear_source if grounding also fails).
 */
export async function runDeepCheck({ claims = [], trace = null } = {}) {
  const batch = (Array.isArray(claims) ? claims : []).slice(0, FACT_CHECK_BATCH_SIZE);
  if (!batch.length) return [];

  return Promise.all(batch.map(async (c) => {
    try {
      const g = await geminiGroundingFallback({ claim: c.claim, trace }).catch(() => null);
      const tag = g && FACT_CHECK_TAGS.includes(g.tag) ? g.tag : "no_clear_source";
      const sources = (Array.isArray(g?.sources) && g.sources.length ? g.sources : (c.sources || [])).slice(0, 3);
      logStep(trace, "FactChecker:verdict", { claimId: c.claimId, tag, via: "grounding", stage: 2 });
      return { claimId: c.claimId, tag, why: String(g?.why || "No clear source found."), sources, via: "grounding" };
    } catch (error) {
      logStep(trace, "FactChecker:error", { claimId: c.claimId, stage: 2, error: error instanceof Error ? error.message : String(error) });
      return { claimId: c.claimId, tag: "no_clear_source", why: "Fact check failed.", sources: c.sources || [], via: "error" };
    }
  }));
}
