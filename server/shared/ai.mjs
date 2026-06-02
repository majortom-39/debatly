// =============================================================================
// shared/ai.mjs  —  The one place every node talks to Gemini.
// =============================================================================
//
// PROJECT DECISION (locked):
//   • Every node uses the SAME model:  gemini-3.1-flash-lite
//   • Every node uses the SAME thinking level:  medium
//
// Why one file: so a node never re-implements "how to call the model". A node
// just says runAgent({ agent, prompt }) and gets clean JSON back. If we ever
// change model or thinking level, we change it HERE, once.
//
// Per-node override: a node CAN pass its own thinkingLevel (e.g. "high" for a
// tricky node like Inconsistency) without touching this file — but the default
// for all of them is "medium", as agreed.
// =============================================================================

import { GoogleGenAI } from "@google/genai";
import { config } from "../config.mjs";

// --- The single model + thinking level for the whole pipeline ----------------
export const NODE_MODEL = "gemini-3.1-flash-lite";
export const NODE_THINKING_LEVEL = "medium"; // minimal | low | medium | high

// --- The shared Gemini client (Vertex AI) ------------------------------------
const genai = new GoogleGenAI({
  vertexai: true,
  project: config.project,
  location: config.location
});

// --- Safe JSON stringify (handles circular refs + bigints) -------------------
// Used to pack a node's context object into its prompt.
export function stringifyAgentContext(value, space = 0) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return Number(item);
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  }, space);
}

// --- Build the model config -------------------------------------------------
// Gemini 3.x rejects temperature/topP/topK and uses thinkingLevel (not the old
// 2.5-era thinkingBudget). This keeps each node's call valid.
function buildModelConfig({ thinkingLevel = NODE_THINKING_LEVEL, includeThoughts = false, responseMimeType = "application/json", maxOutputTokens, timeoutMs = 30000 } = {}) {
  const cfg = {
    responseMimeType,
    thinkingConfig: {
      thinkingLevel: String(thinkingLevel || NODE_THINKING_LEVEL).toUpperCase(),
      includeThoughts
    },
    httpOptions: { timeout: timeoutMs }
  };
  if (Number.isFinite(Number(maxOutputTokens))) cfg.maxOutputTokens = Number(maxOutputTokens);
  return cfg;
}

// --- The one call every node makes ------------------------------------------
// runAgent returns { text, raw, json } where json is already parsed+repaired.
export async function runAgent({
  agent = "Node",
  prompt = "",
  thinkingLevel = NODE_THINKING_LEVEL,
  includeThoughts = false,
  responseMimeType = "application/json",
  maxOutputTokens,
  timeoutMs = 30000,
  trace = null,
  meta = {}
} = {}) {
  const startedAt = Date.now();
  const modelConfig = buildModelConfig({ thinkingLevel, includeThoughts, responseMimeType, maxOutputTokens, timeoutMs });

  logStep(trace, `${agent}:start`, {
    node: agent,
    model: NODE_MODEL,
    thinkingLevel: modelConfig.thinkingConfig.thinkingLevel,
    promptChars: typeof prompt === "string" ? prompt.length : stringifyAgentContext(prompt).length,
    ...meta
  });

  const response = await genai.models.generateContent({
    model: NODE_MODEL,
    contents: prompt,
    config: modelConfig
  });

  const text = response?.text || "";
  logStep(trace, `${agent}:done`, {
    node: agent,
    model: NODE_MODEL,
    elapsedMs: Date.now() - startedAt,
    outputChars: text.length,
    tokens: response?.usageMetadata || null,
    ...meta
  });

  return {
    text,
    raw: response,
    json: parseJsonWithRepair(text)
  };
}

// --- Same as runAgent but with tools (e.g. Google Search grounding) ----------
// Used by the Fact Checker's grounding fallback. Tools + JSON mime can't both be
// set, so we omit responseMimeType and rely on JSON repair of the text.
export async function runAgentWithTools({
  agent = "Node",
  prompt = "",
  tools = [],
  thinkingLevel = NODE_THINKING_LEVEL,
  timeoutMs = 20000,
  trace = null,
  meta = {}
} = {}) {
  const startedAt = Date.now();
  const cfg = {
    thinkingConfig: { thinkingLevel: String(thinkingLevel || NODE_THINKING_LEVEL).toUpperCase(), includeThoughts: false },
    tools,
    httpOptions: { timeout: timeoutMs }
  };
  logStep(trace, `${agent}:start`, { node: agent, model: NODE_MODEL, tools: tools.length, ...meta });
  const response = await genai.models.generateContent({ model: NODE_MODEL, contents: prompt, config: cfg });
  const text = response?.text || "";
  logStep(trace, `${agent}:done`, { node: agent, elapsedMs: Date.now() - startedAt, outputChars: text.length, ...meta });
  return { text, raw: response, json: parseJsonWithRepair(text) };
}

// --- Lightweight trace logging (no-op if no trace given) ---------------------
export function logStep(trace, step, payload = {}) {
  if (!trace || !Array.isArray(trace.steps)) return;
  trace.steps.push({ step, ...payload, timestamp: Date.now() });
}

// --- JSON parsing that tolerates model quirks (fences, trailing commas) ------
export function parseJsonWithRepair(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1));

  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) candidates.push(raw.slice(firstBracket, lastBracket + 1));

  for (const candidate of candidates) {
    for (const attempt of [candidate, repairJsonString(candidate)]) {
      if (!attempt) continue;
      try {
        return JSON.parse(attempt);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function repairJsonString(input) {
  return String(input ?? "")
    .replace(/,(\s*[}\]])/g, "$1")                                  // drop trailing commas
    .replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');  // quote bare keys
}
