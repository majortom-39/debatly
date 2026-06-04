import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { GoogleGenAI } from "@google/genai";
import { config } from "./config.mjs";
import {
  createDraftDebateProject,
  createPersistedLiveSession,
  deleteDebateProject,
  ensureProjectShareId,
  finalizeStaleRecordingSessions,
  getDatabaseConfigStatus,
  getDebateProject,
  getSharedProject,
  importSharedProject,
  isDatabaseConfigured,
  listDebateProjects,
  markSessionStopped,
  persistDebateReport,
  persistDebateStateSnapshot,
  persistTranscriptTurn,
  updateDebateProjectSpeakerDisplayNames,
  updateDebateProjectTitle,
  upsertUserProfile
} from "./store.mjs";
import { attachAuthUser, authenticateBearerToken, getAuthConfigStatus, getTokenFromUrl, isAuthConfigured, requireAuth } from "./auth.mjs";
import { createSpeechmaticsLiveSttNodeConfig } from "./speechmatics-live-stt-node.mjs";
import { createPyannoteLiveDiarizationNode } from "./pyannote-live-diarization-node.mjs";
import { createLiveAnalysisState, analyzeLive } from "./live-runner.mjs";
import { runReportBuilder } from "./nodes/report-builder.mjs";
import { runDebatePointBuilder } from "./nodes/debate-point-builder.mjs";
import { startIngestFromFile, startIngestFromUrl, getIngestJob, cancelIngestJob, requestIngestEmail } from "./batch-ingest.mjs";
const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(attachAuthUser);
const profileTouchCache = new Map();

app.use((request, _response, next) => {
  const user = request.authUser;
  if (user?.id && isDatabaseConfigured()) {
    const now = Date.now();
    const lastTouched = profileTouchCache.get(user.id) || 0;
    if (now - lastTouched > 60_000) {
      profileTouchCache.set(user.id, now);
      upsertUserProfile(user).catch((error) => {
        console.warn(`[db] user profile touch failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  next();
});

const genai = new GoogleGenAI({
  vertexai: true,
  project: config.project,
  location: config.location
});

const SPEECHMATICS_UNASSIGNED_RAW_SPEAKER = "__unassigned__";
const SPEECHMATICS_UNASSIGNED_SPEAKER_ID = "Unassigned speaker";

const CLAIM_STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "also", "among", "because", "before", "being", "between",
  "could", "does", "doing", "down", "during", "each", "from", "have", "having", "here", "into", "itself",
  "just", "more", "most", "only", "other", "over", "same", "should", "some", "such", "than", "that",
  "their", "them", "then", "there", "these", "they", "this", "those", "through", "under", "very", "what",
  "when", "where", "which", "while", "with", "would", "your", "speaker", "explicitly", "states", "stated",
  "says", "said", "asks", "asked", "questions", "question", "raises", "raised", "aligns", "stance", "topic"
]);

const CLAIM_ACTION_TOKENS = new Set([
  "build", "building", "built", "cost", "costs", "costing", "cut", "cuts", "cutting", "create", "creating",
  "expand", "expanding", "increase", "increases", "reduce", "reduces", "kill", "kills", "killed", "killing",
  "kidnap", "kidnaps", "kidnapped", "kidnapping", "eliminate", "eliminates", "eliminated", "target", "targets",
  "targeting", "support", "supports", "oppose", "opposes", "reject", "rejects", "allocate", "allocates"
]);

const GENERIC_ACTION_BUCKETS = new Set([
  "abduct", "allocate", "ban", "blame", "build", "cause", "challenge", "cost", "create", "cut", "defend",
  "displace", "expand", "fund", "harm", "increase", "intent", "oppose", "recognize", "reduce", "reject",
  "support", "target", "verify"
]);

const GENERIC_QUALITY_BUCKETS = new Set([
  "clear", "effective", "fair", "fast", "harmful", "higher", "lower", "majority", "minority", "reliable",
  "safe", "slow", "true", "unfair", "unsafe"
]);

const FACT_STATUS_TO_VERDICT = {
  checking: "checking",
  verified: "verified",
  contradicted: "contradicted",
  no_clear_source: "no_clear_source",
  cannot_verify: "cannot_verify"
};

const VERDICT_TO_FACT_STATUS = {
  verified: "verified",
  contradicted: "contradicted",
  no_clear_source: "no_clear_source",
  cannot_verify: "cannot_verify"
};

const SCORE_PILLARS = [
  {
    key: "source_verified",
    label: "Verified source",
    weight: 1,
    positiveCap: 999,
    negativeCap: 0,
    help: "A claim from this side was verified by external sources."
  },
  {
    key: "source_contradicted",
    label: "Contradicted source",
    weight: 1,
    positiveCap: 0,
    negativeCap: 999,
    help: "A claim from this side was contradicted by external sources."
  },
  {
    key: "strong_rebuttal",
    label: "Strong rebuttal",
    weight: 1,
    positiveCap: 999,
    negativeCap: 0,
    help: "This side clearly landed a resolved clash."
  },
  {
    key: "weak_response",
    label: "Weak response",
    weight: 1,
    positiveCap: 0,
    negativeCap: 999,
    help: "This side lost ground in a resolved response."
  },
  {
    key: "inconsistency",
    label: "Inconsistency",
    weight: 1,
    positiveCap: 0,
    negativeCap: 999,
    help: "This side contradicted itself or applied a conflicting standard."
  },
  {
    key: "unanswered_challenge",
    label: "Unanswered challenge",
    weight: 1,
    positiveCap: 0,
    negativeCap: 999,
    help: "This side left a direct challenge unanswered."
  }
];
const CORE_SCORE_DIMENSIONS = SCORE_PILLARS.map((pillar) => [pillar.key, pillar.label, pillar.weight]);

function liveBatchWindowMs(session = null) {
  return LIVE_CURRENT_REPORTER_CHUNK_MS;
}

const MIN_SIDE_THESIS_POINTS = Number(process.env.MIN_SIDE_THESIS_POINTS || 1);
const LIVE_CURRENT_REPORTER_CHUNK_MS = Number(process.env.LIVE_CURRENT_REPORTER_CHUNK_MS || 15_000);
const LIVE_CURRENT_STARTUP_CHUNKS = Number(process.env.LIVE_CURRENT_STARTUP_CHUNKS || 4);
const LIVE_DIRECT_SIDE_BUILDER_INTERVAL_MS = Number(process.env.LIVE_DIRECT_SIDE_BUILDER_INTERVAL_MS || 35_000);
const LIVE_DIRECT_CLAIM_INTERVAL_MS = Number(process.env.LIVE_DIRECT_CLAIM_INTERVAL_MS || 20_000);
const LIVE_DIRECT_CLASH_INTERVAL_MS = Number(process.env.LIVE_DIRECT_CLASH_INTERVAL_MS || 20_000);
const LIVE_DIRECT_INCONSISTENCY_INTERVAL_MS = Number(process.env.LIVE_DIRECT_INCONSISTENCY_INTERVAL_MS || 45_000);
const SIDE_POSITION_MAX_CHARS = Math.max(40, Math.min(96, Number(process.env.SIDE_POSITION_MAX_CHARS || 64)));
const DIRECT_ANALYSIS_SCHEMA_VERSION = 6;
const DIRECT_ANALYSIS_ARCHITECTURE = "direct_debate_desk_v2";
const TRACE_PREVIEW_CHARS = 360;
const CLEANING_MAX_TURNS_PER_BATCH = 8;
const SPEAKER_MEMORY_TRANSCRIPT_CHAR_LIMIT = 4500;
const SPEAKER_MEMORY_CLAIM_LIMIT = 14;
const LIVE_SESSION_TTL_MS = Number(process.env.LIVE_SESSION_TTL_MS || 2 * 60 * 60 * 1000);
const LIVE_BATCH_EXCHANGE_TURN_TRIGGER = Number(process.env.LIVE_BATCH_EXCHANGE_TURN_TRIGGER || 4);
const LIVE_BATCH_EXCHANGE_TURNS_PER_SPEAKER = Number(process.env.LIVE_BATCH_EXCHANGE_TURNS_PER_SPEAKER || 2);
const LIVE_BATCH_MONOLOGUE_TURN_TRIGGER = Number(process.env.LIVE_BATCH_MONOLOGUE_TURN_TRIGGER || 6);
const LIVE_BATCH_CHAR_TRIGGER = Number(process.env.LIVE_BATCH_CHAR_TRIGGER || 1300);
const LIVE_BATCH_DEBATE_WINDOW_MS = Number(process.env.LIVE_BATCH_DEBATE_WINDOW_MS || 20000);
const LIVE_BATCH_TIME_TRIGGER_MS = Number(process.env.LIVE_BATCH_TIME_TRIGGER_MS || LIVE_BATCH_DEBATE_WINDOW_MS);
const LIVE_BATCH_FAST_DEBOUNCE_MS = Number(process.env.LIVE_BATCH_FAST_DEBOUNCE_MS || 500);
const LIVE_BATCH_IDLE_DEBOUNCE_MS = Number(process.env.LIVE_BATCH_IDLE_DEBOUNCE_MS || 1200);
const SPEECHMATICS_PENDING_FLUSH_MS = Number(process.env.SPEECHMATICS_PENDING_FLUSH_MS || 12000);
const SPEECHMATICS_PENDING_FLUSH_WORDS = Number(process.env.SPEECHMATICS_PENDING_FLUSH_WORDS || 80);
const SPEECHMATICS_PENDING_FLUSH_GROUPS = Number(process.env.SPEECHMATICS_PENDING_FLUSH_GROUPS || 8);
const PYANNOTE_FALLBACK_MAX_WORDS = Number(process.env.PYANNOTE_FALLBACK_MAX_WORDS || 12);
const PYANNOTE_FALLBACK_MAX_MS = Number(process.env.PYANNOTE_FALLBACK_MAX_MS || 3500);
const PYANNOTE_BOUNDARY_GUARD_SEC = Number(process.env.PYANNOTE_BOUNDARY_GUARD_SEC || 0.08);
const PYANNOTE_MIN_WORD_OVERLAP_SEC = Number(process.env.PYANNOTE_MIN_WORD_OVERLAP_SEC || 0.02);
const PYANNOTE_STABLE_EMIT_LAG_SEC = Number(process.env.PYANNOTE_STABLE_EMIT_LAG_SEC || 1.5);
const PYANNOTE_MICRO_TURN_MAX_WORDS = Number(process.env.PYANNOTE_MICRO_TURN_MAX_WORDS || 2);
const PYANNOTE_MICRO_TURN_MAX_MS = Number(process.env.PYANNOTE_MICRO_TURN_MAX_MS || 900);
const SPEECHMATICS_DRIFT_MIN_MS = Number(process.env.SPEECHMATICS_DRIFT_MIN_MS || 60_000);
const SPEECHMATICS_DRIFT_MIN_EVENTS = Number(process.env.SPEECHMATICS_DRIFT_MIN_EVENTS || 10);
const SPEECHMATICS_DRIFT_MIN_WORDS = Number(process.env.SPEECHMATICS_DRIFT_MIN_WORDS || 100);
const SPEECHMATICS_DRIFT_COOLDOWN_MS = Number(process.env.SPEECHMATICS_DRIFT_COOLDOWN_MS || 120_000);
const SPEECHMATICS_DRIFT_MAX_RECOVERIES = Number(process.env.SPEECHMATICS_DRIFT_MAX_RECOVERIES || 2);
const LIVE_PATTERN_CONTEXT_BATCHES = Number(process.env.LIVE_PATTERN_CONTEXT_BATCHES || 6);
const LIVE_DIALOGUE_WINDOW_BATCHES = Number(process.env.LIVE_DIALOGUE_WINDOW_BATCHES || 4);
const LIVE_CONTEXT_BATCH_LIMIT = Math.max(12, LIVE_PATTERN_CONTEXT_BATCHES + 2);
const LIVE_VERIFY_LIMIT = Number(process.env.LIVE_VERIFY_LIMIT || 6);
const LIVE_VERIFY_PER_SPEAKER_LIMIT = Number(process.env.LIVE_VERIFY_PER_SPEAKER_LIMIT || 3);
const LIVE_SOURCE_CHECK_PENDING_MAX_MS = Number(process.env.LIVE_SOURCE_CHECK_PENDING_MAX_MS || 90_000);
const LIVE_REPORT_WAIT_MS = Number(process.env.LIVE_REPORT_WAIT_MS || 90000);
const LIVE_REPORT_CURRENT_WAIT_MS = Number(process.env.LIVE_REPORT_CURRENT_WAIT_MS || 25_000);
const LIVE_REPORT_CURRENT_MAX_WAIT_MS = Number(process.env.LIVE_REPORT_CURRENT_MAX_WAIT_MS || 30_000);
const DEBATE_REPORT_AGENT_TIMEOUT_MS = Number(process.env.DEBATE_REPORT_AGENT_TIMEOUT_MS || 9000);
const FACT_CHECKER_DEFAULT_TIMEOUT_MS = Number(process.env.FACT_CHECKER_TIMEOUT_MS || 12000);
const FACT_CHECKER_BASE_OUTPUT_TOKENS = Number(process.env.FACT_CHECKER_MAX_OUTPUT_TOKENS || 850);
const FACT_CHECKER_MAX_OUTPUT_TOKENS = Number(process.env.FACT_CHECKER_MAX_TOTAL_OUTPUT_TOKENS || 2400);
const FACT_CHECKER_THINKING_BUDGET = Number(process.env.FACT_CHECKER_THINKING_BUDGET || 0);
const FIRECRAWL_SEARCH_TIMEOUT_MS = config.firecrawlSearchTimeoutMs;
const FIRECRAWL_SEARCH_LIMIT = config.firecrawlSearchLimit;
const FIRECRAWL_EXCLUDED_DOMAINS = config.firecrawlExcludedDomains;
const LIVE_RUNTIME_LOG_PATH = process.env.DEBATLY_RUNTIME_LOG_PATH || "server-runtime.log";
const RUNNING_API_SERVER = /(?:^|[\\/])server[\\/]index\.mjs$/i.test(process.argv[1] || "");
const DEBATE_TRACE_LOG_PATH = process.env.DEBATE_TRACE_LOG_PATH || (RUNNING_API_SERVER ? "logs/live-agentic-trace.jsonl" : "");

const liveSessions = new Map();

function createDirectTracePayload(node, inputCounts = {}, outputCounts = {}, extra = {}) {
  return {
    analysisSchemaVersion: DIRECT_ANALYSIS_SCHEMA_VERSION,
    architecture: DIRECT_ANALYSIS_ARCHITECTURE,
    node,
    stage: node,
    inputCounts,
    outputCounts,
    input: inputCounts,
    output: outputCounts,
    ...extra
  };
}

function createTrace({
  label = "direct-ledger",
  recordingStartedAt = 0,
  requestStartedAt = Date.now(),
  debateStartSec = null,
  debateEndSec = null,
  transcriptWindowStartSec = null,
  transcriptWindowEndSec = null,
  turnIds = []
} = {}) {
  const cleanLabel = cleanClaimText(label || "direct-ledger").replace(/[^\w.-]+/g, "-").slice(0, 60) || "direct-ledger";
  return {
    id: `${cleanLabel}-${stableTextHash(`${cleanLabel}:${requestStartedAt}:${turnIds.join("|")}`).slice(0, 8)}`,
    label: cleanLabel,
    recordingStartedAt: Number(recordingStartedAt || 0),
    requestStartedAt,
    debateStartSec,
    debateEndSec,
    transcriptWindowStartSec,
    transcriptWindowEndSec,
    turnIds: uniqueStrings(turnIds || [])
  };
}

function logTraceStep(trace, step, payload = {}) {
  logDeterministicStep(trace, step, payload);
}

function logDeterministicStep(trace, step, payload = {}) {
  const now = Date.now();
  const debateEndSec = firstFiniteNumber(payload.debateEndSec, payload.endSec, trace?.debateEndSec, payload.packetRange?.endSec);
  const debateStartSec = firstFiniteNumber(payload.debateStartSec, payload.startSec, trace?.debateStartSec, payload.packetRange?.startSec);
  const entry = {
    traceId: trace?.id || payload.traceId || "",
    step,
    node: payload.node || step.split(":")[0] || "DirectLedger",
    stage: payload.stage || step.split(":")[1] || payload.node || "event",
    at: new Date(now).toISOString(),
    wallClockAt: new Date(now).toISOString(),
    requestElapsedMs: trace?.requestStartedAt ? now - trace.requestStartedAt : payload.requestElapsedMs ?? null,
    recordingElapsedMs: trace?.recordingStartedAt ? Math.max(0, now - trace.recordingStartedAt) : payload.recordingElapsedMs ?? null,
    debateStartSec: Number.isFinite(debateStartSec) ? debateStartSec : null,
    debateEndSec: Number.isFinite(debateEndSec) ? debateEndSec : null,
    debateStartMs: Number.isFinite(debateStartSec) ? Math.round(debateStartSec * 1000) : null,
    debateEndMs: Number.isFinite(debateEndSec) ? Math.round(debateEndSec * 1000) : null,
    debateMinute: Number.isFinite(debateEndSec) ? Number((debateEndSec / 60).toFixed(2)) : null,
    transcriptWindowStartSec: firstFiniteNumber(payload.transcriptWindowStartSec, trace?.transcriptWindowStartSec),
    transcriptWindowEndSec: firstFiniteNumber(payload.transcriptWindowEndSec, trace?.transcriptWindowEndSec),
    packetRange: payload.packetRange || {
      startSec: Number.isFinite(debateStartSec) ? debateStartSec : null,
      endSec: Number.isFinite(debateEndSec) ? debateEndSec : null
    },
    batchSeq: payload.batchSeq ?? null,
    inputCounts: payload.inputCounts || payload.input || {},
    outputCounts: payload.outputCounts || payload.output || {},
    decisionReason: payload.decisionReason || payload.reason || "",
    turnIds: uniqueStrings([...(trace?.turnIds || []), ...(payload.turnIds || [])]).slice(-40),
    analysisSchemaVersion: DIRECT_ANALYSIS_SCHEMA_VERSION,
    architecture: DIRECT_ANALYSIS_ARCHITECTURE,
    ...payload
  };
  const line = JSON.stringify(entry);
  console.log(`[debatly trace] ${line}`);
  if (DEBATE_TRACE_LOG_PATH) {
    try {
      mkdirSync(dirname(DEBATE_TRACE_LOG_PATH), { recursive: true });
      appendFileSync(DEBATE_TRACE_LOG_PATH, `${line}\n`, "utf8");
    } catch (error) {
      console.warn(`[trace] append failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function attachTraceTimings(timings = {}, trace = null) {
  if (!trace) return;
  logDeterministicStep(trace, "Pipeline:timings", { timings });
}

function debateRangeFromTurns(turns = []) {
  const starts = [];
  const ends = [];
  for (const turn of turns || []) {
    const startSec = Number(turn?.startSec);
    const endSec = Number(turn?.endSec);
    if (Number.isFinite(startSec)) starts.push(startSec);
    if (Number.isFinite(endSec)) ends.push(endSec);
    for (const word of turn?.words || []) {
      const wordStart = Number(word?.startSec ?? word?.start_time ?? word?.start);
      const wordEnd = Number(word?.endSec ?? word?.end_time ?? word?.end);
      if (Number.isFinite(wordStart)) starts.push(wordStart);
      if (Number.isFinite(wordEnd)) ends.push(wordEnd);
    }
  }
  const startSec = starts.length ? Math.min(...starts) : null;
  const endSec = ends.length ? Math.max(...ends) : (startSec !== null ? startSec : null);
  return {
    startSec,
    endSec,
    durationSec: startSec !== null && endSec !== null ? Math.max(0, endSec - startSec) : null
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return NaN;
}

function stringifyAgentContext(value, space = 0) {
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

function generationConfigForModel(model = "", generationConfig = {}) {
  const next = { ...(generationConfig || {}) };
  if (!/^gemini-3/i.test(String(model || ""))) return next;
  delete next.temperature;
  delete next.topP;
  delete next.topK;
  delete next.top_p;
  delete next.top_k;
  if (next.thinkingConfig?.thinkingBudget !== undefined) {
    const includeThoughts = Boolean(next.thinkingConfig.includeThoughts);
    next.thinkingConfig = { thinkingLevel: "MEDIUM", includeThoughts };
  }
  return next;
}

async function generateContentForAgent({ trace = null, agent = "Direct Agent", model = config.fastModel, contents = "", config: generationConfig = {}, meta = {} } = {}) {
  const startedAt = Date.now();
  const modelConfig = generationConfigForModel(model, generationConfig);
  logDeterministicStep(trace, `${agent}:start`, {
    node: agent,
    stage: "start",
    model,
    promptChars: typeof contents === "string" ? contents.length : stringifyAgentContext(contents).length,
    responseMimeType: modelConfig?.responseMimeType || "",
    toolCount: Array.isArray(modelConfig?.tools) ? modelConfig.tools.length : 0,
    ...meta
  });
  const response = await genai.models.generateContent({
    model,
    contents,
    config: modelConfig
  });
  const text = response?.text || "";
  logDeterministicStep(trace, `${agent}:done`, {
    node: agent,
    stage: "done",
    model,
    elapsedMs: Date.now() - startedAt,
    outputChars: text.length,
    tokens: response?.usageMetadata || null,
    ...meta
  });
  return response;
}

async function runTranscriptStitcher({ newTurns = [], fallbackUtterances = [] } = {}) {
  return normalizeCleaningAgentUtterances(
    fallbackUtterances.map((utterance) => ({
      speakerId: utterance.speakerId,
      rawTurnIds: utterance.rawTurnIds || utterance.turnIds || [],
      text: utterance.text || utterance.quote || "",
      speakerOwnershipConfidence: utterance.speakerOwnershipConfidence ?? 0.9
    })),
    newTurns,
    fallbackUtterances
  );
}

function keyMomentDelta(moment = {}) {
  const kind = keyMomentCategory(moment);
  if (kind === "source_verified") return 10;
  if (kind === "strong_rebuttal") return 10;
  if (kind === "source_contradicted") return -10;
  if (kind === "weak_response") return -10;
  if (kind === "unanswered_challenge") return -10;
  if (kind === "inconsistency") return -10;
  return 0;
}

function lowerFirst(text = "") {
  const clean = cleanClaimText(text);
  return clean ? clean.charAt(0).toLowerCase() + clean.slice(1) : "";
}

function scoreEventFamily(event = {}) {
  return cleanClaimText(event.category || event.pillar || event.title || "").toLowerCase().replace(/[^\w]+/g, "_");
}

function inconsistencySideId(item = {}) {
  return normalizeSideId(item.accusedSideId || item.sideId || normalizeAgentSideId(item));
}

function isDeclarativeSpeakerStandardQuote(text = "") {
  const clean = cleanClaimText(text);
  return wordCount(clean) >= 5 && !clean.endsWith("?") && !/^(what|why|how|when|where|do you|did you|are you|is it)\b/i.test(clean);
}

function isEligibleInconsistencyPoint(point = {}) {
  return Boolean(point?.id && normalizeSideId(point.sideId) && isAssertedPoint(point));
}

function isMetaOnlyClaimText(text = "") {
  return isMetaNarrationPoint(text) || isDebateStrategyMetaText(text);
}

function looksLikeGarbledClaim(text = "") {
  const clean = cleanClaimText(text);
  if (!clean) return true;
  if (/[^\w\s.,!?;:'"()/-]{2,}/.test(clean)) return true;
  return /\b(uh uh|um um|yeah yeah)\b/i.test(clean) && wordCount(clean) < 8;
}

function looksLikeIncompleteClaimQuote(text = "") {
  const clean = cleanClaimText(text);
  if (!clean) return true;
  if (wordCount(clean) <= 3) return true;
  return /\b(and|or|but|because|that|the|a|an|to|of|for|with)\s*$/i.test(clean);
}

function uniqueById(items = []) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const id = cleanClaimText(item?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function inferOwnershipTypeFromCandidate(candidate = {}) {
  const text = `${candidate.claim || ""} ${candidate.quote || ""}`;
  if (hasReportedSpeechCue(text) && !hasCurrentSpeakerInference(text)) return "reported_opponent";
  if (hasReportedSpeechCue(text)) return "quoted_evidence";
  return "owned_assertion";
}

function inferSpeechActFromCandidate(candidate = {}) {
  const text = cleanClaimText(`${candidate.claim || ""} ${candidate.quote || ""}`);
  if (isQuestionLike(text)) return "question";
  if (/\b(i agree|i concede|fair point|you are right)\b/i.test(text)) return "concession";
  if (/\b(no|not true|i disagree|that is wrong|however|but)\b/i.test(text)) return "rebuttal";
  return "claim";
}

function isOwnedOwnershipType(value = "") {
  return [
    "owned_assertion",
    "owned_rebuttal",
    "owned_concession",
    "owned_evidence",
    "speaker_assertion",
    "owned_statement",
    "self_claim",
    "quoted_evidence"
  ].includes(String(value || "").trim().toLowerCase());
}

function assessSideOwnershipConflict(candidate = {}, _state = {}) {
  const ownershipType = candidate.ownershipType || inferOwnershipTypeFromCandidate(candidate);
  if (!isOwnedOwnershipType(ownershipType)) {
    return { veto: true, confidenceCap: 0.5, boundaryCap: 0.5, reason: "Candidate is not owned by the speaker." };
  }
  return { veto: false, confidenceCap: 1, boundaryCap: 1, reason: "" };
}

function isOwnedClaimPoint(point = {}) {
  const ownershipType = normalizeOwnershipType(point.ownershipType || inferOwnershipTypeFromCandidate(point));
  if (!isOwnedOwnershipType(ownershipType)) return false;
  const speechAct = normalizeSpeechAct(point.speechAct || inferSpeechActFromCandidate(point));
  if (["opponent_paraphrase", "reported_speech", "sarcasm"].includes(speechAct)) return false;
  const quoteRole = normalizeQuoteRole(point.quoteRole || inferQuoteRoleFromCandidate(point));
  const claimMode = normalizeClaimMode(point.claimMode || inferClaimModeFromCandidate(point));
  if (["opponent_quote", "external_quote"].includes(quoteRole) && claimMode !== "quoted_evidence") return false;
  return true;
}

function deriveArtifacts(state = {}) {
  return buildDirectArtifacts(normalizeClaimState(state));
}

function isLiveSourceTimedOut(point = {}) {
  return normalizeFactStatus(point.factStatus) === "checking"
    && Date.now() - Number(point.at || point.createdAt || Date.now()) >= LIVE_SOURCE_CHECK_PENDING_MAX_MS;
}

function shouldQueueVerification(point = {}, { includeLiveTimedOut = false } = {}) {
  if (!isDirectClaimPoint(point)) return false;
  const status = normalizeFactStatus(point.factStatus || "checking");
  if (status === "checking") return true;
  return includeLiveTimedOut && isLiveSourceTimedOut(point);
}

function selectBalancedVerificationPoints(points = [], { limit = LIVE_VERIFY_LIMIT, perSpeakerLimit = LIVE_VERIFY_PER_SPEAKER_LIMIT } = {}) {
  const output = [];
  const bySpeaker = new Map();
  for (const point of [...points].sort((a, b) => Number(a.at || 0) - Number(b.at || 0))) {
    if (output.length >= limit) break;
    const speakerId = point.speakerId || "unknown";
    const count = bySpeaker.get(speakerId) || 0;
    if (count >= perSpeakerLimit) continue;
    output.push(point);
    bySpeaker.set(speakerId, count + 1);
  }
  return output;
}

function expireStaleLiveSourceChecks(session) {
  if (!session?.debate?.points?.length) return;
  const points = session.debate.points.map((point) => {
    if (!isLiveSourceTimedOut(point)) return point;
    const why = "No completed source result was available in the live window, so this claim remains unverified.";
    return {
      ...point,
      factStatus: "no_clear_source",
      evidenceBasis: "contextual",
      scoreEligible: false,
      why,
      noSourceReason: why
    };
  });
  session.debate = finalizeDirectLedgerState({ ...session.debate, points });
}

async function verifyDebatePoints(input = {}) {
  const state = normalizeClaimState(input.currentDebate || input.debate || {});
  const suppliedPoints = Array.isArray(input.points) && input.points.length
    ? input.points
    : (state.points || []).filter((point) => shouldQueueVerification(point, input.options || {}));
  const turns = Array.isArray(input.transcriptWindow) ? input.transcriptWindow : [];
  const trace = createTrace({
    label: input.options?.label || "direct-verification",
    recordingStartedAt: input.recordingStartedAt || 0,
    turnIds: suppliedPoints.flatMap((point) => point.turnIds || [])
  });
  const verified = await verifySelectedPoints(suppliedPoints, state, turns, {
    model: input.options?.model || config.groundingModel,
    timeoutMs: input.options?.timeoutMs || FACT_CHECKER_DEFAULT_TIMEOUT_MS,
    trace
  });
  const byId = new Map((state.points || []).map((point) => [point.id, point]));
  for (const point of verified) byId.set(point.id, { ...(byId.get(point.id) || {}), ...point });
  const next = finalizeDirectLedgerState({ ...state, points: [...byId.values()] });
  return input.options?.includeTimings ? { ...next, _timings: { verifiedPoints: verified.length } } : next;
}

function rescoreDebateState(inputDebate = {}, _options = {}) {
  return finalizeDirectLedgerState(inputDebate);
}

if (RUNNING_API_SERVER) installRuntimeLogMirror();

function installRuntimeLogMirror() {
  if (!LIVE_RUNTIME_LOG_PATH || process.env.DEBATLY_DISABLE_RUNTIME_LOG === "true") return;
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  let appendFailed = false;
  const write = (level, args) => {
    if (appendFailed) return;
    try {
      mkdirSync(dirname(LIVE_RUNTIME_LOG_PATH), { recursive: true });
      const line = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return arg.stack || arg.message;
          return inspect(arg, { depth: 6, colors: false, breakLength: 180 });
        })
        .join(" ");
      appendFileSync(LIVE_RUNTIME_LOG_PATH, `${new Date().toISOString()} ${level} ${line}\n`, "utf8");
    } catch (error) {
      appendFailed = true;
      original.warn(`Could not append runtime log: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  console.log = (...args) => {
    write("INFO", args);
    original.log(...args);
  };
  console.warn = (...args) => {
    write("WARN", args);
    original.warn(...args);
  };
  console.error = (...args) => {
    write("ERROR", args);
    original.error(...args);
  };
}

app.get("/api/config", (_request, response) => {
  response.json({
    app: "debatly",
    project: config.project,
    location: config.location,
    database: getDatabaseConfigStatus(),
    auth: getAuthConfigStatus(),
    vertexModel: config.model,
    vertexFastModel: config.fastModel,
    vertexGroundingModel: config.groundingModel,
    livePipeline: "direct-ledger",
    analysisSchemaVersion: DIRECT_ANALYSIS_SCHEMA_VERSION,
    pipelineBuild: DIRECT_ANALYSIS_ARCHITECTURE,
    speechProvider: "Speechmatics Realtime STT",
    speechModel: config.speechmaticsOperatingPoint,
    speakerDiarization: config.liveDiarizationProvider === "pyannote"
      ? "Local pyannote/wespeaker online diarization (Speechmatics words)"
      : "Speechmatics realtime speaker diarization",
    researchOrder: ["Firecrawl Search retrieval", "Gemini-lite verdict synthesis", "Vertex Gemini grounding fallback"]
  });
});

app.get("/api/me", async (request, response) => {
  try {
    const profile = request.authUser?.id && isDatabaseConfigured()
      ? await upsertUserProfile(request.authUser)
      : null;
    response.json({ user: request.authUser || null, profile, auth: getAuthConfigStatus() });
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to load user profile");
  }
});

app.get("/api/debates", async (request, response) => {
  try {
    if (!request.authUser?.id) {
      response.json({ debates: [], authenticated: false, database: getDatabaseConfigStatus() });
      return;
    }
    if (!isDatabaseConfigured()) {
      response.json({ debates: [], authenticated: true, database: getDatabaseConfigStatus() });
      return;
    }
    const debates = await listDebateProjects({ limit: request.query.limit || 30, ownerId: request.authUser.id });
    response.json({ debates, authenticated: true, database: getDatabaseConfigStatus() });
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to list debates");
  }
});

app.post("/api/debates", async (request, response) => {
  try {
    if (!requireAuth(request, response)) return;
    if (!isDatabaseConfigured()) {
      response.status(503).send("database is not configured");
      return;
    }
    const title = String(request.body?.title || "Untitled debate").trim();
    const project = await createDraftDebateProject({ ownerId: request.authUser.id, title });
    if (!project) {
      response.status(500).send("failed to create debate");
      return;
    }
    response.status(201).json(project);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to create debate");
  }
});

app.get("/api/debates/:projectId", async (request, response) => {
  try {
    if (!requireAuth(request, response)) return;
    const saved = await getDebateProject(request.params.projectId, { ownerId: request.authUser.id });
    if (!saved) {
      response.status(404).send("debate not found");
      return;
    }
    response.json(saved);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to load debate");
  }
});

app.patch("/api/debates/:projectId", async (request, response) => {
  try {
    if (!requireAuth(request, response)) return;
    const title = typeof request.body?.title === "string" ? String(request.body.title || "").trim() : "";
    const hasSpeakerDisplayNames = request.body?.speakerDisplayNames
      && typeof request.body.speakerDisplayNames === "object"
      && !Array.isArray(request.body.speakerDisplayNames);
    if (!title && !hasSpeakerDisplayNames) {
      response.status(400).send("title or speakerDisplayNames is required");
      return;
    }
    let updated = title
      ? await updateDebateProjectTitle(request.params.projectId, title, { ownerId: request.authUser.id })
      : await getDebateProject(request.params.projectId, { ownerId: request.authUser.id }).then((saved) => saved?.project || null);
    if (updated && hasSpeakerDisplayNames) {
      const speakerDisplayNames = normalizeSpeakerDisplayNames(request.body.speakerDisplayNames);
      updated = await updateDebateProjectSpeakerDisplayNames(request.params.projectId, speakerDisplayNames, { ownerId: request.authUser.id });
      for (const liveSession of liveSessions.values()) {
        if (liveSession.projectId === request.params.projectId && liveSession.ownerId === request.authUser.id) {
          liveSession.debate = normalizeClaimState({
            ...liveSession.debate,
            speakerDisplayNames
          });
        }
      }
    }
    if (!updated) {
      response.status(404).send("debate not found");
      return;
    }
    response.json(updated);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to update debate");
  }
});

app.delete("/api/debates/:projectId", async (request, response) => {
  try {
    if (!requireAuth(request, response)) return;
    const deleted = await deleteDebateProject(request.params.projectId, { ownerId: request.authUser.id });
    if (!deleted) {
      response.status(404).send("debate not found");
      return;
    }
    response.json({ deleted: true });
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to delete debate");
  }
});

// --- Sharing: create a public link, read it, import a copy --------------------
// Owner creates/fetches a share token for one of their projects.
app.post("/api/debates/:projectId/share", async (request, response) => {
  try {
    if (!requireAuth(request, response)) return;
    const shareId = await ensureProjectShareId(request.params.projectId, request.authUser.id);
    if (!shareId) {
      response.status(404).send("debate not found");
      return;
    }
    response.json({ shareId });
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to create share link");
  }
});

// Public, read-only view of a shared project (no auth required).
app.get("/api/shared/:shareId", async (request, response) => {
  try {
    const data = await getSharedProject(request.params.shareId);
    if (!data) {
      response.status(404).send("shared debate not found");
      return;
    }
    response.json(data);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to load shared debate");
  }
});

// Import a shared project into the caller's account (guest or permanent).
app.post("/api/shared/:shareId/import", async (request, response) => {
  try {
    if (!requireAuth(request, response)) return;
    const projectId = await importSharedProject(request.params.shareId, request.authUser.id);
    if (!projectId) {
      response.status(404).send("shared debate not found");
      return;
    }
    response.json({ projectId });
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "failed to import shared debate");
  }
});

app.post("/api/analyze-turn", async (request, response) => {
  try {
    const nextState = await runLivePipeline({
      ...(request.body || {}),
      newTurns: request.body?.turn ? [request.body.turn] : [],
      options: { ...(request.body?.options || {}), includeTimings: request.body?.options?.includeTimings }
    });
    response.json(nextState);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "analysis failed");
  }
});

app.post("/api/analyze-batch", async (request, response) => {
  try {
    const nextState = await runLivePipeline({ ...(request.body || {}), options: { ...(request.body?.options || {}) } });
    response.json(nextState);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "batch analysis failed");
  }
});

app.post("/api/verify-points", async (request, response) => {
  try {
    const verified = await verifyDebatePoints(request.body);
    const nextState = finalizeDirectLedgerState(verified);
    response.json(nextState);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "point verification failed");
  }
});

app.post("/api/rescore-debate", async (request, response) => {
  try {
    const inputDebate = request.body?.currentDebate || request.body;
    const nextState = rescoreDebateState(inputDebate, {
      recordingStartedAt: request.body?.recordingStartedAt || 0,
      options: request.body?.options || {}
    });
    response.json(nextState);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "debate scoring failed");
  }
});

app.post("/api/debate-report", async (request, response) => {
  const requestStartedAt = Date.now();
  try {
    const sessionId = String(request.body?.sessionId || "");
    const session = sessionId ? liveSessions.get(sessionId) : null;
    const requestDurationMs = Number(request.body?.durationMs || 0);
    if (session && Number.isFinite(requestDurationMs) && requestDurationMs > 0 && !session.stoppedDurationMs) {
      session.stoppedDurationMs = Math.max(0, Math.round(requestDurationMs));
    }
    const requestSpeakerDisplayNames = normalizeSpeakerDisplayNames(request.body?.currentDebate?.speakerDisplayNames || request.body?.speakerDisplayNames || {});
    if (session && Object.keys(requestSpeakerDisplayNames).length) {
      session.debate = normalizeClaimState({
        ...session.debate,
        speakerDisplayNames: {
          ...(session.debate?.speakerDisplayNames || {}),
          ...requestSpeakerDisplayNames
        }
      });
    }
    const logContext = { sessionId: session?.id || sessionId || "", projectId: session?.projectId || request.body?.projectId || "" };
    console.log(`[debate-report] request start ${JSON.stringify({ ...logContext })}`);
    const generatedReport = await generateDebateReport(request.body || {});
    const reportGeneratedElapsedMs = Date.now() - requestStartedAt;
    const report = attachReportGenerationTiming(generatedReport, {
      elapsedMs: reportGeneratedElapsedMs,
      measuredAt: new Date().toISOString(),
      source: "api"
    });
    console.log(`[debate-report] report generated ${JSON.stringify({ ...logContext, elapsedMs: reportGeneratedElapsedMs, reportId: report?.id || "" })}`);
    if (session) {
      const persistStartedAt = Date.now();
      await persistDebateReport({
        report,
        sessionId: session.id,
        projectId: session.projectId,
        ownerId: session.ownerId || request.authUser?.id || null,
        debate: session.debate,
        scoreHistory: session.scoreHistory,
        durationMs: sessionDurationMs(session)
      });
      console.log(`[debate-report] report persisted ${JSON.stringify({ ...logContext, elapsedMs: Date.now() - persistStartedAt, totalMs: Date.now() - requestStartedAt, reportId: report?.id || "" })}`);
    } else if (request.body?.projectId && request.authUser?.id) {
      const projectId = String(request.body.projectId);
      const ownedProject = await getDebateProject(projectId, { ownerId: request.authUser.id });
      if (ownedProject) {
        const persistStartedAt = Date.now();
        await persistDebateReport({
          report,
          sessionId: sessionId || "",
          projectId,
          ownerId: request.authUser.id,
          debate: request.body?.currentDebate || {},
          scoreHistory: request.body?.scoreHistory || [],
          durationMs: requestDurationMs
        });
        console.log(`[debate-report] report persisted ${JSON.stringify({ ...logContext, projectId, elapsedMs: Date.now() - persistStartedAt, totalMs: Date.now() - requestStartedAt, reportId: report?.id || "" })}`);
      }
    }
    response.json(report);
    console.log(`[debate-report] response sent ${JSON.stringify({ ...logContext, totalMs: Date.now() - requestStartedAt, reportId: report?.id || "" })}`);
    if (session) {
      const flushStartedAt = Date.now();
      void flushSessionPersistence(session)
        .then(() => {
          console.log(`[debate-report] background persistence flushed ${JSON.stringify({ ...logContext, elapsedMs: Date.now() - flushStartedAt })}`);
        })
        .catch((error) => {
          console.warn(`[db] report background persistence flush failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "debate report failed");
  }
});

// --- Batch ingestion: uploaded file / video URL → full report ----------------
// Upload arrives as a raw binary body (filename in the x-filename header) so we
// avoid a multipart dependency. Route-level express.raw handles large files.
app.post("/api/ingest/upload", express.raw({ type: () => true, limit: "1536mb" }), async (request, response) => {
  try {
    if (!requireAuth(request, response)) return;
    const buffer = request.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      response.status(400).send("Empty upload.");
      return;
    }
    const filename = decodeURIComponent(String(request.headers["x-filename"] || "upload"));
    const jobId = startIngestFromFile({ buffer, filename, ownerId: request.authUser?.id || null, ownerEmail: request.authUser?.email || null });
    response.json({ jobId });
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "upload failed");
  }
});

app.post("/api/ingest/url", async (request, response) => {
  try {
    if (!requireAuth(request, response)) return;
    const url = String(request.body?.url || "").trim();
    if (!url) { response.status(400).send("Missing url."); return; }
    const jobId = startIngestFromUrl({ url, ownerId: request.authUser?.id || null, ownerEmail: request.authUser?.email || null });
    response.json({ jobId });
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "url ingest failed");
  }
});

app.get("/api/ingest/:jobId", (request, response) => {
  if (!requireAuth(request, response)) return;
  const job = getIngestJob(request.params.jobId);
  if (!job) { response.status(404).send("job not found"); return; }
  response.json(job);
});

// Cancel an in-flight import (kills download/pyannote/ffmpeg).
app.post("/api/ingest/:jobId/cancel", (request, response) => {
  if (!requireAuth(request, response)) return;
  const ok = cancelIngestJob(request.params.jobId);
  response.json({ canceled: ok });
});

// "Notify me when done" → email the user's registered address on completion.
app.post("/api/ingest/:jobId/notify", (request, response) => {
  if (!requireAuth(request, response)) return;
  const ok = requestIngestEmail(request.params.jobId);
  response.json({ ok, emailConfigured: getIngestJob(request.params.jobId)?.emailConfigured ?? false });
});

app.post("/api/research", async (request, response) => {
  try {
    const trace = createTrace({
      label: request.body?.options?.label || "research",
      recordingStartedAt: request.body?.recordingStartedAt || 0
    });
    const result = await researchWithFirecrawl(request.body.prompt, trace, { agent: "Firecrawl Research Agent" });
    response.json(result);
  } catch (error) {
    response.status(500).send(error instanceof Error ? error.message : "research failed");
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/live" });

wss.on("connection", async (ws, request) => {
  const liveSessionId = randomUUID();
  const liveAuthUser = await authenticateBearerToken(getTokenFromUrl(request)).catch((error) => {
    console.warn(`[auth] live token validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  const requireLiveAuth = process.env.REQUIRE_LIVE_AUTH !== "false";
  if (requireLiveAuth && isAuthConfigured() && isDatabaseConfigured() && !liveAuthUser?.id) {
    console.warn("[auth] live websocket rejected: missing or invalid signed-in user");
    ws.send(JSON.stringify({
      type: "error",
      message: "Sign in expired. Please sign in again before recording."
    }));
    ws.close(1008, "Authentication required");
    return;
  }
  const requestedProjectId = getProjectIdFromUrl(request);
  let liveProjectId = "";
  if (requestedProjectId && liveAuthUser?.id) {
    const ownedProject = await getDebateProject(requestedProjectId, { ownerId: liveAuthUser.id }).catch((error) => {
      console.warn(`[db] live project ownership check failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (ownedProject?.project?.id) {
      if (ownedProject.project.status === "report_ready") {
        console.warn(`[db] live websocket rejected for report-ready project ${requestedProjectId}`);
        ws.send(JSON.stringify({
          type: "error",
          message: "Report already generated. Create a new debate project to record again."
        }));
        ws.close(1008, "Report already generated");
        return;
      }
      liveProjectId = requestedProjectId;
    } else {
      console.warn(`[db] ignoring unowned live project id ${requestedProjectId}`);
    }
  }
  const liveSession = createLiveSession(liveSessionId, ws, liveProjectId);
  liveSession.ownerId = liveAuthUser?.id || null;
  const turnPrefix = randomUUID();
  let resultCounter = 0;
  let audioChunks = 0;
  let audioBytes = 0;
  let transcriptEvents = 0;
  const speechStats = createSpeechmaticsStats();
  const sttProviderLabel = "Speechmatics";
  const sttProviderEventName = "speechmatics";
  const sttStatsProvider = "speechmatics";
  const packagingLogLabel = "speechmatics packaging";
  const speakerMap = new Map();
  const recoveryAudio = [];
  const pyannoteSegments = [];
  const usePyannoteLiveDiarization = config.liveDiarizationProvider === "pyannote" && config.pyannoteLiveEnabled;
  const pyannoteOnlyDiarization = usePyannoteLiveDiarization && config.pyannoteOnlyDiarization;
  let pyannoteNode = null;
  let pyannoteReady = false;
  let pyannoteAudioChunks = [];
  let pyannoteAudioBytes = 0;
  let pyannoteRunning = false;
  let pyannoteWindowSeq = 0;
  let pyannoteLastWindowAt = 0;
  let pyannoteCoverageEndSec = 0;
  let pendingSpeechGroups = [];
  let pendingSpeechWords = [];
  let pendingSpeechWordSeq = 0;
  let clientAudioSettings = null;
  let firstAudioReceivedAt = 0;
  let lastAudioReceivedAt = 0;
  let recoveryAudioBytes = 0;
  let recoveryDroppedBytes = 0;
  let speechWs = null;
  let speechReady = false;
  let speechAudioSent = 0;
  let speechEndOfStreamSent = false;
  let speechSessionSeq = 0;
  let activeSpeechSeq = 0;
  let activeSpeechTimestampOffsetSec = 0;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastCloseCode = null;
  let lastDegradedStatusAt = 0;
  let closing = false;
  let gracefulStopRequested = false;
  let transcriptionFatal = false;
  let clientPaused = false;
  let gracefulStopTimer = null;
  const speechDiarizationDrift = {
    observedRawSpeakers: new Set(),
    collapsedRawSpeaker: "",
    collapsedStartedAt: 0,
    collapsedEvents: 0,
    collapsedWords: 0,
    lastRecoveryAt: 0,
    recoveries: 0
  };

  liveSessions.set(liveSessionId, liveSession);
  liveSession.dbReady = createPersistedLiveSession({
    sessionId: liveSession.id,
    projectId: liveSession.projectId,
    startedAt: liveSession.recordingStartedAt,
    debate: liveSession.debate,
    scoreHistory: liveSession.scoreHistory,
    ownerId: liveSession.ownerId
  }).catch((error) => {
    console.warn(`[db] live session create failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  ws.send(JSON.stringify({
    type: "session_ready",
    sessionId: liveSessionId,
    projectId: liveSession.projectId,
    pipeline: liveSession.pipeline,
    analysisSchemaVersion: DIRECT_ANALYSIS_SCHEMA_VERSION
  }));
  ws.send(JSON.stringify({ type: "ready", message: "Connecting Speechmatics realtime STT" }));
  console.log("live websocket connected");
  logLiveEvent("browser_connected");
  sendSttStatus("connecting", "Connecting Speechmatics realtime STT");

  if (!config.speechmaticsApiKey) {
    ws.send(JSON.stringify({ type: "error", message: "SPEECHMATICS_API_KEY is not set on the server." }));
    ws.close();
    return;
  }

  const speechmaticsNodeConfig = createSpeechmaticsLiveSttNodeConfig(config);
  console.log("[speechmatics config]", JSON.stringify(speechmaticsNodeConfig.summary));
  logLiveEvent("speechmatics_config", speechmaticsNodeConfig.summary);
  ws.send(JSON.stringify({
    type: "diarization_status",
    status: "warming",
    message: usePyannoteLiveDiarization
      ? "Local pyannote speaker diarization starting"
      : "Speechmatics speaker diarization starting"
  }));

  if (usePyannoteLiveDiarization) startPyannoteLiveDiarization();

  connectSpeechProvider("initial");

  function connectSpeechProvider(reason) {
    connectSpeechmatics(reason);
  }

  function startPyannoteLiveDiarization() {
    try {
      pyannoteNode = createPyannoteLiveDiarizationNode(config, {
        onLog: (entry) => {
          const level = entry?.level === "warn" ? "warn" : "log";
          const text = typeof entry?.message === "string" ? entry.message : JSON.stringify(entry?.message ?? entry);
          console[level](`[pyannote live worker] ${text}`);
        }
      });
    } catch (error) {
      pyannoteNode = null;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pyannote live] failed to spawn worker: ${message}`);
      logLiveEvent("pyannote_spawn_failed", { message });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "diarization_status", status: "warming", message: "Falling back to Speechmatics speaker diarization" }));
      }
      return;
    }
    pyannoteNode.readyPromise.then((info) => {
      if (closing || ws.readyState !== WebSocket.OPEN) return;
      pyannoteReady = true;
      logLiveEvent("pyannote_ready", { device: info?.device, engine: info?.engine, loadSec: info?.loadSec });
      console.log(`[pyannote live] worker ready: ${JSON.stringify({ device: info?.device, engine: info?.engine, loadSec: info?.loadSec })}`);
      ws.send(JSON.stringify({ type: "diarization_status", status: "ready", message: "Local pyannote speaker diarization ready" }));
      maybeSchedulePyannoteWindow(false);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pyannote live] worker did not become ready: ${message}`);
      logLiveEvent("pyannote_ready_failed", { message });
      try { pyannoteNode?.stop(); } catch { /* worker may already be closing */ }
      pyannoteNode = null;
      pyannoteReady = false;
      if (!closing && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "diarization_status", status: "warming", message: "Falling back to Speechmatics speaker diarization" }));
      }
    });
  }

  function connectSpeechmatics(reason) {
    if (closing || gracefulStopRequested || transcriptionFatal || ws.readyState !== WebSocket.OPEN) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearSpeechHeartbeat();
    speechReady = false;
    speechAudioSent = 0;
    speechEndOfStreamSent = false;
    speechSessionSeq += 1;
    activeSpeechSeq = speechSessionSeq;
    activeSpeechTimestampOffsetSec = Math.max(0, (audioBytes - recoveryAudioBytes) / 32000);
    const sessionSeq = activeSpeechSeq;
    const isReconnect = reason !== "initial";
    const status = isReconnect ? (recoveryDroppedBytes > 0 ? "degraded" : "reconnecting") : "connecting";
    sendSttStatus(
      status,
      isReconnect ? "Reconnecting Speechmatics realtime STT" : "Connecting Speechmatics realtime STT",
      { sessionSeq }
    );
    logLiveEvent("speechmatics_connecting", { reason, sessionSeq, attempt: reconnectAttempt, timestampOffsetSec: activeSpeechTimestampOffsetSec });

    const child = new WebSocket(speechmaticsNodeConfig.url, {
      headers: {
        Authorization: `Bearer ${config.speechmaticsApiKey}`
      }
    });
    speechWs = child;

    child.on("open", () => {
      if (child !== speechWs || closing) return;
      console.log(`Speechmatics realtime STT connected: ${config.speechmaticsOperatingPoint}`);
      logLiveEvent("speechmatics_open", { sessionSeq, attempt: reconnectAttempt });
      try {
        child.send(JSON.stringify(speechmaticsNodeConfig.startMessage));
      } catch (error) {
        handleSpeechmaticsFailure(sessionSeq, {
          stage: "start_recognition_error",
          message: error instanceof Error ? error.message : "Speechmatics StartRecognition failed"
        });
      }
    });

    child.on("message", (raw, isBinary) => {
      if (child !== speechWs || isBinary) return;
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch (error) {
        handleSpeechmaticsFailure(sessionSeq, {
          stage: "parse_error",
          message: error instanceof Error ? error.message : "Speechmatics message parse error"
        });
        return;
      }
      if (event.message === "RecognitionStarted") {
        speechReady = true;
        reconnectAttempt = 0;
        resetSpeechDiarizationDriftState("recognition_started");
        startSpeechHeartbeat(child, sessionSeq);
        logLiveEvent("speechmatics_ready", { sessionSeq, replayBufferedMs: recoveryBufferedMs(), droppedMs: recoveryDroppedMs() });
        ws.send(JSON.stringify({ type: "ready", message: "Speechmatics realtime STT ready" }));
        ws.send(JSON.stringify({ type: "diarization_status", status: "ready", message: "Speechmatics speaker diarization ready" }));
        replayRecoveryAudio(child, sessionSeq);
        sendSttStatus("ready", "Speechmatics realtime STT ready", { sessionSeq });
        return;
      }
      if (event.message === "AddPartialTranscript") {
        speechStats.partialTranscriptEvents += 1;
        emitSpeechmaticsTranscript(event, false, sessionSeq);
        return;
      }
      if (event.message === "AddTranscript") {
        transcriptEvents += 1;
        speechStats.addTranscriptEvents += 1;
        queueSpeechmaticsFinal(event, sessionSeq);
        return;
      }
      if (event.message === "AudioAdded") {
        speechStats.audioAddedEvents = Number(speechStats.audioAddedEvents || 0) + 1;
        return;
      }
      if (event.message === "EndOfUtterance") {
        speechStats.utteranceEndEvents = Number(speechStats.utteranceEndEvents || 0) + 1;
        flushPendingSpeechGroups(false, "utterance_end");
        return;
      }
      if (event.message === "Info" || event.message === "Warning") {
        console.log(`Speechmatics ${event.message.toLowerCase()}`, event);
        return;
      }
      if (event.message === "RecognitionStarted" || event.message === "SpeechStarted") {
        speechStats.speechStartedEvents = Number(speechStats.speechStartedEvents || 0) + 1;
        return;
      }
      if (event.message === "EndOfTranscript") {
        speechStats.metadataEvents = Number(speechStats.metadataEvents || 0) + 1;
        speechStats.endOfTranscriptEvents += 1;
        flushPendingSpeechGroups(true, "end_of_transcript");
        console.log("Speechmatics realtime transcript ended");
        sendSpeechmaticsStats("end_of_transcript");
        if (gracefulStopRequested && ws.readyState === WebSocket.OPEN) {
          clearTimeout(gracefulStopTimer);
          setTimeout(() => ws.close(), 150);
        } else {
          handleSpeechmaticsFailure(sessionSeq, { stage: "end_of_transcript", message: "Speechmatics ended transcript unexpectedly" });
        }
        return;
      }
      if (event.message === "Error" || event.type || event.error) {
        const message = event.reason || event.error || event.type || event.message || "Speechmatics realtime STT error";
        console.error("Speechmatics realtime STT error", event);
        handleSpeechmaticsFailure(sessionSeq, { stage: "in_band_error", message, eventType: event.type || event.message });
      }
    });

    child.on("error", (error) => {
      if (child !== speechWs) return;
      console.error("Speechmatics realtime STT error", error);
      handleSpeechmaticsFailure(sessionSeq, {
        stage: "socket_error",
        message: error instanceof Error ? error.message : "Speechmatics realtime STT error"
      });
    });

    child.on("close", (code, reason) => {
      const closeReason = reason.toString();
      console.log(`Speechmatics realtime STT closed: ${code} ${closeReason}`);
      if (child === speechWs) {
        speechWs = null;
        speechReady = false;
        clearSpeechHeartbeat();
      }
      lastCloseCode = code;
      logLiveEvent("speechmatics_closed", { sessionSeq, code, reason: closeReason });
      if (!closing && !gracefulStopRequested && !transcriptionFatal && ws.readyState === WebSocket.OPEN) {
        handleSpeechmaticsFailure(sessionSeq, { stage: "close", code, reason: closeReason });
      }
    });
  }

  function handleSpeechmaticsFailure(sessionSeq, details = {}) {
    if (sessionSeq !== activeSpeechSeq || closing || gracefulStopRequested || transcriptionFatal || ws.readyState !== WebSocket.OPEN) return;
    if (details.code) lastCloseCode = details.code;
    if (isFatalSpeechmaticsFailure(details)) {
      transcriptionFatal = true;
      speechReady = false;
      clearSpeechHeartbeat();
      flushPendingSpeechGroups(true, `${sttProviderEventName}_fatal`);
      sendSpeechmaticsStats(`${sttProviderEventName}_fatal`);
      const message = speechmaticsFatalMessage(details);
      sendSttStatus("stopped", message, { attempt: reconnectAttempt, lastCloseCode });
      ws.send(JSON.stringify({ type: "diarization_status", status: "disabled", message: "Live transcription is unavailable right now." }));
      logLiveEvent(`${sttProviderEventName}_fatal`, {
        ...details,
        bufferedMs: recoveryBufferedMs(),
        droppedMs: recoveryDroppedMs()
      });
      if (speechWs?.readyState === WebSocket.OPEN || speechWs?.readyState === WebSocket.CONNECTING) {
        try {
          speechWs.terminate();
        } catch {
          // Already closing.
        }
      }
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, "transcription unavailable");
      }, 250);
      return;
    }
    if (reconnectTimer) return;
    speechReady = false;
    clearSpeechHeartbeat();
    flushPendingSpeechGroups(true, `${sttProviderEventName}_reconnect`);
    sendSpeechmaticsStats(`${sttProviderEventName}_reconnect`);
    if (speechWs?.readyState === WebSocket.OPEN || speechWs?.readyState === WebSocket.CONNECTING) {
      try {
        speechWs.terminate();
      } catch {
        // The close handler will handle reconnect scheduling if terminate races.
      }
    }
    scheduleSpeechmaticsReconnect(details);
  }

  function scheduleSpeechmaticsReconnect(details = {}) {
    if (closing || gracefulStopRequested || transcriptionFatal || ws.readyState !== WebSocket.OPEN || reconnectTimer) return;
    reconnectAttempt += 1;
    const delayMs = Math.min(
      Math.max(100, config.speechmaticsReconnectInitialMs) * 2 ** Math.max(0, reconnectAttempt - 1),
      Math.max(config.speechmaticsReconnectInitialMs, config.speechmaticsReconnectMaxMs)
    );
    const status = recoveryDroppedBytes > 0 ? "degraded" : "reconnecting";
    const message = status === "degraded"
      ? "Transcription reconnecting; recording continues, but a transcript gap is possible."
      : "Transcription reconnecting; recording continues.";
    sendSttStatus(status, message, { attempt: reconnectAttempt, lastCloseCode });
    logLiveEvent(`${sttProviderEventName}_reconnect_scheduled`, {
      ...details,
      attempt: reconnectAttempt,
      delayMs,
      bufferedMs: recoveryBufferedMs(),
      droppedMs: recoveryDroppedMs()
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSpeechProvider("reconnect");
    }, delayMs);
  }

  function isFatalSpeechmaticsFailure(details = {}) {
    const text = `${details.message || ""} ${details.reason || ""} ${details.eventType || ""} ${details.code || ""}`.toLowerCase();
    return text.includes("audio usage exceeded")
      || text.includes("timelimit_exceeded")
      || text.includes("usage exceeded")
      || text.includes("quota")
      || text.includes("unauthorized")
      || text.includes("forbidden")
      || text.includes("invalid api key")
      || text.includes("authentication")
      || text.includes("401")
      || text.includes("403")
      || text.includes("data-0000")
      || text.includes("payload cannot be decoded");
  }

  function speechmaticsFatalMessage(details = {}) {
    const text = `${details.message || ""} ${details.reason || ""} ${details.eventType || ""}`.toLowerCase();
    if (text.includes("audio usage exceeded") || text.includes("timelimit_exceeded") || text.includes("usage exceeded") || text.includes("quota")) {
      return "Live transcription is unavailable right now.";
    }
    if (text.includes("unauthorized") || text.includes("forbidden") || text.includes("invalid api key")) {
      return "Live transcription is unavailable right now.";
    }
    return "Live transcription is unavailable right now.";
  }

  function startSpeechHeartbeat(child, sessionSeq) {
    clearSpeechHeartbeat();
    const keepAliveMs = config.speechmaticsHeartbeatMs;
    if (!keepAliveMs || keepAliveMs <= 0) return;
    heartbeatTimer = setInterval(() => {
      if (child !== speechWs || child.readyState !== WebSocket.OPEN || closing || gracefulStopRequested) {
        clearSpeechHeartbeat();
        return;
      }
      try {
        child.ping();
      } catch (error) {
        handleSpeechmaticsFailure(sessionSeq, {
          stage: "heartbeat_error",
          message: error instanceof Error ? error.message : `${sttProviderLabel} keepalive failed`
        });
      }
    }, keepAliveMs);
  }

  function clearSpeechHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  ws.on("message", (message, isBinary) => {
    if (!isBinary) {
      const handled = handleClientControlMessage(message);
      if (handled) return;
    }
    if (clientPaused) return;
    const audio = message;
    const audioBuffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
    const size = audioBuffer.length;
    audioChunks += 1;
    audioBytes += size;
    const now = Date.now();
    if (!firstAudioReceivedAt) firstAudioReceivedAt = now;
    lastAudioReceivedAt = now;
    const rms = calculatePcmRms(audioBuffer);
    const chunkDurationMs = Math.round(size / 32);
    const pcmSeconds = Number((audioBytes / 32000).toFixed(3));
    const wallMs = Math.max(1, lastAudioReceivedAt - firstAudioReceivedAt);
    const byteRate = Math.round(audioBytes / (wallMs / 1000));
    if (audioChunks === 1 || audioChunks % 5 === 0) {
      ws.send(JSON.stringify({ type: "audio_ack", chunks: audioChunks, bytes: audioBytes, rms, chunkDurationMs, pcmSeconds, byteRate }));
      console.log(`audio chunk ${audioChunks}, total ${audioBytes} bytes, rms ${rms}`);
    }
    if (audioChunks === 1 || audioChunks % 50 === 0) {
      console.log(`[live-audio-stats] ${JSON.stringify({
        chunks: audioChunks,
        bytes: audioBytes,
        chunkBytes: size,
        chunkDurationMs,
        pcmSeconds,
        byteRate,
        expectedByteRate: 32000,
        wallMs,
        clientAudioContextSampleRate: clientAudioSettings?.audioContextSampleRate,
        clientMicSampleRate: clientAudioSettings?.trackSettings?.sampleRate,
        clientMicChannelCount: clientAudioSettings?.trackSettings?.channelCount
      })}`);
    }
    if (speechReady && speechWs?.readyState === WebSocket.OPEN) {
      const sent = sendSpeechAudio(audioBuffer);
      if (!sent) bufferRecoveryAudio(audioBuffer);
    } else {
      bufferRecoveryAudio(audioBuffer);
    }
    appendPyannoteAudio(audioBuffer);
  });

  ws.on("close", () => {
    closing = true;
    if (liveSession.pauseStartedAt) {
      liveSession.pausedMs += Math.max(0, Date.now() - liveSession.pauseStartedAt);
      liveSession.pauseStartedAt = 0;
    }
    liveSession.ws = null;
    liveSession.closedAt = liveSession.stoppedAt || Date.now();
    queueSessionPersistence(liveSession, "mark session stopped", () => markSessionStopped({
      sessionId: liveSession.id,
      projectId: liveSession.projectId,
      endedAt: liveSession.closedAt,
      durationMs: sessionDurationMs(liveSession),
      status: liveSession.reportStatus === "ready" ? "report_ready" : "stopped",
      diagnostics: {
        chunks: audioChunks,
        bytes: audioBytes,
        transcriptEvents,
        manual: gracefulStopRequested,
        speechStats
      }
    }));
    clearTimeout(liveSession.analysisTimer);
    liveSession.analysisTimer = null;
    scheduleLiveSessionCleanup(liveSession);
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearSpeechHeartbeat();
    pyannoteNode?.stop();
    pyannoteNode = null;
    clearTimeout(gracefulStopTimer);
    rebuildPendingSpeechGroups("client_close", { terminal: true });
    speechStats.pendingGroupsAtClose = pendingSpeechGroups.length;
    speechStats.pendingWordsAtClose = pendingSpeechWords.length;
    flushPendingSpeechGroups(true, "client_close");
    sendSpeechmaticsStats("client_close");
    logLiveEvent("browser_closed", {
      chunks: audioChunks,
      bytes: audioBytes,
      transcriptEvents,
      manual: gracefulStopRequested,
      bufferedMs: recoveryBufferedMs(),
      droppedMs: recoveryDroppedMs()
    });
    console.log(`live websocket closed after ${audioChunks} chunks, ${audioBytes} bytes, ${transcriptEvents} ${sttProviderLabel} final transcript event(s)`);
    console.log(`[${packagingLogLabel} summary] ${JSON.stringify(speechStats)}`);
    const closingSpeechWs = speechWs;
    if (closingSpeechWs?.readyState === WebSocket.OPEN) {
      sendSpeechEndOfStream(closingSpeechWs);
      setTimeout(() => {
        if (closingSpeechWs.readyState === WebSocket.OPEN || closingSpeechWs.readyState === WebSocket.CLOSING) {
          closingSpeechWs.close();
        }
      }, 750);
    } else if (closingSpeechWs?.readyState === WebSocket.CONNECTING) {
      closingSpeechWs.terminate();
    }
  });

  function handleClientControlMessage(message) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(message) ? message.toString() : String(message));
    } catch {
      return false;
    }
    if (parsed?.type === "pause") {
      clientPaused = true;
      const now = Date.now();
      if (!liveSession.pauseStartedAt) liveSession.pauseStartedAt = now;
      liveSession.updatedAt = now;
      logLiveEvent("client_pause", {
        elapsedMs: Number(parsed.elapsedMs || 0),
        chunks: audioChunks,
        bytes: audioBytes
      });
      return true;
    }
    if (parsed?.type === "resume") {
      const now = Date.now();
      if (liveSession.pauseStartedAt) {
        liveSession.pausedMs += Math.max(0, now - liveSession.pauseStartedAt);
      }
      liveSession.pauseStartedAt = 0;
      liveSession.updatedAt = now;
      clientPaused = false;
      logLiveEvent("client_resume", {
        elapsedMs: Number(parsed.elapsedMs || 0),
        pausedMs: liveSession.pausedMs,
        chunks: audioChunks,
        bytes: audioBytes
      });
      return true;
    }
    if (parsed?.type === "audio_settings") {
      clientAudioSettings = sanitizeClientAudioSettings(parsed);
      console.log(`[live-audio-config] ${JSON.stringify(clientAudioSettings)}`);
      logLiveEvent("audio_settings", clientAudioSettings);
      return true;
    }
    if (parsed?.type === "audio_channel_stats") {
      const stats = sanitizeClientAudioChannelStats(parsed);
      console.log(`[live-audio-channel-stats] ${JSON.stringify(stats)}`);
      logLiveEvent("audio_channel_stats", stats);
      return true;
    }
    if (parsed?.type !== "stop") return false;
    const now = Date.now();
    if (liveSession.pauseStartedAt) {
      liveSession.pausedMs += Math.max(0, now - liveSession.pauseStartedAt);
      liveSession.pauseStartedAt = 0;
    }
    const clientElapsedMs = Number(parsed.elapsedMs || parsed.durationMs || 0);
    liveSession.stoppedAt = now;
    if (Number.isFinite(clientElapsedMs) && clientElapsedMs > 0) {
      liveSession.stoppedDurationMs = Math.max(0, Math.round(clientElapsedMs));
    }
    liveSession.updatedAt = now;
    clientPaused = false;
    requestGracefulStop("client_stop");
    return true;
  }

  function requestGracefulStop(reason) {
    if (gracefulStopRequested) return;
    gracefulStopRequested = true;
    closing = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearSpeechHeartbeat();
    speechStats.stopRequests += 1;
    sendSttStatus("stopped", "Stopping live transcription");
    rebuildPendingSpeechGroups("stop_requested");
    console.log(`[${packagingLogLabel}] ${JSON.stringify({ stage: "stop_requested", reason, pendingGroups: pendingSpeechGroups.length, pendingWords: pendingSpeechWords.length })}`);
    logLiveEvent("stop_requested", { reason, pendingGroups: pendingSpeechGroups.length, pendingWords: pendingSpeechWords.length });
    if (speechWs?.readyState === WebSocket.OPEN) {
      sendSpeechEndOfStream(speechWs);
    }
    gracefulStopTimer = setTimeout(() => {
      const finish = () => {
        sendSpeechmaticsStats("stop_timeout");
        if (ws.readyState === WebSocket.OPEN) ws.close();
      };
      if (usePyannoteLiveDiarization && pyannoteNode) {
        pyannoteNode.flushTurns(true)
          .then((res) => emitWorkerTurns(res?.turns || []))
          .catch(() => { /* worker gone; nothing to flush */ })
          .finally(finish);
      } else {
        flushPendingSpeechGroups(true, "stop_timeout");
        finish();
      }
    }, 2500);
  }

  function sendSpeechAudio(audioBuffer) {
    if (!audioBuffer || speechWs?.readyState !== WebSocket.OPEN) return false;
    try {
      speechWs.send(audioBuffer);
      speechAudioSent += 1;
      return true;
    } catch (error) {
      handleSpeechmaticsFailure(activeSpeechSeq, {
        stage: "send_audio_error",
        message: error instanceof Error ? error.message : `${sttProviderLabel} audio send failed`
      });
      return false;
    }
  }

  function sendSpeechEndOfStream(child = speechWs) {
    if (!child || child.readyState !== WebSocket.OPEN) return false;
    if (speechEndOfStreamSent) return true;
    try {
      child.send(JSON.stringify({ message: "EndOfStream", last_seq_no: speechAudioSent }));
      speechEndOfStreamSent = true;
      return true;
    } catch (error) {
      handleSpeechmaticsFailure(activeSpeechSeq, {
        stage: "end_of_stream_error",
        message: error instanceof Error ? error.message : "Speechmatics EndOfStream failed"
      });
      return false;
    }
  }

  function bufferRecoveryAudio(audioBuffer) {
    if (!audioBuffer?.length) return;
    const copy = Buffer.from(audioBuffer);
    recoveryAudio.push(copy);
    recoveryAudioBytes += copy.length;
    trimRecoveryAudio();
    speechStats.recoveryBufferedBytes = recoveryAudioBytes;
    speechStats.recoveryDroppedBytes = recoveryDroppedBytes;
  }

  function trimRecoveryAudio() {
    const limitBytes = Math.max(0, config.speechmaticsRecoveryBufferMs) * 32;
    while (limitBytes > 0 && recoveryAudioBytes > limitBytes && recoveryAudio.length) {
      const dropped = recoveryAudio.shift();
      recoveryAudioBytes -= dropped.length;
      recoveryDroppedBytes += dropped.length;
    }
    if (limitBytes === 0 && recoveryAudio.length) {
      while (recoveryAudio.length) {
        const dropped = recoveryAudio.shift();
        recoveryAudioBytes -= dropped.length;
        recoveryDroppedBytes += dropped.length;
      }
    }
    if (recoveryDroppedBytes > 0 && Date.now() - lastDegradedStatusAt > 2000 && !closing && ws.readyState === WebSocket.OPEN) {
      lastDegradedStatusAt = Date.now();
      sendSttStatus("degraded", "Transcription reconnecting; recording continues, but a transcript gap is possible.");
      logLiveEvent(`${sttProviderEventName}_recovery_buffer_dropped`, {
        bufferedMs: recoveryBufferedMs(),
        droppedMs: recoveryDroppedMs()
      });
    }
  }

  function replayRecoveryAudio(child, sessionSeq) {
    if (child !== speechWs || child.readyState !== WebSocket.OPEN || recoveryAudio.length === 0) return;
    const bufferedChunks = recoveryAudio.splice(0);
    const bufferedBytes = recoveryAudioBytes;
    recoveryAudioBytes = 0;
    speechStats.recoveryBufferedBytes = 0;
    logLiveEvent(`${sttProviderEventName}_replay_buffer`, {
      sessionSeq,
      chunks: bufferedChunks.length,
      bytes: bufferedBytes,
      bufferedMs: Math.round(bufferedBytes / 32),
      droppedMs: recoveryDroppedMs()
    });
    for (const audioBuffer of bufferedChunks) {
      if (child !== speechWs || child.readyState !== WebSocket.OPEN) {
        bufferRecoveryAudio(audioBuffer);
        break;
      }
      if (!sendSpeechAudio(audioBuffer)) {
        bufferRecoveryAudio(audioBuffer);
        break;
      }
    }
  }

  function recoveryBufferedMs() {
    return Math.round(recoveryAudioBytes / 32);
  }

  function recoveryDroppedMs() {
    return Math.round(recoveryDroppedBytes / 32);
  }

  function appendPyannoteAudio(audioBuffer) {
    if (!pyannoteNode || !audioBuffer?.length) return;
    const copy = Buffer.from(audioBuffer);
    pyannoteAudioChunks.push(copy);
    pyannoteAudioBytes += copy.length;
    trimPyannoteAudioBuffer();
    maybeSchedulePyannoteWindow(false);
  }

  function trimPyannoteAudioBuffer() {
    const limitBytes = Math.max(0, config.pyannoteLiveMaxBufferMs || 0) * 32;
    if (!limitBytes) {
      pyannoteAudioChunks = [];
      pyannoteAudioBytes = 0;
      return;
    }
    while (pyannoteAudioBytes > limitBytes && pyannoteAudioChunks.length) {
      const dropped = pyannoteAudioChunks.shift();
      pyannoteAudioBytes -= dropped.length;
    }
  }

  function maybeSchedulePyannoteWindow(force = false) {
    if (!pyannoteNode || !pyannoteReady || pyannoteRunning || (!force && closing) || pyannoteAudioBytes <= 0) return;
    const now = Date.now();
    const bufferedMs = Math.round(pyannoteAudioBytes / 32);
    const audioElapsedMs = Math.round(audioBytes / 32);
    const bootstrapUntilMs = Math.max(0, Number(config.pyannoteLiveBootstrapUntilMs || 0));
    const firstWindow = pyannoteWindowSeq === 0;
    const bootstrapMode = !force && (firstWindow || audioElapsedMs <= bootstrapUntilMs);
    const scheduleMode = force ? "force" : bootstrapMode ? "bootstrap" : "rolling";
    const configuredWindowMs = force
      ? Math.max(1000, Number(config.pyannoteLiveRollingWindowMs || config.pyannoteLiveWindowMs || 15000))
      : bootstrapMode
        ? Math.max(1000, Number(config.pyannoteLiveBootstrapWindowMs || 8000))
        : Math.max(1000, Number(config.pyannoteLiveRollingWindowMs || config.pyannoteLiveWindowMs || 15000));
    const configuredIntervalMs = bootstrapMode
      ? Math.max(500, Number(config.pyannoteLiveBootstrapIntervalMs || 2000))
      : Math.max(500, Number(config.pyannoteLiveRollingIntervalMs || config.pyannoteLiveIntervalMs || 4000));
    const minAudioMs = force
      ? Math.min(1000, Math.max(0, config.pyannoteLiveMinAudioMs || 0))
      : Math.min(configuredWindowMs, Math.max(0, config.pyannoteLiveMinAudioMs || 0));
    if (bufferedMs < minAudioMs) return;
    if (!force && pyannoteLastWindowAt && now - pyannoteLastWindowAt < configuredIntervalMs) return;

    const effectiveWindowMs = firstWindow
      ? Math.max(
        configuredWindowMs,
        Number(config.pyannoteLiveRollingWindowMs || config.pyannoteLiveWindowMs || 0),
        Number(config.pyannoteLiveColdStartWindowMs || 0)
      )
      : configuredWindowMs;
    const windowBytes = Math.min(
      pyannoteAudioBytes,
      Math.max(3200, Math.round(effectiveWindowMs * 32))
    );
    const windowAudio = pyannoteTailBuffer(windowBytes);
    if (!windowAudio.length) return;

    const windowEndSec = Math.max(0, audioBytes / 32000);
    const windowStartSec = Math.max(0, windowEndSec - windowAudio.length / 32000);
    const seq = ++pyannoteWindowSeq;
    pyannoteRunning = true;
    pyannoteLastWindowAt = now;
    speechStats.pyannoteWindowsStarted += 1;
    console.log(`[pyannote live] ${JSON.stringify({ stage: "window_start", seq, windowStartSec, windowEndSec, bytes: windowAudio.length, force, scheduleMode, firstWindow, configuredWindowMs, effectiveWindowMs, configuredIntervalMs, bufferedMs })}`);
    logLiveEvent("pyannote_window_start", { seq, windowStartSec, windowEndSec, bytes: windowAudio.length, force, scheduleMode, firstWindow, configuredWindowMs, effectiveWindowMs, configuredIntervalMs, bufferedMs });

    pyannoteNode.diarizePcm16Window({
      audioBuffer: windowAudio,
      sampleRate: config.speechmaticsSampleRate || config.pyannoteSampleRate || 16000,
      windowStartSec
    }).then((result) => {
      pyannoteCoverageEndSec = Math.max(pyannoteCoverageEndSec, Number(result?.coverageEndSec || 0));
      speechStats.pyannoteWindowsCompleted += 1;
      // Worker owns assignment now: emit any turns it flushed as coverage advanced.
      emitWorkerTurns(result?.turns || []);
    }).catch((error) => {
      speechStats.pyannoteWindowErrors += 1;
      const message = error instanceof Error ? error.message : "pyannote live diarization failed";
      console.warn(`[pyannote live] ${JSON.stringify({ stage: "window_error", seq, message })}`);
      logLiveEvent("pyannote_window_error", { seq, message });
    }).finally(() => {
      pyannoteRunning = false;
      if (!closing && !gracefulStopRequested) maybeSchedulePyannoteWindow(false);
    });
  }

  function pyannoteTailBuffer(byteCount) {
    let remaining = byteCount;
    const parts = [];
    for (let index = pyannoteAudioChunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = pyannoteAudioChunks[index];
      const take = Math.min(remaining, chunk.length);
      parts.unshift(take === chunk.length ? chunk : chunk.subarray(chunk.length - take));
      remaining -= take;
    }
    return Buffer.concat(parts);
  }

  function handlePyannoteWindowResult(result = {}, window = {}) {
    const rawSegments = Array.isArray(result.exclusiveSpeakerDiarization)
      ? result.exclusiveSpeakerDiarization
      : Array.isArray(result.segments)
        ? result.segments
        : [];
    const normalizedSegments = rawSegments
      .map((segment) => ({
        startSec: Number(segment.start ?? segment.startSec),
        endSec: Number(segment.end ?? segment.endSec),
        rawSpeaker: String(segment.speaker ?? segment.rawSpeaker ?? "").trim()
      }))
      .filter((segment) => Number.isFinite(segment.startSec) && Number.isFinite(segment.endSec) && segment.endSec > segment.startSec && segment.rawSpeaker);

    const byRawSpeaker = new Map();
    for (const segment of normalizedSegments) {
      const items = byRawSpeaker.get(segment.rawSpeaker) || [];
      items.push(segment);
      byRawSpeaker.set(segment.rawSpeaker, items);
    }
    const speakerByRaw = new Map();
    const claimedStableSpeakers = new Set();
    const rawSpeakerMap = [];
    const rawSpeakerEntries = Array.from(byRawSpeaker.entries())
      .sort((left, right) => totalSegmentDurationSec(right[1]) - totalSegmentDurationSec(left[1]) || left[0].localeCompare(right[0]));
    for (const [rawSpeaker, segments] of rawSpeakerEntries) {
      const assignment = stablePyannoteSpeakerId(rawSpeaker, segments, claimedStableSpeakers);
      speakerByRaw.set(rawSpeaker, assignment.speakerId);
      claimedStableSpeakers.add(assignment.speakerId);
      rawSpeakerMap.push({
        rawSpeaker,
        speakerId: assignment.speakerId,
        match: assignment.match,
        overlapSec: roundSeconds(assignment.overlapSec || 0),
        overlapSpeakerId: assignment.overlapSpeakerId || "",
        segments: segments.length,
        durationSec: roundSeconds(totalSegmentDurationSec(segments))
      });
    }
    const stableSegments = normalizedSegments.map((segment) => ({
      ...segment,
      speakerId: speakerByRaw.get(segment.rawSpeaker)
    }));

    const windowStartSec = Number(window.windowStartSec || 0);
    const windowEndSec = Number(window.windowEndSec || 0);
    const retainedSegments = pyannoteSegments.filter((segment) => (
      segment.endSec < windowStartSec + 0.05 || segment.startSec > windowEndSec - 0.05
    ));
    pyannoteSegments.length = 0;
    pyannoteSegments.push(...retainedSegments, ...stableSegments);
    pyannoteSegments.sort((left, right) => left.startSec - right.startSec || left.endSec - right.endSec);

    const pruneBeforeSec = Math.max(0, audioBytes / 32000 - Math.max(30, (config.pyannoteLiveMaxBufferMs || 120000) / 1000));
    while (pyannoteSegments.length && pyannoteSegments[0].endSec < pruneBeforeSec) {
      pyannoteSegments.shift();
    }
    const maxStableEnd = stableSegments.reduce((max, segment) => Math.max(max, segment.endSec), 0);
    pyannoteCoverageEndSec = Math.max(pyannoteCoverageEndSec, maxStableEnd || windowEndSec);
    speechStats.pyannoteWindowsCompleted += 1;

    const details = {
      seq: window.seq,
      windowStartSec,
      windowEndSec,
      coverageEndSec: pyannoteCoverageEndSec,
      segments: stableSegments.length,
      rawSpeakers: byRawSpeaker.size,
      stableSpeakers: uniqueStrings(stableSegments.map((segment) => segment.speakerId)).length,
      rawSpeakerMap,
      diarizationSec: result.timings?.diarizationSec
    };
    console.log(`[pyannote live] ${JSON.stringify({ stage: "window_done", ...details })}`);
    logLiveEvent("pyannote_window_done", details);
  }

  function stablePyannoteSpeakerId(rawSpeaker, currentSegments = [], claimedStableSpeakers = new Set()) {
    const overlapBySpeaker = new Map();
    for (const current of currentSegments) {
      for (const previous of pyannoteSegments) {
        const overlap = overlapSeconds(current, previous);
        if (overlap <= 0.05) continue;
        overlapBySpeaker.set(previous.speakerId, (overlapBySpeaker.get(previous.speakerId) || 0) + overlap);
      }
    }
    const overlapCandidates = Array.from(overlapBySpeaker.entries())
      .sort((left, right) => right[1] - left[1]);
    const [bestSpeakerId = "", bestOverlap = 0] = overlapCandidates[0] || [];

    const mapKey = `pyannote:${normalizeSpeechmaticsRawSpeaker(rawSpeaker)}`;
    const minStableOverlapSec = Number.isFinite(config.pyannoteStableOverlapSec)
      ? Math.max(0, config.pyannoteStableOverlapSec)
      : 0.75;
    for (const [speakerId, overlap] of overlapCandidates) {
      if (claimedStableSpeakers.has(speakerId)) continue;
      if (overlap >= minStableOverlapSec) {
        speakerMap.set(mapKey, speakerId);
        return { speakerId, match: "overlap", overlapSec: overlap, overlapSpeakerId: speakerId };
      }
    }

    const previousSpeakerId = speakerMap.get(mapKey);
    if (previousSpeakerId && !claimedStableSpeakers.has(previousSpeakerId)) {
      return {
        speakerId: previousSpeakerId,
        match: "previous-map",
        overlapSec: overlapBySpeaker.get(previousSpeakerId) || 0,
        overlapSpeakerId: previousSpeakerId
      };
    }

    const speakerId = allocateStableSpeakerId(claimedStableSpeakers);
    speakerMap.set(mapKey, speakerId);
    return {
      speakerId,
      match: bestSpeakerId && claimedStableSpeakers.has(bestSpeakerId) ? "new-collision" : "new",
      overlapSec: bestOverlap,
      overlapSpeakerId: bestSpeakerId
    };
  }

  function allocateStableSpeakerId(claimedStableSpeakers = new Set()) {
    const usedSpeakerIds = new Set([...speakerMap.values(), ...claimedStableSpeakers]);
    for (let index = 1; index < 1000; index += 1) {
      const speakerId = `Speaker ${index}`;
      if (!usedSpeakerIds.has(speakerId)) return speakerId;
    }
    return `Speaker ${usedSpeakerIds.size + 1}`;
  }

  function totalSegmentDurationSec(segments = []) {
    return segments.reduce((total, segment) => total + Math.max(0, Number(segment.endSec || 0) - Number(segment.startSec || 0)), 0);
  }

  function roundSeconds(value) {
    return Number((Number(value) || 0).toFixed(3));
  }

  function rebuildPendingSpeechGroups(reason = "normal", options = {}) {
    const droppedUnassignedWords = discardPyannoteUnassignedPendingWords(reason, options);
    pendingSpeechGroups = coalesceAdjacentSpeakerGroups(smoothPyannoteMicroTurns(groupPendingWordsByCurrentDiarization(pendingSpeechWords)));
    speechStats.wordLedgerWords = pendingSpeechWords.length;
    speechStats.wordLedgerGroups = pendingSpeechGroups.length;
    speechStats.pyannoteCoverageLagSec = pyannoteNode
      ? Number(Math.max(0, audioBytes / 32000 - pyannoteCoverageEndSec).toFixed(3))
      : 0;
    if (reason === "pyannote_result" && pendingSpeechWords.length) {
      const assignedWords = pendingSpeechWords.filter((word) => findPyannoteSegmentForWord(word)).length;
      console.log(`[${packagingLogLabel}] ${JSON.stringify({
        stage: "word_ledger_rebuilt",
        reason,
        pendingWords: pendingSpeechWords.length,
        pendingGroups: pendingSpeechGroups.length,
        assignedWords,
        unassignedWords: Math.max(0, pendingSpeechWords.length - assignedWords),
        droppedUnassignedWords,
        coverageEndSec: pyannoteCoverageEndSec,
        coverageLagSec: speechStats.pyannoteCoverageLagSec
      })}`);
    }
    return pendingSpeechGroups;
  }

  function groupPendingWordsByCurrentDiarization(words = []) {
    const output = [];
    for (const word of words) {
      const fallbackSpeakerId = word.fallbackSpeakerId || SPEECHMATICS_UNASSIGNED_SPEAKER_ID;
      const fallbackRawSpeaker = word.fallbackRawSpeaker || word.rawSpeaker || SPEECHMATICS_UNASSIGNED_RAW_SPEAKER;
      const match = findPyannoteSegmentForWord(word);
      if (!match && pyannoteOnlyDiarization) continue;
      const speakerId = match?.speakerId || fallbackSpeakerId;
      const speakerSource = match ? "pyannote" : (word.fallbackSpeakerSource || speakerSourceForSttSegment({ speakerId }, sttStatsProvider));
      const rawSpeaker = match ? `pyannote:${match.rawSpeaker}` : fallbackRawSpeaker;
      appendHybridWordGroup(output, {
        group: word,
        speakerId,
        speakerSource,
        word: {
          ...word,
          rawSpeaker,
          fallbackRawSpeaker,
          fallbackSpeakerId,
          diarizationSource: speakerSource
        }
      });
    }
    return output;
  }

  function appendHybridWordGroup(output, { group = {}, speakerId, speakerSource, word }) {
    const now = Date.now();
    const queuedAt = Number(group.queuedAt || group.firstQueuedAt || now);
    const firstQueuedAt = Number(group.firstQueuedAt || group.queuedAt || now);
    const lastQueuedAt = Number(group.lastQueuedAt || group.queuedAt || now);
    const eventSeq = Number.isFinite(Number(word.eventSeq ?? group.eventSeq)) ? Number(word.eventSeq ?? group.eventSeq) : null;
    const last = output.at(-1);
    if (canCoalesceWordGroups(last, { speakerId, speakerSource, eventSeq })) {
      last.words.push(word);
      last.rawSpeakers = uniqueStrings([...(last.rawSpeakers || []), word.rawSpeaker]);
      if (word.rawSpeaker === SPEECHMATICS_UNASSIGNED_RAW_SPEAKER) last.unassignedWords = Number(last.unassignedWords || 0) + 1;
      last.firstQueuedAt = Math.min(Number(last.firstQueuedAt || firstQueuedAt), firstQueuedAt);
      last.lastQueuedAt = Math.max(Number(last.lastQueuedAt || lastQueuedAt), lastQueuedAt);
      if (last.eventSeq !== eventSeq) last.eventSeq = null;
      return;
    }
    output.push({
      speakerId,
      speakerSource,
      words: [word],
      rawSpeakers: [word.rawSpeaker],
      unassignedWords: word.rawSpeaker === SPEECHMATICS_UNASSIGNED_RAW_SPEAKER ? 1 : 0,
      eventSeq,
      queuedAt,
      firstQueuedAt,
      lastQueuedAt
    });
  }

  function canCoalesceWordGroups(left, right = {}) {
    if (!left) return false;
    if (left.speakerId !== right.speakerId || left.speakerSource !== right.speakerSource) return false;
    if (left.speakerSource === "pyannote" || left.speakerSource === "speechmatics") return true;
    const leftEventSeq = Number(left.eventSeq);
    const rightEventSeq = Number(right.eventSeq);
    if (!Number.isFinite(leftEventSeq) || !Number.isFinite(rightEventSeq)) return true;
    return leftEventSeq === rightEventSeq;
  }

  function removePendingSpeechWords(words = []) {
    const ids = new Set((words || []).map((word) => word.pendingWordId).filter(Boolean));
    if (!ids.size) return;
    pendingSpeechWords = pendingSpeechWords.filter((word) => !ids.has(word.pendingWordId));
  }

  function isPyannoteFallbackGroup(group = {}) {
    return Boolean(pyannoteNode) && !pyannoteOnlyDiarization && group.speakerSource !== "pyannote";
  }

  function discardPyannoteUnassignedPendingWords(reason = "normal", options = {}) {
    if (!pyannoteOnlyDiarization || !pendingSpeechWords.length) return 0;
    const terminal = Boolean(options.terminal);
    const graceSec = Math.max(0.5, PYANNOTE_BOUNDARY_GUARD_SEC * 4);
    const kept = [];
    const dropped = [];
    for (const word of pendingSpeechWords) {
      if (findPyannoteSegmentForWord(word)) {
        kept.push(word);
        continue;
      }
      const endSec = Number(word.endSec ?? word.startSec);
      const coveredWithoutAssignment = Number.isFinite(endSec)
        && pyannoteCoverageEndSec > 0
        && endSec <= pyannoteCoverageEndSec - graceSec;
      if (terminal || coveredWithoutAssignment) {
        dropped.push(word);
      } else {
        kept.push(word);
      }
    }
    if (!dropped.length) return 0;
    pendingSpeechWords = kept;
    speechStats.pyannoteDroppedUnassignedWords += dropped.length;
    console.log(`[${packagingLogLabel}] ${JSON.stringify({
      stage: "drop_pyannote_unassigned",
      source: reason,
      reason: terminal ? "terminal_no_pyannote_assignment" : "covered_no_pyannote_assignment",
      words: dropped.length,
      pendingWords: pendingSpeechWords.length,
      pyannoteCoverageEndSec,
      preview: joinWords(dropped.map((word) => word.word)).slice(0, 160)
    })}`);
    return dropped.length;
  }

  function capFallbackGroup(group = {}) {
    if (!isPyannoteFallbackGroup(group)) return group;
    const words = Array.isArray(group.words) ? group.words : [];
    if (!words.length) return group;
    const maxWords = Math.max(1, PYANNOTE_FALLBACK_MAX_WORDS);
    const maxMs = Math.max(500, PYANNOTE_FALLBACK_MAX_MS);
    let take = Math.min(words.length, maxWords);
    for (let count = 1; count <= Math.min(words.length, maxWords); count += 1) {
      const durationMs = speechGroupDebateMs({ words: words.slice(0, count) });
      if (durationMs && durationMs > maxMs) {
        take = Math.max(1, count - 1);
        break;
      }
      take = count;
    }
    const slicedWords = words.slice(0, take);
    const summary = summarizeSpeechmaticsWords(slicedWords);
    return {
      ...group,
      words: slicedWords,
      rawSpeakers: summary.labels,
      unassignedWords: summary.unassignedWords,
      firstQueuedAt: Number(slicedWords[0]?.firstQueuedAt || slicedWords[0]?.queuedAt || group.firstQueuedAt || group.queuedAt || Date.now()),
      lastQueuedAt: Number(slicedWords.at(-1)?.lastQueuedAt || slicedWords.at(-1)?.queuedAt || group.lastQueuedAt || group.queuedAt || Date.now())
    };
  }

  function findPyannoteSegmentForWord(word = {}) {
    if (!pyannoteSegments.length) return null;
    const startSec = Number(word.startSec);
    const endSec = Number(word.endSec);
    if (!Number.isFinite(startSec) && !Number.isFinite(endSec)) return null;
    const start = Number.isFinite(startSec) ? startSec : endSec;
    const end = Number.isFinite(endSec) ? endSec : startSec;
    const wordSpan = Math.max(0.001, end - start);
    let best = null;
    let bestOverlap = 0;
    for (const segment of pyannoteSegments) {
      const overlap = overlapSeconds({ startSec: start, endSec: end }, segment);
      if (overlap > bestOverlap) {
        best = segment;
        bestOverlap = overlap;
      }
    }
    if (best && bestOverlap >= Math.min(wordSpan * 0.5, Math.max(PYANNOTE_MIN_WORD_OVERLAP_SEC, 0.005))) return best;
    const midpoint = (start + end) / 2;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const segment of pyannoteSegments) {
      const distance = midpoint < segment.startSec
        ? segment.startSec - midpoint
        : midpoint > segment.endSec
          ? midpoint - segment.endSec
          : 0;
      if (distance < nearestDistance) {
        nearest = segment;
        nearestDistance = distance;
      }
    }
    return nearestDistance <= Math.max(0, PYANNOTE_BOUNDARY_GUARD_SEC) ? nearest : null;
  }

  function shouldHoldGroupForPyannote(group = {}, pendingAgeMs = 0, options = {}) {
    if (options.terminal || !pyannoteNode) return false;
    const bounds = speechSegmentTimeBounds(group.words || []);
    if (!Number.isFinite(Number(bounds.endSec))) return false;
    const stableLagSec = group.speakerSource === "pyannote" ? PYANNOTE_STABLE_EMIT_LAG_SEC : 0.1;
    if (Number(bounds.endSec) <= pyannoteCoverageEndSec - stableLagSec) return false;
    const standardWaitMs = Math.max(0, Number(config.pyannoteLiveTurnWaitMs || 0));
    const coldStartWaitMs = Math.max(standardWaitMs, Number(config.pyannoteLiveColdStartTurnWaitMs || 0));
    const waitMs = pyannoteCoverageEndSec > 0 ? standardWaitMs : coldStartWaitMs;
    if (waitMs <= 0 || pendingAgeMs >= waitMs) return false;
    maybeSchedulePyannoteWindow(false);
    return true;
  }

  function sendSttStatus(status, message, extra = {}) {
    const payload = {
      type: "stt_status",
      status,
      message,
      sessionSeq: extra.sessionSeq ?? activeSpeechSeq,
      attempt: extra.attempt ?? reconnectAttempt,
      bufferedMs: recoveryBufferedMs(),
      droppedMs: recoveryDroppedMs(),
      lastCloseCode,
      ...extra
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function logLiveEvent(stage, extra = {}) {
    console.log(`[live-session] ${JSON.stringify({
      at: new Date().toISOString(),
      stage,
      liveSessionId,
      sessionSeq: extra.sessionSeq ?? activeSpeechSeq,
      attempt: extra.attempt ?? reconnectAttempt,
      bufferedMs: recoveryBufferedMs(),
      droppedMs: recoveryDroppedMs(),
      lastCloseCode,
      manual: gracefulStopRequested,
      ...extra
    })}`);
  }

  function resetSpeechDiarizationDriftState(reason = "reset") {
    speechDiarizationDrift.observedRawSpeakers = new Set();
    speechDiarizationDrift.collapsedRawSpeaker = "";
    speechDiarizationDrift.collapsedStartedAt = 0;
    speechDiarizationDrift.collapsedEvents = 0;
    speechDiarizationDrift.collapsedWords = 0;
    if (reason !== "recognition_started") {
      logLiveEvent("speechmatics_diarization_drift_reset", { reason });
    }
  }

  function resetSpeechDiarizationCollapseCounters() {
    speechDiarizationDrift.collapsedRawSpeaker = "";
    speechDiarizationDrift.collapsedStartedAt = 0;
    speechDiarizationDrift.collapsedEvents = 0;
    speechDiarizationDrift.collapsedWords = 0;
  }

  function maybeRecoverSpeechmaticsDiarizationDrift(eventStats, segments, sessionSeq = activeSpeechSeq) {
    if (sessionSeq !== activeSpeechSeq || closing || gracefulStopRequested || ws.readyState !== WebSocket.OPEN) return;
    const summary = summarizeSpeechmaticsSegments(segments);
    const rawLabels = uniqueStrings((summary.labels || []).filter((label) => !isSpeechmaticsUnassignedRawSpeaker(label)));
    const wordTotal = rawLabels.reduce((sum, label) => sum + Number(summary.counts?.[label] || 0), 0) || Number(eventStats.wordItems || 0);
    if (rawLabels.length >= 2) {
      for (const label of rawLabels) speechDiarizationDrift.observedRawSpeakers.add(label);
      resetSpeechDiarizationCollapseCounters();
      return;
    }
    if (rawLabels.length !== 1 || wordTotal <= 0) return;

    const [rawSpeaker] = rawLabels;
    speechDiarizationDrift.observedRawSpeakers.add(rawSpeaker);
    if (speechDiarizationDrift.observedRawSpeakers.size < 2) return;

    const now = Date.now();
    if (speechDiarizationDrift.collapsedRawSpeaker !== rawSpeaker) {
      speechDiarizationDrift.collapsedRawSpeaker = rawSpeaker;
      speechDiarizationDrift.collapsedStartedAt = now;
      speechDiarizationDrift.collapsedEvents = 0;
      speechDiarizationDrift.collapsedWords = 0;
    }
    speechDiarizationDrift.collapsedEvents += 1;
    speechDiarizationDrift.collapsedWords += wordTotal;

    const collapsedMs = now - speechDiarizationDrift.collapsedStartedAt;
    const cooldownReady = now - speechDiarizationDrift.lastRecoveryAt >= SPEECHMATICS_DRIFT_COOLDOWN_MS;
    const thresholdReady = collapsedMs >= SPEECHMATICS_DRIFT_MIN_MS
      && speechDiarizationDrift.collapsedEvents >= SPEECHMATICS_DRIFT_MIN_EVENTS
      && speechDiarizationDrift.collapsedWords >= SPEECHMATICS_DRIFT_MIN_WORDS;
    if (!thresholdReady || !cooldownReady || speechDiarizationDrift.recoveries >= SPEECHMATICS_DRIFT_MAX_RECOVERIES) return;

    speechDiarizationDrift.lastRecoveryAt = now;
    speechDiarizationDrift.recoveries += 1;
    speechStats.diarizationDriftRecoveries = Number(speechStats.diarizationDriftRecoveries || 0) + 1;
    const details = {
      stage: "diarization_drift",
      message: "Speechmatics speaker labels collapsed to one raw speaker after multiple raw speakers were already observed.",
      rawSpeaker,
      observedRawSpeakers: Array.from(speechDiarizationDrift.observedRawSpeakers),
      collapsedMs,
      collapsedEvents: speechDiarizationDrift.collapsedEvents,
      collapsedWords: speechDiarizationDrift.collapsedWords,
      recoveryCount: speechDiarizationDrift.recoveries,
      sessionSeq
    };
    console.warn(`[speechmatics diarization drift] ${JSON.stringify(details)}`);
    logLiveEvent("speechmatics_diarization_drift_detected", details);
    ws.send(JSON.stringify({
      type: "diarization_status",
      status: "reconnecting",
      message: "Speaker diarization drift detected; reconnecting Speechmatics."
    }));
    sendSttStatus("reconnecting", "Speaker diarization drift detected; reconnecting Speechmatics.", { reason: "diarization_drift", sessionSeq });
    resetSpeechDiarizationCollapseCounters();
    handleSpeechmaticsFailure(sessionSeq, details);
  }

  function emitSpeechmaticsTranscript(event, isFinal, sessionSeq = activeSpeechSeq) {
    const transcript = String(event.metadata?.transcript || transcriptTextFromSpeechmaticsResults(event.results || event.words)).trim();
    if (!transcript) return;
    const segments = splitSpeechmaticsTranscriptBySpeaker(event, speakerMap, sessionSeq);
    if (!isFinal) {
      const segment = segments[0] || createUnassignedSpeechmaticsSegment(transcript);
      const bounds = speechSegmentTimeBounds(segment.words);
      ws.send(
        JSON.stringify({
          type: "transcript",
          turn: {
            id: `${turnPrefix}-interim-${resultCounter}`,
            speakerId: segment.speakerId,
            text: segment.text || transcript,
            isFinal: false,
            at: Date.now(),
            startSec: bounds.startSec,
            endSec: bounds.endSec,
            words: segment.words,
            rawSpeakers: segment.rawSpeakers,
            unassignedWords: segment.unassignedWords,
            speakerSource: speakerSourceForSpeechmaticsSegment(segment)
          }
        })
      );
      speechStats.emittedInterimTurns += 1;
      return;
    }

    const finalSegments = segments.filter((segment) => shouldEmitTranscriptSegment(segment.text));
    for (const segment of finalSegments.length ? finalSegments : [createUnassignedSpeechmaticsSegment(transcript)]) {
      sendFinalTranscriptSegment(segment);
    }
  }

  // Dispatch: when local pyannote diarization is active, the Python worker owns
  // word->speaker assignment + turn merging (faithful Utterr). Only fall back to
  // the legacy Speechmatics packaging if the worker process is gone/failing.
  function queueSpeechmaticsFinal(event, sessionSeq = activeSpeechSeq) {
    if (usePyannoteLiveDiarization && pyannoteNode) {
      routeFinalToWorker(event, sessionSeq);
      return;
    }
    queueSpeechmaticsFinalLegacy(event, sessionSeq);
  }

  // Convert a Speechmatics final event into worker words (absolute audio clock).
  function extractWordsForWorker(event) {
    const offset = Number(activeSpeechTimestampOffsetSec) || 0;
    const results = Array.isArray(event.results)
      ? event.results
      : (Array.isArray(event.words) ? event.words : []);
    const out = [];
    for (const item of results) {
      const alternative = item.alternatives?.[0] || item;
      const text = String(alternative.content ?? item.text ?? item.word ?? "").trim();
      if (!text) continue;
      const type = item.type === "punctuation" ? "punctuation" : "word";
      const rawStart = Number(item.start_time ?? item.start);
      const rawEnd = Number(item.end_time ?? item.end);
      out.push({
        text,
        type,
        start: Number.isFinite(rawStart) ? rawStart + offset : null,
        end: Number.isFinite(rawEnd) ? rawEnd + offset : null
      });
    }
    return out;
  }

  // Emit each worker turn immediately as its own final (no server-side turn
  // buffering). Like the test app, small finished pieces are sent right away with
  // their speaker; the FRONTEND stitches consecutive same-speaker pieces into one
  // growing bubble. This makes the speaker's labeled bubble appear within ~1s and
  // fill in live, instead of showing up all at once when the turn ends.
  function emitWorkerTurns(turns = []) {
    for (const turn of turns) {
      const text = String(turn?.text || "").trim();
      if (!text) continue;
      const speakerId = String(turn.speaker || "Unknown");
      const start = Number.isFinite(Number(turn.start)) ? Number(turn.start) : undefined;
      const end = Number.isFinite(Number(turn.end)) ? Number(turn.end) : undefined;
      speechStats.pyannoteAssignedWords += Number(turn.word_count || wordCount(text));
      sendFinalTranscriptSegment({
        speakerId,
        text,
        words: [{ word: text, startSec: start, endSec: end, rawSpeaker: `pyannote:${speakerId}` }],
        rawSpeakers: [`pyannote:${speakerId}`],
        unassignedWords: 0,
        speakerSource: "pyannote"
      });
    }
  }

  function routeFinalToWorker(event, sessionSeq = activeSpeechSeq) {
    mergeSpeechmaticsEventStats(speechStats, speechmaticsEventStats(event));
    const words = extractWordsForWorker(event);
    if (!words.length) return;
    const node = pyannoteNode;
    if (!node) {
      queueSpeechmaticsFinalLegacy(event, sessionSeq);
      return;
    }
    node.addWords(words).then((res) => {
      emitWorkerTurns(res?.turns || []);
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pyannote live] addWords failed; Speechmatics fallback for this event: ${message}`);
      logLiveEvent("pyannote_addwords_failed", { message, sessionSeq });
      queueSpeechmaticsFinalLegacy(event, sessionSeq);
    });
  }

  function queueSpeechmaticsFinalLegacy(event, sessionSeq = activeSpeechSeq) {
    const eventStats = speechmaticsEventStats(event);
    mergeSpeechmaticsEventStats(speechStats, eventStats);
    const segments = splitSpeechmaticsTranscriptBySpeaker(event, speakerMap, sessionSeq);
    if (!eventStats.transcriptChars && !eventStats.wordItems && !eventStats.punctuationItems) {
      speechStats.emptyFinalEvents += 1;
    } else if (!eventStats.wordItems && eventStats.punctuationItems) {
      speechStats.punctuationOnlyFinalEvents += 1;
    } else {
      speechStats.wordBearingFinalEvents += 1;
    }
    console.log(`[${packagingLogLabel}] ${JSON.stringify({ stage: "final_event", event: speechStats.addTranscriptEvents, ...eventStats, segments: segments.length, rawSpeakers: summarizeSpeechmaticsSegments(segments), pendingBefore: pendingSpeechGroups.length })}`);
    const queuedAt = Date.now();
    const eventSeq = speechStats.addTranscriptEvents;
    for (const [segmentIndex, segment] of segments.entries()) {
      if (!segment.words?.length && !segment.text) continue;
      const fallbackRawSpeaker = segment.rawSpeakers?.[0] || SPEECHMATICS_UNASSIGNED_RAW_SPEAKER;
      const words = segment.words?.length
        ? segment.words.map((word) => ({
          ...word,
          fallbackRawSpeaker: word.rawSpeaker || fallbackRawSpeaker,
          fallbackSpeakerId: segment.speakerId
        }))
        : [{
          word: segment.text,
          rawSpeaker: fallbackRawSpeaker,
          fallbackRawSpeaker,
          fallbackSpeakerId: segment.speakerId
        }];
      for (const [wordIndex, word] of words.entries()) {
        pendingSpeechWords.push({
          ...word,
          pendingWordId: `${eventSeq}:${segmentIndex}:${wordIndex}:${pendingSpeechWordSeq++}`,
          eventSeq,
          segmentIndex,
          fallbackRawSpeaker: word.fallbackRawSpeaker || fallbackRawSpeaker,
          fallbackSpeakerId: word.fallbackSpeakerId || segment.speakerId,
          fallbackSpeakerSource: speakerSourceForSpeechmaticsSegment(segment),
          rawSpeaker: word.rawSpeaker || fallbackRawSpeaker,
          queuedAt,
          firstQueuedAt: queuedAt,
          lastQueuedAt: queuedAt
        });
      }
      pendingSpeechGroups.push({
        speakerId: segment.speakerId,
        fallbackSpeakerId: segment.speakerId,
        words,
        rawSpeakers: segment.rawSpeakers || [fallbackRawSpeaker],
        unassignedWords: Number(segment.unassignedWords || 0),
        speakerSource: speakerSourceForSpeechmaticsSegment(segment),
        eventSeq,
        queuedAt,
        firstQueuedAt: queuedAt,
        lastQueuedAt: queuedAt
      });
      speechStats.groupsQueued += 1;
      speechStats.wordsQueued += segment.words?.length || wordCount(segment.text || "");
    }
    rebuildPendingSpeechGroups("final_event");
    maybeRecoverSpeechmaticsDiarizationDrift(eventStats, segments, sessionSeq);
    flushPendingSpeechGroups(false, "final_event");
  }

  function flushPendingSpeechGroups(force, source = "normal") {
    if (force) speechStats.forceFlushes += 1;
    const terminalFlush = force && !["speech_final", "utterance_end", "end_of_transcript"].includes(source);
    rebuildPendingSpeechGroups(source, { terminal: terminalFlush });
    const sourceCompletesGroup = ["speech_final", "utterance_end", "end_of_transcript"].includes(source);
    while (pendingSpeechGroups.length > 0) {
      const group = pendingSpeechGroups[0];
      const text = joinWords((group.words || []).map((word) => word.word));
      const words = wordCount(text);
      const pendingWords = pendingSpeechWords.length;
      const pendingAgeMs = Date.now() - Number(group.firstQueuedAt || group.queuedAt || Date.now());
      const groupDebateMs = speechGroupDebateMs(group);
      const hasFollowingSpeaker = pendingSpeechGroups.length > 1 && pendingSpeechGroups[1]?.speakerId !== group.speakerId;
      const endsWithPunctuation = /[.!?]$/.test(text);
      const reachedWordThreshold = words >= 34;
      const reachedSpeakerChange = hasFollowingSpeaker && words >= 2;
      const fallbackGroup = isPyannoteFallbackGroup(group);
      const reachedFallbackCap = fallbackGroup && (
        words >= Math.max(1, PYANNOTE_FALLBACK_MAX_WORDS)
        || groupDebateMs >= Math.max(500, PYANNOTE_FALLBACK_MAX_MS)
        || reachedSpeakerChange
      );
      const reachedRollingFlush =
        pendingAgeMs >= SPEECHMATICS_PENDING_FLUSH_MS
        || groupDebateMs >= LIVE_BATCH_DEBATE_WINDOW_MS
        || pendingWords >= SPEECHMATICS_PENDING_FLUSH_WORDS
        || pendingSpeechGroups.length >= SPEECHMATICS_PENDING_FLUSH_GROUPS;
      if (shouldHoldGroupForPyannote(group, pendingAgeMs, { terminal: terminalFlush })) {
        speechStats.heldGroups += 1;
        incrementCounter(speechStats.holdReasons, "awaiting_pyannote");
        console.log(`[${packagingLogLabel}] ${JSON.stringify({ stage: "hold", source, reason: "awaiting_pyannote", speakerId: group.speakerId, speakerSource: group.speakerSource, rawSpeakers: group.rawSpeakers || summarizeSpeechmaticsWords(group.words).labels, unassignedWords: group.unassignedWords || summarizeSpeechmaticsWords(group.words).unassignedWords, words, pendingGroups: pendingSpeechGroups.length, pendingWords, pendingAgeMs, groupDebateMs, pyannoteCoverageEndSec, preview: text.slice(0, 120) })}`);
        break;
      }
      const isComplete = terminalFlush || sourceCompletesGroup || endsWithPunctuation || reachedWordThreshold || reachedSpeakerChange || reachedFallbackCap || reachedRollingFlush;
      if (!isComplete) {
        speechStats.heldGroups += 1;
        const holdReason = hasFollowingSpeaker ? "speaker_change_below_threshold" : "awaiting_punctuation_or_length";
        incrementCounter(speechStats.holdReasons, holdReason);
        console.log(`[${packagingLogLabel}] ${JSON.stringify({ stage: "hold", source, reason: holdReason, speakerId: group.speakerId, speakerSource: group.speakerSource, rawSpeakers: group.rawSpeakers || summarizeSpeechmaticsWords(group.words).labels, unassignedWords: group.unassignedWords || summarizeSpeechmaticsWords(group.words).unassignedWords, words, pendingGroups: pendingSpeechGroups.length, pendingWords, pendingAgeMs, groupDebateMs, preview: text.slice(0, 120) })}`);
        break;
      }
      const emitGroup = fallbackGroup ? capFallbackGroup(group) : group;
      const emitText = joinWords((emitGroup.words || []).map((word) => word.word));
      const emitWords = wordCount(emitText);
      if (pyannoteOnlyDiarization && emitGroup.speakerSource !== "pyannote") {
        removePendingSpeechWords(emitGroup.words || []);
        speechStats.pyannoteDroppedUnassignedWords += emitWords;
        rebuildPendingSpeechGroups(`${source}:drop_pyannote_only`);
        console.log(`[${packagingLogLabel}] ${JSON.stringify({ stage: "drop_pyannote_unassigned", source, reason: "pyannote_only_no_fallback", speakerId: emitGroup.speakerId, speakerSource: emitGroup.speakerSource, rawSpeakers: emitGroup.rawSpeakers || summarizeSpeechmaticsWords(emitGroup.words).labels, words: emitWords, pendingAfter: pendingSpeechGroups.length, preview: emitText.slice(0, 120) })}`);
        continue;
      }
      removePendingSpeechWords(emitGroup.words || []);
      const reason = force
        ? fallbackGroup && emitWords < words
          ? "fallback_cap"
          : source
        : endsWithPunctuation
          ? "punctuation"
          : reachedWordThreshold
            ? "word_threshold"
            : reachedSpeakerChange
              ? "speaker_change"
              : reachedFallbackCap
                ? "fallback_cap"
                : "rolling_flush";
      incrementCounter(speechStats.flushReasons, reason);
      if (reason === "fallback_cap") speechStats.fallbackCappedTurns += 1;
      if (!shouldEmitTranscriptSegment(emitText)) {
        speechStats.droppedSegments += 1;
        rebuildPendingSpeechGroups(`${source}:drop`);
        console.log(`[${packagingLogLabel}] ${JSON.stringify({ stage: "drop", source, reason, speakerId: emitGroup.speakerId, speakerSource: emitGroup.speakerSource, rawSpeakers: emitGroup.rawSpeakers || summarizeSpeechmaticsWords(emitGroup.words).labels, unassignedWords: emitGroup.unassignedWords || summarizeSpeechmaticsWords(emitGroup.words).unassignedWords, words: emitWords, pendingAfter: pendingSpeechGroups.length, preview: emitText.slice(0, 120) })}`);
        continue;
      }
      if (emitGroup.speakerSource === "pyannote") {
        speechStats.pyannoteAssignedWords += emitWords;
      } else {
        speechStats.pyannoteFallbackWords += emitWords;
      }
      rebuildPendingSpeechGroups(`${source}:emit`);
      console.log(`[${packagingLogLabel}] ${JSON.stringify({ stage: "emit_final", source, reason, speakerId: emitGroup.speakerId, speakerSource: emitGroup.speakerSource, rawSpeakers: emitGroup.rawSpeakers || summarizeSpeechmaticsWords(emitGroup.words).labels, unassignedWords: emitGroup.unassignedWords || summarizeSpeechmaticsWords(emitGroup.words).unassignedWords, words: emitWords, pendingAfter: pendingSpeechGroups.length, pendingAgeMs, groupDebateMs: speechGroupDebateMs(emitGroup), pyannoteCoverageEndSec, preview: emitText.slice(0, 160) })}`);
      sendFinalTranscriptSegment({
        speakerId: emitGroup.speakerId,
        text: emitText,
        words: emitGroup.words || [],
        rawSpeakers: emitGroup.rawSpeakers || summarizeSpeechmaticsWords(emitGroup.words).labels,
        unassignedWords: emitGroup.unassignedWords || summarizeSpeechmaticsWords(emitGroup.words).unassignedWords,
        speakerSource: emitGroup.speakerSource
      });
    }
  }

  function sendFinalTranscriptSegment(segment) {
    const text = segment.text || joinWords((segment.words || []).map((word) => word.word));
    if (!shouldEmitTranscriptSegment(text)) return;
      if (ws.readyState !== WebSocket.OPEN) {
        speechStats.undeliveredFinalTurns += 1;
        console.log(`[${packagingLogLabel}] ${JSON.stringify({ stage: "undelivered_final", speakerId: segment.speakerId, rawSpeakers: segment.rawSpeakers || summarizeSpeechmaticsWords(segment.words).labels, unassignedWords: segment.unassignedWords || summarizeSpeechmaticsWords(segment.words).unassignedWords, words: wordCount(text), preview: text.slice(0, 120) })}`);
        return;
      }
      speechStats.emittedFinalTurns += 1;
      const bounds = speechSegmentTimeBounds(segment.words);
      const wordSummary = summarizeSpeechmaticsWords(segment.words);
      const turn = {
        id: `${turnPrefix}-${resultCounter++}`,
        speakerId: segment.speakerId,
        text,
        isFinal: true,
        at: Date.now(),
        startSec: bounds.startSec,
        endSec: bounds.endSec,
        words: segment.words,
        rawSpeakers: segment.rawSpeakers || wordSummary.labels,
        unassignedWords: Number(segment.unassignedWords || wordSummary.unassignedWords || 0),
        speakerSource: segment.speakerSource || speakerSourceForSttSegment(segment, sttStatsProvider)
      };
      ws.send(
        JSON.stringify({
          type: "transcript",
          turn
        })
      );
      recordLiveFinalTurn(liveSession, turn);
  }

  function mapSpeechmaticsRawSpeakerForTranscript(rawSpeaker, sessionSeq = activeSpeechSeq) {
    if (pyannoteOnlyDiarization) return SPEECHMATICS_UNASSIGNED_SPEAKER_ID;
    return mapSpeechmaticsSpeaker(rawSpeaker, speakerMap, sessionSeq);
  }

  function sendSpeechmaticsStats(reason) {
    rebuildPendingSpeechGroups(`stats:${reason}`);
    speechStats.pendingGroupsAtClose = pendingSpeechGroups.length;
    speechStats.pendingWordsAtClose = pendingSpeechWords.length;
    speechStats.pyannoteCoverageLagSec = pyannoteNode
      ? Number(Math.max(0, audioBytes / 32000 - pyannoteCoverageEndSec).toFixed(3))
      : 0;
    const payload = { type: "stt_stats", provider: sttStatsProvider, reason, stats: speechStats };
    console.log(`[${packagingLogLabel} stats] ${JSON.stringify(payload)}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }
});

function createSpeechmaticsStats() {
  return {
    partialTranscriptEvents: 0,
    emittedInterimTurns: 0,
    addTranscriptEvents: 0,
    endOfTranscriptEvents: 0,
    speechStartedEvents: 0,
    utteranceEndEvents: 0,
    metadataEvents: 0,
    audioAddedEvents: 0,
    stopRequests: 0,
    emptyFinalEvents: 0,
    wordBearingFinalEvents: 0,
    punctuationOnlyFinalEvents: 0,
    resultItems: 0,
    wordItems: 0,
    punctuationItems: 0,
    transcriptChars: 0,
    groupsQueued: 0,
    wordsQueued: 0,
    emittedFinalTurns: 0,
    undeliveredFinalTurns: 0,
    droppedSegments: 0,
    heldGroups: 0,
    forceFlushes: 0,
    recoveryBufferedBytes: 0,
    recoveryDroppedBytes: 0,
    diarizationDriftRecoveries: 0,
    pyannoteWindowsStarted: 0,
    pyannoteWindowsCompleted: 0,
    pyannoteWindowErrors: 0,
    pyannoteAssignedWords: 0,
    pyannoteFallbackWords: 0,
    pyannoteCoverageLagSec: 0,
    pyannoteDroppedUnassignedWords: 0,
    wordLedgerWords: 0,
    wordLedgerGroups: 0,
    fallbackCappedTurns: 0,
    pendingGroupsAtClose: 0,
    pendingWordsAtClose: 0,
    holdReasons: {},
    flushReasons: {}
  };
}

function speechmaticsEventStats(event = {}) {
  const items = Array.isArray(event.results)
    ? event.results
    : Array.isArray(event.words)
      ? event.words
      : [];
  let wordItems = 0;
  let punctuationItems = 0;
  let transcriptChars = String(event.metadata?.transcript || "").trim().length;
  for (const item of items) {
    const alternative = item.alternatives?.[0] || item;
    const content = String(alternative.content || item.text || item.word || "");
    if (item.type === "punctuation") {
      punctuationItems += 1;
    } else if (content.trim()) {
      wordItems += 1;
    }
    if (!transcriptChars && content.trim()) transcriptChars += content.length;
  }
  return {
    resultItems: items.length,
    wordItems,
    punctuationItems,
    transcriptChars
  };
}

function mergeSpeechmaticsEventStats(target, eventStats) {
  target.resultItems += eventStats.resultItems || 0;
  target.wordItems += eventStats.wordItems || 0;
  target.punctuationItems += eventStats.punctuationItems || 0;
  target.transcriptChars += eventStats.transcriptChars || 0;
}

function incrementCounter(counter, key, amount = 1) {
  counter[key] = (counter[key] || 0) + amount;
}

function isSpeechmaticsUnassignedRawSpeaker(rawSpeaker) {
  const label = String(rawSpeaker ?? "").trim();
  return !label || label === "UU" || label === SPEECHMATICS_UNASSIGNED_RAW_SPEAKER;
}

function normalizeSpeechmaticsRawSpeaker(rawSpeaker) {
  return isSpeechmaticsUnassignedRawSpeaker(rawSpeaker)
    ? SPEECHMATICS_UNASSIGNED_RAW_SPEAKER
    : String(rawSpeaker).trim();
}

function isSpeechmaticsUnassignedSpeakerId(speakerId = "") {
  return String(speakerId || "").trim() === SPEECHMATICS_UNASSIGNED_SPEAKER_ID;
}

function isSpeechmaticsUnassignedTurn(turn = {}) {
  return isSpeechmaticsUnassignedSpeakerId(turn.speakerId) || String(turn.speakerSource || "").endsWith("_unassigned");
}

function sanitizeClientAudioSettings(payload = {}) {
  const pickAudioFields = (source = {}) => {
    const output = {};
    for (const key of ["sampleRate", "sampleSize", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl", "latency"]) {
      const value = source?.[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        output[key] = value;
      } else if (Array.isArray(value)) {
        output[key] = value
          .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
          .slice(0, 12);
      } else if (value && typeof value === "object") {
        const range = {};
        for (const rangeKey of ["min", "max"]) {
          const rangeValue = value?.[rangeKey];
          if (typeof rangeValue === "number") range[rangeKey] = rangeValue;
        }
        if (Object.keys(range).length) output[key] = range;
      }
    }
    return output;
  };
  return {
    at: new Date().toISOString(),
    audioContextSampleRate: Number(payload.audioContextSampleRate || 0),
    outputSampleRate: Number(payload.outputSampleRate || 0),
    sampleFormat: String(payload.sampleFormat || ""),
    channelCount: Number(payload.channelCount || 0),
    inputChannelMode: String(payload.inputChannelMode || ""),
    chunkTargetBytes: Number(payload.chunkTargetBytes || 0),
    expectedBytesPerSecond: Number(payload.expectedBytesPerSecond || 0),
    trackLabel: String(payload.trackLabel || "").slice(0, 120),
    trackSettings: pickAudioFields(payload.trackSettings),
    trackConstraints: pickAudioFields(payload.trackConstraints),
    trackCapabilities: pickAudioFields(payload.trackCapabilities),
    supportedConstraints: pickAudioFields(payload.supportedConstraints)
  };
}

function sanitizeClientAudioChannelStats(payload = {}) {
  const rms = Array.isArray(payload.rms)
    ? payload.rms.map((value) => Number(value)).filter(Number.isFinite).slice(0, 4)
    : [];
  const correlation = Number(payload.correlation);
  return {
    at: new Date().toISOString(),
    inputChannels: Number(payload.inputChannels || 0),
    channelMode: String(payload.channelMode || ""),
    rms,
    correlation: Number.isFinite(correlation) ? Number(correlation.toFixed(4)) : null
  };
}

function speakerSourceForSpeechmaticsSegment(segment = {}) {
  return isSpeechmaticsUnassignedSpeakerId(segment.speakerId) ? "speechmatics_unassigned" : "speechmatics";
}

function speakerSourceForSttSegment(segment = {}, provider = "stt") {
  return isSpeechmaticsUnassignedSpeakerId(segment.speakerId) ? `${provider}_unassigned` : provider;
}

function createUnassignedSpeechmaticsSegment(text = "") {
  const cleanText = String(text || "").trim();
  return {
    speakerId: SPEECHMATICS_UNASSIGNED_SPEAKER_ID,
    text: cleanText,
    words: cleanText ? [{ word: cleanText, rawSpeaker: SPEECHMATICS_UNASSIGNED_RAW_SPEAKER }] : [],
    rawSpeakers: [SPEECHMATICS_UNASSIGNED_RAW_SPEAKER],
    unassignedWords: wordCount(cleanText)
  };
}

function mapSpeechmaticsSpeaker(rawSpeaker, speakerMap, speakerNamespace = "") {
  const label = normalizeSpeechmaticsRawSpeaker(rawSpeaker);
  if (label === SPEECHMATICS_UNASSIGNED_RAW_SPEAKER) return SPEECHMATICS_UNASSIGNED_SPEAKER_ID;
  const mapKey = speakerNamespace ? `${speakerNamespace}:${label}` : label;
  if (!speakerMap.has(mapKey)) {
    speakerMap.set(mapKey, `Speaker ${speakerMap.size + 1}`);
  }
  return speakerMap.get(mapKey);
}

function splitSpeechmaticsTranscriptBySpeaker(event, speakerMap, speakerNamespace = "") {
  const words = Array.isArray(event.words) ? event.words : [];
  const results = Array.isArray(event.results) ? event.results : [];
  const groups = [];
  let lastRawSpeaker = null;

  for (const item of results.length ? results : words) {
    const alternative = item.alternatives?.[0] || item;
    const text = alternative.content || item.text || item.word || "";
    if (!String(text).trim()) continue;
    if (item.type === "punctuation") {
      const last = groups.at(-1);
      if (last) last.words.push({ word: text, rawSpeaker: last.rawSpeakers?.at(-1) || lastRawSpeaker || SPEECHMATICS_UNASSIGNED_RAW_SPEAKER });
      continue;
    }
    const explicitRawSpeaker = alternative.speaker ?? item.speaker;
    const rawSpeaker = normalizeSpeechmaticsRawSpeaker(explicitRawSpeaker ?? lastRawSpeaker);
    if (rawSpeaker !== SPEECHMATICS_UNASSIGNED_RAW_SPEAKER) {
      lastRawSpeaker = rawSpeaker;
    }
    const speakerId = mapSpeechmaticsSpeaker(rawSpeaker, speakerMap, speakerNamespace);
    const last = groups.at(-1);
    const wordInfo = {
      word: text,
      rawSpeaker,
      startSec: Number.isFinite(Number(item.start_time ?? item.start)) ? Number(item.start_time ?? item.start) : undefined,
      endSec: Number.isFinite(Number(item.end_time ?? item.end)) ? Number(item.end_time ?? item.end) : undefined
    };
    if (last?.speakerId === speakerId) {
      last.words.push(wordInfo);
      last.rawSpeakers = uniqueStrings([...(last.rawSpeakers || []), rawSpeaker]);
      if (rawSpeaker === SPEECHMATICS_UNASSIGNED_RAW_SPEAKER) last.unassignedWords = Number(last.unassignedWords || 0) + 1;
    } else {
      groups.push({
        speakerId,
        words: [wordInfo],
        rawSpeakers: [rawSpeaker],
        unassignedWords: rawSpeaker === SPEECHMATICS_UNASSIGNED_RAW_SPEAKER ? 1 : 0
      });
    }
  }

  if (groups.length === 0 && event.metadata?.transcript) {
    return [createUnassignedSpeechmaticsSegment(event.metadata.transcript)];
  }

  return groups.map((group) => ({
    speakerId: group.speakerId,
    text: joinWords(group.words.map((word) => word.word)),
    words: group.words,
    rawSpeakers: group.rawSpeakers || summarizeSpeechmaticsWords(group.words).labels,
    unassignedWords: Number(group.unassignedWords || 0)
  }));
}

function transcriptTextFromSpeechmaticsResults(results = []) {
  return joinWords((results || []).map((item) => item.alternatives?.[0]?.content || "").filter(Boolean));
}

function coalesceAdjacentSpeakerGroups(groups) {
  const output = [];
  for (const group of groups || []) {
    if (!group?.words?.length) continue;
    const last = output.at(-1);
    const sameSpeakerAndSource = last?.speakerId === group.speakerId && (last.speakerSource || "") === (group.speakerSource || "");
    const canMergeEvent = group.speakerSource === "pyannote"
      || group.speakerSource === "speechmatics"
      || !Number.isFinite(Number(last?.eventSeq))
      || !Number.isFinite(Number(group.eventSeq))
      || Number(last.eventSeq) === Number(group.eventSeq);
    if (sameSpeakerAndSource && canMergeEvent) {
      last.words.push(...group.words);
      last.rawSpeakers = uniqueStrings([...(last.rawSpeakers || []), ...(group.rawSpeakers || summarizeSpeechmaticsWords(group.words).labels)]);
      last.unassignedWords = Number(last.unassignedWords || 0) + Number(group.unassignedWords || summarizeSpeechmaticsWords(group.words).unassignedWords || 0);
      if (last.eventSeq !== group.eventSeq) last.eventSeq = null;
      last.firstQueuedAt = Math.min(
        Number(last.firstQueuedAt || last.queuedAt || Date.now()),
        Number(group.firstQueuedAt || group.queuedAt || Date.now())
      );
      last.lastQueuedAt = Math.max(
        Number(last.lastQueuedAt || last.queuedAt || Date.now()),
        Number(group.lastQueuedAt || group.queuedAt || Date.now())
      );
    } else {
      output.push({
        ...group,
        firstQueuedAt: Number(group.firstQueuedAt || group.queuedAt || Date.now()),
        lastQueuedAt: Number(group.lastQueuedAt || group.queuedAt || Date.now()),
        speakerSource: group.speakerSource,
        fallbackSpeakerId: group.fallbackSpeakerId,
        eventSeq: Number.isFinite(Number(group.eventSeq)) ? Number(group.eventSeq) : null,
        rawSpeakers: group.rawSpeakers || summarizeSpeechmaticsWords(group.words).labels,
        unassignedWords: Number(group.unassignedWords || summarizeSpeechmaticsWords(group.words).unassignedWords || 0),
        words: [...group.words]
      });
    }
  }
  return output;
}

function smoothPyannoteMicroTurns(groups = []) {
  const output = (groups || []).map((group) => ({
    ...group,
    words: [...(group.words || [])],
    rawSpeakers: [...(group.rawSpeakers || summarizeSpeechmaticsWords(group.words).labels)]
  }));
  for (let index = 1; index < output.length - 1; index += 1) {
    const previous = output[index - 1];
    const current = output[index];
    const next = output[index + 1];
    if (!isPyannoteGroup(previous) || !isPyannoteGroup(current) || !isPyannoteGroup(next)) continue;
    if (previous.speakerId !== next.speakerId || current.speakerId === previous.speakerId) continue;
    const text = joinWords((current.words || []).map((word) => word.word));
    const words = wordCount(text);
    const durationMs = speechGroupDebateMs(current);
    const isTiny = words <= Math.max(1, PYANNOTE_MICRO_TURN_MAX_WORDS)
      || (durationMs > 0 && durationMs <= Math.max(100, PYANNOTE_MICRO_TURN_MAX_MS));
    if (!isTiny || /[.!?]$/.test(text)) continue;
    output[index] = {
      ...current,
      speakerId: previous.speakerId,
      speakerSource: previous.speakerSource,
      rawSpeakers: previous.rawSpeakers || summarizeSpeechmaticsWords(previous.words).labels
    };
  }
  return output;
}

function isPyannoteGroup(group = {}) {
  return group?.speakerSource === "pyannote" && Array.isArray(group.words) && group.words.length > 0;
}

function summarizeSpeechmaticsWords(words = []) {
  const counts = {};
  let unassignedWords = 0;
  for (const word of words || []) {
    const rawSpeaker = normalizeSpeechmaticsRawSpeaker(word?.rawSpeaker);
    counts[rawSpeaker] = (counts[rawSpeaker] || 0) + 1;
    if (rawSpeaker === SPEECHMATICS_UNASSIGNED_RAW_SPEAKER) unassignedWords += 1;
  }
  return {
    labels: Object.keys(counts),
    counts,
    unassignedWords
  };
}

function summarizeSpeechmaticsSegments(segments = []) {
  const counts = {};
  let unassignedWords = 0;
  for (const segment of segments || []) {
    const summary = summarizeSpeechmaticsWords(segment.words || []);
    for (const [label, count] of Object.entries(summary.counts || {})) {
      counts[label] = (counts[label] || 0) + count;
    }
    unassignedWords += Number(segment.unassignedWords || summary.unassignedWords || 0);
  }
  return {
    labels: Object.keys(counts),
    counts,
    unassignedWords
  };
}

function speechSegmentTimeBounds(words = []) {
  const starts = [];
  const ends = [];
  for (const word of words || []) {
    if (Number.isFinite(Number(word?.startSec))) starts.push(Number(word.startSec));
    if (Number.isFinite(Number(word?.endSec))) ends.push(Number(word.endSec));
  }
  return {
    startSec: starts.length ? Math.min(...starts) : undefined,
    endSec: ends.length ? Math.max(...ends) : undefined
  };
}

function speechGroupDebateMs(group = {}) {
  const starts = [];
  const ends = [];
  for (const word of group.words || []) {
    if (Number.isFinite(Number(word.startSec))) starts.push(Number(word.startSec));
    if (Number.isFinite(Number(word.endSec))) ends.push(Number(word.endSec));
  }
  if (!starts.length || !ends.length) return 0;
  return Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) * 1000));
}

function overlapSeconds(left = {}, right = {}) {
  const start = Math.max(Number(left.startSec), Number(right.startSec));
  const end = Math.min(Number(left.endSec), Number(right.endSec));
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

if (process.env.DEBATLY_NO_LISTEN !== "1") {
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`debatly API listening on http://127.0.0.1:${config.port}`);
    console.log(`[debatly config] persistence=${isDatabaseConfigured() ? "enabled" : "disabled"} auth=${isAuthConfigured() ? "enabled" : "disabled"}`);
    if (isDatabaseConfigured()) {
      void finalizeStaleRecordingSessions()
        .then((result) => {
          if (result.sessions || result.projects) {
            console.log(`[db] recovered stale live sessions ${JSON.stringify(result)}`);
          }
        })
        .catch((error) => {
          console.warn(`[db] stale live session recovery failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
  });
}

function createLiveSession(sessionId, ws, projectId = "") {
  const startedAt = Date.now();
  return {
    id: sessionId,
    projectId: projectId || randomUUID(),
    ws,
    createdAt: startedAt,
    updatedAt: startedAt,
    recordingStartedAt: startedAt,
    analysis: createLiveAnalysisState(), // clean node-pipeline analysis state
    livePayload: null,                   // latest clean payload for the frontend
    debate: finalizeDirectLedgerState(normalizeClaimState({})), // legacy placeholder (removed in cleanup)
    pausedMs: 0,
    pauseStartedAt: 0,
    stoppedAt: 0,
    stoppedDurationMs: 0,
    closedAt: 0,
    cleanupTimer: null,
    seq: 0,
    turns: [],
    analysisBatches: [],
    pendingTurns: [],
    pendingChars: 0,
    pendingStartedAt: 0,
    analysisTimer: null,
    analysisRunning: false,
    lastAnalysisAt: 0,
    lastExchangeAnalysisAt: 0,
    lastSideBuilderAnalysisAt: 0,
    lastInconsistencyAnalysisAt: 0,
    lastScoreHistoryAt: 0,
    lastScoreEventSignature: "",
    finalInconsistencySettled: false,
    verificationRunning: false,
    verificationQueue: [],
    verificationQueuedIds: new Set(),
    verificationInFlightIds: new Set(),
    verificationCompletedIds: new Set(),
    reportStatus: "idle",
    liveGateOpenedAt: 0,
    liveGateOpenDebateSec: null,
    liveGateOpenSeq: 0,
    reportFinalizedAt: 0,
    ownerId: null,
    scoreHistory: [{ minute: 0, blue: 0, red: 0 }],
    dbReady: null,
    dbWriteQueue: Promise.resolve()
  };
}

function getProjectIdFromUrl(request) {
  try {
    const parsed = new URL(request.url || "", "http://127.0.0.1");
    return parsed.searchParams.get("project_id") || "";
  } catch {
    return "";
  }
}

function queueSessionPersistence(session, label, write) {
  if (!session || !isDatabaseConfigured()) return;
  session.dbWriteQueue = (session.dbWriteQueue || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (session.dbReady) await session.dbReady;
      await write();
    })
    .catch((error) => {
      console.warn(`[db] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

async function flushSessionPersistence(session) {
  if (!session?.dbWriteQueue) return;
  try {
    await session.dbWriteQueue;
  } catch {
    // Individual persistence steps already log their own failures.
  }
}

function sessionDurationMs(session) {
  if (!session) return 0;
  const stoppedDurationMs = Number(session.stoppedDurationMs || 0);
  if (Number.isFinite(stoppedDurationMs) && stoppedDurationMs > 0) return Math.max(0, Math.round(stoppedDurationMs));
  const end = session.stoppedAt || session.closedAt || Date.now();
  const pausedNow = session.pauseStartedAt ? Math.max(0, Date.now() - session.pauseStartedAt) : 0;
  return Math.max(0, end - (session.recordingStartedAt || end) - (session.pausedMs || 0) - pausedNow);
}

function scheduleLiveSessionCleanup(session) {
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    if (Date.now() - Math.max(session.updatedAt || 0, session.closedAt || 0) >= LIVE_SESSION_TTL_MS - 1000) {
      liveSessions.delete(session.id);
    }
  }, LIVE_SESSION_TTL_MS);
}

function recordLiveFinalTurn(session, turn) {
  if (!session || !turn?.isFinal) return;
  session.updatedAt = Date.now();
  session.turns.push(turn);
  session.debate = registerTranscriptSpeakers(session.debate, [turn]);
  queueSessionPersistence(session, "persist transcript turn", () => persistTranscriptTurn({
    sessionId: session.id,
    projectId: session.projectId,
    turn
  }));
  if (!isAnalyzableTurn(turn)) return;
  if (session.reportStatus === "ready") return;
  session.finalInconsistencySettled = false;
  const hadPendingTurns = session.pendingTurns.length > 0;
  session.pendingTurns.push(turn);
  if (!hadPendingTurns) session.pendingStartedAt = Date.now();
  session.pendingChars += String(turn.text || "").length;
  const decision = liveBatchDecision(session);
  sendLiveAnalysisStatus(session, "queued", "Debate analysis queued", {
    pendingTurns: session.pendingTurns.length,
    pendingDebateMs: decision.pendingDebateMs,
    batchWindowMs: liveBatchWindowMs(session),
    trigger: decision.trigger
  });
  if (session.reportStatus === "settling") return;
  scheduleLiveAnalysis(session, decision.delayMs);
}

function liveBatchDecision(session) {
  const batchWindowMs = liveBatchWindowMs(session);
  const batchTimeTriggerMs = LIVE_CURRENT_REPORTER_CHUNK_MS;
  const elapsed = Date.now() - (session.pendingStartedAt || session.lastAnalysisAt || session.recordingStartedAt || Date.now());
  const speakerCount = new Set(session.pendingTurns.map((item) => item.speakerId)).size;
  const turnCounts = new Map();
  for (const queuedTurn of session.pendingTurns) {
    turnCounts.set(queuedTurn.speakerId, (turnCounts.get(queuedTurn.speakerId) || 0) + 1);
  }
  const speakersWithExchangeDepth = [...turnCounts.values()].filter((count) => count >= LIVE_BATCH_EXCHANGE_TURNS_PER_SPEAKER).length;
  const pendingRange = debateRangeFromTurns(session.pendingTurns);
  const hasDebateTiming = Number.isFinite(Number(pendingRange.startSec))
    && Number.isFinite(Number(pendingRange.endSec))
    && Number(pendingRange.endSec) > Number(pendingRange.startSec);
  const pendingDebateMs = hasDebateTiming
    ? Math.max(0, Math.round((Number(pendingRange.endSec) - Number(pendingRange.startSec)) * 1000))
    : 0;
  const dueByDuration = hasDebateTiming && pendingDebateMs >= batchWindowMs;
  const dueByExchange = !hasDebateTiming && speakerCount >= 2
    && session.pendingTurns.length >= LIVE_BATCH_EXCHANGE_TURN_TRIGGER
    && speakersWithExchangeDepth >= 2;
  const dueByMonologue = !hasDebateTiming && speakerCount === 1 && session.pendingTurns.length >= LIVE_BATCH_MONOLOGUE_TURN_TRIGGER;
  const dueByChars = session.pendingChars >= LIVE_BATCH_CHAR_TRIGGER;
  const dueByTime = elapsed >= batchTimeTriggerMs;
  const trigger = dueByDuration
    ? "duration"
    : dueByChars
      ? "chars"
      : dueByTime
        ? "time"
        : dueByExchange
          ? "exchange"
          : dueByMonologue
            ? "monologue"
            : "waiting";
  const due = dueByDuration || dueByExchange || dueByMonologue || dueByChars || dueByTime;
  const wallWaitMs = Math.max(0, batchTimeTriggerMs - elapsed);
  const durationWaitMs = hasDebateTiming ? Math.max(0, batchWindowMs - pendingDebateMs) : wallWaitMs;
  const delayMs = due
    ? LIVE_BATCH_FAST_DEBOUNCE_MS
    : Math.max(LIVE_BATCH_IDLE_DEBOUNCE_MS, Math.min(wallWaitMs, durationWaitMs));
  return {
    delayMs,
    trigger,
    pendingDebateMs
  };
}

function scheduleLiveAnalysis(session, delayMs = LIVE_BATCH_IDLE_DEBOUNCE_MS) {
  if (!session) return;
  if (session.reportStatus === "ready" || session.reportStatus === "settling") return;
  clearTimeout(session.analysisTimer);
  session.analysisTimer = setTimeout(() => {
    session.analysisTimer = null;
    void runLiveAnalysis(session);
  }, Math.max(0, delayMs));
}

function takeLivePendingBatch(session, { forceFinalWindow = false } = {}) {
  const pending = session?.pendingTurns || [];
  if (!pending.length) return [];
  const batchWindowMs = liveBatchWindowMs(session);
  const targetMs = forceFinalWindow ? batchWindowMs : Math.max(batchWindowMs, 6000);
  const firstRange = debateRangeFromTurns([pending[0]]);
  const hasTiming = Number.isFinite(Number(firstRange.startSec)) || Number.isFinite(Number(firstRange.endSec));
  if (!hasTiming) {
    const maxTurns = forceFinalWindow ? Math.max(4, LIVE_BATCH_EXCHANGE_TURN_TRIGGER * 2) : pending.length;
    const batch = pending.splice(0, Math.min(pending.length, maxTurns));
    session.pendingChars = pending.reduce((sum, turn) => sum + String(turn.text || "").length, 0);
    if (!pending.length) session.pendingStartedAt = 0;
    return batch;
  }
  let takeCount = 0;
  for (let index = 0; index < pending.length; index += 1) {
    takeCount = index + 1;
    const range = debateRangeFromTurns(pending.slice(0, takeCount));
    const debateMs = Number.isFinite(Number(range.startSec)) && Number.isFinite(Number(range.endSec))
      ? Math.max(0, Math.round((Number(range.endSec) - Number(range.startSec)) * 1000))
      : 0;
    if ((takeCount >= 2 && debateMs >= targetMs) || takeCount >= 10) break;
  }
  const batch = pending.splice(0, Math.max(1, takeCount));
  session.pendingChars = pending.reduce((sum, turn) => sum + String(turn.text || "").length, 0);
  if (!pending.length) session.pendingStartedAt = 0;
  return batch;
}

function recordLiveAnalysisBatch(session, turns = []) {
  const batchTurns = (turns || []).filter(Boolean);
  if (!session || !batchTurns.length) return;
  const range = debateRangeFromTurns(batchTurns);
  session.analysisBatches = [
    ...(session.analysisBatches || []),
    {
      id: `batch-${stableTextHash(batchTurns.map((turn) => turn.id || `${turn.speakerId}:${turn.at || ""}`).join("|"))}`,
      recordedAt: Date.now(),
      startSec: range.startSec,
      endSec: range.endSec,
      turns: batchTurns
    }
  ].slice(-LIVE_CONTEXT_BATCH_LIMIT);
}

function liveAnalysisCadence(session, batch = []) {
  return liveAnalysisCadenceCurrent(session, batch);
}

function maybeTraceLiveGateOpen(session, cadence = {}, batch = []) {
  if (!session || session.liveGateOpenedAt || !cadence.startupReady || cadence.mode !== "editor") return;
  const now = Date.now();
  const batchRange = debateRangeFromTurns(batch);
  const transcriptRange = debateRangeFromTurns(session.turns || []);
  const debateEndSec = Number.isFinite(Number(batchRange.endSec))
    ? Number(batchRange.endSec)
    : Number.isFinite(Number(transcriptRange.endSec))
      ? Number(transcriptRange.endSec)
      : null;
  session.liveGateOpenedAt = now;
  session.liveGateOpenDebateSec = debateEndSec;
  session.liveGateOpenSeq = session.seq;
  const payload = {
    sessionId: session.id,
    openedAt: new Date(now).toISOString(),
    openedAtMs: now,
    debateStartSec: batchRange.startSec,
    debateEndSec,
    interviewSec: debateEndSec,
    interviewMinute: Number.isFinite(Number(debateEndSec)) ? Number((Number(debateEndSec) / 60).toFixed(2)) : null,
    transcriptWindowStartSec: transcriptRange.startSec,
    transcriptWindowEndSec: transcriptRange.endSec,
    reporterChunks: (session.analysisBatches || []).length,
    startupChunksRequired: LIVE_CURRENT_STARTUP_CHUNKS,
    pendingTurns: session.pendingTurns?.length || 0,
    batchTurns: batch.length,
    cadence: cadence.mode,
    contextBatches: cadence.contextBatches,
    seq: session.seq
  };
  console.log(`[live-gate] ${JSON.stringify(payload)}`);
  logDeterministicStep(null, "LiveAnalysisGate:opened", payload);
}

function liveAnalysisCadenceCurrent(session, batch = []) {
  const now = Date.now();
  const batches = session.analysisBatches || [];
  const startupReady = batches.length >= LIVE_CURRENT_STARTUP_CHUNKS;
  const dueBySideClock = !session.lastSideBuilderAnalysisAt || now - session.lastSideBuilderAnalysisAt >= LIVE_DIRECT_SIDE_BUILDER_INTERVAL_MS;
  const dueByClaimClock = !session.lastClaimAnalysisAt || now - session.lastClaimAnalysisAt >= LIVE_DIRECT_CLAIM_INTERVAL_MS;
  const dueByExchangeClock = !session.lastExchangeAnalysisAt || now - session.lastExchangeAnalysisAt >= LIVE_DIRECT_CLASH_INTERVAL_MS;
  const dueByInconsistencyClock = !session.lastInconsistencyAnalysisAt || now - session.lastInconsistencyAnalysisAt >= LIVE_DIRECT_INCONSISTENCY_INTERVAL_MS;
  const firstEditorPass = startupReady && !session.lastClaimAnalysisAt;
  const exchangeSignal = hasImmediateExchangeSignal(batch);
  const runSideBuilder = startupReady && (firstEditorPass || dueBySideClock);
  const runClaims = startupReady && (firstEditorPass || dueByClaimClock || dueByExchangeClock || dueByInconsistencyClock);
  const runExchange = startupReady && runClaims && (firstEditorPass || dueByExchangeClock || exchangeSignal);
  const runInconsistencies = startupReady && dueByInconsistencyClock;
  const contextBatchCount = runInconsistencies ? 8 : runSideBuilder ? 6 : runExchange ? 5 : 4;
  return {
    mode: startupReady ? "editor" : "reporter",
    pipeline: "direct-ledger",
    startupReady,
    runReporter: true,
    runSideBuilder: Boolean(runSideBuilder),
    runClaims: Boolean(runClaims),
    runExchange: Boolean(runExchange),
    runInconsistencies: Boolean(runInconsistencies),
    analysisMilestone: runInconsistencies ? "consistency" : null,
    contextBatches: contextBatchCount,
    contextTurns: recentLiveContextTurns(session, contextBatchCount)
  };
}

function fullLiveAnalysisCadence(session) {
  return {
    mode: "finalize",
    pipeline: "direct-ledger",
    startupReady: true,
    runReporter: true,
    runSideBuilder: true,
    runClaims: true,
    runExchange: true,
    runInconsistencies: true,
    analysisMilestone: "final",
    contextBatches: 8,
    contextTurns: recentLiveContextTurns(session, 8)
  };
}

function reportSettleCadenceCurrent(session) {
  return {
    mode: "report-settle",
    pipeline: "direct-ledger",
    startupReady: currentReporterChunkCount(session?.debate || {}, []) >= LIVE_CURRENT_STARTUP_CHUNKS,
    runReporter: true,
    runSideBuilder: false,
    runClaims: false,
    runExchange: false,
    runInconsistencies: false,
    analysisMilestone: null,
    contextBatches: 1,
    contextTurns: recentLiveContextTurns(session, 1)
  };
}

function hasLiveAnalysisContext(session) {
  return Boolean(session?.analysisBatches?.some((batch) => (batch.turns || []).some(isAnalyzableTurn)));
}

async function runLiveFinalInconsistencyPass(session) {
  if (!session || session.analysisRunning) return;
  if (session.reportStatus === "ready") return;
  const cadence = fullLiveAnalysisCadence(session);
  const sourceBatch = (session.analysisBatches || []).at(-1)?.turns || [];
  const contextTurns = (cadence.contextTurns || []).filter(isAnalyzableTurn);
  const sourceTurns = sourceBatch.filter(isAnalyzableTurn);
  const batch = sourceTurns.length
    ? sourceTurns
    : contextTurns.slice(-Math.max(4, LIVE_BATCH_EXCHANGE_TURN_TRIGGER));
  if (!batch.length || !contextTurns.length) {
    session.finalInconsistencySettled = true;
    return;
  }
  session.analysisRunning = true;
  sendLiveAnalysisStatus(session, "running", liveAnalysisStatusMessage(cadence, batch), {
    pendingTurns: session.pendingTurns.length,
    cadence: cadence.mode,
    contextBatches: cadence.contextBatches
  });
  try {
    const nextState = await runLivePipeline({
      newTurns: batch,
      transcriptWindow: session.turns.slice(-32),
      currentDebate: session.debate,
      recordingStartedAt: session.recordingStartedAt,
      options: {
        skipVerification: true,
        includeTimings: true,
        label: `live-final-inconsistency-${session.id.slice(0, 8)}`,
        liveCadence: cadence.mode,
        startupReady: cadence.startupReady,
        runSideBuilder: cadence.runSideBuilder,
        runChallenges: true,
        runClaims: true,
        runInconsistencies: true,
        artifactContextTurns: contextTurns,
        artifactContextBatches: cadence.contextBatches
      }
    });
    const { _timings, ...debateState } = nextState;
    session.debate = preserveDurableFactState(session.debate, debateState);
    session.seq += 1;
    session.lastAnalysisAt = Date.now();
    session.lastExchangeAnalysisAt = session.lastAnalysisAt;
    session.lastSideBuilderAnalysisAt = session.lastAnalysisAt;
    session.lastInconsistencyAnalysisAt = session.lastAnalysisAt;
    session.updatedAt = Date.now();
    appendScoreHistory(session, "analysis");
    sendLiveDebateState(session, "analysis", _timings);
  } catch (error) {
    console.error("Live final inconsistency pass failed", error);
    sendLiveAnalysisStatus(session, "error", error instanceof Error ? error.message : "Live final inconsistency pass failed", {
      pendingTurns: session.pendingTurns.length
    });
  } finally {
    session.finalInconsistencySettled = true;
    session.analysisRunning = false;
  }
}

function recentLiveContextTurns(session, batchCount = 1) {
  const batches = (session?.analysisBatches || []).slice(-Math.max(1, batchCount));
  const byId = new Map();
  for (const turn of batches.flatMap((batch) => batch.turns || [])) {
    if (!turn?.id) continue;
    byId.set(turn.id, turn);
  }
  return [...byId.values()].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function hasImmediateExchangeSignal(turns = []) {
  const speakers = new Set((turns || []).map((turn) => turn.speakerId).filter(Boolean));
  const text = normalizeTranscript((turns || []).map((turn) => turn.text || "").join(" "));
  return speakers.size >= 2 && /\b(why|but|however|hold on|your claim|you said|youre saying|not true|i disagree|i would condemn|that is a genocidal|that is not|because|therefore)\b/.test(text);
}

function liveAnalysisStatusMessage(cadence, batch = []) {
  const turns = batch.length;
  const suffix = `${turns} transcript turn${turns === 1 ? "" : "s"}`;
  if (cadence?.mode === "reporter") return `Cleaning reporter chunk from ${suffix}`;
  if (cadence?.mode === "editor") return `Updating direct Debate Desk cards across ${cadence.contextBatches} reporter chunks`;
  if (cadence?.mode === "finalize") return `Finalizing direct Debate Desk ledger across ${cadence.contextBatches} chunks`;
  if (cadence?.mode === "report-settle") return `Saving final transcript chunk from ${suffix}`;
  if (cadence?.runInconsistencies && !cadence?.runExchange) return `Checking consistency across ${cadence.contextBatches} batches`;
  if (cadence?.mode === "exchange") return `Linking direct clashes across ${cadence.contextBatches} batches`;
  return `Finding fresh claims from ${suffix}`;
}

async function runLiveAnalysis(session, { forceInconsistencyPass = false, reportSettle = false } = {}) {
  if (!session || session.analysisRunning) return;
  if (session.reportStatus === "ready" || (session.reportStatus === "settling" && !reportSettle)) return;
  clearTimeout(session.analysisTimer);
  session.analysisTimer = null;
  const batch = takeLivePendingBatch(session, { forceFinalWindow: forceInconsistencyPass });
  if (!batch.length) {
    sendLiveAnalysisStatus(session, "idle", "Debate analysis idle", { pendingTurns: 0 });
    return;
  }
  recordLiveAnalysisBatch(session, batch);
  const cadence = reportSettle
    ? reportSettleCadenceCurrent(session)
    : forceInconsistencyPass
      ? fullLiveAnalysisCadence(session)
      : liveAnalysisCadence(session, batch);
  maybeTraceLiveGateOpen(session, cadence, batch);
  session.analysisRunning = true;
  const existingPointIds = new Set((session.debate.points || []).map((point) => point.id));
  sendLiveAnalysisStatus(session, "running", liveAnalysisStatusMessage(cadence, batch), {
    pendingTurns: session.pendingTurns.length,
    cadence: cadence.mode,
    contextBatches: cadence.contextBatches
  });
  try {
    // CLEAN NODE PIPELINE: regroup all final turns into 60s packets and process
    // any newly-settled ones. On the final pass (reportSettle/forceInconsistency)
    // we flush the last partial packet too.
    const allTurns = (session.turns || [])
      .filter((t) => t && t.isFinal && t.text)
      .map((t) => ({ id: t.id, speakerId: t.speakerId, text: t.text, startSec: t.startSec, endSec: t.endSec }));
    const flush = Boolean(reportSettle || forceInconsistencyPass);
    session.livePayload = await analyzeLive(session.analysis, allTurns, { flush });
    session.seq += 1;
    session.lastAnalysisAt = Date.now();
    session.updatedAt = Date.now();
    sendLiveDebateState(session, "analysis", null);
  } catch (error) {
    console.error("Live analysis failed", error);
    sendLiveAnalysisStatus(session, "error", error instanceof Error ? error.message : "Live analysis failed", {
      pendingTurns: session.pendingTurns.length
    });
  } finally {
    session.analysisRunning = false;
    if (session.pendingTurns.length) {
      const decision = liveBatchDecision(session);
      sendLiveAnalysisStatus(session, "queued", "Debate analysis queued", {
        pendingTurns: session.pendingTurns.length,
        pendingDebateMs: decision.pendingDebateMs,
        batchWindowMs: liveBatchWindowMs(session),
        trigger: decision.trigger
      });
      scheduleLiveAnalysis(session, decision.delayMs);
    } else if (!session.verificationRunning && !session.verificationQueue.length) {
      sendLiveAnalysisStatus(session, "idle", "Debate analysis idle", { pendingTurns: 0 });
    }
  }
}

function queueLiveVerification(session, existingPointIds = new Set(), { autoStart = true } = {}) {
  if (!session || session.reportStatus === "ready") return 0;
  expireStaleLiveSourceChecks(session);
  const candidates = selectBalancedVerificationPoints(
    (session.debate.points || [])
      .filter((point) => !existingPointIds.has(point.id) || point.factStatus === "checking")
      .filter((point) => shouldQueueVerification(point))
      .filter((point) => !session.verificationQueuedIds.has(point.id))
      .filter((point) => !session.verificationInFlightIds.has(point.id))
      .filter((point) => !session.verificationCompletedIds.has(point.id)),
    { limit: LIVE_VERIFY_LIMIT, perSpeakerLimit: LIVE_VERIFY_PER_SPEAKER_LIMIT }
  );
  for (const point of candidates) {
    session.verificationQueue.push(point.id);
    session.verificationQueuedIds.add(point.id);
  }
  if (autoStart && session.verificationQueue.length) {
    void runLiveVerification(session);
  }
  return candidates.length;
}

async function runLiveVerification(session) {
  if (!session || session.verificationRunning || !session.verificationQueue.length) return;
  if (session.reportStatus === "ready") {
    session.verificationQueue = [];
    session.verificationQueuedIds.clear();
    return;
  }
  const pointIds = session.verificationQueue.splice(0, LIVE_VERIFY_LIMIT);
  const points = pointIds
    .map((id) => (session.debate.points || []).find((point) => point.id === id))
    .filter(Boolean);
  if (!points.length) return;
  for (const point of points) {
    session.verificationQueuedIds.delete(point.id);
    session.verificationInFlightIds.add(point.id);
  }
  session.verificationRunning = true;
  sendLiveAnalysisStatus(session, "verifying", `Checking ${points.length} source claim${points.length === 1 ? "" : "s"}`, {
    pendingTurns: session.pendingTurns.length
  });
  try {
    const nextState = await verifyDebatePoints({
      points,
      transcriptWindow: session.turns.slice(-24),
      currentDebate: session.debate,
      recordingStartedAt: session.recordingStartedAt,
      options: {
        includeTimings: true,
        limit: LIVE_VERIFY_LIMIT,
        perSpeakerLimit: LIVE_VERIFY_PER_SPEAKER_LIMIT,
        includeLiveTimedOut: true,
        label: `live-verification-${session.id.slice(0, 8)}`
      }
    });
    const { _timings, ...debateState } = nextState;
    session.debate = preserveDurableFactState(session.debate, debateState);
    session.seq += 1;
    session.updatedAt = Date.now();
    for (const point of points) {
      const latest = (session.debate.points || []).find((candidate) => candidate.id === point.id);
      if (latest && latest.factStatus !== "checking") session.verificationCompletedIds.add(point.id);
    }
    appendScoreHistory(session, "verification");
    sendLiveDebateState(session, "verification", _timings);
  } catch (error) {
    console.error("Live verification failed", error);
    sendLiveAnalysisStatus(session, "error", error instanceof Error ? error.message : "Live verification failed", {
      pendingTurns: session.pendingTurns.length
    });
  } finally {
    for (const point of points) session.verificationInFlightIds.delete(point.id);
    session.verificationRunning = false;
    if (!session.verificationQueue.length) {
      queueLiveVerification(session, new Set(), { autoStart: false });
    }
    if (session.verificationQueue.length) {
      setTimeout(() => void runLiveVerification(session), 400);
    } else if (!session.analysisRunning && !session.pendingTurns.length) {
      sendLiveAnalysisStatus(session, "idle", "Debate analysis idle", { pendingTurns: 0 });
    }
  }
}

function sendLiveAnalysisStatus(session, status, message, extra = {}) {
  const payload = {
    type: "analysis_status",
    sessionId: session.id,
    status,
    message,
    pendingTurns: session.pendingTurns?.length || 0,
    ...extra
  };
  sendLiveJson(session, payload);
}

function sendLiveDebateState(session, source, _timings) {
  // Persist the clean payload, then emit it. The frontend reads `analysis`
  // (sides with score/breakdown, debate points+families, claims+tags, inconsistencies).
  queueSessionPersistence(session, `persist analysis ${source}`, () => persistDebateStateSnapshot({
    sessionId: session.id,
    projectId: session.projectId,
    seq: session.seq,
    analysis: session.livePayload || null,
    transcriptTurnCount: session.turns?.length || 0,
    durationMs: sessionDurationMs(session)
  }));
  sendLiveJson(session, {
    type: "debate_state",
    sessionId: session.id,
    seq: session.seq,
    source,
    analysis: session.livePayload || null
  });
}

function sendLiveJson(session, payload) {
  if (session?.ws?.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(payload));
  }
}

function appendScoreHistory(session, source = "analysis") {
  if (!session) return;
  const scorecard = session.debate?.scorecard || computeDirectScorecard(session.debate?.artifacts || {}, session.debate?.sides || []);
  const previous = session.scoreHistory.at(-1) || { minute: 0, blue: 0, red: 0 };
  const nextHistory = buildReportScoreTimeline({
    debate: session.debate || {},
    transcriptTurns: session.turns || [],
    scoreHistory: session.scoreHistory || [],
    scorecard
  });
  const entry = nextHistory.at(-1) || {
    minute: Math.max(0, scoreHistoryMinute(session)),
    blue: Math.round(Number(scorecard.blue?.score ?? session.debate?.scores?.blue ?? 0)),
    red: Math.round(Number(scorecard.red?.score ?? session.debate?.scores?.red ?? 0))
  };
  logLiveScoreSnapshot(session, source, entry, scorecard, previous);
  const previousSignature = scoreTimelineSignature(session.scoreHistory || []);
  const nextSignature = scoreTimelineSignature(nextHistory);
  if (previousSignature === nextSignature) return;
  const now = Date.now();
  session.scoreHistory = nextHistory;
  session.lastScoreHistoryAt = now;
  session.lastScoreEventSignature = entry.event ? scoreEventSignature(entry.event) : `${entry.blue}:${entry.red}`;
  capScoreHistory(session);
}

function scoreTimelineSignature(timeline = []) {
  return (timeline || []).map((entry) => [
    Number(entry?.minute || 0),
    Number(entry?.blue || 0),
    Number(entry?.red || 0),
    entry?.event?.side || "",
    entry?.event?.delta || "",
    entry?.event?.title || "",
    (entry?.event?.artifactIds || []).join("|")
  ].join(":")).join(";");
}

function scoreHistoryEventFromLedger(scorecard = {}, changedSide = "blue", fallbackDelta = 0, source = "analysis", session = null) {
  const events = Array.isArray(scorecard?.ledger?.events) ? scorecard.ledger.events : [];
  const sideEvents = events
    .filter((event) => event?.side === changedSide && Number.isFinite(Number(event.delta)) && event.title)
    .sort((a, b) => scoreEventPriority(b) - scoreEventPriority(a));
  const picked = sideEvents[0];
  if (picked) {
    return {
      side: changedSide,
      delta: Math.round(Number(picked.delta || fallbackDelta || 0)),
      kind: Number(picked.delta || fallbackDelta || 0) < 0 ? "loss" : "score",
      title: sanitizeScoreEventTitle(picked.title, picked),
      detail: cleanClaimText(picked.detail || scorecard.reason || ""),
      source,
      category: picked.category || picked.pillar || "",
      artifactIds: uniqueStrings(picked.artifactIds || []).slice(0, 8)
    };
  }
  if (!fallbackDelta) return null;
  return {
    side: changedSide,
    delta: Math.round(fallbackDelta),
    kind: fallbackDelta < 0 ? "loss" : "score",
    title: fallbackDelta < 0 ? "Score lost" : "Score gained",
    detail: scorecard.reason || "The event ledger changed after new debate artifacts were processed.",
    source,
    artifactIds: recentScoreArtifactIds(session?.debate)
  };
}

function scoreEventSignature(event = {}) {
  return `${event.side || ""}:${event.title || ""}:${event.delta || 0}:${(event.artifactIds || []).join("|")}`;
}

function logLiveScoreSnapshot(session, source, entry, scorecard, previous) {
  const artifacts = normalizeArtifacts(session?.debate?.artifacts || {});
  console.log(`[live-score] ${JSON.stringify({
    at: new Date().toISOString(),
    sessionId: session?.id || "",
    source,
    minute: entry.minute,
    blue: entry.blue,
    red: entry.red,
    changed: Number(previous?.blue) !== Number(entry.blue) || Number(previous?.red) !== Number(entry.red),
    event: entry.event?.title || "",
    edgeLabel: scorecard?.edgeLabel || "",
    reason: scorecard?.reason || "",
    method: scorecard?.method || "",
    leader: scorecard?.leader || "even",
    artifacts: {
      claims: artifacts.claims.length,
      clashes: artifacts.clashes.length,
      inconsistencies: artifacts.inconsistencies.length,
      sourceChecks: artifacts.sourceChecks.length
    }
  })}`);
}

function scoreHistoryMinute(session) {
  const range = debateRangeFromTurns(session?.turns || []);
  if (Number.isFinite(Number(range.endSec))) {
    return Number((Number(range.endSec) / 60).toFixed(1));
  }
  const now = Date.now();
  const activePauseMs = session?.pauseStartedAt ? Math.max(0, now - session.pauseStartedAt) : 0;
  const pausedMs = Math.max(0, Number(session?.pausedMs || 0) + activePauseMs);
  return Number(((now - (session?.recordingStartedAt || now) - pausedMs) / 60000).toFixed(1));
}

function recentScoreArtifactIds(debate = {}) {
  const artifacts = normalizeArtifacts(debate.artifacts || {});
  return [
    ...artifacts.clashes.slice(-2).map((item) => item.id),
    ...artifacts.inconsistencies.slice(-1).map((item) => item.id),
    ...artifacts.claims.slice(-2).map((item) => item.id)
  ].filter(Boolean).slice(0, 4);
}

function capScoreHistory(session) {
  if (session.scoreHistory.length <= 240) return;
  const first = session.scoreHistory[0];
  const tail = session.scoreHistory.slice(-90);
  const events = session.scoreHistory.slice(1, -90).filter((entry) => entry.event).slice(-149);
  const seen = new Set();
  session.scoreHistory = [first, ...events, ...tail].filter((entry) => {
    const key = `${entry.minute}:${entry.blue}:${entry.red}:${entry.event?.title || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reportSettleWaitMs(requestedWaitMs, session = null) {
  const fallback = LIVE_REPORT_CURRENT_WAIT_MS;
  const requested = Number.isFinite(Number(requestedWaitMs)) && Number(requestedWaitMs) > 0
    ? Number(requestedWaitMs)
    : fallback;
  const maxWait = Math.max(1000, LIVE_REPORT_CURRENT_MAX_WAIT_MS);
  return Math.max(1000, Math.min(requested, maxWait));
}

function reportAgentTimeoutMs(requestedTimeoutMs) {
  const requested = Number.isFinite(Number(requestedTimeoutMs)) && Number(requestedTimeoutMs) > 0
    ? Number(requestedTimeoutMs)
    : DEBATE_REPORT_AGENT_TIMEOUT_MS;
  return Math.max(2000, Math.min(requested, DEBATE_REPORT_AGENT_TIMEOUT_MS));
}

// CLEAN report generation: settle the session (flush remaining packets through
// the node pipeline), then hand the clean live payload to the Report Builder
// node. Numbers/charts come straight from the ledger; only prose is AI-written.
async function generateDebateReport({ sessionId = "", analysis = null, transcriptTurns = [], durationMs = 0, options = {} } = {}) {
  const startedAt = Date.now();
  const session = sessionId ? liveSessions.get(sessionId) : null;
  if (session) {
    const waitMs = reportSettleWaitMs(options.waitMs, session);
    await settleLiveSessionForReport(session, waitMs);
    console.log(`[debate-report] settle finished ${JSON.stringify({ sessionId: session.id, elapsedMs: Date.now() - startedAt, waitMs })}`);
  }
  // Guarantee the final (still-open) packet is flushed through the pipeline so
  // the report — and the score timeline's last point — covers the whole debate.
  if (session?.analysis) {
    try {
      const allTurns = (session.turns || [])
        .filter((t) => t && t.isFinal && t.text)
        .map((t) => ({ id: t.id, speakerId: t.speakerId, text: t.text, startSec: t.startSec, endSec: t.endSec }));
      session.livePayload = await analyzeLive(session.analysis, allTurns, { flush: true });
    } catch (error) {
      console.warn(`[debate-report] final flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The clean pipeline payload is the single source of truth for the report.
  const payload = session?.livePayload || analysis || null;
  const turns = session ? session.turns : (Array.isArray(transcriptTurns) ? transcriptTurns : []);
  const reportDurationMs = session ? sessionDurationMs(session) : Math.max(0, Math.round(Number(durationMs) || 0));
  const reportSessionId = session?.id || sessionId || "";

  if (!payload || !payload.sides) {
    console.log(`[debate-report] no analysis payload — returning empty report ${JSON.stringify({ sessionId: reportSessionId })}`);
    return emptyDebateReport(reportSessionId, reportDurationMs);
  }

  const trace = createTrace(`debate-report-${reportSessionId.slice(0, 8) || "fallback"}`);
  const report = await runReportBuilder({
    payload,
    transcriptTurns: turns,
    durationMs: reportDurationMs,
    sessionId: reportSessionId,
    trace
  });
  console.log(`[debate-report] report built ${JSON.stringify({ sessionId: reportSessionId, elapsedMs: Date.now() - startedAt, speakers: report.speakers?.length || 0, factChecks: report.factChecks?.length || 0 })}`);
  return report;
}

// Minimal valid report when there's nothing to analyze (e.g. stopped instantly).
function emptyDebateReport(sessionId, durationMs) {
  return {
    id: `report-${Date.now().toString(36)}`,
    sessionId: String(sessionId || ""),
    generatedAt: new Date().toISOString(),
    topic: "",
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    verdict: "No debate was analyzed in this session, so there is nothing to report.",
    blueSummary: "",
    redSummary: "",
    scoreboard: { blue: { score: 0, breakdown: null }, red: { score: 0, breakdown: null } },
    scoreTimeline: { points: [], maxMinute: 0, capMinute: 10 },
    speakers: [],
    factChecks: [],
    contradictions: [],
    keyMoments: []
  };
}

async function settleLiveSessionForReport(session, timeoutMs) {
  const startedAt = Date.now();
  const settleTimings = {
    analysisMs: 0,
    finalInconsistencyMs: 0,
    verificationMs: 0,
    judgeMs: 0
  };
  session.reportStatus = "settling";
  console.log(`[debate-report] settle start ${JSON.stringify({
    sessionId: session.id,
    pendingTurns: session.pendingTurns.length,
    verificationQueue: session.verificationQueue.length,
    remainingCheckablePoints: countRemainingCheckablePoints(session),
    timeoutMs
  })}`);
  sendLiveAnalysisStatus(session, "running", "Finishing the last transcript batches", {
    pendingTurns: session.pendingTurns.length
  });
  clearTimeout(session.analysisTimer);
  session.analysisTimer = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (session.analysisRunning || session.verificationRunning) {
      await sleep(150);
      continue;
    }
    if (session.pendingTurns.length) {
      const stageStartedAt = Date.now();
      await runLiveAnalysis(session, {
        forceInconsistencyPass: false,
        reportSettle: true
      });
      settleTimings.analysisMs += Date.now() - stageStartedAt;
      continue;
    }
    if (!session.finalInconsistencySettled) {
      const stageStartedAt = Date.now();
      await runLiveFinalInconsistencyPass(session);
      settleTimings.finalInconsistencyMs += Date.now() - stageStartedAt;
      continue;
    }
    let queuedVerification = 0;
    if (!session.verificationQueue.length) {
      queuedVerification = queueRemainingLiveVerification(session);
    }
    if (session.verificationQueue.length) {
      const stageStartedAt = Date.now();
      await runLiveVerification(session);
      settleTimings.verificationMs += Date.now() - stageStartedAt;
      continue;
    }
    if (!hasRemainingCheckablePoints(session)) break;
    if (!queuedVerification) {
      console.log(`[debate-report] settle unresolved checks will be finalized ${JSON.stringify({
        sessionId: session.id,
        elapsedMs: Date.now() - startedAt,
        remainingCheckablePoints: countRemainingCheckablePoints(session)
      })}`);
      break;
    }
    await sleep(150);
  }
  if (session.analysisRunning || session.verificationRunning || session.pendingTurns.length || hasRemainingCheckablePoints(session)) {
    console.log(`[debate-report] settle timeout ${JSON.stringify({
      sessionId: session.id,
      elapsedMs: Date.now() - startedAt,
      pendingTurns: session.pendingTurns.length,
      verificationQueue: session.verificationQueue.length,
      remainingCheckablePoints: countRemainingCheckablePoints(session)
    })}`);
  }
  const forcedVerification = forceResolvePendingVerificationForReport(session.debate);
  if (forcedVerification.changed) {
    session.debate = forcedVerification.debate;
    session.verificationQueue = [];
    session.verificationQueuedIds.clear();
    for (const pointId of forcedVerification.pointIds) {
      session.verificationCompletedIds.add(pointId);
    }
    console.log(`[debate-report] pending source checks finalized ${JSON.stringify({
      sessionId: session.id,
      finalized: forcedVerification.pointIds.length
    })}`);
  }
  const judgeStartedAt = Date.now();
  session.debate = finalizeDirectLedgerState(session.debate);
  settleTimings.judgeMs = Date.now() - judgeStartedAt;
  appendScoreHistory(session, "verification");
  session.reportStatus = "ready";
  session.reportFinalizedAt = Date.now();
  session.verificationQueue = [];
  session.verificationQueuedIds.clear();
  console.log(`[debate-report] settle complete ${JSON.stringify({
    sessionId: session.id,
    elapsedMs: Date.now() - startedAt,
    timings: settleTimings,
    pendingTurns: session.pendingTurns.length,
    remainingCheckablePoints: countRemainingCheckablePoints(session),
    claims: session.debate?.artifacts?.claims?.length || 0,
    sourceChecks: session.debate?.artifacts?.sourceChecks?.length || 0
  })}`);
}

function queueRemainingLiveVerification(session) {
  if (!session) return 0;
  const candidates = (session.debate.points || [])
    .filter((point) => shouldQueueVerification(point, { includeLiveTimedOut: true }))
    .filter((point) => !session.verificationQueuedIds.has(point.id))
    .filter((point) => !session.verificationInFlightIds.has(point.id))
    .filter((point) => !session.verificationCompletedIds.has(point.id) || point.factStatus === "checking" || isLiveSourceTimedOut(point))
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  for (const point of candidates) {
    session.verificationQueue.push(point.id);
    session.verificationQueuedIds.add(point.id);
  }
  return candidates.length;
}

function hasRemainingCheckablePoints(session) {
  return countRemainingCheckablePoints(session) > 0;
}

function countRemainingCheckablePoints(session) {
  return (session?.debate?.points || [])
    .filter((point) => shouldQueueVerification(point, { includeLiveTimedOut: true }))
    .filter((point) => !session.verificationCompletedIds.has(point.id) || point.factStatus === "checking" || isLiveSourceTimedOut(point))
    .length;
}

function forceResolvePendingVerificationForReport(debate = {}) {
  const state = normalizeClaimState(debate);
  const pointIds = [];
  const points = (state.points || []).map((point) => {
    if (!point?.id || normalizeFactStatus(point.factStatus) !== "checking") return point;
    if (!isAssertedPoint(point)) return point;
    pointIds.push(point.id);
    const why = "No completed source result was available before the final report, so this claim remains unverified.";
    return {
      ...point,
      factStatus: "no_clear_source",
      evidenceBasis: "contextual",
      scoreEligible: false,
      why,
      noSourceReason: why,
      sources: normalizeSources(point.sources || point.audit?.sources || []),
      audit: {
        ...point.audit,
        factExplanation: why,
        evidenceBasis: "contextual",
        scoreEligible: false,
        sources: normalizeSources(point.sources || point.audit?.sources || [])
      }
    };
  });
  if (!pointIds.length) return { debate, changed: false, pointIds: [] };
  const next = finalizeDirectLedgerState({ ...state, points });
  return { debate: next, changed: true, pointIds };
}

async function runDebateReportAgent({ debate, transcriptTurns, scoreHistory, deterministic, trace }) {
  const context = buildDebateReportContext(debate, transcriptTurns, scoreHistory, deterministic);
  const prompt = [
    "You are debatly's Final Report Agent.",
    "Your job is to write the Final Report section for a news audience after the recording has stopped.",
    "Use only the transcript-backed artifacts and score timeline in the context.",
    "Write in past tense. Do not write live/progressive language such as 'is pressing', 'is gaining', or 'is forming'.",
    "Do not use internal labels like analyst read, quote receipt, burden met, artifact, model, or pipeline.",
    "Use Blue side and Red side vocabulary in report prose. Do not write Speaker 1, Speaker 2, or speaker names in the report copy.",
    "Keep the language direct, specific, and grounded in the speakers' own words.",
    "Treat reportCompiler as the approved report scaffold. Do not invent major themes outside that scaffold.",
    "Build the highlights from the approved issue matrix, burden board, Key Moments, fact-check read, consistency read, and score milestones.",
    "Never turn a neutral/moderator quote into a Blue side or Red side owned highlight. Use neutral quotes only for format/context if needed.",
    "Return strict JSON only.",
    "Schema:",
    "{",
    '  "questionOnTable": "one clear audience question",',
    '  "burdenLeftOpen": "what the trailing side still had to prove",',
    '  "groundGained": "why one side gained ground or why no clear edge emerged",',
    '  "highlightCards": [{"label":"short label","title":"plain past-tense title","detail":"2 short sentences","tone":"blue|red|amber|green","quotes":[{"speaker":"Speaker 1|Speaker 2|Speaker N","tone":"blue|red|neutral","text":"exact quote"}],"artifactIds":["ids"]}]',
    "}",
    "Rules:",
    "- Produce 4-6 highlight cards.",
    "- Each quote must be exact or near-exact from the routed artifacts or transcript snippets.",
    "- Each quote must be one complete standalone sentence or question, normally 8-26 words.",
    "- Do not stitch multiple sentences together. Prefer one full statement that captures the claim.",
    "- Prefer quotes already attached to the direct-ledger artifact IDs you cite. The backend will resolve quote ownership from direct artifacts.",
    "- Report prose must say Blue side or Red side, but quote speaker fields must name the actual transcript speaker who said the words, such as Speaker 1 or Speaker 2. Do not label a quote as Blue side or Red side.",
    "- If the debate is not mature enough, say what remained unresolved instead of pretending there was a decisive report.",
    "- Prefer specific cards such as burden left open, concession locked, source-backed turn, capability test weakened, direct answer problem, source check, or consistency break when the artifacts support them.",
    "- At least one highlight should explain a score-timeline milestone when one exists.",
    "- At least one highlight should use a Key Moment when the scaffold includes one.",
    `Routed context for Final Report Agent: ${stringifyAgentContext(context)}`
  ].join("\n");
  const response = await generateContentForAgent({
    trace,
    agent: "Debate Final Report Agent",
    model: config.fastModel,
    contents: prompt,
    config: {
      temperature: 0.08,
      responseMimeType: "application/json"
    },
    meta: {
      claims: context.artifacts.claims.length,
      clashes: context.artifacts.clashes.length,
      turns: transcriptTurns.length
    }
  });
  return parseJsonWithLocalRepair(response.text || "{}");
}

function buildDebateReportContext(debate = {}, transcriptTurns = [], scoreHistory = [], deterministic = {}) {
  const normalized = finalizeDirectLedgerState(normalizeClaimState(debate));
  const artifacts = normalizeArtifacts(normalized.artifacts || {});
  const reportCompiler = buildReportCompilerScaffold(normalized, {}, artifacts, scoreHistory, deterministic);
  return {
    topic: normalized.topic || "",
    sides: ensureTwoSides(normalized.sides || []).map((side) => ({
      id: side.id,
      label: confirmedSideLabel(side),
      score: side.score,
      speakerIds: side.speakerIds || []
    })),
    scorecard: compactReportScorecard(normalized.scorecard),
    scoreTimeline: (scoreHistory || []).slice(-80),
    reportCompiler,
    artifacts: {
      claims: artifacts.claims.slice(-18).map((item) => compactReportCard(item, "claim")),
      clashes: artifacts.clashes.slice(-14).map((item) => compactReportCard(item, "clash")),
      inconsistencies: artifacts.inconsistencies.slice(-8).map((item) => compactReportCard(item, "inconsistency")),
      keyMoments: artifacts.keyMoments.slice(-10).map((item) => compactReportCard(item, "key_moment")),
      sourceChecks: artifacts.sourceChecks.slice(-12).map((item) => compactReportCard(item, "source"))
    },
    transcriptSamples: (transcriptTurns || []).filter((turn) => turn?.isFinal).slice(-30).map((turn) => ({
      side: sideName(turnOwnerSideFromState(normalized, turn) || speakerSideFromState(normalized, turn.speakerId)),
      text: truncatePromptText(turn.text || "", 260),
      at: turn.at,
      startSec: turn.startSec,
      endSec: turn.endSec
    })),
    deterministicDraft: {
      questionOnTable: deterministic.questionOnTable,
      burdenLeftOpen: deterministic.burdenLeftOpen,
      groundGained: deterministic.groundGained
    }
  };
}

function buildReportCompilerScaffold(debate = {}, _unused = {}, artifacts = {}, scoreHistory = [], deterministic = {}) {
  const sides = ensureTwoSides(debate.sides || []);
  const floorSpeakers = new Map((debate.floorState?.speakers || []).map((speaker) => [speaker.speakerId, speaker]));
  return {
    frame: {
      question: officialReportQuestionFromDebate(debate) || deterministic.questionOnTable || "",
      blueThesis: confirmedSideLabel(sides[0]),
      redThesis: confirmedSideLabel(sides[1]),
      debatePhase: debate.floorState?.phase || "",
      confidence: 0
    },
    speakerRoles: (debate.speakers || []).map((speaker) => {
      const floor = floorSpeakers.get(speaker.speakerId) || {};
      return {
        speakerId: speaker.speakerId,
        role: floor.role || speaker.speakerRole || "unknown_speaker",
        side: sideName(speaker.sideId),
        confidence: floor.confidence || speaker.floorRoleConfidence || speaker.sideConfidence || 0
      };
    }).slice(0, 8),
    issueMatrix: buildReportIssueMatrix(artifacts),
    burdenBoard: buildReportBurdenBoard(artifacts),
    keyMoments: (artifacts.keyMoments || [])
      .slice(-8)
      .map((item) => compactReportCard(item, "key_moment"))
      .filter(Boolean),
    factCheckRead: buildReportFactCheckRead(artifacts),
    consistencyRead: buildReportConsistencyRead(artifacts),
    scoreMilestones: buildReportScoreMilestoneScaffold(scoreHistory)
  };
}

function buildReportIssueMatrix(artifacts = {}) {
  const groups = new Map();
  const add = (item = {}, type = "") => {
    const card = compactReportCard(item, type);
    if (!card?.id) return;
    const title = cleanReportText(card.issueGroupTitle || item.issueTitle || item.title || item.claim || item.summary || type.replace(/_/g, " "));
    const key = cleanClaimText(card.issueGroupId || normalizeTranscript(title).split(/\s+/).slice(0, 8).join("-") || card.id);
    const group = groups.get(key) || { issue: truncatePromptText(title, 90), cards: [], blue: [], red: [], clashes: [], keyMoments: [], sources: [], inconsistencies: [] };
    group.cards.push(card);
    if (card.sideId === "side-a") group.blue.push(card);
    if (card.sideId === "side-b") group.red.push(card);
    if (type === "clash") group.clashes.push(card);
    if (type === "key_moment") group.keyMoments.push(card);
    if (type === "source") group.sources.push(card);
    if (type === "inconsistency") group.inconsistencies.push(card);
    groups.set(key, group);
  };
  for (const item of artifacts.claims || []) add(item, "claim");
  for (const item of artifacts.clashes || []) add(item, "clash");
  for (const item of artifacts.inconsistencies || []) add(item, "inconsistency");
  for (const item of artifacts.keyMoments || []) add(item, "key_moment");
  for (const item of artifacts.sourceChecks || []) add(item, "source");
  return [...groups.values()]
    .map((group) => {
      const blueBest = pickBestReportCompilerCard(group.blue);
      const redBest = pickBestReportCompilerCard(group.red);
      const clash = pickBestReportCompilerCard(group.clashes);
      const status = group.keyMoments.length
        ? "Key Moment"
        : group.inconsistencies.length
          ? "consistency issue"
          : blueBest && redBest
              ? "contested"
              : blueBest
                ? "Blue side developed"
                : redBest
                  ? "Red side developed"
                  : "context";
      return {
        issue: group.issue,
        status,
        blue: blueBest ? compactReportCompilerCard(blueBest) : null,
        red: redBest ? compactReportCompilerCard(redBest) : null,
        clash: clash ? compactReportCompilerCard(clash) : null,
        artifactIds: uniqueStrings(group.cards.map((card) => card.id)).slice(0, 10),
        weight: group.cards.length + group.clashes.length * 2 + group.keyMoments.length * 4 + group.inconsistencies.length * 3 + group.sources.length
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);
}

function pickBestReportCompilerCard(cards = []) {
  return [...cards].filter(Boolean).sort((a, b) => reportCompilerCardPriority(b) - reportCompilerCardPriority(a))[0] || null;
}

function reportCompilerCardPriority(card = {}) {
  let score = 0;
  if (card.type === "key_moment") score += 12;
  if (card.type === "clash") score += 8;
  if (card.type === "inconsistency") score += 7;
  if (card.type === "source") score += 6;
  if (card.quote) score += 2;
  if (card.status === "verified" || card.sourceStatus === "verified") score += 3;
  if (card.status === "claim_weakened" || card.status === "claim_defeated") score += 3;
  score += Math.min(4, wordCount(`${card.title || ""} ${card.detail || ""}`) / 20);
  return score;
}

function compactReportCompilerCard(card = {}) {
  if (!card || typeof card !== "object") return null;
  return {
    id: card.id,
    type: card.type,
    side: sideName(card.sideId),
    title: card.title,
    detail: card.detail,
    quote: card.quote,
    status: card.status || card.sourceStatus || "",
    artifactIds: card.artifactIds || []
  };
}

function buildReportBurdenBoard(artifacts = {}) {
  const sideSummary = (sideId) => {
    const met = (artifacts.claims || []).filter((claim) => claim.sideId === sideId && (claim.burden === "met" || claim.status === "supported")).slice(-4);
    const open = (artifacts.claims || []).filter((claim) => claim.sideId === sideId && (claim.burden === "open" || claim.status === "checking")).slice(-5);
    return {
      side: sideName(sideId),
      met: met.map((item) => compactReportCompilerCard(compactReportCard(item, "claim"))).filter(Boolean),
      open: open.map((item) => compactReportCompilerCard(compactReportCard(item, "claim"))).filter(Boolean)
    };
  };
  return [sideSummary("side-a"), sideSummary("side-b")];
}

function buildReportFactCheckRead(artifacts = {}) {
  const sources = [...(artifacts.sourceChecks || [])]
    .map((item) => compactReportCard(item, "source"))
    .filter(Boolean);
  const byStatus = sources.reduce((counts, source) => {
    const status = source.sourceStatus || source.status || source.evidenceStatus || "unknown";
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  return {
    counts: byStatus,
    strongest: sources
      .filter((source) => source.sourceStatus === "verified" || source.status === "verified")
      .slice(-4)
      .map(compactReportCompilerCard),
    unresolved: sources
      .filter((source) => !["verified", "contradicted"].includes(normalizeFactStatus(source.sourceStatus || source.status)))
      .slice(-4)
      .map(compactReportCompilerCard)
  };
}

function buildReportConsistencyRead(artifacts = {}) {
  const items = [...(artifacts.inconsistencies || [])]
    .map((item) => compactReportCard(item, "inconsistency"))
    .filter(Boolean);
  return {
    count: items.length,
    strongest: items.slice(-6).map(compactReportCompilerCard),
    status: items.length ? "durable consistency issues found" : "no durable inconsistency found"
  };
}

function buildReportScoreMilestoneScaffold(scoreHistory = []) {
  return normalizeScoreTimeline(scoreHistory, null)
    .filter((entry, index, array) => index === 0 || entry.event || index === array.length - 1)
    .slice(-14)
    .map((entry) => ({
      minute: entry.minute,
      blue: entry.blue,
      red: entry.red,
      event: entry.event ? {
        side: entry.event.side === "red" ? "Red side" : "Blue side",
        delta: entry.event.delta,
        title: entry.event.title,
        detail: entry.event.detail,
        category: entry.event.category || "",
        artifactIds: entry.event.artifactIds || []
      } : null
    }));
}

function compactReportCard(item = {}, type = "") {
  if (!item || typeof item !== "object") return null;
  return {
    id: cleanClaimText(item.id || ""),
    type,
    sideId: type === "inconsistency" ? inconsistencySideId(item) : normalizeSideId(item.sideId),
    speakerId: cleanClaimText(item.speakerId || item.quoteASpeakerId || ""),
    title: truncatePromptText(cleanClaimText(item.title || item.claim || item.summary || item.label || ""), 220),
    detail: truncatePromptText(cleanClaimText(item.summary || item.explanation || item.burdenWhy || ""), 260),
    quote: truncatePromptText(cleanClaimText(item.quote || item.sourceQuote || item.challengerResponse || ""), 240),
    targetQuote: truncatePromptText(cleanClaimText(item.targetQuote || item.originalClaim || ""), 220),
    quoteA: truncatePromptText(cleanClaimText(item.quoteA || ""), 220),
    quoteB: truncatePromptText(cleanClaimText(item.quoteB || ""), 220),
    status: cleanClaimText(item.status || item.outcome || item.evidenceStatus || ""),
    sourceStatus: cleanClaimText(item.sourceStatus || item.status || ""),
    evidenceStatus: cleanClaimText(item.evidenceStatus || ""),
    severity: item.severity,
    issueGroupId: cleanClaimText(item.issueGroupId || ""),
    issueGroupTitle: truncatePromptText(cleanClaimText(item.issueGroupTitle || ""), 120),
    pointId: cleanClaimText(item.pointId || item.pointIds?.[0] || ""),
    claimId: cleanClaimText(item.claimId || item.claimIds?.[0] || ""),
    artifactIds: uniqueStrings([item.id, item.claimId, item.pointId, ...(Array.isArray(item.artifactIds) ? item.artifactIds : [])].filter(Boolean)).slice(0, 8),
    minute: Number.isFinite(Number(item.startSec)) ? Number((Number(item.startSec) / 60).toFixed(1)) : undefined
  };
}

function compactReportScoreEvent(event = {}) {
  return {
    id: cleanClaimText(event.id || ""),
    side: event.side === "red" ? "red" : event.sideId === "side-b" ? "red" : "blue",
    sideId: normalizeSideId(event.sideId || (event.side === "red" ? "side-b" : "side-a")),
    delta: Math.round(Number(event.delta ?? event.value ?? 0)),
    title: truncatePromptText(cleanClaimText(event.title || ""), 120),
    detail: truncatePromptText(cleanClaimText(event.detail || ""), 180),
    category: cleanClaimText(event.category || event.pillar || ""),
    artifactIds: uniqueStrings(event.artifactIds || []).slice(0, 8),
    minute: event.minute
  };
}

function compactReportScorecard(scorecard = {}) {
  if (!scorecard || typeof scorecard !== "object") return null;
  const compactSide = (side = {}) => ({
    score: Math.round(Number(side.score || 0)),
    pillars: (side.pillars || []).map((pillar) => ({
      key: pillar.key,
      value: Math.round(Number(pillar.value || 0)),
      artifactIds: uniqueStrings(pillar.artifactIds || []).slice(0, 8)
    }))
  });
  return {
    method: scorecard.method || "",
    leader: scorecard.leader || "",
    edgeLabel: scorecard.edgeLabel || "",
    reason: truncatePromptText(cleanClaimText(scorecard.reason || ""), 260),
    blue: compactSide(scorecard.blue),
    red: compactSide(scorecard.red),
    events: (scorecard.ledger?.events || []).slice(-20).map(compactReportScoreEvent)
  };
}

function buildDeterministicDebateReport({ sessionId = "", debate = {}, transcriptTurns = [], scoreHistory = [] } = {}) {
  const normalized = finalizeDirectLedgerState(normalizeClaimState(debate));
  const artifacts = normalizeArtifacts(normalized.artifacts || {});
  const scorecard = normalized.scorecard || computeDirectScorecard(artifacts, normalized.sides || []);
  const leaderColor = scorecard.leader === "red" || scorecard.edgeLabel === "Red edge" ? "red" : scorecard.leader === "blue" || scorecard.edgeLabel === "Blue edge" ? "blue" : "amber";
  const leaderSideId = leaderColor === "red" ? "side-b" : "side-a";
  const trailingSideId = leaderSideId === "side-a" ? "side-b" : "side-a";
  const strongestClaim = pickStrongestClaim(artifacts.claims, leaderSideId) || artifacts.claims[0];
  const strongestChallenge = artifacts.clashes.find((item) => ["claim_defeated", "claim_weakened"].includes(item.outcome)) || artifacts.clashes[0];
  const Inconsistency = artifacts.inconsistencies.find((item) => item.severity === "high") || artifacts.inconsistencies[0];
  const keyMoment = artifacts.keyMoments?.[0];
  const sourceCheck = artifacts.sourceChecks.find((item) => item.status === "verified" || item.status === "contradicted") || artifacts.sourceChecks[0];
  const openClaim = artifacts.claims.find((claim) => claim.sideId === trailingSideId && claim.burden === "open")
    || artifacts.claims.find((claim) => claim.burden === "open");
  const report = {
    id: `report-${randomUUID()}`,
    sessionId,
    generatedAt: new Date().toISOString(),
    questionOnTable: buildReportQuestion(normalized, strongestChallenge, strongestClaim),
    burdenLeftOpen: openClaim
      ? `${sideName(openClaim.sideId)} still had to prove this: ${openClaim.claim}`
      : scorecard.edgeLabel === "Even" || scorecard.leader === "even"
        ? "Neither side left a single decisive burden resolved."
        : `${sideName(trailingSideId)} still had to answer the strongest points behind ${sideName(leaderSideId)}'s lead.`,
    groundGained: scorecard.edgeLabel === "Even" || scorecard.leader === "even"
      ? "The debate finished without a clear score lead."
      : `${sideName(leaderSideId)} gained ground because ${lowerFirst(scorecard.reason || "its strongest points held up better")}.`,
    scoreTimeline: Array.isArray(scoreHistory) && scoreHistory.length > 1
      ? normalizeScoreTimeline(scoreHistory, scorecard)
      : buildReportScoreTimeline({ debate: normalized, transcriptTurns, scoreHistory, scorecard }),
    highlightCards: []
  };
  if (strongestClaim) {
    report.highlightCards.push({
      label: "Strongest claim",
      title: strongestClaim.claim,
      detail: strongestClaim.burdenWhy || "This was one of the clearest claims the side put before the audience.",
      tone: toneForSide(strongestClaim.sideId),
      quotes: quoteList([{ speaker: strongestClaim.speakerId, sideId: strongestClaim.sideId, text: strongestClaim.quote }]),
      artifactIds: [strongestClaim.id]
    });
  }
  if (strongestChallenge) {
    const challengeTargetPoint = (normalized.points || []).find((point) => point.id === strongestChallenge.toPointId);
    report.highlightCards.push({
      label: "Key clash",
      title: strongestChallenge.summary,
      detail: strongestChallenge.challengerResponse,
      tone: toneForSide(strongestChallenge.sideId),
      quotes: quoteList([
        { speaker: challengeTargetPoint?.speakerId, sideId: challengeTargetPoint?.sideId, text: strongestChallenge.targetQuote },
        { speaker: strongestChallenge.speakerId, sideId: strongestChallenge.sideId, text: strongestChallenge.sourceQuote }
      ]),
      artifactIds: [strongestChallenge.id]
    });
  }
  if (keyMoment) {
    report.highlightCards.push({
      label: "Key Moment",
      title: keyMoment.title || "A major score moment changed the debate",
      detail: keyMoment.summary || "This moment shifted how the strongest claims were judged.",
      tone: toneForSide(keyMoment.sideId) || "amber",
      quotes: quoteList([{ speaker: keyMoment.speakerId, sideId: keyMoment.sideId, text: keyMoment.quote }]),
      artifactIds: [keyMoment.id, ...(keyMoment.artifactIds || [])].filter(Boolean)
    });
  }
  if (Inconsistency) {
    const accusedSideId = inconsistencySideId(Inconsistency);
    report.highlightCards.push({
      label: "Inconsistency",
      title: Inconsistency.summary,
      detail: `${sideName(accusedSideId)} had to explain why these two standards belonged together.`,
      tone: toneForSide(accusedSideId),
      quotes: quoteList([
        { speaker: Inconsistency.quoteASpeakerId || Inconsistency.speakerId, sideId: accusedSideId, text: Inconsistency.quoteA },
        { speaker: Inconsistency.quoteBSpeakerId || Inconsistency.speakerId, sideId: accusedSideId, text: Inconsistency.quoteB }
      ]),
      artifactIds: [Inconsistency.id]
    });
  }
  if (sourceCheck) {
    report.highlightCards.push({
      label: "Source check",
      title: sourceCheck.claim,
      detail: sourceCheck.explanation,
      tone: sourceCheck.status === "verified" ? "green" : normalizeFactStatus(sourceCheck.status) === "contradicted" ? "red" : "amber",
      quotes: [],
      artifactIds: [sourceCheck.id]
    });
  }
  if (!report.highlightCards.length) {
    const finalTurns = (transcriptTurns || []).filter((turn) => turn?.isFinal).slice(-4);
    report.highlightCards.push({
      label: "Transcript read",
      title: "The report needed more durable claim material.",
      detail: "The recording ended before the system had enough stable claims, clashes, or source checks to produce a full debate read.",
      tone: "amber",
      quotes: finalTurns.slice(0, 2).map((turn) => ({ speaker: turn.speakerId, tone: "neutral", text: turn.text })),
      artifactIds: []
    });
  }
  return normalizeDebateReport(report, report, { sourceChecks: artifacts.sourceChecks });
}

function normalizeDebateReport(candidate = {}, fallback = {}, options = {}) {
  const cards = Array.isArray(candidate.highlightCards) && candidate.highlightCards.length
    ? candidate.highlightCards
    : fallback.highlightCards || [];
  const fallbackCards = Array.isArray(fallback.highlightCards) ? fallback.highlightCards : [];
  const quoteCatalog = Array.isArray(options.quoteCatalog) ? options.quoteCatalog : [];
  const officialScoreTimeline = Array.isArray(options.scoreTimeline) && options.scoreTimeline.length
    ? options.scoreTimeline
    : null;
  return {
    id: cleanClaimText(candidate.id || fallback.id || `report-${randomUUID()}`),
    sessionId: cleanClaimText(candidate.sessionId || fallback.sessionId || ""),
    generatedAt: candidate.generatedAt || fallback.generatedAt || new Date().toISOString(),
    questionOnTable: cleanReportText(options.questionOnTable || fallback.questionOnTable || candidate.questionOnTable || "Which side left the stronger record?"),
    burdenLeftOpen: cleanReportText(candidate.burdenLeftOpen || fallback.burdenLeftOpen || "The final burden remained unresolved."),
    groundGained: cleanReportText(candidate.groundGained || fallback.groundGained || "No clear edge emerged."),
    scoreTimeline: normalizeScoreTimeline(officialScoreTimeline || fallback.scoreTimeline || candidate.scoreTimeline || [], null),
    highlightCards: cards.slice(0, 6).map((card, index) => {
      const fallbackCard = fallbackCards[index] || {};
      return {
        label: cleanReportText(card?.label || `Highlight ${index + 1}`),
        title: cleanReportText(card?.title || "Debate highlight"),
        detail: cleanReportText(card?.detail || ""),
        tone: ["blue", "red", "amber", "green"].includes(card?.tone) ? card.tone : "amber",
        quotes: normalizeReportQuotes(
          (card?.quotes || []).map((quote) => ({ ...quote, artifactIds: card?.artifactIds || [] })),
          quoteCatalog,
          (fallbackCard?.quotes || []).map((quote) => ({ ...quote, artifactIds: fallbackCard?.artifactIds || [] }))
        ),
        artifactIds: Array.isArray(card?.artifactIds) ? card.artifactIds.map((id) => cleanClaimText(id)).filter(Boolean).slice(0, 8) : []
      };
    })
  };
}

function attachReportGenerationTiming(report = {}, timing = {}) {
  const elapsedMs = Math.max(0, Math.round(Number(timing.elapsedMs || 0)));
  if (!report || typeof report !== "object" || !elapsedMs) return report;
  return {
    ...report,
    generationTiming: {
      ...(report.generationTiming && typeof report.generationTiming === "object" ? report.generationTiming : {}),
      elapsedMs,
      measuredAt: cleanClaimText(timing.measuredAt || new Date().toISOString()),
      source: cleanClaimText(timing.source || "api")
    }
  };
}

function cleanReportText(text = "") {
  return cleanClaimText(text)
    .replace(/\bside[\s_-]*a\b/gi, "Blue side")
    .replace(/\bside[\s_-]*b\b/gi, "Red side")
    .replace(/\bSpeaker\s*1['\u2019]s\b/gi, "a side's")
    .replace(/\bSpeaker\s*2['\u2019]s\b/gi, "a side's")
    .replace(/\bSpeaker\s*1['’]s\b/gi, "Blue side's")
    .replace(/\bSpeaker\s*2['’]s\b/gi, "Red side's")
    .replace(/\bSpeaker\s*\d+['’]s\b/gi, "a side's")
    .replace(/\bSpeaker\s*\d+\b/gi, "a side")
    .replace(/\bthe speaker\b/gi, "the side")
    .replace(/\bspeaker perspective\b/gi, "side perspective");
}

function buildFallbackScoreTimeline(debate = {}) {
  const direct = finalizeDirectLedgerState(normalizeClaimState(debate));
  const scorecard = direct.scorecard || computeDirectScorecard(direct.artifacts || {}, direct.sides || []);
  return normalizeScoreTimeline([{ minute: 0, blue: 0, red: 0 }, { minute: 1, blue: scorecard.blue.score, red: scorecard.red.score }], scorecard);
}

function buildReportScoreTimeline({ debate = {}, transcriptTurns = [], scoreHistory = [], scorecard = null } = {}) {
  const normalized = finalizeDirectLedgerState(normalizeClaimState(debate));
  const pointsById = new Map((normalized.points || []).map((point) => [point.id, point]));
  const artifacts = normalizeArtifacts(normalized.artifacts || {});
  const artifactMinuteById = buildReportArtifactMinuteIndex(normalized, artifacts);
  const events = [];
  const addEvent = (event) => {
    const side = event.sideId === "side-b" || event.side === "red" ? "red" : event.sideId === "side-a" || event.side === "blue" ? "blue" : "";
    if (!side || !Number.isFinite(Number(event.delta)) || !event.title) return;
    events.push({
      side,
      delta: Math.max(-10, Math.min(10, Math.round(Number(event.delta)))),
      kind: Number(event.delta) < 0 ? "loss" : "score",
      title: sanitizeScoreEventTitle(event.title, event),
      detail: cleanClaimText(event.detail || ""),
      minute: resolveReportScoreEventMinute(event, artifactMinuteById, pointsById, transcriptTurns, events.length),
      artifactIds: uniqueStrings(event.artifactIds || []).slice(0, 6),
      category: cleanClaimText(event.category || ""),
      weight: Math.abs(Number(event.delta)) + Number(event.weight || 0)
    });
  };

  const existingTimeline = normalizeScoreTimeline(scoreHistory, scorecard);
  const ledgerEvents = buildReportEventsFromScoreLedger(scorecard?.ledger);
  if (!ledgerEvents.length && scoreTimelineMatchesScorecard(existingTimeline, scorecard) && existingTimeline.some((entry) => entry.event)) {
    return selectMeaningfulReportScoreTimeline(appendReportTimelineEndpoint(existingTimeline, transcriptTurns, scorecard));
  }

  const scorecardEvents = ledgerEvents.length ? [] : buildReportEventsFromScorecard(scorecard);
  for (const event of (ledgerEvents.length ? ledgerEvents : scorecardEvents)) addEvent(event);

  if (!events.length) {
    const historyEvents = normalizeScoreTimeline(scoreHistory, scorecard).filter((entry, index, array) => index === 0 || entry.event || index === array.length - 1);
    return appendReportTimelineEndpoint(
      historyEvents.length > 1 ? historyEvents : normalizeScoreTimeline([{ minute: 0, blue: 0, red: 0 }], null),
      transcriptTurns,
      scorecard
    );
  }

  return buildOfficialScoreTimelineFromEvents(events, transcriptTurns, scorecard);
}

function scoreTimelineMatchesScorecard(timeline = [], scorecard = null) {
  if (!Array.isArray(timeline) || !timeline.length || !scorecard) return false;
  const last = timeline.at(-1) || {};
  const blue = Math.round(Number(scorecard?.blue?.score ?? 0));
  const red = Math.round(Number(scorecard?.red?.score ?? 0));
  return Math.round(Number(last.blue ?? NaN)) === blue && Math.round(Number(last.red ?? NaN)) === red;
}

function buildReportEventsFromScorecard(scorecard = null) {
  if (!scorecard || typeof scorecard !== "object") return [];
  const sideEvents = [
    ...((scorecard.blue?.events || []).map((event) => ({ ...event, side: "blue", sideId: event.sideId || "side-a" }))),
    ...((scorecard.red?.events || []).map((event) => ({ ...event, side: "red", sideId: event.sideId || "side-b" })))
  ];
  return sideEvents
    .filter((event) => event?.side && Number.isFinite(Number(event.delta)) && event.title)
    .map((event) => ({
      id: event.id || "",
      side: event.side,
      sideId: event.sideId || (event.side === "red" ? "side-b" : "side-a"),
      delta: Number(event.delta),
      title: event.title,
      detail: event.detail || "",
      minute: event.minute,
      at: event.at,
      artifactIds: event.artifactIds || [],
      category: event.category || event.pillar || "",
      weight: Number(event.weight || Math.abs(Number(event.delta))),
      kind: Number(event.delta) < 0 ? "loss" : "score"
    }));
}

function buildReportEventsFromScoreLedger(ledger = {}) {
  if (!ledger || !["key_moment_score", "event_ledger"].includes(ledger.method) || !Array.isArray(ledger.events)) return [];
  return ledger.events
    .filter((event) => event?.side && Number.isFinite(Number(event.delta)) && event.title)
    .map((event) => ({
      id: event.id || "",
      side: event.side,
      sideId: event.sideId || (event.side === "red" ? "side-b" : "side-a"),
      delta: Number(event.delta),
      title: event.title,
      detail: event.detail || "",
      minute: event.minute,
      at: event.at,
      artifactIds: event.artifactIds || [],
      category: event.category || event.pillar || "",
      weight: Number(event.weight || Math.abs(Number(event.delta))),
      kind: Number(event.delta) < 0 ? "loss" : "score"
    }));
}

function buildReportArtifactMinuteIndex(debate = {}, artifacts = {}) {
  const index = new Map();
  const add = (ids = [], source = {}) => {
    const minute = pointMinute(source);
    if (!Number.isFinite(minute)) return;
    for (const id of uniqueStrings(ids.filter(Boolean))) {
      if (!index.has(id)) index.set(id, minute);
    }
  };
  for (const point of debate.points || []) add([point.id, ...(point.turnIds || [])], point);
  for (const claim of artifacts.claims || []) add([claim.id, claim.pointId, ...(claim.turnIds || [])], claim);
  for (const clash of artifacts.clashes || []) add([clash.id, clash.fromPointId, clash.toPointId], clash);
  for (const item of artifacts.inconsistencies || []) add([item.id, ...(item.pointIds || [])], item);
  for (const item of artifacts.keyMoments || []) add([item.id, ...(item.artifactIds || [])], item);
  for (const item of artifacts.sourceChecks || []) add([item.id, item.pointId, item.claimId], item);
  return index;
}

function resolveReportScoreEventMinute(event = {}, artifactMinuteById = new Map(), pointsById = new Map(), transcriptTurns = [], fallbackIndex = 0) {
  if (Number.isFinite(Number(event.minute))) return Math.max(0, Number(event.minute));
  const linkedIds = uniqueStrings([
    event.id,
    event.pointId,
    event.claimId,
    ...(event.pointIds || []),
    ...(event.artifactIds || [])
  ]);
  for (const id of linkedIds) {
    const indexed = artifactMinuteById.get(id);
    if (Number.isFinite(Number(indexed))) return Math.max(0, Number(indexed));
    const point = pointsById.get(id);
    const pointAt = pointMinute(point);
    if (Number.isFinite(pointAt)) return Math.max(0, pointAt);
  }
  return Math.max(0, reportEventMinute(event, pointsById, transcriptTurns, fallbackIndex));
}

function buildOfficialScoreTimelineFromEvents(events = [], transcriptTurns = [], scorecard = null) {
  let blue = 0;
  let red = 0;
  let lastMinute = -1;
  const timeline = [{ minute: 0, blue, red }];
  const seen = new Set();
  const pointsById = new Map((transcriptTurns || []).map((turn) => [turn.id, turn]));
  const ordered = [...(events || [])]
    .filter((event) => event?.side && Number.isFinite(Number(event.delta)) && event.title)
    .sort((a, b) => {
      const minuteA = Number.isFinite(Number(a.minute)) ? Number(a.minute) : Number.MAX_SAFE_INTEGER;
      const minuteB = Number.isFinite(Number(b.minute)) ? Number(b.minute) : Number.MAX_SAFE_INTEGER;
      return minuteA - minuteB || Number(a.at || 0) - Number(b.at || 0) || scoreEventPriority(b) - scoreEventPriority(a);
    });
  for (const event of ordered) {
    const signature = event.id || `${event.side}:${event.delta}:${event.title}:${(event.artifactIds || []).join("|")}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const minute = scoreTimelineEventMinute(event, pointsById, transcriptTurns, timeline.length - 1);
    const stableMinute = minute <= lastMinute ? Number((lastMinute + 0.1).toFixed(1)) : Number(minute.toFixed(1));
    lastMinute = stableMinute;
    if (event.side === "red") {
      red = Math.round(red + Number(event.delta || 0));
    } else {
      blue = Math.round(blue + Number(event.delta || 0));
    }
    timeline.push({
      minute: stableMinute,
      blue,
      red,
      event: {
        id: cleanClaimText(event.id || signature),
        side: event.side === "red" ? "red" : "blue",
        delta: Math.round(Number(event.delta || 0)),
        title: sanitizeScoreEventTitle(event.title, event),
        detail: cleanClaimText(event.detail || ""),
        kind: Number(event.delta || 0) < 0 ? "loss" : "score",
        category: cleanClaimText(event.category || ""),
        artifactIds: uniqueStrings(event.artifactIds || []).slice(0, 8)
      }
    });
  }
  return selectMeaningfulReportScoreTimeline(appendReportTimelineEndpoint(normalizeScoreTimeline(timeline, null), transcriptTurns, scorecard));
}

function scoreTimelineEventMinute(event = {}, pointsById = new Map(), transcriptTurns = [], fallbackIndex = 0) {
  if (Number.isFinite(Number(event.minute))) return Math.max(0, Number(event.minute));
  const linkedIds = uniqueStrings([
    event.pointId,
    ...(event.pointIds || []),
    ...(event.artifactIds || [])
  ]);
  for (const id of linkedIds) {
    const minute = pointMinute(pointsById.get(id));
    if (Number.isFinite(minute)) return minute;
  }
  return Math.max(0, reportEventMinute(event, pointsById, transcriptTurns, fallbackIndex));
}

function appendReportTimelineEndpoint(timeline = [], transcriptTurns = [], scorecard = null) {
  const normalized = normalizeScoreTimeline(timeline, scorecard);
  const last = normalized.at(-1) || { minute: 0, blue: 0, red: 0 };
  const range = debateRangeFromTurns(transcriptTurns);
  const finalMinute = Number.isFinite(Number(range.endSec)) ? Number((Number(range.endSec) / 60).toFixed(1)) : null;
  const finalBlue = Math.round(Number(scorecard?.blue?.score ?? last.blue));
  const finalRed = Math.round(Number(scorecard?.red?.score ?? last.red));
  const scoresMatch = Number(last.blue || 0) === finalBlue && Number(last.red || 0) === finalRed;
  if (!Number.isFinite(Number(finalMinute))) {
    if (scoresMatch) return normalized;
    return normalizeScoreTimeline([
      ...normalized,
      {
        minute: Number((Number(last.minute || 0) + 0.1).toFixed(1)),
        blue: finalBlue,
        red: finalRed
      }
    ], null);
  }
  if (Number(finalMinute) <= Number(last.minute || 0) + 0.05) {
    if (scoresMatch) return normalized;
    return normalizeScoreTimeline([
      ...normalized,
      {
        minute: Number((Number(last.minute || 0) + 0.1).toFixed(1)),
        blue: finalBlue,
        red: finalRed
      }
    ], null);
  }
  return normalizeScoreTimeline([
    ...normalized,
    {
      minute: Number(finalMinute),
      blue: finalBlue,
      red: finalRed
    }
  ], null);
}

function sanitizeScoreEventTitle(title = "", event = {}) {
  const cleaned = cleanClaimText(title || "");
  const detail = cleanClaimText(event.detail || "");
  const haystack = normalizeTranscript(`${cleaned} ${detail}`);
  const looksLikeTranscriptFragment = !cleaned
    || cleaned.length > 58
    || wordCount(cleaned) > 8
    || /[,;:]/.test(cleaned)
    || /\b(i|you|we|they|israel'?s|putin'?s)\b.*\b(think|said|can|could|would|again|find|mean)\b/.test(haystack);
  if (!looksLikeTranscriptFragment) return cleaned;
  const losing = Number(event.delta) < 0 || event.kind === "loss";
  if (/\b(consistency|standard|same test|same rule|double standard)\b/.test(haystack)) return losing ? "Inconsistency" : "Challenge landed";
  if (/\b(capability|could have|nuke|nuclear|erase everyone)\b/.test(haystack)) return losing ? "Capability defense weakened" : "Capability test landed";
  if (/\b(concession|conceded|accepted|genocidal statement)\b/.test(haystack)) return losing ? "Concession narrowed the defense" : "Concession forced";
  if (/\b(intent|motive)\b/.test(haystack)) return losing ? "Intent point weakened" : "Intent point landed";
  if (/\b(source|evidence|receipt|quote|official|minister|scholar)\b/.test(haystack)) return losing ? "Source weakened claim" : "Source backed claim";
  if (/\b(dodge|pivot|talking point|answer)\b/.test(haystack)) return losing ? "Direct answer problem" : "Direct answer landed";
  return losing ? "Point lost force" : "Point gained force";
}

function reportEventMinute(event = {}, pointsById = new Map(), transcriptTurns = [], fallbackIndex = 0) {
  const ids = uniqueStrings([event.pointId, ...(event.pointIds || [])]);
  for (const id of ids) {
    const minute = pointMinute(pointsById.get(id));
    if (Number.isFinite(minute)) return minute;
  }
  const directMinute = pointMinute(event);
  if (Number.isFinite(directMinute)) return directMinute;
  const range = debateRangeFromTurns(transcriptTurns);
  const endMinute = Number.isFinite(Number(range.endSec)) ? Number(range.endSec) / 60 : null;
  if (endMinute) return Math.min(endMinute, 0.5 + fallbackIndex * Math.max(0.4, endMinute / 12));
  return 0.5 + fallbackIndex * 0.8;
}

function pointMinute(point = {}) {
  const end = Number(point?.endSec);
  const start = Number(point?.startSec);
  if (Number.isFinite(end)) return Number((end / 60).toFixed(2));
  if (Number.isFinite(start)) return Number((start / 60).toFixed(2));
  return NaN;
}

function selectReportScoreEvents(events = []) {
  const seen = new Set();
  const unique = [...events]
    .filter((event) => event.title && event.delta)
    .sort((a, b) => scoreEventPriority(b) - scoreEventPriority(a))
    .filter((event) => {
      const key = `${event.side}:${scoreEventFamily(event)}:${normalizeTranscript(event.detail || event.title).split(/\s+/).slice(0, 12).join(" ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const picked = [];
  for (const side of ["blue", "red"]) {
    const sideEvents = unique.filter((event) => event.side === side);
    picked.push(...pickScoreEventsForSide(sideEvents, 6));
  }
  return picked
    .sort((a, b) => Number(a.minute || 0) - Number(b.minute || 0))
    .slice(0, 12);
}

function pickScoreEventsForSide(events = [], limit = 6) {
  if (events.length <= limit) return events;
  const byPriority = [...events].sort((a, b) => scoreEventPriority(b) - scoreEventPriority(a));
  const maxMinute = Math.max(...events.map((event) => Number(event.minute || 0)), 1);
  const selected = [];
  const add = (event) => {
    if (!event || selected.includes(event) || selected.length >= limit) return;
    selected.push(event);
  };
  add([...events].filter((event) => Number(event.delta || 0) > 0).sort((a, b) => scoreEventPriority(b) - scoreEventPriority(a))[0]);
  add([...events].filter((event) => Number(event.delta || 0) < 0).sort((a, b) => scoreEventPriority(b) - scoreEventPriority(a))[0]);
  for (let bucket = 0; bucket < limit; bucket += 1) {
    const start = (bucket / limit) * maxMinute;
    const end = ((bucket + 1) / limit) * maxMinute;
    const best = byPriority.find((event) => Number(event.minute || 0) >= start && Number(event.minute || 0) <= end);
    add(best);
  }
  const topicKeys = new Set(selected.map(scoreEventTopicKey));
  for (const event of byPriority) {
    if (selected.length >= limit) break;
    const topicKey = scoreEventTopicKey(event);
    const crowded = selected.some((item) => Math.abs(Number(item.minute || 0) - Number(event.minute || 0)) < 0.25 && item.kind === event.kind);
    if ((topicKeys.has(topicKey) || crowded) && selected.length >= Math.ceil(limit / 2)) continue;
    add(event);
    topicKeys.add(topicKey);
  }
  for (const event of byPriority) add(event);
  return selected;
}

function selectMeaningfulReportScoreTimeline(timeline = []) {
  const normalized = normalizeScoreTimeline(timeline, null);
  if (normalized.length <= 16) return normalized;
  const first = normalized[0];
  const final = normalized.at(-1);
  const eventEntries = normalized.filter((entry) => entry.event);
  const selected = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry?.event) return;
    const key = entry.event.id || `${entry.minute}:${entry.event.side}:${entry.event.delta}:${entry.event.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(entry);
  };
  for (const side of ["blue", "red"]) {
    const sideEntries = eventEntries
      .filter((entry) => entry.event?.side === side)
      .sort((a, b) => scoreTimelineEntryPriority(b) - scoreTimelineEntryPriority(a));
    add(sideEntries.find((entry) => Number(entry.event?.delta || 0) > 0));
    add(sideEntries.find((entry) => Number(entry.event?.delta || 0) < 0));
  }
  const orderedByPriority = [...eventEntries].sort((a, b) => scoreTimelineEntryPriority(b) - scoreTimelineEntryPriority(a));
  for (const entry of orderedByPriority) {
    if (selected.length >= 12) break;
    const crowded = selected.some((item) => Math.abs(Number(item.minute || 0) - Number(entry.minute || 0)) < 0.2 && item.event?.side === entry.event?.side);
    if (crowded && selected.length >= 6) continue;
    add(entry);
  }
  const selectedByTime = selected.sort((a, b) => Number(a.minute || 0) - Number(b.minute || 0));
  const lastSelectedBeforeFinal = selectedByTime.at(-1) || first;
  if (final && !final.event && lastSelectedBeforeFinal) {
    for (const side of ["blue", "red"]) {
      const finalScore = Math.round(Number(final[side] || 0));
      const selectedScore = Math.round(Number(lastSelectedBeforeFinal[side] || 0));
      if (finalScore === selectedScore) continue;
      const bridge = [...eventEntries]
        .filter((entry) => entry.event?.side === side)
        .filter((entry) => Number(entry.minute || 0) > Number(lastSelectedBeforeFinal.minute || 0) + 0.01)
        .filter((entry) => Number(entry.minute || 0) <= Number(final.minute || 0) + 0.01)
        .sort((a, b) => Number(b.minute || 0) - Number(a.minute || 0) || scoreTimelineEntryPriority(b) - scoreTimelineEntryPriority(a))[0];
      add(bridge);
    }
  }
  const output = [first, ...selected.sort((a, b) => Number(a.minute || 0) - Number(b.minute || 0))];
  const lastSelected = output.at(-1);
  if (final && (!lastSelected || Number(final.minute || 0) > Number(lastSelected.minute || 0) + 0.05 || Number(final.blue) !== Number(lastSelected.blue) || Number(final.red) !== Number(lastSelected.red))) {
    output.push(final);
  }
  return normalizeScoreTimeline(output, null);
}

function scoreTimelineEntryPriority(entry = {}) {
  const event = entry.event || {};
  let score = scoreEventPriority({ ...event, minute: entry.minute }) + Math.abs(Number(event.delta || 0)) * 2;
  const totalSwing = Math.abs(Number(entry.blue || 0) - Number(entry.red || 0));
  if (totalSwing >= 10) score += 2;
  if (/\b(major|turning|landed|double standard|source|concession|unanswered)\b/i.test(`${event.title || ""} ${event.detail || ""}`)) score += 4;
  return score;
}

function scoreEventPriority(event = {}) {
  let score = Math.abs(Number(event.delta || 0)) * 3 + Number(event.weight || 0);
  const title = normalizeTranscript(event.title || "");
  const detail = normalizeTranscript(event.detail || "");
  if (/\b(concession|accepted|genocidal statement)\b/.test(`${title} ${detail}`)) score += 10;
  if (/\b(consistency|standard|same test|double standard)\b/.test(`${title} ${detail}`)) score += 8;
  if (/\b(intent|motive|capability|nuke|nuclear)\b/.test(`${title} ${detail}`)) score += 5;
  if (/\b(70|percent|buildings|children|official|minister|parliament|court|un|icj)\b/.test(`${title} ${detail}`)) score += 4;
  if (event.kind === "loss") score += 1;
  return score;
}

function scoreEventTopicKey(event = {}) {
  const text = normalizeTranscript(`${event.title || ""} ${event.detail || ""}`);
  if (/\b(concession|accepted|genocidal statement|minority view)\b/.test(text)) return "concession";
  if (/\b(consistency|standard|same test|same rule|double standard)\b/.test(text)) return "consistency";
  if (/\b(capability|could have|nuke|nuclear|erase everyone)\b/.test(text)) return "capability";
  if (/\b(intent|motive)\b/.test(text)) return "intent";
  if (/\b(source|evidence|quote|official|minister|scholar|parliament)\b/.test(text)) return "evidence";
  if (/\b(dodge|pivot|talking point|answer|direct)\b/.test(text)) return "direct-answer";
  if (/\b(hamas|blame|human shields|provoked)\b/.test(text)) return "blame";
  if (/\b(70|percent|buildings|destruction|uninhabitable|casualties|killed|displaced)\b/.test(text)) return "destruction";
  return normalizeTranscript(event.title || "moment").split(/\s+/).slice(0, 4).join("-");
}

function normalizeScoreTimeline(scoreTimeline = [], scorecard = null) {
  const source = Array.isArray(scoreTimeline) && scoreTimeline.length ? scoreTimeline : [{ minute: 0, blue: 0, red: 0 }];
  const normalized = source.map((entry) => ({
    minute: Math.max(0, Number(entry?.minute || 0)),
    blue: Math.max(-9999, Math.min(9999, Math.round(Number(entry?.blue ?? 0)))),
    red: Math.max(-9999, Math.min(9999, Math.round(Number(entry?.red ?? 0)))),
    ...(entry?.event ? {
      event: {
        id: cleanClaimText(entry.event.id || ""),
        side: entry.event.side === "red" ? "red" : "blue",
        delta: Math.round(Number(entry.event.delta || 0)),
        title: cleanClaimText(entry.event.title || "Score moved"),
        detail: cleanClaimText(entry.event.detail || ""),
        kind: entry.event.kind === "loss" ? "loss" : "score",
        category: cleanClaimText(entry.event.category || ""),
        artifactIds: Array.isArray(entry.event.artifactIds) ? entry.event.artifactIds.map((id) => cleanClaimText(id)).filter(Boolean).slice(0, 8) : []
      }
    } : {})
  }));
  if (scorecard && normalized.length === 1) {
    normalized.push({ minute: 1, blue: scorecard.blue.score, red: scorecard.red.score });
  }
  return capNormalizedScoreTimeline(normalized);
}

function capNormalizedScoreTimeline(points = []) {
  if (points.length <= 120) return points;
  const first = points[0];
  const tail = points.slice(-80);
  const middleEvents = points.slice(1, -80).filter((entry) => entry.event).slice(-39);
  const seen = new Set();
  return [first, ...middleEvents, ...tail].filter((entry) => {
    const key = `${entry.minute}:${entry.blue}:${entry.red}:${entry.event?.title || ""}:${entry.event?.delta || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickStrongestClaim(claims = [], sideId = "") {
  const candidates = sideId ? claims.filter((claim) => claim.sideId === sideId) : claims;
  return [...candidates].sort((a, b) => {
    const aScore = Number(a.importance || 0) + (a.status === "supported" ? 2 : 0) + (a.burden === "met" ? 1 : 0);
    const bScore = Number(b.importance || 0) + (b.status === "supported" ? 2 : 0) + (b.burden === "met" ? 1 : 0);
    return bScore - aScore;
  })[0];
}

function buildReportQuestion(debate = {}, challenge, claim) {
  const officialQuestion = officialReportQuestionFromDebate(debate);
  if (officialQuestion) return officialQuestion;
  if (challenge?.originalClaim && challenge?.challengerResponse) {
    return `Did ${sideName(challenge.sideId)} answer the claim it challenged?`;
  }
  if (claim?.claim) return `Did the debate resolve this claim: ${claim.claim}?`;
  const topic = cleanClaimText(debate.topic || "");
  return topic ? `Which side made the stronger case on ${lowerFirst(topic)}?` : "Which side made the stronger case?";
}

function officialReportQuestionFromDebate(debate = {}) {
  const candidate = cleanClaimText(
    debate.topic
    || debate.analysis?.sideState?.topic
    || ""
  );
  if (!candidate || /^what is the central claim/i.test(candidate) || /^listening for the debate topic/i.test(candidate)) return "";
  return ensureQuestionText(candidate);
}

function ensureQuestionText(text = "") {
  const cleaned = cleanClaimText(text || "").replace(/[.!\s]+$/g, "").trim();
  if (!cleaned) return "";
  return /\?$/.test(cleaned) ? cleaned : `${cleaned}?`;
}

function toneForSide(sideId = "") {
  if (sideId === "side-a") return "blue";
  if (sideId === "side-b") return "red";
  return "amber";
}

const BLUE_SIDE_ID = "side-a";
const RED_SIDE_ID = "side-b";
const BLUE_SIDE = "blue";
const RED_SIDE = "red";
const DEBATER_SPEAKER = "debater";
const NEUTRAL_SPEAKER = "neutral_speaker";
const UNKNOWN_SPEAKER = "unknown_speaker";
const POSSIBLE_ALIAS_SPEAKER = "possible_alias";
const FLOOR_STATE_VERSION = 1;
const OWNER_SIDE_CONFIDENCE_MIN = 0.72;
const OWNER_SIDE_PROFILE_MARGIN_MIN = 0.08;
const SIDE_COLLISION_CONFIDENCE_MIN = 0.72;

function sideName(sideId = "") {
  if (sideId === BLUE_SIDE_ID) return "Blue side";
  if (sideId === RED_SIDE_ID) return "Red side";
  return "This side";
}

function sideColorFromSideId(sideId = "") {
  const normalized = normalizeSideId(sideId);
  if (normalized === BLUE_SIDE_ID) return BLUE_SIDE;
  if (normalized === RED_SIDE_ID) return RED_SIDE;
  return "";
}

function buildCurrentSpeakerSideMap(state = {}) {
  const normalized = {
    ...state,
    sides: ensureTwoSides(state.sides || []),
    speakers: Array.isArray(state.speakers) ? state.speakers : []
  };
  const bySpeaker = new Map();
  const add = (speakerId = "", sideId = "", confidence = 0, reason = "") => {
    const cleanSpeakerId = cleanClaimText(speakerId || "");
    const normalizedSideId = normalizeSideId(sideId);
    if (!cleanSpeakerId || !normalizedSideId) return;
    const speaker = normalized.speakers.find((item) => item.speakerId === cleanSpeakerId) || {};
    const roleReason = cleanAgentDisplayText([
      reason,
      speaker.assignmentReason || "",
      speaker.floorRoleReason || ""
    ].filter(Boolean).join(" "));
    const roleQuote = cleanClaimText(speaker.sampleText || "");
    if (isNeutralFloorSpeaker(normalized, cleanSpeakerId)) return;
    if (isModeratorSideAssignment({ speakerId: cleanSpeakerId, reason: roleReason, evidenceQuote: roleQuote, state: normalized })) return;
    const nextConfidence = Math.max(0, Math.min(1, Number(confidence || 0)));
    const existing = bySpeaker.get(cleanSpeakerId);
    if (existing && Number(existing.confidence || 0) > nextConfidence) return;
    bySpeaker.set(cleanSpeakerId, {
      speakerId: cleanSpeakerId,
      sideId: normalizedSideId,
      confidence: nextConfidence || 0.75,
      reason: cleanClaimText(reason || "Current speaker-side assignment.")
    });
  };

  for (const speaker of normalized.speakers) {
    if (speaker?.identityStatus === "side_collision") continue;
    add(
      speaker.speakerId,
      speaker.sideId || speakerSideFromSides(normalized.sides, speaker.speakerId),
      speaker.sideConfidence || 0.75,
      speaker.assignmentReason || "Speaker profile assignment."
    );
  }
  for (const side of normalized.sides) {
    for (const speakerId of side.speakerIds || []) {
      add(speakerId, side.id, 0.7, "Side roster assignment.");
    }
  }
  return [...bySpeaker.values()].sort((a, b) => a.speakerId.localeCompare(b.speakerId, undefined, { numeric: true }));
}

function sideAnchorLoad(state = {}, sideId = "") {
  const normalizedSideId = normalizeSideId(sideId);
  if (!normalizedSideId) return { total: 0, speakers: 0, points: 0, artifacts: 0 };
  const speakerIds = new Set();
  for (const speaker of state.speakers || []) {
    if (normalizeSideId(speaker?.sideId) !== normalizedSideId) continue;
    if (!speakerRosterSideFromRegistry(state, speaker.speakerId)) continue;
    speakerIds.add(speaker.speakerId);
  }
  for (const side of ensureTwoSides(state.sides || [])) {
    if (side.id !== normalizedSideId) continue;
    for (const speakerId of side.speakerIds || []) speakerIds.add(speakerId);
  }
  const points = (state.points || []).filter((point) => normalizeSideId(point.sideId) === normalizedSideId && isScoredPoint(point)).length;
  const artifacts = normalizeArtifacts(state.artifacts || {});
  const artifactCount = [
    ...(artifacts.claims || []),
    ...(artifacts.clashes || []),
    ...(artifacts.keyMoments || []),
    ...(artifacts.sourceChecks || [])
  ].filter((item) => normalizeSideId(item?.sideId) === normalizedSideId).length
    + (artifacts.inconsistencies || []).filter((item) => inconsistencySideId(item) === normalizedSideId).length;
  return {
    total: speakerIds.size + points + artifactCount,
    speakers: speakerIds.size,
    points,
    artifacts: artifactCount
  };
}

function hasBlueSideAnchor(state = {}) {
  return sideAnchorLoad(state, BLUE_SIDE_ID).total > 0;
}

function speakerOwnedSideCounts(state = {}, speakerId = "") {
  const counts = {
    [BLUE_SIDE_ID]: 0,
    [RED_SIDE_ID]: 0
  };
  if (!speakerId) return counts;
  const add = (sideId, weight = 1) => {
    const normalized = normalizeSideId(sideId);
    if (normalized && counts[normalized] !== undefined) counts[normalized] += weight;
  };
  for (const point of state.points || []) {
    if (point?.speakerId === speakerId && isScoredPoint(point)) add(point.sideId, 2);
  }
  const artifacts = normalizeArtifacts(state.artifacts || {});
  for (const claim of artifacts.claims || []) {
    if (claim?.speakerId === speakerId) add(claim.sideId);
  }
  for (const item of [...(artifacts.clashes || []), ...(artifacts.keyMoments || [])]) {
    if (item?.speakerId === speakerId) add(item.sideId);
  }
  for (const item of artifacts.inconsistencies || []) {
    if (item?.speakerId === speakerId) add(inconsistencySideId(item));
  }
  return counts;
}

function coerceInitialSideAnchor(state = {}, speakerId = "", proposedSideId = "") {
  const sideId = normalizeSideId(proposedSideId);
  if (!sideId) return "";
  if (sideId !== RED_SIDE_ID) return sideId;
  return hasBlueSideAnchor(state) ? RED_SIDE_ID : BLUE_SIDE_ID;
}

function coerceSideAnchorForAssignmentBatch(state = {}, speakerId = "", proposedSideId = "", batchHasBlueAnchor = false) {
  const sideId = normalizeSideId(proposedSideId);
  if (!sideId) return "";
  if (sideId !== RED_SIDE_ID) return sideId;
  return batchHasBlueAnchor || hasBlueSideAnchor(state) ? RED_SIDE_ID : BLUE_SIDE_ID;
}

function initialSideAnchorReason(state = {}, proposedSideId = "", reason = "") {
  const normalized = normalizeSideId(proposedSideId);
  if (normalized === RED_SIDE_ID && !hasBlueSideAnchor(state)) {
    return "Anchored the first score-bearing debater to Blue side until an opposing side is established.";
  }
  return cleanAgentDisplayText(reason || "");
}

function quoteList(items = []) {
  return items
    .filter((item) => item?.text)
    .map((item) => ({
      speaker: cleanQuoteSpeakerLabel(item.speaker || item.speakerId || "") || (item.sideId ? sideName(item.sideId) : "Debate audio"),
      tone: item.sideId === "side-a" ? "blue" : item.sideId === "side-b" ? "red" : "neutral",
      text: cleanClaimText(item.text || "")
    }))
    .slice(0, 3);
}

function buildReportQuoteCatalog(debate = {}, transcriptTurns = []) {
  const normalized = normalizeClaimState(debate);
  const entries = [];
  const addEntry = ({ text, speakerId, sideId, artifactId = "", quoteId = "", role = "owned_statement" }) => {
    const clean = cleanClaimText(text || "");
    if (!clean) return;
    const resolvedSideId = normalizeSideId(sideId) || speakerSideFromState(normalized, speakerId);
    entries.push({
      artifactId: cleanClaimText(artifactId || ""),
      quoteId: cleanClaimText(quoteId || ""),
      text: clean,
      normalized: normalizeTranscript(clean),
      speakerId: cleanClaimText(speakerId || ""),
      sideId: resolvedSideId,
      tone: toneForSide(resolvedSideId),
      role: normalizeQuoteRole(role)
    });
  };
  for (const turn of transcriptTurns || []) {
    addEntry({ text: turn.text, speakerId: turn.speakerId, sideId: turnOwnerSideFromState(normalized, turn) });
  }
  for (const point of normalized.points || []) {
    addEntry({ text: point.quote || point.claim, speakerId: point.speakerId, sideId: point.sideId });
  }
  return entries.filter((entry) => entry.normalized);
}

function normalizeReportQuotes(quotes = [], quoteCatalog = [], fallbackQuotes = []) {
  const source = Array.isArray(quotes) && quotes.length ? quotes : fallbackQuotes;
  return (source || [])
    .map((quote) => normalizeReportQuote(quote, quoteCatalog))
    .filter((quote) => quote.text)
    .slice(0, 3);
}

function normalizeReportQuote(quote = {}, quoteCatalog = []) {
  const text = cleanClaimText(quote?.text || "");
  const artifactIds = Array.isArray(quote?.artifactIds) ? quote.artifactIds : [];
  const match = findQuoteCatalogMatch(text, quoteCatalog, artifactIds);
  if (match) {
    const tone = match.tone === "blue" || match.tone === "red" ? match.tone : "neutral";
    return {
      speaker: cleanQuoteSpeakerLabel(match.speakerId) || "Debate audio",
      tone,
      text
    };
  }
  const tone = ["blue", "red", "neutral"].includes(quote?.tone) ? quote.tone : "neutral";
  const ownerMatch = findQuoteOwnerMatch(text, quoteCatalog, tone);
  return {
    speaker: cleanQuoteSpeakerLabel(quote?.speaker) || cleanQuoteSpeakerLabel(ownerMatch?.speakerId) || (tone === "blue" ? "Blue speaker" : tone === "red" ? "Red speaker" : "Debate audio"),
    tone: ownerMatch?.tone || tone,
    text
  };
}

function cleanQuoteSpeakerLabel(label = "") {
  const clean = cleanClaimText(label || "");
  if (/^speaker\s+\d+$/i.test(clean)) return clean.replace(/^speaker/i, "Speaker");
  return "";
}

function findQuoteCatalogMatch(text = "", quoteCatalog = [], artifactIds = []) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return null;
  const artifactSet = new Set((artifactIds || []).map((id) => cleanClaimText(id)).filter(Boolean));
  if (artifactSet.size) {
    let scopedBest = null;
    for (const entry of quoteCatalog || []) {
      if (!entry?.normalized || !artifactSet.has(entry.artifactId)) continue;
      const score = entry.normalized === normalized
        ? 1
        : entry.normalized.includes(normalized)
          ? 0.96
          : normalized.includes(entry.normalized)
            ? 0.86
            : tokenOverlapRatio(normalized, entry.normalized);
      if (score >= 0.62 && (!scopedBest || score > scopedBest.score)) scopedBest = { ...entry, score };
    }
    if (scopedBest) return scopedBest;
  }
  let best = null;
  for (const entry of quoteCatalog || []) {
    if (!entry?.normalized) continue;
    let score = 0;
    if (entry.normalized === normalized) score = 1;
    else if (entry.normalized.includes(normalized)) score = 0.96;
    else if (normalized.includes(entry.normalized)) score = entry.normalized.length >= normalized.length * 0.65 ? 0.86 : 0.58;
    else score = tokenOverlapRatio(normalized, entry.normalized);
    const lengthFit = Math.min(normalized.length, entry.normalized.length) / Math.max(normalized.length, entry.normalized.length);
    const adjustedScore = score + lengthFit * 0.04;
    if (adjustedScore >= 0.68 && (!best || adjustedScore > best.score)) best = { ...entry, score: adjustedScore };
  }
  return best;
}

function findQuoteOwnerMatch(text = "", quoteCatalog = [], tone = "neutral") {
  const normalized = normalizeTranscript(text);
  if (!normalized) return null;
  let best = null;
  for (const entry of quoteCatalog || []) {
    if (!entry?.normalized || !entry.speakerId) continue;
    if ((tone === "blue" || tone === "red") && entry.tone !== tone) continue;
    const score = tokenOverlapRatio(normalized, entry.normalized);
    if (score >= 0.18 && (!best || score > best.score)) best = { ...entry, score };
  }
  return best;
}

async function analyzeDebateTurn({ turn, transcriptWindow = [], currentDebate = {} }) {
  return runLivePipeline({
    newTurns: turn ? [turn] : [],
    transcriptWindow,
    currentDebate
  });
}

async function runLivePipeline(args = {}) {
  const options = args.options || {};
  return runDirectLedgerLivePipeline({ ...args, options });
}

async function runDirectLedgerLivePipeline(args = {}) {
  const options = args.options || {};
  const totalStartedAt = Date.now();
  const incomingTurns = Array.isArray(args.newTurns) ? args.newTurns.filter(Boolean) : [];
  const windowTurns = Array.isArray(args.transcriptWindow) ? args.transcriptWindow.filter(Boolean) : [];
  const contextTurns = uniqueTurnsById([
    ...windowTurns,
    ...(Array.isArray(options.artifactContextTurns) ? options.artifactContextTurns : []),
    ...incomingTurns
  ]).filter(Boolean);
  const debateRange = debateRangeFromTurns(incomingTurns);
  const transcriptRange = debateRangeFromTurns([...windowTurns, ...incomingTurns]);
  const timings = {
    label: options.label || "direct-ledger",
    selectionModel: options.selectionModel || config.fastModel,
    groundingModel: options.groundingModel || config.groundingModel,
    pipeline: "direct-ledger",
    turns: 0,
    selectedPoints: 0,
    verifiedPoints: 0,
    dialogueWindows: 0,
    cleaningMs: 0,
    sideBuilderMs: 0,
    debatePointBuilderMs: 0,
    claimBuilderMs: 0,
    clashFinderMs: 0,
    inconsistencyFinderMs: 0,
    assemblerMs: 0,
    totalMs: 0,
    liveCadence: options.liveCadence || "direct",
    artifactContextBatches: Number(options.artifactContextBatches || 1)
  };
  const trace = createTrace({
    label: timings.label,
    recordingStartedAt: options.recordingStartedAt || args.recordingStartedAt || 0,
    requestStartedAt: totalStartedAt,
    debateStartSec: debateRange.startSec,
    debateEndSec: debateRange.endSec,
    transcriptWindowStartSec: transcriptRange.startSec,
    transcriptWindowEndSec: transcriptRange.endSec,
    turnIds: incomingTurns.map((turn) => turn.id).filter(Boolean)
  });
  const timedIncoming = incomingTurns.some((turn) => Number.isFinite(Number(turn.startSec)) || Number.isFinite(Number(turn.endSec)));
  const fixtureBatchReady = !timedIncoming && incomingTurns.length >= LIVE_CURRENT_STARTUP_CHUNKS;
  const startupReady = Boolean(options.startupReady) || fixtureBatchReady || currentReporterChunkCount(args.currentDebate, incomingTurns) >= LIVE_CURRENT_STARTUP_CHUNKS;
  let state = clearNonDirectAnalysisState(normalizeClaimState(args.currentDebate || {}));

  logDeterministicStep(trace, "Reporter:received", createDirectTracePayload("Reporter", {
    RawTurnBatch: incomingTurns.length,
    RawTurnLedger: windowTurns.length
  }, {
    RawTurnBatch: incomingTurns.length
  }, {
    turns: incomingTurns.length,
    transcriptWindowTurns: windowTurns.length,
    speakers: uniqueStrings(incomingTurns.map((turn) => turn.speakerId)).length,
    chars: incomingTurns.reduce((sum, turn) => sum + String(turn?.text || "").length, 0),
    batchStartSec: debateRange.startSec,
    batchEndSec: debateRange.endSec,
    liveCadence: timings.liveCadence,
    artifactContextBatches: timings.artifactContextBatches
  }));

  state = registerTranscriptSpeakers(state, [...windowTurns, ...incomingTurns]);
  logDeterministicStep(trace, "SpeakerRegistry:updated", {
    speakers: state.speakers.length,
    batchSpeakers: uniqueStrings(incomingTurns.map((turn) => turn.speakerId))
  });

  const fallbackCleanUtterances = buildCleanUtterances(stitchTranscriptTurns(incomingTurns));
  const preliminaryCleanTurns = fallbackCleanUtterances.map(cleanUtteranceToTurn);
  const preliminaryWindows = buildDialogueWindows(preliminaryCleanTurns, windowTurns, state);
  const preliminaryReadyWindows = preliminaryWindows.filter((window) => window.windowStatus === "ready");
  const cleaningTargetTurns = selectRawTurnsForCleaning(incomingTurns, preliminaryReadyWindows, CLEANING_MAX_TURNS_PER_BATCH);
  const fallbackCleaningUtterances = buildCleanUtterances(stitchTranscriptTurns(cleaningTargetTurns));
  logDeterministicStep(trace, "Cleaner:target-selected", createDirectTracePayload("Cleaner", {
    RawTurnBatch: incomingTurns.length
  }, {
    CleanTranscriptChunk: fallbackCleaningUtterances.length
  }, {
    incomingTurns: incomingTurns.length,
    preliminaryWindows: preliminaryWindows.length,
    preliminaryReadyWindows: preliminaryReadyWindows.length,
    cleaningTurns: cleaningTargetTurns.length,
    maxCleaningTurns: CLEANING_MAX_TURNS_PER_BATCH
  }));
  const cleaningStartedAt = Date.now();
  const cleanUtterances = options.skipCleaning
    ? fallbackCleaningUtterances
    : await withTimeout(
        runTranscriptStitcher({
          newTurns: cleaningTargetTurns,
          transcriptWindow: windowTurns,
          currentDebate: state,
          fallbackUtterances: fallbackCleaningUtterances,
          model: timings.selectionModel,
          trace
        }),
        12000,
        "Cleaner timed out"
      ).catch((error) => {
        console.log(`Cleaner fallback: ${error instanceof Error ? error.message : "unknown error"}`);
        return fallbackCleaningUtterances;
      });
  timings.cleaningMs = Date.now() - cleaningStartedAt;
  state = mergeCleanUtterances(state, cleanUtterances);
  logDeterministicStep(trace, "TranscriptStore:merged", createDirectTracePayload("TranscriptStore", {
    CleanTranscriptChunk: cleanUtterances.length
  }, {
    CleanTranscriptLedger: state.utterances?.length || 0
  }, {
    utterances: cleanUtterances.length,
    totalUtterances: state.utterances?.length || 0,
    elapsedMs: timings.cleaningMs,
    skipped: Boolean(options.skipCleaning)
  }));

  const cleanUtteranceById = new Map((state.utterances || []).map((utterance) => [utterance.utteranceId, utterance]));
  const cleanTurns = cleanUtterances.map((utterance) => cleanUtteranceToTurn(cleanUtteranceById.get(utterance.utteranceId) || utterance));
  const rollingCleanTurns = cleanTurns.length ? selectRollingCleanTurnsForWindows(state, cleanTurns) : [];
  const dialogueWindows = rollingCleanTurns.length ? buildDialogueWindows(rollingCleanTurns, windowTurns, state) : preliminaryWindows;
  state = mergeDialogueWindows(state, dialogueWindows);
  const readyWindows = dialogueWindows.filter((window) => window.windowStatus === "ready");
  const eligibleTurns = flattenDialogueWindowTurns(readyWindows).filter((turn) => isTurnClaimEligible(state, turn));
  timings.dialogueWindows = readyWindows.length;
  timings.turns = eligibleTurns.length;
  logDeterministicStep(trace, "StabilizerGate:window-built", createDirectTracePayload("StabilizerGate", {
    CleanTranscriptLedger: state.utterances?.length || 0
  }, {
    ReadyWindowQueue: readyWindows.length
  }, {
    windows: dialogueWindows.length,
    readyWindows: readyWindows.length,
    heldWindows: dialogueWindows.filter((window) => window.windowStatus === "held").length,
    contextWindows: dialogueWindows.filter((window) => window.contextOnly).length,
    reasons: dialogueWindows.map((window) => window.reason),
    windowStatuses: dialogueWindows.map((window) => window.windowStatus),
    contextSignals: uniqueStrings(dialogueWindows.flatMap((window) => window.contextSignals || [])),
    windowTurns: dialogueWindows.map((window) => window.turns?.length || 0),
    startupReady
  }));

  if (startupReady && readyWindows.length && eligibleTurns.length) {
    const sideStartedAt = Date.now();
    const sideSelection = await withTimeout(
      runDirectSideBuilderAgent({
        dialogueWindows: readyWindows.slice(-2),
        transcriptWindow: contextTurns,
        currentDebate: state,
        model: timings.selectionModel,
        trace
      }),
      14000,
      "Side Builder timed out"
    ).catch((error) => {
      console.log(`Side Builder fallback: ${error instanceof Error ? error.message : "unknown error"}`);
      return {};
    });
    const sideBuilderSpeakerProposals = normalizeDirectSideBuilderSpeakerProposals(sideSelection?.speakers || [], state);
    const speakerSideProposals = sideBuilderSpeakerProposals.filter((proposal) => isSpeakerSideMapEligible(state, proposal.speakerId, eligibleTurns
      .filter((turn) => turn.speakerId === proposal.speakerId)
      .flatMap((turn) => [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])])));
    state = applySpeakerAssignments(state, speakerSideProposals, eligibleTurns, []);
    const appliedSpeakerSideProposals = speakerSideProposals.filter((proposal) => (
      speakerSideFromState(state, proposal.speakerId) === proposal.sideId
    ));
    state = mergeSpeakerPositionMemory(state, [
      ...normalizeDirectSpeakerMemory(sideSelection?.speakerMemory || [], state)
    ], readyWindows);
    state = applyDirectSideLabels(state, sideSelection);
    state = appendSideAssignmentAudit(state, appliedSpeakerSideProposals, readyWindows, trace);
    timings.sideBuilderMs = Date.now() - sideStartedAt;
    logDeterministicStep(trace, "SideBuilder:assigned", createDirectTracePayload("SideBuilder", {
      ReadyWindowQueue: readyWindows.length,
      SpeakerPositionMemory: state.speakerPositionMemory?.length || 0
    }, {
      SpeakerSideMap: state.speakers.length
    }, {
      assignments: appliedSpeakerSideProposals.length,
      sideBuilderMs: timings.sideBuilderMs
    }));

    const sideBuiltWindows = buildReadyClaimWindows(readyWindows, state);
    let latestDebatePoints = [];
    const shouldRunDebatePointBuilder = options.runClaims !== false
      || options.runChallenges !== false
      || options.runInconsistencies !== false
      || options.runThesis !== false;
    if (shouldRunDebatePointBuilder) {
      const debatePointStartedAt = Date.now();
      const existingDebatePoints = debatePointLedgerFromState(state);
      const debatePointPacket = buildLiveDebatePointPacket({
        state,
        sideBuiltWindows,
        existingPointLedger: existingDebatePoints
      });
      const debatePointSelection = await withTimeout(
        runDebatePointBuilder({
          dialogueWindows: debatePointPacket?.dialogueWindows || [],
          speakers: debatePointPacket?.speakers || {},
          existingPoints: existingDebatePoints
        }),
        34000,
        "Debate Point Builder timed out"
      ).catch((error) => {
        console.log(`Debate Point Builder fallback: ${error instanceof Error ? error.message : "unknown error"}`);
        return { points: [], rawPoints: [], malformedByReason: { node_error: 1 } };
      });
      timings.debatePointBuilderMs = Date.now() - debatePointStartedAt;
      latestDebatePoints = debatePointSelection.points || [];
      state = mergeDebatePointLedger(state, latestDebatePoints);
      logDeterministicStep(trace, "DebatePointBuilder:built", createDirectTracePayload("DebatePointBuilder", {
        SideBuiltWindowQueue: sideBuiltWindows.length,
        ExistingDebatePointLedger: existingDebatePoints.length
      }, {
        DebatePointCandidates: Array.isArray(debatePointSelection.rawPoints) ? debatePointSelection.rawPoints.length : 0,
        DebatePointLedgerAdditions: Array.isArray(debatePointSelection.points) ? debatePointSelection.points.length : 0,
        DebatePointLedger: debatePointLedgerFromState(state).length
      }, {
        malformedByReason: debatePointSelection.malformedByReason || {},
        debatePointBuilderMs: timings.debatePointBuilderMs
      }));
    }

    if (options.runThesis !== false) {
      if (latestDebatePoints.length) {
        const thesisStartedAt = Date.now();
        const thesisSelection = await withTimeout(
          runDirectThesisBuilderAgent({
            sideBuiltWindows,
            debatePoints: latestDebatePoints,
            currentDebate: state,
            model: timings.selectionModel,
            trace
          }),
          18000,
          "Thesis Builder timed out"
        ).catch((error) => {
          console.log(`Thesis Builder fallback: ${error instanceof Error ? error.message : "unknown error"}`);
          return {};
        });
        state = applyDirectThesisBuilderUpdate(state, thesisSelection, latestDebatePoints, sideBuiltWindows, trace);
        timings.thesisBuilderMs = Date.now() - thesisStartedAt;
        logDeterministicStep(trace, "ThesisBuilder:updated", createDirectTracePayload("ThesisBuilder", {
          DebatePointBatch: latestDebatePoints.length,
          DebatePointLedger: debatePointLedgerFromState(state).length,
          ThesisLedger: thesisUpdateLedgerFromState(state).length
        }, {
          BlueThesis: thesisSelection?.blueThesis ? 1 : 0,
          RedThesis: thesisSelection?.redThesis ? 1 : 0,
          FeaturedQuote: thesisSelection?.featuredQuote?.text ? 1 : 0
        }, {
          thesisBuilderMs: timings.thesisBuilderMs
        }));
      } else {
        logDeterministicStep(trace, "ThesisBuilder:skipped", {
          reason: "no-new-debate-points"
        });
      }
    }

    if (options.runClaims !== false) {
      const claimStartedAt = Date.now();
      const claimReviewDebatePoints = debatePointsAwaitingReview(state, latestDebatePoints, "claim");
      let claimBuilderFailed = false;
      const pointSelection = await withTimeout(
        runDirectClaimBuilderAgent({
          dialogueWindows: sideBuiltWindows,
          debatePoints: claimReviewDebatePoints,
          currentDebate: state,
          model: timings.selectionModel,
          trace
        }),
        30000,
        "Claim Builder timed out"
      ).catch((error) => {
        claimBuilderFailed = true;
        console.log(`Claim Builder fallback: ${error instanceof Error ? error.message : "unknown error"}`);
        return {};
      });
      timings.claimBuilderMs = Date.now() - claimStartedAt;
      const claimCandidates = pointSelection?.claims || pointSelection?.points || [];
      let selectedPoints = normalizeClaimBuilderOutput(claimCandidates, eligibleTurns, state, trace)
        .map((point) => ({
          ...point,
          role: "claim",
          factStatus: point.factStatus && point.factStatus !== "checking" ? point.factStatus : "checking"
        }));
      selectedPoints = alignPointSidesToSpeakers(selectedPoints, state);
      timings.selectedPoints = selectedPoints.length;
      state = mergeDebatePoints(state, selectedPoints);
      if (!claimBuilderFailed) {
        state = markDebatePointsReviewed(state, claimReviewDebatePoints, "claim");
      }
      logDeterministicStep(trace, "ClaimBuilder:selected", createDirectTracePayload("ClaimBuilder", {
        SideBuiltWindowQueue: sideBuiltWindows.length,
        DebatePointsAwaitingReview: claimReviewDebatePoints.length
      }, {
        ClaimCards: selectedPoints.length
      }, {
        rawPoints: Array.isArray(claimCandidates) ? claimCandidates.length : 0,
        selectedPoints: selectedPoints.length,
        reviewedDebatePoints: claimBuilderFailed ? 0 : claimReviewDebatePoints.length,
        reviewDeferred: claimBuilderFailed,
        claimBuilderMs: timings.claimBuilderMs
      }));
    }

    const artifactDialogueWindows = buildArtifactContextDialogueWindows(options.artifactContextTurns, windowTurns, state, readyWindows);
    if (options.runChallenges !== false) {
      const clashStartedAt = Date.now();
      const clashReviewDebatePoints = debatePointsAwaitingReview(state, latestDebatePoints, "clash");
      let clashFinderFailed = false;
      const clashSelection = await withTimeout(
        runDirectClashFinderAgent({
          dialogueWindows: artifactDialogueWindows,
          debatePoints: clashReviewDebatePoints,
          currentDebate: state,
          model: timings.selectionModel,
          trace
        }),
        16000,
        "Clash Finder timed out"
      ).catch((error) => {
        clashFinderFailed = true;
        console.log(`Clash Finder fallback: ${error instanceof Error ? error.message : "unknown error"}`);
        return {};
      });
      const clashes = normalizeDirectClashArtifacts(clashSelection?.clashes || [], state, clashReviewDebatePoints);
      state = mergeDirectClashArtifacts(state, clashes);
      if (!clashFinderFailed) {
        state = markDebatePointsReviewed(state, clashReviewDebatePoints, "clash");
      }
      timings.clashFinderMs = Date.now() - clashStartedAt;
      logDeterministicStep(trace, "ClashFinder:merged", {
        rawClashes: Array.isArray(clashSelection?.clashes) ? clashSelection.clashes.length : 0,
        acceptedClashes: clashes.length,
        totalClashes: state.artifacts?.clashes?.length || 0,
        debatePointsAwaitingReview: clashReviewDebatePoints.length,
        reviewedDebatePoints: clashFinderFailed ? 0 : clashReviewDebatePoints.length,
        reviewDeferred: clashFinderFailed,
        clashFinderMs: timings.clashFinderMs
      });
    }

    if (options.runInconsistencies !== false) {
      const inconsistencyStartedAt = Date.now();
      const inconsistencyReviewDebatePoints = debatePointsAwaitingReview(state, latestDebatePoints, "inconsistency");
      let inconsistencyFinderFailed = false;
      const inconsistencySelection = await withTimeout(
        runDirectInconsistencyFinderAgent({
          dialogueWindows: artifactDialogueWindows,
          debatePoints: inconsistencyReviewDebatePoints,
          currentDebate: state,
          model: timings.selectionModel,
          trace
        }),
        16000,
        "Inconsistency Finder timed out"
      ).catch((error) => {
        inconsistencyFinderFailed = true;
        console.log(`Inconsistency Finder fallback: ${error instanceof Error ? error.message : "unknown error"}`);
        return {};
      });
      const inconsistencies = normalizeDirectInconsistencyArtifacts(inconsistencySelection?.inconsistencies || [], state, inconsistencyReviewDebatePoints);
      state = mergeDirectInconsistencyArtifacts(state, inconsistencies);
      if (!inconsistencyFinderFailed) {
        state = markDebatePointsReviewed(state, inconsistencyReviewDebatePoints, "inconsistency");
      }
      timings.inconsistencyFinderMs = Date.now() - inconsistencyStartedAt;
      logDeterministicStep(trace, "InconsistencyFinder:merged", {
        rawInconsistencies: Array.isArray(inconsistencySelection?.inconsistencies) ? inconsistencySelection.inconsistencies.length : 0,
        acceptedInconsistencies: inconsistencies.length,
        totalInconsistencies: state.artifacts?.inconsistencies?.length || 0,
        debatePointsAwaitingReview: inconsistencyReviewDebatePoints.length,
        reviewedDebatePoints: inconsistencyFinderFailed ? 0 : inconsistencyReviewDebatePoints.length,
        reviewDeferred: inconsistencyFinderFailed,
        inconsistencyFinderMs: timings.inconsistencyFinderMs
      });
    }
  } else {
    logDeterministicStep(trace, "Editor:skipped", {
      reason: startupReady ? "cadence-cleaning-window-only" : "startup-waiting-for-reporter-chunks",
      startupReady,
      reporterChunks: currentReporterChunkCount(state, incomingTurns)
    });
  }

  const assemblerStartedAt = Date.now();
  const finalized = finalizeDirectLedgerState(state);
  timings.assemblerMs = Date.now() - assemblerStartedAt;
  timings.totalMs = Date.now() - totalStartedAt;
  const finalTimings = {
    ...timings,
    reporterChunks: currentReporterChunkCount(finalized, incomingTurns),
    startupReady
  };
  attachTraceTimings(finalTimings, trace);
  logDeterministicStep(trace, "DebateDeskAssembler:finalized", {
    claims: finalized.artifacts?.claims?.length || 0,
    clashes: finalized.artifacts?.clashes?.length || 0,
    keyMoments: finalized.artifacts?.keyMoments?.length || 0,
    factChecks: finalized.artifacts?.sourceChecks?.length || 0,
    scoreBlue: finalized.scorecard?.blue?.score || 0,
    scoreRed: finalized.scorecard?.red?.score || 0,
    assemblerMs: timings.assemblerMs
  });
  console.log(`pipeline timing ${timings.label}: windows=${timings.dialogueWindows} cleaning=${timings.cleaningMs}ms side=${timings.sideBuilderMs}ms debatePoints=${timings.debatePointBuilderMs}ms thesis=${timings.thesisBuilderMs || 0}ms claims=${timings.claimBuilderMs}ms clashes=${timings.clashFinderMs}ms inconsistencies=${timings.inconsistencyFinderMs}ms assembler=${timings.assemblerMs}ms total=${timings.totalMs}ms points=${timings.selectedPoints}`);
  return options.includeTimings ? { ...finalized, _timings: finalTimings } : finalized;
}

function clearNonDirectAnalysisState(state = {}) {
  const directAnalysis = normalizeDirectAnalysisState(state.analysis);
  const keepDirectArtifacts = Boolean(
    directAnalysis
    || state.pipeline === "direct-ledger"
    || Number(state.analysisSchemaVersion || 0) >= DIRECT_ANALYSIS_SCHEMA_VERSION
  );
  return {
    ...state,
    artifacts: keepDirectArtifacts ? normalizeArtifacts(state.artifacts || {}) : normalizeArtifacts({}),
    analysis: directAnalysis,
    scorecard: normalizeScorecard(state.scorecard)
  };
}

function normalizeDirectAnalysisState(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Number(value.schemaVersion || 0) < DIRECT_ANALYSIS_SCHEMA_VERSION) return null;
  if (value.architecture !== DIRECT_ANALYSIS_ARCHITECTURE) return null;
  const tabs = value.tabs || {};
  const internal = value.internal || {};
  const score = value.score || {};
  return {
    ...value,
    schemaVersion: DIRECT_ANALYSIS_SCHEMA_VERSION,
    architecture: DIRECT_ANALYSIS_ARCHITECTURE,
    tabs: {
      claims: Array.isArray(tabs.claims) ? tabs.claims : [],
      clashes: Array.isArray(tabs.clashes) ? tabs.clashes : [],
      keyMoments: Array.isArray(tabs.keyMoments) ? tabs.keyMoments : []
    },
    internal: {
      factChecks: Array.isArray(internal.factChecks) ? internal.factChecks : [],
      inconsistencies: Array.isArray(internal.inconsistencies) ? internal.inconsistencies : [],
      sideAssignments: Array.isArray(internal.sideAssignments) ? internal.sideAssignments : [],
      debatePoints: normalizeDebatePointLedger(internal.debatePoints || []),
      thesisUpdates: normalizeThesisUpdateLedger(internal.thesisUpdates || []),
      claimReviewedDebatePointIds: uniqueStrings(Array.isArray(internal.claimReviewedDebatePointIds) ? internal.claimReviewedDebatePointIds.map(cleanClaimText) : []),
      clashReviewedDebatePointIds: uniqueStrings(Array.isArray(internal.clashReviewedDebatePointIds) ? internal.clashReviewedDebatePointIds.map(cleanClaimText) : []),
      inconsistencyReviewedDebatePointIds: uniqueStrings(Array.isArray(internal.inconsistencyReviewedDebatePointIds) ? internal.inconsistencyReviewedDebatePointIds.map(cleanClaimText) : [])
    },
    score: {
      method: "key_moment_score",
      version: DIRECT_ANALYSIS_SCHEMA_VERSION,
      ...score,
      events: Array.isArray(score.events) ? score.events : []
    }
  };
}

async function runDirectSideBuilderAgent({ dialogueWindows = [], transcriptWindow = [], currentDebate = {}, model = config.fastModel, trace = null } = {}) {
  const context = buildDirectSideBuilderContext(currentDebate, dialogueWindows, transcriptWindow);
  if (!context.dialogueWindows.length) {
    logDeterministicStep(trace, "SideBuilder:skipped", { reason: "no-ready-side-built-window" });
    return {};
  }
  const prompt = [
    "You are debatly's Side Builder.",
    "Your job is to maintain the debate setup: topic, Blue side position, Red side position, and durable speaker-to-side map.",
    "Do not extract claim cards, clashes, inconsistencies, sources, scores, or report prose.",
    "Return strict JSON only.",
    "Schema:",
    "{",
    '  "topic": "short neutral debate topic, or empty",',
    '  "bluePosition": "short Blue side position, or empty",',
    '  "redPosition": "short Red side position, or empty",',
    '  "speakers": [{"speakerId":"Speaker 1","side":"blue|red","confidence":0.0,"reason":"specific reason from stance/opposition/continuation","evidenceQuote":"exact quote that supports assignment"}],',
    '  "speakerMemory": [{"speakerId":"Speaker 1","likelySide":"blue|red","confidence":0.0,"stanceSummary":"plain summary","supportingEvidence":["short quote"]}]',
    "}",
    "Rules:",
    "- Assign by the position a speaker advances, defends, or continues.",
    "- Do not assign moderators, hosts, interviewers, timekeepers, narrators, audience members, or floor-management speakers to either side.",
    "- A moderator question is context only, even when it challenges one side sharply.",
    "- Only assign a speaker when they make sustained side-owned debate points in their own words.",
    "- Treat ads, sponsor reads, product/service promotion, brand reads, and commercial breaks as context only; never assign them to Blue side or Red side.",
    "- Never assign a speaker to Blue side merely because they ask about, challenge, or probe Blue side.",
    "- A question, greeting, short challenge, or probe is not enough to assign a side.",
    "- If a new speaker challenges a side, wait until they also state or repeatedly continue a real opposing position.",
    "- If a new speaker continues the same line as a previous challenger, keep them on that challenger side only when their own words show sustained agreement.",
    "- Keep existing assignments unless the new transcript gives clear stronger evidence of a correction.",
    "- Use only Blue side and Red side in prose.",
    "- Include evidenceQuote for every assignment; no quote means no assignment.",
    "- Keep the topic and side positions short and topic-agnostic.",
    `Routed context for Side Builder: ${stringifyAgentContext(context)}`
  ].join("\n");
  const response = await generateContentForAgent({
    trace,
    agent: "Side Builder",
    model,
    contents: prompt,
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 3000,
      httpOptions: { timeout: 30000 }
    },
    meta: {
      windows: context.dialogueWindows.length,
      speakers: context.speakerSideMap.length,
      speakerHistory: context.speakerHistory.length,
      dialogueWindowLedger: context.dialogueWindowLedger.length
    }
  });
  return parseJsonWithLocalRepair(response.text || "{}");
}

function buildDirectSideBuilderContext(state = {}, dialogueWindows = [], transcriptWindow = []) {
  const normalized = normalizeClaimState(state);
  return {
    agent: "Side Builder",
    receives: ["cleaned side-builder packet", "existing speaker-side map", "own side memory", "full compact speaker history", "compact stabilizer window ledger"],
    excludes: ["claims", "fact checks", "clashes", "inconsistencies", "scores"],
    topic: normalized.topic || "",
    sides: ensureTwoSides(normalized.sides || []).map((side) => ({
      side: sideColorName(side.id),
      position: confirmedSideLabel(side) || side.workingThesis || "",
      speakerIds: side.speakerIds || []
    })),
    speakerSideMap: buildCurrentSpeakerSideMap(normalized).map((entry) => ({
      speakerId: entry.speakerId,
      side: sideColorName(entry.sideId),
      confidence: entry.confidence,
      reason: entry.reason
    })),
    speakerMemory: (normalized.speakerPositionMemory || []).slice(-40).map((item) => ({
      speakerId: item.speakerId,
      likelySide: sideColorName(item.likelySide),
      confidence: item.confidence,
      stanceSummary: item.stanceSummary,
      supportingEvidence: item.supportingEvidence || []
    })),
    speakerHistory: (normalized.speakers || []).map((speaker) => ({
      speakerId: speaker.speakerId,
      side: sideColorName(speaker.sideId),
      confidence: speaker.sideConfidence,
      reason: truncatePromptText(speaker.assignmentReason || "", 260),
      wordCount: speaker.wordCount,
      turnCount: speaker.turnCount,
      voicedDurationSec: speaker.voicedDurationSec,
      firstStartSec: speaker.firstStartSec,
      lastEndSec: speaker.lastEndSec,
      speakerRole: normalizeFloorSpeakerRole(speaker.speakerRole),
      floorRoleConfidence: speaker.floorRoleConfidence,
      sampleText: truncatePromptText(speaker.sampleText || "", 360)
    })),
    dialogueWindowLedger: (normalized.dialogueWindows || []).slice(-120).map((window) => ({
      windowId: window.windowId,
      status: window.windowStatus,
      reason: window.reason,
      startSec: window.startSec,
      endSec: window.endSec,
      speakerIds: window.speakerIds || [],
      contextOnly: Boolean(window.contextOnly),
      contextKind: window.contextKind || "",
      contextSignals: window.contextSignals || []
    })),
    dialogueWindows: (dialogueWindows || []).slice(-2).map((window) => ({
      windowId: window.windowId,
      reason: window.reason,
      contextOnly: Boolean(window.contextOnly),
      contextKind: window.contextKind || "",
      contextSignals: window.contextSignals || [],
      startSec: window.startSec,
      endSec: window.endSec,
      speakerColumns: (window.speakerColumns || window.speakerBlocks || []).map((block) => ({
        speakerId: block.speakerId,
        text: truncatePromptText(block.text || "", 900),
        existingSide: sideColorName(speakerSideFromState(normalized, block.speakerId)),
        sideMapEligible: isSpeakerSideMapEligible(normalized, block.speakerId, block.turnIds || [])
      })),
      turns: (window.turns || []).map((turn) => ({
        id: turn.id,
        speakerId: turn.speakerId,
        text: truncatePromptText(turn.text || "", 360),
        startSec: turn.startSec,
        endSec: turn.endSec
      }))
    })),
    recentTranscript: (transcriptWindow || []).slice(-16).map((turn) => ({
      speakerId: turn.speakerId,
      text: truncatePromptText(turn.text || "", 220),
      startSec: turn.startSec,
      endSec: turn.endSec
    }))
  };
}

function normalizeDirectSideBuilderSpeakerProposals(items = [], state = {}) {
  const normalized = normalizeClaimState(state);
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const speakerId = cleanClaimText(item?.speakerId || "");
      const sideId = normalizeAgentSideId(item);
      const confidence = clamp01(item?.confidence ?? item?.sideConfidence, 0);
      const reason = cleanAgentDisplayText(item?.reason || item?.assignmentReason || "");
      const evidenceQuote = cleanClaimText(item?.evidenceQuote || item?.quote || "");
      if (!speakerId || !sideId || confidence < 0.55 || !evidenceQuote) return null;
      if (isModeratorSideAssignment({ speakerId, reason, evidenceQuote, state: normalized })) return null;
      if (isWeakSideAssignmentEvidence({ reason, evidenceQuote })) return null;
      const existing = (normalized.speakers || []).find((speaker) => speaker.speakerId === speakerId);
      if (existing?.sideId && existing.sideId !== sideId && Number(existing.sideConfidence || 0) >= 0.86 && confidence < 0.94) return null;
      if (/\b(asks?|questions?|probes?|mentions?)\s+(blue|red)\s+side\b/i.test(reason) && !/\b(supports?|defends?|argues?|opposes?|challenges?|continues?)\b/i.test(reason)) return null;
      return {
        speakerId,
        sideId,
        sideConfidence: confidence,
        assignmentReason: reason || "Assigned by direct stance ownership.",
        evidenceQuote
      };
    })
    .filter(Boolean);
}

function isWeakSideAssignmentEvidence({ reason = "", evidenceQuote = "" } = {}) {
  const quote = cleanClaimText(evidenceQuote || "");
  const normalizedQuote = normalizeTranscript(quote);
  if (!normalizedQuote) return true;
  const combined = normalizeTranscript(`${reason || ""} ${quote}`);
  const hasSelfOwnedStance = /\b(i think|i believe|i argue|i support|i oppose|i defend|i do not believe|i don't believe|we think|we believe|we support|we oppose|we defend|my position|our position|my view|our view)\b/.test(combined);
  const hasArgumentSignal = /\b(argues?|advocates?|defends?|opposes?|supports?|rejects?|claims?|states?|says?|because|therefore|should|should not|shouldn't|must|must not|ought|means|requires|causes|prevents|proves|shows)\b/.test(combined);
  const socialOnly = /^(nice to meet you|good to meet you|thank you|thanks|okay|ok|yeah|yes|no|right|sure|go ahead|hello|hi)\b[.!?\s]*$/i.test(quote);
  const questionLead = /^(can i just ask|can i ask|let me ask|i want to ask|how|what|why|when|where|who|do you|does|did|are you|is it|would you|could you|should we|under what)\b/i.test(quote);
  const questionOnly = questionLead || /[?]\s*$/.test(quote);
  if (socialOnly) return true;
  if (wordCount(quote) < 5 && !hasSelfOwnedStance) return true;
  if (questionOnly && !hasSelfOwnedStance) return true;
  if (!hasSelfOwnedStance && !hasArgumentSignal) return true;
  return false;
}

function isModeratorSideAssignment({ speakerId = "", reason = "", evidenceQuote = "", state = {} } = {}) {
  const speaker = (state.speakers || []).find((item) => item.speakerId === speakerId) || {};
  if (isNeutralFloorSpeaker(state, speakerId)) return true;
  const role = normalizeFloorSpeakerRole(speaker.speakerRole);
  if (role === NEUTRAL_SPEAKER && Number(speaker.floorRoleConfidence || 0) >= 0.58) return true;
  const text = normalizeTranscript(`${reason} ${evidenceQuote}`);
  if (!text) return false;
  const selfOwnedStance = /\b(i think|i believe|i argue|we think|we believe|my position|our position|my plan|our plan|i support|i oppose|i defend)\b/.test(text);
  if (/\b(moderator|moderation|host|interviewer|timekeeper|neutral|facilitat(?:e|ing)|maintains neutrality|debate structure|floor management|manages the debate|context only|procedural|opening statements?|floor is yours)\b/.test(text)) return true;
  if (/\b(i want to ask|i do want to ask|let me ask|i'll let you respond|i will let you respond|feel the need to respond|your time is up|time is up|please step forward|we're going to turn|we are going to turn|turn to the issue|let's move on|lets move on|go ahead|thank you president|thank you vice president)\b/.test(text)) {
    return !selfOwnedStance;
  }
  if (/\b(personal attack|make your case|crossed one of the lines|culture that we try to establish|mutual .{0,24}contest|we'?re going to have a discussion|we are going to have a discussion)\b/.test(text)) {
    return !selfOwnedStance;
  }
  if (/\b(i heard (you|your opponent)|people have said|others would say|there'?s an issue to be discussed|what in your view|i'?ll probably jump in|i will probably jump in)\b/.test(text)) {
    return !/\b(i think|i believe|i argue|we think|we believe|my position|our position|my plan|our plan|i support|i oppose|i defend)\b/.test(text);
  }
  return false;
}

function normalizeDirectSpeakerMemory(items = [], state = {}) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const speakerId = cleanClaimText(item?.speakerId || "");
      let likelySide = normalizeAgentSideId({ side: item?.likelySide || item?.side });
      if (!speakerId) return null;
      const stanceSummary = truncatePromptText(cleanAgentDisplayText(item?.stanceSummary || ""), 360);
      const supportingEvidence = uniqueStrings(Array.isArray(item?.supportingEvidence) ? item.supportingEvidence.map(cleanClaimText) : []).slice(0, 4);
      if (isModeratorSideAssignment({
        speakerId,
        reason: stanceSummary,
        evidenceQuote: supportingEvidence.join(" "),
        state
      })) {
        likelySide = "";
      }
      return {
        speakerId,
        likelySide,
        confidence: likelySide ? clamp01(item?.confidence, 0.65) : 0,
        stanceSummary,
        supportingEvidence,
        recentShiftRisk: "low",
        updatedAt: Date.now()
      };
    })
    .filter(Boolean);
}

function applyDirectSideLabels(state = {}, selection = {}) {
  const topic = cleanClaimText(selection?.topic || "");
  const bluePosition = cleanAgentDisplayText(selection?.bluePosition || "");
  const redPosition = cleanAgentDisplayText(selection?.redPosition || "");
  const sides = ensureTwoSides(state.sides || []).map((side) => {
    const proposed = side.id === BLUE_SIDE_ID ? bluePosition : redPosition;
    if (!proposed || isGenericTopic(proposed)) return side;
    const sidePoints = (state.points || []).filter((point) => point.sideId === side.id).slice(-8);
    return confirmSideThesis(side, proposed, sidePoints);
  });
  return {
    ...state,
    topic: topic && !isGenericTopic(topic) ? compactTopic(topic) : state.topic,
    sides: dedupeSideThesisLabels({ ...state, sides })
  };
}

function appendSideAssignmentAudit(state = {}, proposals = [], dialogueWindows = [], trace = null) {
  const existing = normalizeDirectAnalysisState(state.analysis)?.internal?.sideAssignments || [];
  const range = debateRangeFromTurns(flattenDialogueWindowTurns(dialogueWindows));
  const entries = proposals.map((proposal) => ({
    eventId: `side-${stableTextHash(`${proposal.speakerId}:${proposal.sideId}:${proposal.evidenceQuote || proposal.assignmentReason}`)}`,
    speakerId: proposal.speakerId,
    sideId: proposal.sideId,
    side: sideColorName(proposal.sideId),
    confidence: clamp01(proposal.sideConfidence, 0),
    decisionReason: cleanAgentDisplayText(proposal.assignmentReason || ""),
    evidenceQuote: cleanClaimText(proposal.evidenceQuote || ""),
    wallClockAt: new Date().toISOString(),
    debateStartSec: range.startSec,
    debateEndSec: range.endSec,
    debateMinute: Number.isFinite(Number(range.endSec)) ? Number((Number(range.endSec) / 60).toFixed(2)) : null,
    packetRange: {
      startSec: range.startSec,
      endSec: range.endSec
    },
    traceId: trace?.id || ""
  }));
  if (entries.length) {
    for (const entry of entries) {
      logDeterministicStep(trace, "SideBuilder:assignment-audit", {
        speakerId: entry.speakerId,
        side: entry.side,
        confidence: entry.confidence,
        decisionReason: entry.decisionReason,
        evidenceQuote: entry.evidenceQuote,
        debateStartSec: entry.debateStartSec,
        debateEndSec: entry.debateEndSec
      });
    }
  }
  return {
    ...state,
    analysis: {
      ...(normalizeDirectAnalysisState(state.analysis) || emptyDirectAnalysisState()),
      internal: {
        ...(normalizeDirectAnalysisState(state.analysis)?.internal || {}),
        sideAssignments: uniqueByEventId([...existing, ...entries])
      }
    }
  };
}

function uniqueByEventId(items = []) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const id = cleanClaimText(item?.eventId || item?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function buildLiveDebatePointPacket({ state = {}, sideBuiltWindows = [], existingPointLedger = [] } = {}) {
  const normalized = normalizeClaimState(state);
  const turns = uniqueTurnsById((sideBuiltWindows || [])
    .flatMap((window) => window?.turns || [])
    .map((turn) => ({
      id: cleanClaimText(turn.id || ""),
      speakerId: cleanClaimText(turn.speakerId || ""),
      side: sideColorName(turnOwnerSideFromState(normalized, turn) || normalizeAgentSideId(turn) || turn.ownerSideId || turn.sideId),
      text: cleanClaimText(turn.text || ""),
      startSec: finiteOrUndefined(turn.startSec),
      endSec: finiteOrUndefined(turn.endSec)
    }))
    .filter((turn) => turn.id && turn.speakerId && turn.text));
  const range = debateRangeFromTurns(turns);
  const speakerMap = {};
  for (const entry of buildCurrentSpeakerSideMap(normalized)) {
    if (!entry?.speakerId || !normalizeSideId(entry.sideId)) continue;
    speakerMap[entry.speakerId] = {
      speakerId: entry.speakerId,
      side: sideColorName(entry.sideId),
      confidence: clamp01(entry.confidence, 0),
      reason: cleanAgentDisplayText(entry.reason || "")
    };
  }
  const sides = {};
  for (const side of ensureTwoSides(normalized.sides || [])) {
    sides[sideName(side.id)] = {
      position: confirmedSideLabel(side) || side.workingThesis || "",
      header: confirmedSideLabel(side) || side.workingThesis || "",
      confidence: clamp01(side.confidence || side.sideConfidence, 0.8)
    };
  }
  return {
    scenarioId: cleanClaimText(normalized.sessionId || normalized.projectId || ""),
    batchIndex: cleanClaimText((sideBuiltWindows || []).map((window) => window?.windowId).filter(Boolean).join("|")),
    packetRange: [range.startSec, range.endSec].filter((value) => Number.isFinite(Number(value))),
    setupLine: normalized.topic || "",
    topic: normalized.topic || "",
    sides,
    speakerMap,
    turns,
    existingPointLedger: normalizeDebatePointLedger(existingPointLedger)
  };
}

function debatePointLedgerFromState(state = {}) {
  return normalizeDebatePointLedger(normalizeDirectAnalysisState(state.analysis)?.internal?.debatePoints || []);
}

function debatePointReviewField(kind = "") {
  if (kind === "clash") return "clashReviewedDebatePointIds";
  if (kind === "inconsistency") return "inconsistencyReviewedDebatePointIds";
  return "claimReviewedDebatePointIds";
}

function reviewedDebatePointIdSet(state = {}, kind = "claim") {
  const field = debatePointReviewField(kind);
  return new Set(uniqueStrings((normalizeDirectAnalysisState(state.analysis)?.internal?.[field] || []).map(cleanClaimText)));
}

function debatePointsAwaitingReview(state = {}, latestDebatePoints = [], kind = "claim") {
  const reviewed = reviewedDebatePointIdSet(state, kind);
  const byId = new Map();
  for (const point of normalizeDebatePointLedger(latestDebatePoints || [])) {
    if (point?.pointId) byId.set(point.pointId, point);
  }
  for (const point of debatePointLedgerFromState(state)) {
    if (!point?.pointId || reviewed.has(point.pointId)) continue;
    byId.set(point.pointId, point);
  }
  return [...byId.values()].sort((a, b) => artifactTimeValue(a) - artifactTimeValue(b));
}

function markDebatePointsReviewed(state = {}, reviewedPoints = [], kind = "claim") {
  const ids = uniqueStrings(normalizeDebatePointLedger(reviewedPoints || []).map((point) => point.pointId));
  if (!ids.length) return state;
  const analysis = normalizeDirectAnalysisState(state.analysis) || emptyDirectAnalysisState();
  const field = debatePointReviewField(kind);
  const nextIds = uniqueStrings([...(analysis.internal?.[field] || []), ...ids]);
  return {
    ...state,
    analysis: {
      ...analysis,
      updatedAt: Date.now(),
      internal: {
        ...(analysis.internal || {}),
        [field]: nextIds
      }
    }
  };
}

function mergeDebatePointLedger(state = {}, incomingPoints = []) {
  const analysis = normalizeDirectAnalysisState(state.analysis) || emptyDirectAnalysisState();
  const byId = new Map(debatePointLedgerFromState(state).map((point) => [point.pointId, point]));
  for (const point of normalizeDebatePointLedger(incomingPoints)) {
    if (!point.pointId) continue;
    byId.set(point.pointId, { ...(byId.get(point.pointId) || {}), ...point });
  }
  const debatePoints = [...byId.values()]
    .sort((a, b) => artifactTimeValue(a) - artifactTimeValue(b));
  return {
    ...state,
    analysis: {
      ...analysis,
      updatedAt: Date.now(),
      internal: {
        ...(analysis.internal || {}),
        debatePoints
      }
    }
  };
}

function normalizeDebatePointLedger(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const sideId = normalizeSideId(item?.sideId || item?.side || "");
      const side = sideColorName(sideId || item?.side || "");
      const point = cleanAgentDisplayText(item?.point || item?.claim || "");
      const quote = cleanClaimText(item?.quote || "");
      const speakerId = cleanClaimText(item?.speakerId || "");
      const pointId = cleanClaimText(item?.pointId || item?.id || "");
      if (!pointId || !sideId || !side || !point || !quote || !speakerId) return null;
      return {
        pointId,
        speakerId,
        side,
        sideId,
        point,
        quote,
        turnIds: uniqueStrings(Array.isArray(item?.turnIds) ? item.turnIds.map(cleanClaimText) : []),
        startSec: finiteOrUndefined(item?.startSec),
        endSec: finiteOrUndefined(item?.endSec),
        pointType: cleanClaimText(item?.pointType || "value") || "value",
        issueHint: cleanAgentDisplayText(item?.issueHint || ""),
        reason: cleanAgentDisplayText(item?.reason || ""),
        confidence: clamp01(item?.confidence, 0.7),
        source: cleanClaimText(item?.source || "debate_point_builder")
      };
    })
    .filter(Boolean);
}

function compactDebatePointForPrompt(point = {}) {
  return {
    pointId: point.pointId,
    speakerId: point.speakerId,
    side: point.side,
    point: truncatePromptText(point.point || "", 320),
    quote: truncatePromptText(point.quote || "", 320),
    turnIds: point.turnIds || [],
    pointType: point.pointType || "",
    issueHint: point.issueHint || "",
    startSec: point.startSec,
    endSec: point.endSec
  };
}

function thesisUpdateLedgerFromState(state = {}) {
  return normalizeThesisUpdateLedger(normalizeDirectAnalysisState(state.analysis)?.internal?.thesisUpdates || []);
}

function normalizeThesisUpdateLedger(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const batchId = cleanClaimText(item?.batchId || item?.id || "");
      const blueThesis = normalizeSideThesisLabel(item?.blueThesis || "");
      const redThesis = normalizeSideThesisLabel(item?.redThesis || "");
      const quoteText = cleanClaimText(item?.featuredQuote?.text || item?.featuredQuote?.quote || item?.quote || "");
      const rawText = cleanClaimText(item?.featuredQuote?.rawText || item?.featuredQuote?.sourceText || "");
      const sideId = normalizeSideId(item?.featuredQuote?.sideId || item?.featuredQuote?.side || "");
      return {
        batchId: batchId || `thesis-${stableTextHash(`${blueThesis}:${redThesis}:${quoteText}:${item?.debateEndSec || ""}`)}`,
        blueThesis,
        redThesis,
        featuredQuote: quoteText ? {
          text: quoteText,
          rawText: rawText || undefined,
          speakerId: cleanClaimText(item?.featuredQuote?.speakerId || item?.speakerId || "Debate audio"),
          sideId: sideId || undefined,
          side: sideColorName(sideId) || cleanClaimText(item?.featuredQuote?.side || ""),
          atSec: finiteOrUndefined(item?.featuredQuote?.atSec ?? item?.atSec),
          reason: cleanAgentDisplayText(item?.featuredQuote?.reason || item?.quoteReason || "")
        } : null,
        debateStartSec: finiteOrUndefined(item?.debateStartSec),
        debateEndSec: finiteOrUndefined(item?.debateEndSec),
        debateMinute: finiteOrUndefined(item?.debateMinute),
        pointIds: uniqueStrings(Array.isArray(item?.pointIds) ? item.pointIds.map(cleanClaimText) : []),
        updatedAt: Number(item?.updatedAt || Date.now())
      };
    })
    .filter((item) => item.blueThesis || item.redThesis || item.featuredQuote)
    .slice(-500);
}

async function runDirectThesisBuilderAgent({ sideBuiltWindows = [], debatePoints = [], currentDebate = {}, model = config.fastModel, trace = null } = {}) {
  const context = buildDirectThesisBuilderContext(currentDebate, sideBuiltWindows, debatePoints);
  if (!context.newDebatePoints.length) {
    logDeterministicStep(trace, "ThesisBuilder:skipped", { reason: "no-new-debate-points" });
    return {};
  }
  const prompt = [
    "You are debatly's Thesis Builder.",
    "This is a live debate. Every 30 seconds you update the current thesis/topic for Blue side and Red side, plus one strong featured quote.",
    "Do not create claim cards, clash cards, inconsistency cards, scores, source checks, or report prose.",
    "Return strict JSON only.",
    "Schema:",
    "{",
    '  "blueThesis": "short current thesis for Blue side, or empty",',
    '  "redThesis": "short current thesis for Red side, or empty",',
    '  "featuredQuote": {',
    '    "speakerId": "Speaker 1",',
    '    "side": "blue|red",',
    '    "text": "lightly smoothed display quote from the current 30 second batch",',
    '    "rawText": "closest original transcript/debate-point quote before smoothing",',
    '    "turnIds": ["turn id"],',
    '    "reason": "why this is the strongest usable quote in the batch",',
    '    "confidence": 0.0',
    "  }",
    "}",
    "Rules:",
    "- Use the new debate points to understand what each side is currently arguing in this 30 second batch.",
    "- Use the full debate point ledger and thesis history only for context and to avoid repeating stale wording.",
    "- If one side has no new meaningful debate point in the batch, return an empty thesis for that side so the previous thesis can remain.",
    "- Thesis text must be short, plain English, and specific to the current issue. Aim for 4 to 10 words.",
    "- Do not write 'Blue side says' or 'Red side says'. Write the position itself.",
    "- Do not use Side A or Side B. Use only Blue side and Red side if side names are needed.",
    "- Do not invent a side thesis from a moderator question or setup text.",
    "- Do not create or update thesis/featured quotes from ads, sponsor reads, product/service promotion, brand reads, or commercial breaks.",
    "- Pick the featured quote only from the current batch transcript or the current batch debate point quotes.",
    "- The quote must be one complete, usable sentence or self-contained thought.",
    "- You may lightly smooth the quote for display only: remove repeated filler words, fix punctuation/capitalization, and trim abrupt starts/ends to the nearest complete sentence.",
    "- Always provide rawText with the closest original wording before smoothing.",
    "- Do not add facts, names, numbers, sources, legal terms, or missing ideas while smoothing.",
    "- Do not correct suspected STT name/entity errors. Keep the raw entity wording or choose a different quote.",
    "- Do not combine unrelated or non-contiguous statements into one quote.",
    "- If a quote needs more than light cleanup to read well, set featuredQuote to null.",
    "- Do not use abrupt fragments, cut-off sentences, greetings, procedural talk, or moderator setup.",
    "- If no strong complete quote exists, set featuredQuote to null.",
    "- Do not repeat the same featured quote from thesis history.",
    `Routed context for Thesis Builder: ${stringifyAgentContext(context)}`
  ].join("\n");
  const response = await generateContentForAgent({
    trace,
    agent: "Thesis Builder",
    model,
    contents: prompt,
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 1600,
      httpOptions: { timeout: 18000 }
    },
    meta: {
      newDebatePoints: context.newDebatePoints.length,
      debatePointLedger: context.debatePointLedger.length,
      thesisHistory: context.thesisHistory.length,
      transcriptTurns: context.transcriptTurns.length
    }
  });
  return normalizeDirectThesisBuilderOutput(parseJsonWithLocalRepair(response.text || "{}"), context);
}

function buildDirectThesisBuilderContext(state = {}, sideBuiltWindows = [], debatePoints = []) {
  const normalized = normalizeClaimState(state);
  const latestPoints = normalizeDebatePointLedger(debatePoints || []);
  const fullLedger = debatePointLedgerFromState(normalized);
  const turns = uniqueTurnsById((sideBuiltWindows || [])
    .flatMap((window) => window?.turns || [])
    .map((turn) => ({
      id: cleanClaimText(turn.id || ""),
      speakerId: cleanClaimText(turn.speakerId || ""),
      side: sideColorName(turnOwnerSideFromState(normalized, turn) || normalizeAgentSideId(turn) || turn.ownerSideId || turn.sideId),
      text: truncatePromptText(cleanClaimText(turn.text || ""), 520),
      startSec: finiteOrUndefined(turn.startSec),
      endSec: finiteOrUndefined(turn.endSec)
    }))
    .filter((turn) => turn.id && turn.speakerId && turn.text));
  return {
    agent: "Thesis Builder",
    receives: ["new Debate Point batch", "full compact Debate Point ledger", "past thesis and quote ledger", "current batch speaker transcript"],
    excludes: ["claim cards", "fact checks", "clashes", "inconsistencies", "scores", "report"],
    sides: ensureTwoSides(normalized.sides || []).map((side) => ({
      sideId: side.id,
      side: sideColorName(side.id),
      currentThesis: confirmedSideLabel(side) || side.workingThesis || "",
      speakerIds: side.speakerIds || []
    })),
    speakerSideMap: buildCurrentSpeakerSideMap(normalized).map((entry) => ({
      speakerId: entry.speakerId,
      side: sideColorName(entry.sideId),
      confidence: entry.confidence
    })),
    newDebatePoints: latestPoints.map(compactDebatePointForPrompt),
    debatePointLedger: fullLedger.map(compactDebatePointForPrompt),
    thesisHistory: thesisUpdateLedgerFromState(normalized).map((item) => ({
      blueThesis: item.blueThesis,
      redThesis: item.redThesis,
      quote: item.featuredQuote?.text || "",
      speakerId: item.featuredQuote?.speakerId || "",
      side: item.featuredQuote?.side || sideColorName(item.featuredQuote?.sideId || ""),
      debateEndSec: item.debateEndSec
    })),
    transcriptTurns: turns
  };
}

function normalizeDirectThesisBuilderOutput(selection = {}, context = {}) {
  const blueThesis = normalizeSideThesisLabel(selection?.blueThesis || selection?.blue || "");
  const redThesis = normalizeSideThesisLabel(selection?.redThesis || selection?.red || "");
  const quote = selection?.featuredQuote && typeof selection.featuredQuote === "object" ? selection.featuredQuote : null;
  const candidateText = cleanClaimText(quote?.text || quote?.quote || "");
  const rawText = cleanClaimText(quote?.rawText || quote?.sourceText || "");
  const sideId = normalizeAgentSideId(quote || {});
  const speakerId = cleanClaimText(quote?.speakerId || "");
  const turnIds = uniqueStrings(Array.isArray(quote?.turnIds) ? quote.turnIds.map(cleanClaimText) : []);
  const supportText = rawText || candidateText;
  const support = quoteSupportFromThesisContext(supportText, speakerId, sideId, context);
  const faithfulToRaw = thesisQuoteDisplayMatchesRaw(candidateText, rawText);
  const featuredQuote = quote && candidateText && isUsableThesisFeaturedQuote(candidateText) && support.supported && faithfulToRaw ? {
    speakerId: speakerId || support.speakerId || "Debate audio",
    sideId: sideId || support.sideId,
    side: sideColorName(sideId || support.sideId),
    text: candidateText,
    rawText: rawText || candidateText,
    turnIds: turnIds.length ? turnIds : support.turnIds,
    startSec: support.startSec,
    endSec: support.endSec,
    reason: cleanAgentDisplayText(quote?.reason || ""),
    confidence: clamp01(quote?.confidence, 0.75)
  } : null;
  return {
    blueThesis,
    redThesis,
    featuredQuote
  };
}

function thesisQuoteDisplayMatchesRaw(displayText = "", rawText = "") {
  const display = normalizeTranscript(displayText || "");
  const raw = normalizeTranscript(rawText || "");
  if (!display || !raw) return true;
  if (raw.includes(display)) return true;
  if (tokenOverlapRatio(display, raw) < 0.72) return false;
  const rawTokens = new Set(meaningfulTokens(raw));
  const addedTokens = meaningfulTokens(display).filter((token) => !rawTokens.has(token));
  if (addedTokens.length) return false;
  const rawNumbers = new Set((raw.match(/\b\d+(?:[.,]\d+)?%?\b/g) || []).map((item) => item.replace(/,/g, "")));
  const displayNumbers = (display.match(/\b\d+(?:[.,]\d+)?%?\b/g) || []).map((item) => item.replace(/,/g, ""));
  if (displayNumbers.some((item) => !rawNumbers.has(item))) return false;
  return true;
}

function quoteSupportFromThesisContext(quote = "", speakerId = "", sideId = "", context = {}) {
  const texts = [];
  const cleanSpeaker = cleanClaimText(speakerId || "");
  const normalizedSideId = normalizeSideId(sideId);
  for (const turn of context.transcriptTurns || []) {
    if (cleanSpeaker && turn.speakerId !== cleanSpeaker) continue;
    const turnSideId = normalizeSideId(turn.side);
    if (normalizedSideId && turnSideId && turnSideId !== normalizedSideId) continue;
    texts.push({
      text: turn.text || "",
      speakerId: turn.speakerId,
      sideId: turnSideId,
      turnIds: [turn.id].filter(Boolean),
      startSec: turn.startSec,
      endSec: turn.endSec
    });
  }
  for (const point of context.newDebatePoints || []) {
    if (cleanSpeaker && point.speakerId !== cleanSpeaker) continue;
    const pointSideId = normalizeSideId(point.side);
    if (normalizedSideId && pointSideId && pointSideId !== normalizedSideId) continue;
    texts.push({
      text: point.quote || "",
      speakerId: point.speakerId,
      sideId: pointSideId,
      turnIds: point.turnIds || [],
      startSec: point.startSec,
      endSec: point.endSec
    });
  }
  const quoteNorm = normalizeTranscript(quote);
  let best = null;
  let bestScore = 0;
  for (const item of texts) {
    const sourceNorm = normalizeTranscript(item.text || "");
    if (!sourceNorm || !quoteNorm) continue;
    const exact = sourceNorm.includes(quoteNorm) || quoteNorm.includes(sourceNorm);
    const score = exact ? 1 : tokenOverlapRatio(quoteNorm, sourceNorm);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return {
    supported: bestScore >= 0.58,
    speakerId: best?.speakerId || cleanSpeaker,
    sideId: best?.sideId || normalizedSideId,
    turnIds: best?.turnIds || [],
    startSec: best?.startSec,
    endSec: best?.endSec
  };
}

function isUsableThesisFeaturedQuote(text = "") {
  const clean = cleanClaimText(text || "");
  const words = wordCount(clean);
  if (words < 7 || words > 42) return false;
  if (clean.length < 34 || clean.length > 260) return false;
  if (/[.]{2,}|…/.test(clean)) return false;
  if (/\b(and|or|but|because|so|to|of|for|with|that|which|when|where|while|through|from|into)$/i.test(clean)) return false;
  if (/^(thanks|thank you|okay|ok|yeah|yes|no|um|uh|please|can the|step forward|your time|let's move|lets move)\b/i.test(clean)) return false;
  if (!/\b(is|are|was|were|has|have|had|will|would|should|must|need|needs|can|cannot|can't|do|does|did|made|make|means|shows|think|believe|argue|support|oppose|want|choose|cost|pay|protect|target|killed|build|create)\b/i.test(clean)) return false;
  return true;
}

function applyDirectThesisBuilderUpdate(state = {}, selection = {}, latestPoints = [], sideBuiltWindows = [], trace = null) {
  const normalized = normalizeClaimState(state);
  const pointIds = uniqueStrings((latestPoints || []).map((point) => cleanClaimText(point.pointId || point.id || "")).filter(Boolean));
  const range = debateRangeFromTurns(flattenDialogueWindowTurns(sideBuiltWindows));
  const sides = ensureTwoSides(normalized.sides || []).map((side) => {
    const thesis = side.id === BLUE_SIDE_ID ? selection.blueThesis : selection.redThesis;
    if (!thesis) return side;
    const evidence = normalizeDebatePointLedger(latestPoints)
      .filter((point) => normalizeSideId(point.sideId || point.side) === side.id)
      .map((point) => ({ id: point.pointId, claim: point.point, quote: point.quote, sideId: side.id }));
    return {
      ...confirmSideThesis(side, thesis, evidence),
      thesisSource: "thesis_builder"
    };
  });
  const featured = normalizeThesisFeaturedQuote(selection.featuredQuote, trace);
  const update = {
    batchId: `thesis-${stableTextHash(`${range.startSec}:${range.endSec}:${selection.blueThesis || ""}:${selection.redThesis || ""}:${featured?.text || ""}`)}`,
    blueThesis: selection.blueThesis || "",
    redThesis: selection.redThesis || "",
    featuredQuote: featured,
    debateStartSec: range.startSec,
    debateEndSec: range.endSec,
    debateMinute: Number.isFinite(Number(range.endSec)) ? Number((Number(range.endSec) / 60).toFixed(2)) : null,
    pointIds,
    updatedAt: Date.now()
  };
  const existingAnalysis = normalizeDirectAnalysisState(normalized.analysis) || emptyDirectAnalysisState();
  const nextLedger = normalizeThesisUpdateLedger([...thesisUpdateLedgerFromState(normalized), update]);
  return {
    ...normalized,
    sides: dedupeSideThesisLabels({ ...normalized, sides }),
    featuredQuote: featured || normalized.featuredQuote || null,
    featuredQuoteAttemptedAt: Date.now(),
    analysis: {
      ...existingAnalysis,
      updatedAt: Date.now(),
      internal: {
        ...(existingAnalysis.internal || {}),
        thesisUpdates: nextLedger
      }
    }
  };
}

function normalizeThesisFeaturedQuote(quote = null) {
  if (!quote || typeof quote !== "object") return null;
  const text = cleanClaimText(quote.text || quote.quote || "");
  const rawText = cleanClaimText(quote.rawText || quote.sourceText || "");
  if (!text) return null;
  const sideId = normalizeSideId(quote.sideId || quote.side || "");
  return normalizeFeaturedQuoteState({
    id: cleanClaimText(quote.id || `quote-${stableTextHash(`${quote.speakerId || ""}:${text}`)}`),
    speakerId: cleanClaimText(quote.speakerId || "Debate audio"),
    sideId,
    sideColor: sideColorName(sideId),
    text,
    rawText: rawText || undefined,
    atSec: finiteOrUndefined(quote.startSec ?? quote.atSec),
    updatedAt: Date.now(),
    source: "thesis_builder",
    utteranceIds: uniqueStrings(Array.isArray(quote.turnIds) ? quote.turnIds.map(cleanClaimText) : []),
    rawTurnIds: uniqueStrings(Array.isArray(quote.turnIds) ? quote.turnIds.map(cleanClaimText) : [])
  });
}

async function runDirectClaimBuilderAgent({ dialogueWindows = [], debatePoints = [], currentDebate = {}, model = config.fastModel, trace = null } = {}) {
  const context = buildDirectClaimBuilderContext(currentDebate, dialogueWindows, debatePoints);
  if (!context.newDebatePoints.length) {
    logDeterministicStep(trace, "ClaimBuilder:skipped", { reason: "no-new-debate-points" });
    return {};
  }
  const prompt = [
    "You are debatly's Claim Builder.",
    "Your only job is to create Claims tab cards from exact externally source-checkable factual claims found in the Debate Point Builder output.",
    "Use newDebatePoints as your source of truth. They are Debate Points awaiting Claim Builder review; some can be older points that were created when Claim Builder was not scheduled.",
    "Do not use raw transcript windows.",
    "Use the full compact Debate Point ledger and Claim ledger as debate memory so you avoid duplicates and understand the larger debate context.",
    "Do not create moral opinions, debate summaries, questions, concessions, clashes, weak spots, definitions, or policy recommendations unless the wording is an externally checkable fact.",
    "Do not create Claims from ads, sponsor reads, product/service promotion, brand reads, or commercial breaks unless the debate itself is arguing about advertising as a topic.",
    "Every returned card must be suitable for one source check job.",
    "Return strict JSON only.",
    "Schema:",
    "{",
    '  "claims": [{"sourceDebatePointId":"dp-id","speakerId":"Speaker 1","side":"blue|red","role":"claim","claim":"exact checkable factual statement","quote":"exact quote from the same speaker","turnIds":["turn id"],"burden":"what outside source would verify or contradict","claimMode":"speaker_assertion","quoteRole":"owned_statement","topicContinuity":"main_thread|direct_response|sustained_new_topic","ownershipConfidence":0.0,"boundaryConfidence":0.0,"familyHint":"short factual issue hint"}]',
    "}",
    "Rules:",
    "- Inspect only newDebatePoints for claim cards. Use the full compact ledgers for duplicate checks and larger debate context.",
    "- Every claim must include sourceDebatePointId copied exactly from the Debate Point used.",
    "- A claim must name or imply a real-world fact: number, date, event, source, institution, law, study, poll, report, public action, historical event, scientific fact, or measurable condition.",
    "- Do not extract every factual sentence. Output only claims that materially support or damage a side's main case and would make sense as a Claims tab card for a viewer.",
    "- A batch may return zero points. Prefer zero over weak, repeated, background, or merely interesting facts.",
    "- Skip factual asides, setup/background, examples that do not carry the claim, repeated support for an existing card, and details that would not matter in the final analysis.",
    "- If existing claim cards already cover the same factual issue, do not create a new card unless the new claim is materially different and stronger.",
    "- Prefer load-bearing claims with named sources, named institutions, dates, quantities, official actions, court/legal bodies, scientific facts, or specific historical events.",
    "- Use a strict searchability test before returning anything: if the exact claim would probably end as cannot_verify, do not output it.",
    "- It must be possible for an outside source to answer the claim as verified or contradicted. If the best answer would be opinion, legal interpretation, debate interpretation, motive, intent, or moral judgment, return no card.",
    "- Reject hypotheticals and conditionals. Do not turn 'if X happens' or 'could happen' into a factual claim that X happened.",
    "- For legal or normative wording, only output a factual atom such as 'Source X said Y', 'Court X ruled Y', 'Law X requires Y', or 'Report X found Y'.",
    "- Do not reject a definition point just because it is labeled definition. If the speaker asserts a checkable official, legal, dictionary, scientific, or historical meaning of a term or category, rewrite it as one factual claim about that definition.",
    "- For intent or strategy claims, only output them when the speaker ties them to a named source, document, policy, public statement, report, or observable action.",
    "- Preserve attribution exactly from the Debate Point and quote. Do not infer a person, office, institution, or source from nearby context.",
    "- Do not output claims whose main meaning is 'this proves', 'this shows', 'this is moral', 'this is genocide', 'this is murder', 'this is safe', 'this is legal', or 'this is justified' unless rewritten as a concrete externally checkable fact.",
    "- If a sentence contains several facts, output only the strongest single factual atom, not a compound claim.",
    "- If a quote mixes a broad accusation with factual support, output the factual support only. Do not output the accusation itself.",
    "- Write the claim as a complete standalone factual sentence, not a headline about what the speaker did.",
    "- Reject cards whose claim is mainly an inference such as 'this implies', 'this shows', 'this proves', or 'this is evidence of'. Extract only the underlying factual atom if it is important.",
    "- Good: 'Twenty-four to twenty-six weeks is a common fetal viability range.'",
    "- Bad: 'The speaker questions viability.'",
    "- Reject pure moral claims such as 'abortion is murder' unless the quote also contains a checkable factual premise.",
    "- Reject vague claims using this, that, it, they, the plan, or the policy unless you can resolve the specific named subject from the same speaker/context.",
    "- Do not output duplicates of existing claim cards.",
    "- Include sourceDebatePointId from the debate point you used.",
    "- Include enough names, places, dates, quantities, source names, legal bodies, policy names, or event names for a search query to work.",
    "- Do not pad the list and do not use fixed quotas.",
    "- Use only Blue side and Red side in prose.",
    `Routed context for Claim Builder: ${stringifyAgentContext(context)}`
  ].join("\n");
  const response = await generateContentForAgent({
    trace,
    agent: "Claim Builder",
    model,
    contents: prompt,
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 3500,
      httpOptions: { timeout: 30000 }
    },
    meta: {
      windows: context.dialogueWindows.length,
      existingClaims: context.existingClaims.length,
      newDebatePoints: context.newDebatePoints.length,
      debatePointLedger: context.existingDebatePointLedger.length
    }
  });
  return parseJsonWithLocalRepair(response.text || "{}");
}

function buildDirectClaimBuilderContext(state = {}, dialogueWindows = [], debatePoints = []) {
  const normalized = normalizeClaimState(state);
  const existingDebatePointLedger = debatePointLedgerFromState(normalized);
  const newDebatePoints = normalizeDebatePointLedger(debatePoints);
  return {
    agent: "Claim Builder",
    receives: ["debate points awaiting claim review", "full compact debate point ledger", "full compact claim ledger"],
    excludes: ["clashes", "inconsistencies", "scores", "report"],
    topic: normalized.topic || "",
    sides: ensureTwoSides(normalized.sides || []).map((side) => ({
      side: sideColorName(side.id),
      position: confirmedSideLabel(side) || side.workingThesis || "",
      speakerIds: side.speakerIds || []
    })),
    speakerSideMap: buildCurrentSpeakerSideMap(normalized).map((entry) => ({
      speakerId: entry.speakerId,
      side: sideColorName(entry.sideId),
      confidence: entry.confidence,
      reason: entry.reason
    })),
    existingClaims: (normalized.artifacts?.claims || []).map((claim) => ({
      id: claim.id,
      pointId: claim.pointId,
      sourceDebatePointId: claim.sourceDebatePointId,
      side: sideColorName(claim.sideId),
      speakerId: claim.speakerId,
      claim: truncatePromptText(claim.claim || "", 320),
      quote: truncatePromptText(claim.quote || "", 220),
      familyHint: claim.familyHint || "",
      startSec: claim.startSec,
      endSec: claim.endSec,
      status: claim.status
    })),
    newDebatePoints: newDebatePoints.map(compactDebatePointForPrompt),
    existingDebatePointLedger: existingDebatePointLedger.map(compactDebatePointForPrompt),
    dialogueWindows: []
  };
}

async function runDirectClashFinderAgent({ dialogueWindows = [], debatePoints = [], currentDebate = {}, model = config.fastModel, trace = null } = {}) {
  const context = buildDirectClashFinderContext(currentDebate, dialogueWindows, debatePoints);
  if (!context.newDebatePoints.length) {
    logDeterministicStep(trace, "ClashFinder:skipped", { reason: "no-new-debate-points" });
    return {};
  }
  const prompt = [
    "You are debatly's Clash Finder.",
    "Find direct disagreements where Blue side and Red side face each other on the same disputed question.",
    "Use newDebatePoints as the only source for new or changed clashes. They are Debate Points awaiting Clash Finder review; some can be older points that were created when Clash Finder was not scheduled.",
    "Use the full compact debatePointLedger and existingClashes as debate memory.",
    "Use the tiny transcript window only to understand direct exchange flow, never as a source for positions not in the Debate Point ledger.",
    "Do not create clashes directly from raw transcript unless both sides' points are represented in the debate point ledger.",
    "Do not use Claim Builder cards as required input.",
    "Plain language only. No debate jargon.",
    "Return strict JSON only.",
    "Schema:",
    "{",
    '  "clashes": [{"proposition":"plain disputed question","bluePosition":"Blue side position","redPosition":"Red side position","blueSpeakerId":"Speaker 1","redSpeakerId":"Speaker 2","blueQuote":"best exact Blue side quote","redQuote":"best exact Red side quote","blueSupportingQuotes":["exact Blue side point quotes"],"redSupportingQuotes":["exact Red side point quotes"],"blueChallengeQuotes":["exact Blue side challenge/question quotes"],"redChallengeQuotes":["exact Red side challenge/question quotes"],"blueResponseQuotes":["exact Blue side answer quotes"],"redResponseQuotes":["exact Red side answer quotes"],"verdict":"blue_stronger|red_stronger|no_clear_edge|developing","reason":"one short plain-language reason","turnIds":["turn id"]}]',
    "}",
    "Rules:",
    "- Inspect only newDebatePoints for this review pass. If newDebatePoints is empty, return zero clashes.",
    "- At least one side of every returned clash must come from newDebatePoints.",
    "- Use debatePointLedger only to find the opposing side's prior position or avoid duplicates.",
    "- A clash means both sides have a real point on the same disputed question.",
    "- Create a clash only if one side answers, attacks, denies, narrows, or counters the other side's point on that same question.",
    "- The Blue side and Red side positions must come from debatePointLedger items, not from loose transcript summaries.",
    "- Never create a clash between two speakers on the same side.",
    "- Never use moderator, host, interviewer, or floor-management questions as Blue side or Red side positions.",
    "- A question can be a challenge quote, but not the whole position unless the speaker also states the position clearly.",
    "- Do not use a broad opening thesis as the answer to a later specific allegation unless the quote directly answers that allegation.",
    "- Do not pair a specific point with a general talking point. If the second side does not answer the same question, return no clash or developing.",
    "- Do not create a clash from two points that merely discuss the same broad topic.",
    "- If an existing clash already covers the same disputed point, return a new clash only when a newDebatePoints item materially changes the outcome or gives a cleaner quote.",
    "- Prefer one stable clash per disputed point. Do not create several versions of the same proposition with slightly different wording.",
    "- If the same clash topic comes up again, keep the same proposition and add new quotes to the matching quote arrays.",
    "- Do not create several clashes that reuse the same broad quote from one side. Treat later examples as more quotes for the existing clash.",
    "- Do not turn every factual example into its own clash if it supports the same broader dispute. Pick the clearest direct clash.",
    "- First decide whether a clash exists. Then separately decide who handled the latest exchange better.",
    "- verdict blue_stronger means Blue side directly weakened Red side's point, or Blue side answered the challenge while Red side did not.",
    "- verdict red_stronger means Red side directly weakened Blue side's point, or Red side answered the challenge while Blue side did not.",
    "- If one side gives a specific challenge and the other side answers with a broad slogan, general denial, or topic shift, the challenger is stronger.",
    "- If one side gives specific evidence and the other side only gives a broad denial, the evidence side is stronger.",
    "- If one side points out a logic problem and the other side repeats the original point without fixing the logic, the side pointing out the logic problem is stronger.",
    "- If an existing clash already has both sides represented and a later point strengthens one side, update the verdict instead of leaving it developing.",
    "- verdict no_clear_edge means both sides answered the same question about equally well, or both were equally weak.",
    "- Do not choose no_clear_edge just because both sides spoke. Choose it only when there is truly no clear better answer after comparing the two answers.",
    "- verdict developing means only one side has a real point so far, or the other side has not had a fair chance to answer in the current exchange.",
    "- Do not keep developing once the other side has had a later chance to respond, ignored the point, or moved on. In that case, give the edge to the side whose point remains unanswered.",
    "- If one side dodges the actual question while the other side answers it, the answering side is stronger.",
    "- If one side only repeats a broad slogan against a specific challenge, the other side is stronger.",
    "- If your reason says the sides are talking about different things, then either return no clash or give the edge to the side that stayed on the disputed question. Do not call it no_clear_edge.",
    "- If both sides are actually agreeing, reinforcing each other, or making the same point, return no clash.",
    "- Red side can answer better. Blue side can answer better. Use both labels when earned.",
    "- Use plain language and exact quotes.",
    `Routed context for Clash Finder: ${stringifyAgentContext(context)}`
  ].join("\n");
  const response = await generateContentForAgent({
    trace,
    agent: "Clash Finder",
    model,
    contents: prompt,
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 3500,
      httpOptions: { timeout: 30000 }
    },
    meta: {
      windows: context.dialogueWindows.length,
      newDebatePoints: context.newDebatePoints.length,
      debatePoints: context.debatePointLedger.length,
      existingClashes: context.existingClashes.length
    }
  });
  return parseJsonWithLocalRepair(response.text || "{}");
}

function buildDirectClashFinderContext(state = {}, dialogueWindows = [], debatePoints = []) {
  const normalized = normalizeClaimState(state);
  const newDebatePoints = normalizeDebatePointLedger(debatePoints);
  const debatePointLedger = debatePointLedgerFromState(normalized);
  return {
    agent: "Clash Finder",
    receives: ["debate points awaiting clash review", "full compact debate point ledger", "full compact clash ledger", "speaker-side map", "tiny exchange window"],
    excludes: ["claim cards as required input", "fact checks", "scores"],
    topic: normalized.topic || "",
    speakerSideMap: buildCurrentSpeakerSideMap(normalized).map((entry) => ({
      speakerId: entry.speakerId,
      side: sideColorName(entry.sideId),
      confidence: entry.confidence
    })),
    existingClashes: (normalized.artifacts?.clashes || []).map((clash) => ({
      id: clash.id,
      proposition: clash.proposition || clash.summary,
      bluePosition: clash.bluePosition || (clash.sideId === BLUE_SIDE_ID ? clash.challengerResponse : clash.originalClaim),
      redPosition: clash.redPosition || (clash.sideId === RED_SIDE_ID ? clash.challengerResponse : clash.originalClaim),
      blueQuotes: compactClashQuotesForPrompt(clash, BLUE_SIDE_ID),
      redQuotes: compactClashQuotesForPrompt(clash, RED_SIDE_ID),
      verdict: clash.verdict || "",
      outcome: clash.outcome || ""
    })),
    newDebatePoints: newDebatePoints.map(compactDebatePointForPrompt),
    debatePointLedger: debatePointLedger.map(compactDebatePointForPrompt),
    dialogueWindows: (dialogueWindows || []).slice(-1).map((window) => ({
      windowId: window.windowId,
      startSec: window.startSec,
      endSec: window.endSec,
      sideColumns: (window.sideColumns || buildSideColumnsForTurns(window.turns || [], normalized)).map((column) => ({
        side: sideColorName(column.sideId),
        speakerIds: column.speakerIds || [],
        text: truncatePromptText(column.text || "", 520),
        turnIds: column.turnIds || []
      })),
      turns: (window.turns || []).map((turn) => ({
        id: turn.id,
        speakerId: turn.speakerId,
        side: sideColorName(turnOwnerSideFromState(normalized, turn)),
        text: truncatePromptText(turn.text || "", 220),
        startSec: turn.startSec,
        endSec: turn.endSec
      }))
    }))
  };
}

function compactClashQuotesForPrompt(clash = {}, sideId = "") {
  const normalizedSideId = normalizeSideId(sideId);
  const quoteFields = normalizedSideId === BLUE_SIDE_ID
    ? [clash.blueQuote, clash.blueSupportingQuotes, clash.blueChallengeQuotes, clash.blueResponseQuotes]
    : [clash.redQuote, clash.redSupportingQuotes, clash.redChallengeQuotes, clash.redResponseQuotes];
  return cleanClashQuoteArray(quoteFields.flat()).slice(-5);
}

function normalizeDirectClashArtifacts(items = [], state = {}, newDebatePoints = []) {
  const normalized = normalizeClaimState(state);
  const latestPoints = normalizeDebatePointLedger(newDebatePoints);
  const debatePointLedger = debatePointLedgerFromState(normalized);
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const proposition = cleanAgentDisplayText(item?.proposition || item?.summary || "");
      const blueSpeakerId = cleanClaimText(item?.blueSpeakerId || "");
      const redSpeakerId = cleanClaimText(item?.redSpeakerId || "");
      const blueSide = speakerSideFromState(normalized, blueSpeakerId);
      const redSide = speakerSideFromState(normalized, redSpeakerId);
      if (!proposition || !blueSpeakerId || !redSpeakerId) return null;
      if (blueSide && blueSide !== BLUE_SIDE_ID) return null;
      if (redSide && redSide !== RED_SIDE_ID) return null;
      if (blueSpeakerId === redSpeakerId) return null;
      if (isModeratorSideAssignment({ speakerId: blueSpeakerId, evidenceQuote: item?.blueQuote || "", state: normalized })) return null;
      if (isModeratorSideAssignment({ speakerId: redSpeakerId, evidenceQuote: item?.redQuote || "", state: normalized })) return null;
      let verdict = normalizeDirectClashVerdict(item?.exchangeResult || item?.verdict || item?.result || item?.outcome || "");
      const turnIds = uniqueStrings(item?.turnIds || []);
      const bluePosition = cleanAgentDisplayText(item?.bluePosition || "");
      const redPosition = cleanAgentDisplayText(item?.redPosition || "");
      const blueQuote = cleanClaimText(item?.blueQuote || "");
      const redQuote = cleanClaimText(item?.redQuote || "");
      if (!blueQuote || !redQuote) return null;
      const bluePoint = findDebatePointForClashSide(debatePointLedger, {
        speakerId: blueSpeakerId,
        sideId: BLUE_SIDE_ID,
        quote: blueQuote,
        position: bluePosition,
        proposition
      });
      const redPoint = findDebatePointForClashSide(debatePointLedger, {
        speakerId: redSpeakerId,
        sideId: RED_SIDE_ID,
        quote: redQuote,
        position: redPosition,
        proposition
      });
      if (!bluePoint || !redPoint) return null;
      if (latestPoints.length && !isClashAnchoredToLatestDebatePoint({ blueSpeakerId, redSpeakerId, blueQuote, redQuote, proposition }, latestPoints)) {
        return null;
      }
      const summary = cleanAgentDisplayText(item?.reason || item?.summary || proposition);
      if (isInvalidDirectClashSummary(summary)) return null;
      verdict = tightenDirectClashVerdict(verdict, summary);
      if ((verdict === "blue_stronger" || verdict === "red_stronger") && isWeakResolvedClashEvidence({ blueQuote, redQuote, summary })) {
        verdict = "no_clear_edge";
      }
      const blueSupportingQuotes = cleanClashQuoteArray([item?.blueSupportingQuotes, item?.blueQuotes, blueQuote].flat());
      const redSupportingQuotes = cleanClashQuoteArray([item?.redSupportingQuotes, item?.redQuotes, redQuote].flat());
      const blueChallengeQuotes = cleanClashQuoteArray([item?.blueChallengeQuotes, item?.blueChallenges].flat());
      const redChallengeQuotes = cleanClashQuoteArray([item?.redChallengeQuotes, item?.redChallenges].flat());
      const blueResponseQuotes = cleanClashQuoteArray([item?.blueResponseQuotes, item?.blueResponses].flat());
      const redResponseQuotes = cleanClashQuoteArray([item?.redResponseQuotes, item?.redResponses].flat());
      const winnerSideId = verdict === "blue_stronger" ? BLUE_SIDE_ID : verdict === "red_stronger" ? RED_SIDE_ID : "";
      const id = `clash-${stableTextHash(`${proposition}:${blueQuote}:${redQuote}`)}`;
      return {
        id,
        fromPointId: bluePoint.pointId,
        toPointId: redPoint.pointId,
        speakerId: winnerSideId === RED_SIDE_ID ? redSpeakerId : blueSpeakerId,
        targetSpeakerId: winnerSideId === RED_SIDE_ID ? blueSpeakerId : redSpeakerId,
        sideId: winnerSideId || BLUE_SIDE_ID,
        originalClaim: winnerSideId === RED_SIDE_ID ? bluePosition || blueQuote : redPosition || redQuote,
        challengerResponse: winnerSideId === RED_SIDE_ID ? redPosition || redQuote : bluePosition || blueQuote,
        sourceQuote: winnerSideId === RED_SIDE_ID ? redQuote : blueQuote,
        targetQuote: winnerSideId === RED_SIDE_ID ? blueQuote : redQuote,
        outcome: verdict === "blue_stronger" || verdict === "red_stronger" ? "claim_weakened" : verdict === "no_clear_edge" ? "answered" : "needs_more_context",
        strength: verdict === "blue_stronger" || verdict === "red_stronger" ? 0.82 : verdict === "no_clear_edge" ? 0.5 : 0.35,
        summary,
        proposition,
        bluePosition: bluePosition || blueQuote,
        redPosition: redPosition || redQuote,
        blueSpeakerId,
        redSpeakerId,
        blueQuote,
        redQuote,
        blueSupportingQuotes,
        redSupportingQuotes,
        blueChallengeQuotes,
        redChallengeQuotes,
        blueResponseQuotes,
        redResponseQuotes,
        exchangeResult: verdict,
        verdict,
        turnIds,
        at: Date.now(),
        startSec: finiteMin([item?.startSec, ...turnIds.flatMap((turnId) => turnTimeRangeForId(normalized, turnId).startSec)]),
        endSec: finiteMax([item?.endSec, ...turnIds.flatMap((turnId) => turnTimeRangeForId(normalized, turnId).endSec)])
      };
    })
    .filter(Boolean);
}

function cleanClashQuoteArray(values = []) {
  const raw = Array.isArray(values) ? values : [values];
  return uniqueStrings(raw
    .flat(Infinity)
    .map((value) => cleanClaimText(value || ""))
    .filter((value) => value && wordCount(value) >= 3))
    .slice(-10);
}

function findDebatePointForClashSide(debatePointLedger = [], { speakerId = "", sideId = "", quote = "", position = "", proposition = "" } = {}) {
  const normalizedSideId = normalizeSideId(sideId);
  const candidates = (debatePointLedger || []).filter((point) => (
    point.speakerId === speakerId
    && normalizeSideId(point.sideId) === normalizedSideId
  ));
  if (!candidates.length) return null;
  const scored = candidates
    .map((point) => {
      const quoteScore = textSupportScore(quote, point.quote || "");
      const positionScore = tokenOverlapRatio(normalizeTranscript(position || ""), normalizeTranscript(point.point || ""));
      const propositionScore = tokenOverlapRatio(normalizeTranscript(proposition || ""), normalizeTranscript(point.point || ""));
      return { point, score: Math.max(quoteScore, positionScore, propositionScore) };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 0.35 ? scored[0].point : null;
}

function isClashAnchoredToLatestDebatePoint(clash = {}, latestPoints = []) {
  return (latestPoints || []).some((point) => {
    if (!point?.speakerId) return false;
    const quote = point.speakerId === clash.blueSpeakerId ? clash.blueQuote : point.speakerId === clash.redSpeakerId ? clash.redQuote : "";
    if (!quote) return false;
    return textSupportScore(quote, point.quote || "") >= 0.35
      || tokenOverlapRatio(normalizeTranscript(clash.proposition || ""), normalizeTranscript(point.point || "")) >= 0.55;
  });
}

function normalizeDirectClashVerdict(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["blue_stronger", "blue_won", "blue_answered_better"].includes(raw)) return "blue_stronger";
  if (["red_stronger", "red_won", "red_answered_better"].includes(raw)) return "red_stronger";
  if (["no_clear_edge", "answered"].includes(raw)) return "no_clear_edge";
  return "developing";
}

function isInvalidDirectClashSummary(summary = "") {
  const text = normalizeTranscript(summary || "");
  if (!text) return false;
  return /\b(reinforcing each other|reinforce each other|same point|same core requirement|point of agreement|essentially agree|in agreement|actually agreeing|both sides agree|substantively aligned|no fundamental disagreement|not a fundamental disagreement|not in direct disagreement|not clashing|not actually clashing|not a clash|talking about different things|talking past each other|debating different aspects|different aspects of the|complementary aspects|complementary factors|valid but distinct factors|without one directly refuting the other|without directly invalidating the other)\b/.test(text);
}

function tightenDirectClashVerdict(verdict = "", summary = "") {
  const normalizedVerdict = normalizeDirectClashVerdict(verdict);
  const text = normalizeTranscript(summary || "");
  const summaryEdge = directClashSummaryEdge(text);
  if (summaryEdge) return summaryEdge;
  if (normalizedVerdict === "blue_stronger" || normalizedVerdict === "red_stronger") return normalizedVerdict;
  if (!text) return normalizedVerdict;
  if (/\bblue side\b/.test(text) && /\bred side\b/.test(text)) {
    if (/\bblue side\b.*\b(directly challenges|directly challenged|specific challenge|specific evidence|specific legal|specific example|specific counter|identifies a specific|provided a direct|provided specific|answered the challenge)\b.*\bred side\b.*\b(failed to|has not|hasn't|did not|does not|without|simply denies|only gives|only gave|broad denial|general denial|dismisses without|not addressed|not yet addressed|has not yet addressed)\b/.test(text)) {
      return "blue_stronger";
    }
    if (/\bred side\b.*\b(directly challenges|directly challenged|specific challenge|specific evidence|specific legal|specific example|specific counter|identifies a specific|provided a direct|provided specific|answered the challenge)\b.*\bblue side\b.*\b(failed to|has not|hasn't|did not|does not|without|simply denies|only gives|only gave|broad denial|general denial|dismisses without|not addressed|not yet addressed|has not yet addressed)\b/.test(text)) {
      return "red_stronger";
    }
  }
  if (/\bred side\b.*\b(has not|hasn't|failed to|did not|does not|not yet)\b.*\b(answer|address|respond|engage|refute)\b/.test(text)) return "blue_stronger";
  if (/\bblue side\b.*\b(has not|hasn't|failed to|did not|does not|not yet)\b.*\b(answer|address|respond|engage|refute)\b/.test(text)) return "red_stronger";
  return normalizedVerdict;
}

function directClashSummaryEdge(text = "") {
  if (!text) return "";
  if (summarySaysSideOutperformed(text, "blue", "red")) return "blue_stronger";
  if (summarySaysSideOutperformed(text, "red", "blue")) return "red_stronger";
  return "";
}

function summarySaysSideOutperformed(text = "", strongSide = "", weakSide = "") {
  const strong = strongSide === "blue" ? "(?:blue side|blue)" : "(?:red side|red)";
  const weak = weakSide === "blue" ? "(?:blue side|blue)" : "(?:red side|red)";
  const strongAction = "(?:directly challenges?|directly challenged|specific challenge|specific evidence|specific legal|specific example|specific counter|provides?|provided|presents?|presented|cites?|cited|introduced|introduces|raises?|raised|identifies?|identified|highlights?|highlighted|points? out|pointed out|clarified|answers?|answered)";
  const weakAction = "(?:failed to|fails to|has not|hasn't|did not|does not|not yet|without directly|without addressing|only gives|only gave|broad denial|general denial|general appeal|simply denies|merely stated|dismisses without|dodges?|dodged|deflects?|deflected|repeats?|repeated|failed to engage|failing to directly)";
  const strongFirst = new RegExp(`\\b${strong}\\b.{0,180}${strongAction}.{0,240}\\b${weak}\\b.{0,220}${weakAction}\\b`);
  const weakFirst = new RegExp(`\\b${weak}\\b.{0,220}${weakAction}.{0,240}\\b${strong}\\b.{0,180}${strongAction}\\b`);
  return strongFirst.test(text) || weakFirst.test(text);
}

function normalizeInconsistencyLevel(value = "") {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return raw === "side" || raw === "side_level" ? "side" : "speaker";
}

function isWeakResolvedClashEvidence({ blueQuote = "", redQuote = "", summary = "" } = {}) {
  const text = normalizeTranscript(`${blueQuote} ${redQuote} ${summary}`);
  if (/\b(implied|implicitly|position is implied|suggested through a question|only asked|just asked)\b/.test(text)) return true;
  return false;
}

function isQuestionLikeUtterance(text = "") {
  const raw = cleanClaimText(text || "");
  if (!raw) return false;
  if (raw.includes("?")) return true;
  return /^(who|what|when|where|why|how|do|does|did|is|are|can|could|would|should)\b/i.test(raw);
}

function mergeDirectClashArtifacts(state = {}, incoming = []) {
  const artifacts = normalizeArtifacts(state.artifacts || {});
  const merged = new Map((artifacts.clashes || []).map((item) => [item.id, item]));
  for (const clash of incoming || []) {
    if (!clash?.id) continue;
    const existingSimilar = findSimilarDirectClash([...merged.values()], clash);
    const mergeId = existingSimilar?.id || clash.id;
    const existing = merged.get(mergeId);
    merged.set(mergeId, mergeDirectClashArtifact(existing, clash, mergeId));
  }
  return {
    ...state,
    artifacts: {
      ...artifacts,
      clashes: dedupeDirectClashArtifacts([...merged.values()]).sort((a, b) => artifactTimeValue(a) - artifactTimeValue(b)).slice(-80)
    }
  };
}

function dedupeDirectClashArtifacts(clashes = []) {
  const output = [];
  for (const clash of clashes || []) {
    if (!clash?.id) continue;
    if (isInvalidDirectClashSummary(clash.summary || clash.reason || clash.proposition || "")) continue;
    const index = output.findIndex((existing) => areDirectClashesSameIssue(existing, clash));
    if (index >= 0) {
      output[index] = mergeDirectClashArtifact(output[index], clash, output[index].id);
    } else {
      output.push(clash);
    }
  }
  return output;
}

function mergeDirectClashArtifact(existing = null, incoming = {}, id = "") {
  if (!existing) return normalizeMergedClashQuoteFields({ ...incoming, id });
  const useIncomingJudgement = directClashRank(incoming) >= directClashRank(existing);
  const judgement = useIncomingJudgement ? incoming : existing;
  const blueSupportingQuotes = mergeClashQuoteFields(existing, incoming, "blueSupportingQuotes", "blueQuote");
  const redSupportingQuotes = mergeClashQuoteFields(existing, incoming, "redSupportingQuotes", "redQuote");
  const blueChallengeQuotes = mergeClashQuoteFields(existing, incoming, "blueChallengeQuotes");
  const redChallengeQuotes = mergeClashQuoteFields(existing, incoming, "redChallengeQuotes");
  const blueResponseQuotes = mergeClashQuoteFields(existing, incoming, "blueResponseQuotes");
  const redResponseQuotes = mergeClashQuoteFields(existing, incoming, "redResponseQuotes");
  const nextVerdict = normalizeDirectClashVerdict(judgement.exchangeResult || judgement.verdict || judgement.outcome || "");
  const merged = {
    ...existing,
    id,
    exchangeResult: nextVerdict,
    verdict: nextVerdict,
    outcome: judgement.outcome || existing.outcome,
    strength: Number.isFinite(Number(judgement.strength)) ? Number(judgement.strength) : existing.strength,
    sideId: normalizeSideId(judgement.sideId) || existing.sideId,
    speakerId: cleanClaimText(judgement.speakerId || existing.speakerId || ""),
    targetSpeakerId: cleanClaimText(judgement.targetSpeakerId || existing.targetSpeakerId || ""),
    blueSupportingQuotes,
    redSupportingQuotes,
    blueChallengeQuotes,
    redChallengeQuotes,
    blueResponseQuotes,
    redResponseQuotes,
    proposition: cleanAgentDisplayText(existing.proposition || incoming.proposition || ""),
    bluePosition: cleanAgentDisplayText(existing.bluePosition || incoming.bluePosition || ""),
    redPosition: cleanAgentDisplayText(existing.redPosition || incoming.redPosition || ""),
    blueSpeakerId: cleanClaimText(existing.blueSpeakerId || incoming.blueSpeakerId || ""),
    redSpeakerId: cleanClaimText(existing.redSpeakerId || incoming.redSpeakerId || ""),
    blueQuote: cleanClaimText(existing.blueQuote || "") || blueSupportingQuotes[0] || "",
    redQuote: cleanClaimText(existing.redQuote || "") || redSupportingQuotes[0] || "",
    originalClaim: cleanAgentDisplayText(existing.originalClaim || incoming.originalClaim || ""),
    challengerResponse: cleanAgentDisplayText(existing.challengerResponse || incoming.challengerResponse || ""),
    sourceQuote: cleanClaimText(existing.sourceQuote || incoming.sourceQuote || ""),
    targetQuote: cleanClaimText(existing.targetQuote || incoming.targetQuote || ""),
    summary: cleanAgentDisplayText(existing.summary || incoming.summary || ""),
    reason: cleanAgentDisplayText(existing.reason || existing.summary || incoming.reason || incoming.summary || ""),
    turnIds: uniqueStrings([...(existing.turnIds || []), ...(incoming.turnIds || [])]).slice(-20),
    startSec: finiteMin([existing.startSec, incoming.startSec]),
    endSec: finiteMax([existing.endSec, incoming.endSec]),
    at: existing.at || incoming.at || Date.now(),
    updatedAt: Date.now()
  };
  return normalizeMergedClashQuoteFields(merged);
}

function mergeClashQuoteFields(existing = {}, incoming = {}, arrayField = "", singleField = "") {
  return cleanClashQuoteArray([
    existing?.[arrayField],
    incoming?.[arrayField],
    singleField ? existing?.[singleField] : "",
    singleField ? incoming?.[singleField] : ""
  ].flat()).slice(-12);
}

function normalizeMergedClashQuoteFields(clash = {}) {
  return {
    ...clash,
    blueSupportingQuotes: cleanClashQuoteArray([clash.blueSupportingQuotes, clash.blueQuote].flat()).slice(-12),
    redSupportingQuotes: cleanClashQuoteArray([clash.redSupportingQuotes, clash.redQuote].flat()).slice(-12),
    blueChallengeQuotes: cleanClashQuoteArray(clash.blueChallengeQuotes || []).slice(-12),
    redChallengeQuotes: cleanClashQuoteArray(clash.redChallengeQuotes || []).slice(-12),
    blueResponseQuotes: cleanClashQuoteArray(clash.blueResponseQuotes || []).slice(-12),
    redResponseQuotes: cleanClashQuoteArray(clash.redResponseQuotes || []).slice(-12)
  };
}

function directClashRank(clash = {}) {
  if (clash.verdict === "blue_stronger" || clash.verdict === "red_stronger") return 3;
  if (clash.verdict === "no_clear_edge") return 2;
  return 1;
}

function findSimilarDirectClash(existingClashes = [], incoming = {}) {
  return (existingClashes || []).find((existing) => areDirectClashesSameIssue(existing, incoming));
}

function areDirectClashesSameIssue(a = {}, b = {}) {
  const aProp = normalizeTranscript(a.proposition || a.summary || "");
  const bProp = normalizeTranscript(b.proposition || b.summary || "");
  if (!aProp || !bProp) return false;
  if (aProp === bProp || aProp.includes(bProp) || bProp.includes(aProp)) return true;
  const propOverlap = tokenOverlapRatio(aProp, bProp);
  if (propOverlap >= 0.78) return true;
  const sameBlueAnchor = textSupportScore(a.blueQuote || "", b.blueQuote || "") >= 0.72;
  const sameRedAnchor = textSupportScore(a.redQuote || "", b.redQuote || "") >= 0.72;
  const sameVerdict = normalizeDirectClashVerdict(a.verdict || a.outcome || "") === normalizeDirectClashVerdict(b.verdict || b.outcome || "");
  if ((sameBlueAnchor || sameRedAnchor) && (sameVerdict || propOverlap >= 0.45)) return true;
  const aKey = directClaimKey(aProp);
  const bKey = directClaimKey(bProp);
  if (aKey && bKey && tokenOverlapRatio(aKey, bKey) >= 0.82) return true;
  const sameSpeakers = cleanClaimText(a.blueSpeakerId || "") === cleanClaimText(b.blueSpeakerId || "")
    && cleanClaimText(a.redSpeakerId || "") === cleanClaimText(b.redSpeakerId || "");
  return sameSpeakers && propOverlap >= 0.68;
}

async function runDirectInconsistencyFinderAgent({ dialogueWindows = [], debatePoints = [], currentDebate = {}, model = config.fastModel, trace = null } = {}) {
  const context = buildDirectInconsistencyContext(currentDebate, dialogueWindows, debatePoints);
  if (!context.newDebatePoints.length) {
    logDeterministicStep(trace, "InconsistencyFinder:skipped", { reason: "no-new-debate-points" });
    return {};
  }
  const prompt = [
    "You are debatly's Inconsistency Finder.",
    "Find clear speaker-level or side-level contradictions, changed definitions, changed burdens, or double standards.",
    "Use newDebatePoints as the only source for new or changed inconsistencies. They are Debate Points awaiting Inconsistency Finder review; some can be older points that were created when Inconsistency Finder was not scheduled.",
    "Use the full compact debatePointLedger and existingInconsistencies as debate memory.",
    "Do not use raw transcript windows; Debate Points already contain quote, speaker, side, and timestamp.",
    "Do not make a separate tab. Return only confirmed candidates strong enough to become possible negative Key Moments.",
    "Return strict JSON only.",
    "Schema:",
    "{",
    '  "inconsistencies": [{"side":"blue|red","level":"speaker|side","speakerId":"Speaker 1","title":"plain title","summary":"why the two quotes conflict","firstQuote":"exact quote","secondQuote":"exact quote","standardA":"first rule/claim","standardB":"conflicting rule/claim","turnIds":["turn id"]}]',
    "}",
    "Rules:",
    "- Inspect only newDebatePoints for this review pass. If newDebatePoints is empty, return zero inconsistencies.",
    "- At least one of the two conflicting positions must come from newDebatePoints.",
    "- Use debatePointLedger only to find the older same-speaker or same-side position it conflicts with.",
    "- Be rare. Most batches should return zero inconsistencies.",
    "- Require two owned debate points from the same speaker or same side.",
    "- For speaker-level inconsistency, both quotes must be from the same speaker.",
    "- For side-level inconsistency, both quotes must be from the same side and must express incompatible standards, not just different emphasis.",
    "- The two conflicting positions must be represented in debatePointLedger.",
    "- The two quotes must not both be able to be true under the same meaning. If they can coexist, return no card.",
    "- Good: the same speaker first says X is required, then later says X is not required.",
    "- Good: a side uses one rule for its own side and the opposite rule for the other side on the same issue.",
    "- Bad: one side disagrees with the other side. That is a clash, not an inconsistency.",
    "- Bad: a speaker clarifies, narrows, adds nuance, gives another example, asks a question, or changes topic.",
    "- Bad: a factual claim is contradicted by outside sources. That belongs to fact checking, not inconsistency.",
    "- Do not use partial sentences, interruptions, or questions as either quote.",
    "- For side-level inconsistency, require two clear same-side assertions that conflict. Do not flag teammates merely adding detail or correcting wording.",
    "- Do not flag normal nuance, clarification, or changing topic.",
    "- Track side-level inconsistency even if Speechmatics speaker labels split the same side across speakers.",
    "- Use exact quotes and plain language.",
    "- Do not output low-confidence or merely neutral observations.",
    `Routed context for Inconsistency Finder: ${stringifyAgentContext(context)}`
  ].join("\n");
  const response = await generateContentForAgent({
    trace,
    agent: "Inconsistency Finder",
    model,
    contents: prompt,
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 3500,
      httpOptions: { timeout: 30000 }
    },
    meta: {
      windows: context.dialogueWindows.length,
      newDebatePoints: context.newDebatePoints.length,
      debatePoints: context.debatePointLedger.length,
      existingInconsistencies: context.existingInconsistencies.length
    }
  });
  return parseJsonWithLocalRepair(response.text || "{}");
}

function buildDirectInconsistencyContext(state = {}, dialogueWindows = [], debatePoints = []) {
  const normalized = normalizeClaimState(state);
  const newDebatePoints = normalizeDebatePointLedger(debatePoints);
  const debatePointLedger = debatePointLedgerFromState(normalized);
  return {
    agent: "Inconsistency Finder",
    receives: ["debate points awaiting inconsistency review", "full compact debate point ledger", "full compact inconsistency ledger", "speaker-side map"],
    excludes: ["scores", "report", "source checks as required input"],
    topic: normalized.topic || "",
    speakerSideMap: buildCurrentSpeakerSideMap(normalized).map((entry) => ({
      speakerId: entry.speakerId,
      side: sideColorName(entry.sideId),
      confidence: entry.confidence
    })),
    existingInconsistencies: (normalized.artifacts?.inconsistencies || []).map((item) => ({
      id: item.id,
      side: sideColorName(item.accusedSideId || item.sideId),
      speakerId: item.speakerId,
      summary: item.summary,
      quoteA: item.quoteA,
      quoteB: item.quoteB
    })),
    newDebatePoints: newDebatePoints.map(compactDebatePointForPrompt),
    debatePointLedger: debatePointLedger.map(compactDebatePointForPrompt),
    dialogueWindows: []
  };
}

function normalizeDirectInconsistencyArtifacts(items = [], state = {}, newDebatePoints = []) {
  const normalized = normalizeClaimState(state);
  const latestPoints = normalizeDebatePointLedger(newDebatePoints);
  const debatePointLedger = debatePointLedgerFromState(normalized);
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const sideId = normalizeAgentSideId(item);
      const level = normalizeInconsistencyLevel(item?.level || (item?.speakerId ? "speaker" : "side"));
      const speakerId = cleanClaimText(item?.speakerId || "");
      const firstQuote = cleanClaimText(item?.firstQuote || item?.quoteA || "");
      const secondQuote = cleanClaimText(item?.secondQuote || item?.quoteB || "");
      const summary = cleanAgentDisplayText(item?.summary || "");
      const standardA = cleanAgentDisplayText(item?.standardA || "First claim or standard");
      const standardB = cleanAgentDisplayText(item?.standardB || "Conflicting claim or standard");
      if (!sideId || !firstQuote || !secondQuote || !summary) return null;
      if (level === "speaker" && !speakerId) return null;
      if (speakerId && speakerSideFromState(normalized, speakerId) && speakerSideFromState(normalized, speakerId) !== sideId) return null;
      if (speakerId && isModeratorSideAssignment({ speakerId, evidenceQuote: `${firstQuote} ${secondQuote}`, state: normalized })) return null;
      if (!areInconsistencyQuotesOwnedByDebateLedger({ sideId, speakerId, firstQuote, secondQuote }, debatePointLedger)) return null;
      if (latestPoints.length && !isInconsistencyAnchoredToLatestDebatePoint({ speakerId, sideId, firstQuote, secondQuote, standardA, standardB }, latestPoints)) return null;
      if (!isStrongDirectInconsistencyCandidate({ summary, firstQuote, secondQuote, standardA, standardB })) return null;
      const id = `inconsistency-${stableTextHash(`${sideId}:${speakerId}:${firstQuote}:${secondQuote}`)}`;
      const turnIds = uniqueStrings(item?.turnIds || []);
      return {
        id,
        speakerId,
        speakerIds: uniqueStrings([speakerId].filter(Boolean)),
        level,
        sideId,
        accusedSideId: sideId,
        title: cleanAgentDisplayText(item?.title || "Inconsistency"),
        headline: cleanAgentDisplayText(item?.title || "Inconsistency"),
        summary,
        reason: summary,
        severity: "high",
        standardA,
        standardB,
        quoteA: firstQuote,
        quoteB: secondQuote,
        firstQuote,
        secondQuote,
        pointIds: [],
        status: "confirmed",
        turnIds,
        at: Date.now(),
        startSec: finiteMin([item?.startSec, ...turnIds.flatMap((turnId) => turnTimeRangeForId(normalized, turnId).startSec)]),
        endSec: finiteMax([item?.endSec, ...turnIds.flatMap((turnId) => turnTimeRangeForId(normalized, turnId).endSec)])
      };
    })
    .filter(Boolean);
}

function areInconsistencyQuotesOwnedByDebateLedger(item = {}, debatePointLedger = []) {
  const matchesOwnedPoint = (quote = "") => (debatePointLedger || []).some((point) => {
    if (normalizeSideId(point.sideId) !== normalizeSideId(item.sideId)) return false;
    if (item.speakerId && point.speakerId !== item.speakerId) return false;
    return textSupportScore(quote, point.quote || "") >= 0.35;
  });
  return matchesOwnedPoint(item.firstQuote || "") && matchesOwnedPoint(item.secondQuote || "");
}

function isInconsistencyAnchoredToLatestDebatePoint(item = {}, latestPoints = []) {
  return (latestPoints || []).some((point) => {
    if (normalizeSideId(point.sideId) !== normalizeSideId(item.sideId)) return false;
    if (item.speakerId && point.speakerId !== item.speakerId) return false;
    return textSupportScore(item.firstQuote || "", point.quote || "") >= 0.35
      || textSupportScore(item.secondQuote || "", point.quote || "") >= 0.35
      || tokenOverlapRatio(normalizeTranscript(`${item.standardA || ""} ${item.standardB || ""}`), normalizeTranscript(point.point || "")) >= 0.55;
  });
}

function isStrongDirectInconsistencyCandidate(item = {}) {
  const summary = normalizeTranscript(item.summary || "");
  const firstQuote = cleanClaimText(item.firstQuote || "");
  const secondQuote = cleanClaimText(item.secondQuote || "");
  const standards = normalizeTranscript(`${item.standardA || ""} ${item.standardB || ""}`);
  if (wordCount(firstQuote) < 5 || wordCount(secondQuote) < 5) return false;
  if (/[?]\s*$/.test(firstQuote) || /[?]\s*$/.test(secondQuote)) return false;
  if (/\b(that'?s false|that is false|not true|false\.|false,)\b/i.test(firstQuote) || /\b(that'?s false|that is false|not true|false\.|false,)\b/i.test(secondQuote)) return false;
  if (/^(what|why|how|when|where|who|are|is|do|does|did|can|could|would|should)\b/i.test(firstQuote)) return false;
  if (/^(what|why|how|when|where|who|are|is|do|does|did|can|could|would|should)\b/i.test(secondQuote)) return false;
  if (/\b(could be seen|could be considered|seems|suggests|suggesting|implicitly|implies|may imply|might imply|under certain|not explicitly|appears to|normal nuance|clarif|not mutually exclusive|different levels of detail|more comprehensive)\b/.test(summary)) return false;
  if (/\b(disagrees?|challenges?|questions?|asks?|responds?|pushes back)\b/.test(summary) && !/\b(contradict|conflict|opposite|double standard|changed definition|changed burden)\b/.test(summary)) return false;
  const directConflict = /\b(contradict|conflict|inconsistent|opposite|mutually exclusive|double standard|changed definition|changed burden|first says|then says|later says|but later|one rule|opposite rule)\b/.test(`${summary} ${standards}`);
  if (!directConflict) return false;
  return true;
}

function mergeDirectInconsistencyArtifacts(state = {}, incoming = []) {
  const artifacts = normalizeArtifacts(state.artifacts || {});
  const merged = new Map((artifacts.inconsistencies || []).map((item) => [item.id, item]));
  for (const item of incoming || []) {
    if (!item?.id) continue;
    merged.set(item.id, { ...(merged.get(item.id) || {}), ...item, at: Date.now() });
  }
  return {
    ...state,
    artifacts: {
      ...artifacts,
      inconsistencies: [...merged.values()].sort((a, b) => artifactTimeValue(a) - artifactTimeValue(b)).slice(-80)
    }
  };
}

function finalizeDirectLedgerState(input = {}) {
  const state = clearNonDirectAnalysisState(normalizeClaimState(input));
  const artifacts = buildDirectArtifacts(state);
  const scorecard = computeDirectScorecard(artifacts, state.sides || []);
  const sides = ensureTwoSides(state.sides || []).map((side) => ({
    ...side,
    score: side.id === BLUE_SIDE_ID ? scorecard.blue.score : scorecard.red.score,
    metrics: {
      ...emptyCoreMetrics(),
      points: artifacts.claims.filter((claim) => claim.sideId === side.id).length,
      supported: artifacts.claims.filter((claim) => claim.sideId === side.id && claim.status === "supported").length,
      disputed: artifacts.claims.filter((claim) => claim.sideId === side.id && claim.status === "contradicted").length,
      unclear: artifacts.claims.filter((claim) => claim.sideId === side.id && ["checking", "no_clear_source", "cannot_verify"].includes(claim.status)).length,
      strength: side.id === BLUE_SIDE_ID ? scorecard.blue.score : scorecard.red.score,
      penalty: Math.abs((scorecard.ledger?.events || []).filter((event) => event.sideId === side.id && event.delta < 0).reduce((sum, event) => sum + Number(event.delta || 0), 0))
    }
  }));
  const finalized = {
    ...state,
    sides,
    artifacts,
    scorecard,
    scores: {
      blue: scorecard.blue.score,
      red: scorecard.red.score,
      dimensions: SCORE_PILLARS.map((pillar) => ({
        key: pillar.key,
        label: pillar.label,
        weight: pillar.weight,
        blue: (scorecard.blue.pillars || []).find((item) => item.key === pillar.key)?.value || 0,
        red: (scorecard.red.pillars || []).find((item) => item.key === pillar.key)?.value || 0
      }))
    },
    analysisSchemaVersion: DIRECT_ANALYSIS_SCHEMA_VERSION,
    architecture: DIRECT_ANALYSIS_ARCHITECTURE,
    pipeline: "direct-ledger"
  };
  return {
    ...finalized,
    analysis: buildDirectAnalysisState(finalized)
  };
}

function buildDirectArtifacts(state = {}) {
  const artifacts = normalizeArtifacts(state.artifacts || {});
  const points = (state.points || []).filter(isDirectClaimPoint);
  const sourceChecks = points.map((point) => directSourceCheckFromPoint(point));
  const sourceByPointId = new Map();
  for (const check of sourceChecks) {
    for (const id of [check.pointId, check.claimPointId].filter(Boolean)) sourceByPointId.set(id, check);
  }
  const clashes = (artifacts.clashes || []).filter((item) => isDirectClashVisible(item, state));
  const clashIdsByPointId = new Map();
  for (const clash of clashes) {
    for (const id of [clash.fromPointId, clash.toPointId].filter(Boolean)) {
      clashIdsByPointId.set(id, [...(clashIdsByPointId.get(id) || []), clash.id]);
    }
  }
  const claims = points.map((point) => {
    const source = sourceByPointId.get(point.id);
    return {
      id: `claim-${point.id}`,
      pointId: point.sourceDebatePointId || point.id,
      claimPointId: point.id,
      speakerId: point.speakerId,
      sideId: normalizeSideId(point.sideId),
      role: "claim",
      claimMode: point.claimMode || "speaker_assertion",
      quoteRole: point.quoteRole || "owned_statement",
      topicContinuity: point.topicContinuity || "main_thread",
      ownershipType: point.ownershipType,
      ownershipConfidence: point.ownershipConfidence,
      ownershipReason: point.ownershipReason,
      speechAct: point.speechAct,
      boundaryConfidence: point.boundaryConfidence,
      familyHint: point.familyHint,
      sourceDebatePointId: point.sourceDebatePointId,
      claim: point.claim,
      quote: point.quote,
      status: sourceStatusToClaimArtifactStatus(source?.status || point.factStatus),
      importance: 3,
      burden: point.factStatus === "verified" ? "met" : point.factStatus === "contradicted" ? "not_met" : "open",
      burdenWhy: point.burden || point.why || source?.explanation || "",
      turnIds: point.turnIds || [],
      sourceCheckIds: [source?.id].filter(Boolean),
      clashIds: clashIdsByPointId.get(point.id) || [],
      at: Number(point.at || Date.now()),
      startSec: point.startSec,
      endSec: point.endSec
    };
  });
  const inconsistencies = (artifacts.inconsistencies || []).filter((item) => item?.id && normalizeSideId(item.accusedSideId || item.sideId));
  const keyMoments = buildDirectLedgerKeyMoments({ claims, sourceChecks, clashes, inconsistencies });
  return {
    claims,
    clashes,
    inconsistencies,
    keyMoments,
    sourceChecks
  };
}

function directSourceCheckFromPoint(point = {}) {
  const status = directFactStatus(point.factStatus);
  const sourceDebatePointId = cleanClaimText(point.sourceDebatePointId || point.parentPointId || point.id || "");
  return {
    id: `fact-${point.id}`,
    pointId: sourceDebatePointId,
    claimId: `claim-${point.id}`,
    claimPointId: point.id,
    sourceDebatePointId,
    sideId: point.sideId,
    speakerId: point.speakerId,
    claim: point.claim,
    statement: point.claim,
    searchQuery: buildFirecrawlSearchQuery(point, buildVerificationContext(point, { points: [point], utterances: [] }, [])),
    status,
    evidenceBasis: point.evidenceBasis,
    scoreEligible: point.scoreEligible !== false && ["verified", "contradicted"].includes(status),
    explanation: point.why || point.noSourceReason || (status === "checking" ? "Checking source status." : ""),
    sources: normalizeSources(point.sources || point.audit?.sources || []),
    noSourceReason: point.noSourceReason,
    provider: point.audit?.provider || point.audit?.searchProvider || "",
    at: Number(point.at || Date.now()),
    startSec: point.startSec,
    endSec: point.endSec
  };
}

function directFactStatus(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "verified") return "verified";
  if (normalized === "contradicted") return "contradicted";
  if (normalized === "no_clear_source") return "no_clear_source";
  if (normalized === "cannot_verify") return "cannot_verify";
  return "checking";
}

function isDirectClaimPoint(point = {}) {
  return Boolean(
    point?.id
    && normalizePointRole(point.role || "claim") === "claim"
    && cleanClaimText(point.claim || "")
    && cleanClaimText(point.quote || "")
    && normalizeSideId(point.sideId)
    && cleanClaimText(point.speakerId || "")
  );
}

function sourceStatusToClaimArtifactStatus(value = "") {
  const status = directFactStatus(value);
  return ["checking", "verified", "contradicted", "no_clear_source", "cannot_verify"].includes(status) ? status : "checking";
}

function isDirectClashVisible(clash = {}, state = {}) {
  if (!clash?.id) return false;
  const blueSpeakerId = clash.blueSpeakerId || (clash.sideId === BLUE_SIDE_ID ? clash.speakerId : clash.targetSpeakerId);
  const redSpeakerId = clash.redSpeakerId || (clash.sideId === RED_SIDE_ID ? clash.speakerId : clash.targetSpeakerId);
  if (!blueSpeakerId || !redSpeakerId || blueSpeakerId === redSpeakerId) return false;
  const blueSide = speakerSideFromState(state, blueSpeakerId);
  const redSide = speakerSideFromState(state, redSpeakerId);
  if (blueSide && blueSide !== BLUE_SIDE_ID) return false;
  if (redSide && redSide !== RED_SIDE_ID) return false;
  if (isModeratorSideAssignment({ speakerId: blueSpeakerId, evidenceQuote: clash.blueQuote || clash.sourceQuote || "", state })) return false;
  if (isModeratorSideAssignment({ speakerId: redSpeakerId, evidenceQuote: clash.redQuote || clash.targetQuote || "", state })) return false;
  return true;
}

function buildDirectLedgerKeyMoments({ claims = [], sourceChecks = [], clashes = [], inconsistencies = [] } = {}) {
  const moments = [];
  const add = (item) => {
    if (!item?.id || !normalizeSideId(item.sideId)) return;
    if (moments.some((existing) => existing.id === item.id)) return;
    moments.push({
      impact: keyMomentDelta(item) > 0 ? "high" : "high",
      at: Number(item.at || Date.now()),
      artifactIds: uniqueStrings(item.artifactIds || []).slice(0, 12),
      ...item
    });
  };
  for (const source of sourceChecks || []) {
    if (!source?.id || source.scoreEligible === false) continue;
    const status = directFactStatus(source.status);
    if (status === "verified") {
      add({
        id: `key-source_verified-${source.id}`,
        sideId: source.sideId,
        kind: "source_verified",
        title: "Verified claim",
        summary: source.explanation || source.claim,
        quote: claimQuoteForSource(claims, source),
        artifactIds: uniqueStrings([source.id, source.pointId, source.claimId || `claim-${source.pointId}`].filter(Boolean)),
        startSec: source.startSec,
        endSec: source.endSec,
        at: source.at
      });
    } else if (status === "contradicted") {
      add({
        id: `key-source_contradicted-${source.id}`,
        sideId: source.sideId,
        kind: "source_contradicted",
        title: "Contradicted claim",
        summary: source.explanation || source.claim,
        quote: claimQuoteForSource(claims, source),
        artifactIds: uniqueStrings([source.id, source.pointId, source.claimId || `claim-${source.pointId}`].filter(Boolean)),
        startSec: source.startSec,
        endSec: source.endSec,
        at: source.at
      });
    }
  }
  for (const clash of clashes || []) {
    const verdict = normalizeDirectClashVerdict(clash.verdict || clash.outcome || "");
    if (verdict !== "blue_stronger" && verdict !== "red_stronger") continue;
    const winnerSideId = verdict === "blue_stronger" ? BLUE_SIDE_ID : RED_SIDE_ID;
    const loserSideId = verdict === "blue_stronger" ? RED_SIDE_ID : BLUE_SIDE_ID;
    add({
      id: `key-strong_rebuttal-${clash.id}`,
      sideId: winnerSideId,
      kind: "strong_rebuttal",
      title: `${sideName(winnerSideId)} answered better`,
      summary: clash.summary || clash.proposition || "A direct clash resolved with a clearer answer.",
      quote: winnerSideId === BLUE_SIDE_ID ? clash.blueQuote || clash.sourceQuote : clash.redQuote || clash.sourceQuote,
      artifactIds: [clash.id],
      startSec: clash.startSec,
      endSec: clash.endSec,
      at: clash.at
    });
    add({
      id: `key-weak_response-${clash.id}`,
      sideId: loserSideId,
      kind: "weak_response",
      title: `${sideName(loserSideId)} gave the weaker response`,
      summary: clash.summary || clash.proposition || "A direct clash resolved against this side.",
      quote: loserSideId === BLUE_SIDE_ID ? clash.blueQuote || clash.targetQuote : clash.redQuote || clash.targetQuote,
      artifactIds: [clash.id],
      startSec: clash.startSec,
      endSec: clash.endSec,
      at: clash.at
    });
  }
  for (const item of inconsistencies || []) {
    const sideId = normalizeSideId(item.accusedSideId || item.sideId);
    add({
      id: `key-inconsistency-${item.id}`,
      sideId,
      kind: "inconsistency",
      title: item.title || "Inconsistency",
      summary: item.summary,
      quote: item.quoteB || item.quoteA || "",
      artifactIds: [item.id],
      startSec: item.startSec,
      endSec: item.endSec,
      at: item.at
    });
  }
  return moments.sort((a, b) => artifactTimeValue(a) - artifactTimeValue(b));
}

function claimQuoteForSource(claims = [], source = {}) {
  return (claims || []).find((claim) => claim.pointId === source.pointId)?.quote || "";
}

function computeDirectScorecard(artifacts = {}, sidesInput = []) {
  return computeKeyMomentScorecard(artifacts, ensureTwoSides(sidesInput || []));
}

function buildDirectAnalysisState(state = {}) {
  const artifacts = normalizeArtifacts(state.artifacts || {});
  const scorecard = state.scorecard || computeDirectScorecard(artifacts, state.sides || []);
  const directAnalysis = normalizeDirectAnalysisState(state.analysis);
  const sideAssignments = directAnalysis?.internal?.sideAssignments || [];
  const claimReviewedDebatePointIds = directAnalysis?.internal?.claimReviewedDebatePointIds || [];
  const clashReviewedDebatePointIds = directAnalysis?.internal?.clashReviewedDebatePointIds || [];
  const inconsistencyReviewedDebatePointIds = directAnalysis?.internal?.inconsistencyReviewedDebatePointIds || [];
  const debatePoints = debatePointLedgerFromState(state);
  const claimsTab = (artifacts.claims || []).map((claim) => {
    const check = (artifacts.sourceChecks || []).find((source) => source.pointId === claim.pointId);
    return {
      cardId: claim.id,
      pointId: claim.pointId,
      claimPointId: claim.claimPointId,
      sourceDebatePointId: claim.sourceDebatePointId || claim.pointId,
      sideId: claim.sideId,
      speakerId: claim.speakerId,
      claim: claim.claim,
      quote: claim.quote,
      factStatus: directFactStatus(check?.status || claim.status),
      sourceQuery: check?.searchQuery || "",
      sourceReason: check?.explanation || claim.burdenWhy || "",
      startSec: claim.startSec,
      endSec: claim.endSec,
      atMs: claim.at,
      turnIds: claim.turnIds || [],
      payload: claim
    };
  });
  const factChecks = (artifacts.sourceChecks || []).map((source) => ({
    checkId: source.id,
    claimCardId: source.claimId || `claim-${source.pointId}`,
    pointId: source.pointId,
    claimPointId: source.claimPointId,
    sourceDebatePointId: source.sourceDebatePointId || source.pointId,
    sideId: source.sideId,
    speakerId: source.speakerId,
    statement: source.claim || source.statement,
    searchQuery: source.searchQuery || source.claim || source.statement,
    status: directFactStatus(source.status),
    provider: source.provider || "",
    sources: source.sources || [],
    explanation: source.explanation || source.noSourceReason || "",
    startedAt: null,
    completedAt: directFactStatus(source.status) === "checking" ? null : new Date(source.at || Date.now()).toISOString(),
    payload: source
  }));
  const clashes = (artifacts.clashes || []).map((clash) => ({
    cardId: clash.id,
    proposition: clash.proposition || clash.summary || "",
    blueCardId: clash.blueCardId || "",
    redCardId: clash.redCardId || "",
    blueSpeakerId: clash.blueSpeakerId || (clash.sideId === BLUE_SIDE_ID ? clash.speakerId : clash.targetSpeakerId) || "",
    redSpeakerId: clash.redSpeakerId || (clash.sideId === RED_SIDE_ID ? clash.speakerId : clash.targetSpeakerId) || "",
    blueQuote: clash.blueQuote || (clash.sideId === BLUE_SIDE_ID ? clash.sourceQuote : clash.targetQuote) || "",
    redQuote: clash.redQuote || (clash.sideId === RED_SIDE_ID ? clash.sourceQuote : clash.targetQuote) || "",
    status: clash.outcome === "needs_more_context" ? "still_developing" : "answered",
    verdict: directClashVerdictForDb(clash),
    reason: clash.summary || "",
    startSec: clash.startSec,
    endSec: clash.endSec,
    atMs: clash.at,
    payload: clash
  }));
  const inconsistencies = (artifacts.inconsistencies || []).map((item) => ({
    cardId: item.id,
    sideId: item.accusedSideId || item.sideId,
    speakerId: item.speakerId || item.quoteASpeakerId || "",
    title: item.title || "Inconsistency",
    summary: item.summary,
    firstQuote: item.quoteA,
    secondQuote: item.quoteB,
    status: "confirmed",
    startSec: item.startSec,
    endSec: item.endSec,
    atMs: item.at,
    payload: item
  }));
  const keyMoments = (artifacts.keyMoments || []).map((moment) => ({
    cardId: moment.id,
    sideId: moment.sideId,
    kind: keyMomentCategory(moment),
    impact: keyMomentDelta(moment) > 0 ? "positive" : "negative",
    scoreDelta: keyMomentDelta(moment),
    title: moment.title,
    summary: moment.summary,
    quote: moment.quote || "",
    startSec: moment.startSec,
    endSec: moment.endSec,
    atMs: moment.at,
    artifactIds: moment.artifactIds || [],
    payload: moment
  }));
  const scoreEvents = (scorecard.ledger?.events || []).map((event, index) => ({
    eventId: event.id || `score-event-${index}`,
    keyMomentId: (event.artifactIds || []).find((id) => String(id).startsWith("key-")) || "",
    sideId: normalizeSideId(event.sideId),
    sideColor: event.side || sideColorName(event.sideId),
    category: keyMomentCategory({ kind: event.category, title: event.title, summary: event.detail }),
    delta: Math.round(Number(event.delta || 0)),
    title: event.title || "",
    detail: event.detail || "",
    minute: event.minute,
    atMs: event.at,
    artifactIds: event.artifactIds || [],
    payload: event
  })).filter((event) => event.sideId && event.delta);
  return {
    schemaVersion: DIRECT_ANALYSIS_SCHEMA_VERSION,
    architecture: DIRECT_ANALYSIS_ARCHITECTURE,
    updatedAt: Date.now(),
    sideState: {
      sides: ensureTwoSides(state.sides || []).map((side) => ({
        sideId: side.id,
        label: confirmedSideLabel(side) || side.workingThesis || "",
        speakerIds: side.speakerIds || []
      })),
      speakerSideMap: buildCurrentSpeakerSideMap(state)
    },
    tabs: {
      claims: claimsTab,
      clashes,
      keyMoments
    },
    internal: {
      factChecks,
      inconsistencies,
      sideAssignments,
      debatePoints,
      thesisUpdates: thesisUpdateLedgerFromState(state),
      claimReviewedDebatePointIds,
      clashReviewedDebatePointIds,
      inconsistencyReviewedDebatePointIds
    },
    score: {
      method: "key_moment_score",
      version: DIRECT_ANALYSIS_SCHEMA_VERSION,
      blue: {
        score: scorecard.blue?.score || 0,
        sideId: BLUE_SIDE_ID,
        label: scorecard.blue?.label || "Blue side"
      },
      red: {
        score: scorecard.red?.score || 0,
        sideId: RED_SIDE_ID,
        label: scorecard.red?.label || "Red side"
      },
      leader: scorecard.leader || "even",
      leadMargin: scorecard.leadMargin || 0,
      events: scoreEvents
    }
  };
}

function directClashVerdictForDb(clash = {}) {
  const verdict = normalizeDirectClashVerdict(clash.verdict || "");
  if (verdict === "blue_stronger") return "blue_answered_better";
  if (verdict === "red_stronger") return "red_answered_better";
  if (verdict === "no_clear_edge") return "no_clear_edge";
  return "still_developing";
}

function emptyDirectAnalysisState() {
  return {
    schemaVersion: DIRECT_ANALYSIS_SCHEMA_VERSION,
    architecture: DIRECT_ANALYSIS_ARCHITECTURE,
    updatedAt: Date.now(),
    tabs: { claims: [], clashes: [], keyMoments: [] },
    internal: {
      factChecks: [],
      inconsistencies: [],
      sideAssignments: [],
      debatePoints: [],
      thesisUpdates: [],
      claimReviewedDebatePointIds: [],
      clashReviewedDebatePointIds: [],
      inconsistencyReviewedDebatePointIds: []
    },
    score: { method: "key_moment_score", version: DIRECT_ANALYSIS_SCHEMA_VERSION, events: [] }
  };
}

function turnTimeRangeForId(state = {}, turnId = "") {
  const id = cleanClaimText(turnId || "");
  if (!id) return {};
  const turn = (state.utterances || []).find((utterance) => utterance.utteranceId === id || (utterance.rawTurnIds || []).includes(id));
  return turn ? { startSec: turn.startSec, endSec: turn.endSec } : {};
}

function finiteMin(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? Math.min(...nums) : undefined;
}

function finiteMax(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : undefined;
}

function artifactTimeValue(item = {}) {
  for (const key of ["startSec", "endSec", "at"]) {
    const value = Number(item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function currentReporterChunkCount(currentDebate = {}, incomingTurns = []) {
  const existing = currentDebate?.reporterChunkCount;
  const existingCount = Array.isArray(existing) ? existing.length : 0;
  if (!incomingTurns.length) return existingCount;
  return Math.max(existingCount + 1, Math.ceil(Math.max(0, debateDurationMsFromTurns(incomingTurns)) / Math.max(1, LIVE_CURRENT_REPORTER_CHUNK_MS)));
}

function debateDurationMsFromTurns(turns = []) {
  const range = debateRangeFromTurns(turns);
  if (Number.isFinite(Number(range.startSec)) && Number.isFinite(Number(range.endSec))) {
    return Math.max(0, Math.round((Number(range.endSec) - Number(range.startSec)) * 1000));
  }
  return 0;
}

function normalizeFloorState(input = {}) {
  if (!input || typeof input !== "object") {
    return { version: FLOOR_STATE_VERSION, phase: "unknown", phaseConfidence: 0, updatedAt: 0, speakers: [], utterances: [] };
  }
  return {
    version: FLOOR_STATE_VERSION,
    phase: normalizeDebatePhase(input.phase),
    phaseConfidence: clamp01(input.phaseConfidence, 0),
    updatedAt: Number(input.updatedAt || 0),
    speakers: normalizeFloorSpeakerDecisions(input.speakers || [], input.utterances || [], []),
    utterances: Array.isArray(input.utterances)
      ? input.utterances.map((item) => normalizeFloorUtteranceAnnotation(item, item)).filter((item) => item.utteranceId && item.speakerId).slice(-220)
      : []
  };
}

function normalizeFloorSpeakerDecisions(items = [], utterances = [], fallbacks = []) {
  const bySpeaker = new Map();
  for (const fallback of Array.isArray(fallbacks) ? fallbacks : []) {
    if (!fallback?.speakerId) continue;
    bySpeaker.set(fallback.speakerId, normalizeFloorSpeakerDecision(fallback));
  }
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeFloorSpeakerDecision(item);
    if (!normalized.speakerId) continue;
    const existing = bySpeaker.get(normalized.speakerId);
    if (!existing || normalized.confidence >= Number(existing.confidence || 0) - 0.04 || existing.role === UNKNOWN_SPEAKER) {
      bySpeaker.set(normalized.speakerId, { ...existing, ...normalized });
    }
  }
  const grouped = new Map();
  for (const utterance of Array.isArray(utterances) ? utterances : []) {
    if (!utterance?.speakerId) continue;
    grouped.set(utterance.speakerId, [...(grouped.get(utterance.speakerId) || []), utterance]);
  }
  for (const [speakerId, speakerUtterances] of grouped) {
    const existing = bySpeaker.get(speakerId);
    const roleVotes = speakerUtterances.reduce((acc, utterance) => {
      const role = normalizeFloorSpeakerRole(utterance.speakerRole);
      acc[role] = (acc[role] || 0) + clamp01(utterance.roleConfidence, 0.5);
      return acc;
    }, {});
    const bestRole = Object.entries(roleVotes).sort((a, b) => b[1] - a[1])[0]?.[0] || UNKNOWN_SPEAKER;
    const bestConfidence = Math.max(...speakerUtterances.map((utterance) => clamp01(utterance.roleConfidence, 0.45)), existing?.confidence || 0);
    const hasOwnedDebaterUtterance = speakerUtterances.some((utterance) => (
      utterance.speakerRole === DEBATER_SPEAKER
      && Number(utterance.roleConfidence || 0) >= 0.58
      && (utterance.claimEligible || utterance.sideMapEligible || utterance.stanceBearing)
    ));
    const role = bestRole === UNKNOWN_SPEAKER && (hasOwnedDebaterUtterance || hasStrongDebaterSideHint(existing))
      ? DEBATER_SPEAKER
      : bestRole;
    if (!existing || bestConfidence >= Number(existing.confidence || 0) - 0.08 || existing.role === UNKNOWN_SPEAKER) {
      bySpeaker.set(speakerId, normalizeFloorSpeakerDecision({
        ...existing,
        speakerId,
        role,
        confidence: Math.min(0.95, bestConfidence),
        roleReason: existing?.roleReason || speakerUtterances.find((utterance) => utterance.reason)?.reason || "Role inferred from recent floor behavior."
      }));
    }
  }
  return [...bySpeaker.values()].filter((item) => item.speakerId).slice(-16);
}

function normalizeFloorSpeakerDecision(item = {}) {
  const sideHintId = normalizeAgentSideId({ side: item.sideHint || item.side || item.sideId || "" });
  const sideHintConfidence = clamp01(item.sideHintConfidence ?? item.sideConfidence, sideHintId ? 0.65 : 0);
  const roleReason = cleanAgentDisplayText(item.roleReason || item.reason || "");
  const rawRole = normalizeFloorSpeakerRole(item.role || item.speakerRole);
  const role = rawRole === UNKNOWN_SPEAKER && sideHintId && sideHintConfidence >= 0.78 && hasDebaterFloorReason(roleReason)
    ? DEBATER_SPEAKER
    : rawRole;
  return {
    speakerId: cleanClaimText(item.speakerId || ""),
    role,
    confidence: clamp01(item.confidence ?? item.roleConfidence, 0),
    sideHint: sideHintId ? sideColorName(sideHintId) : "",
    sideHintConfidence,
    roleReason
  };
}

function hasStrongDebaterSideHint(decision = {}) {
  if (!decision) return false;
  return Boolean(
    normalizeAgentSideId({ side: decision.sideHint })
    && Number(decision.sideHintConfidence || 0) >= 0.78
    && normalizeFloorSpeakerRole(decision.role) !== NEUTRAL_SPEAKER
    && hasDebaterFloorReason(decision.roleReason || "")
  );
}

function hasDebaterFloorReason(text = "") {
  return /\b(opening|claim|argues?|claim|case|stance|position|thesis|supports?|opposes?|against|yes|no|affirmative|negative|rebuttal|challenges?|defends?)\b/i.test(String(text || ""));
}

function normalizeFloorUtteranceAnnotation(item = {}, source = {}) {
  const role = normalizeFloorSpeakerRole(item?.speakerRole || item?.role);
  const speechFunction = normalizeSpeechFunction(item?.speechFunction || item?.function);
  const contextOnly = Boolean(item?.contextOnly ?? (role !== DEBATER_SPEAKER || ["topic_setup", "procedural", "off_topic"].includes(speechFunction)));
  const stanceBearing = Boolean(item?.stanceBearing ?? (!contextOnly && ["opening_statement", "claim"].includes(speechFunction)));
  const claimEligible = Boolean(item?.claimEligible ?? (role === DEBATER_SPEAKER && stanceBearing && !contextOnly));
  const ownerSideId = normalizeAgentSideId(item?.ownerSideId || item?.ownerSide || item?.sideHint || "");
  const ownerSideConfidence = clamp01(item?.ownerSideConfidence ?? item?.sideHintConfidence ?? item?.sideConfidence, ownerSideId ? 0.65 : 0);
  return {
    utteranceId: cleanClaimText(item?.utteranceId || source?.utteranceId || source?.id || ""),
    speakerId: cleanClaimText(item?.speakerId || source?.speakerId || ""),
    speakerRole: role,
    roleConfidence: clamp01(item?.roleConfidence ?? item?.confidence, role === UNKNOWN_SPEAKER ? 0.35 : 0.6),
    speechFunction,
    debatePhase: normalizeDebatePhase(item?.debatePhase || item?.phase),
    stanceBearing,
    sideMapEligible: Boolean(item?.sideMapEligible ?? (role === DEBATER_SPEAKER && stanceBearing)),
    claimEligible,
    challengeEligible: Boolean(item?.challengeEligible ?? claimEligible),
    scoreEligible: Boolean(item?.scoreEligible ?? claimEligible),
    contextOnly,
    reason: cleanAgentDisplayText(item?.reason || ""),
    ownerSideId: ownerSideId || "",
    ownerSideConfidence,
    ownerSideReason: cleanAgentDisplayText(item?.ownerSideReason || item?.sideReason || ""),
    ownershipMode: normalizeUtteranceOwnershipMode(item?.ownershipMode || (contextOnly ? "neutral_context" : ownerSideId ? "speaker_side" : "unknown"))
  };
}

function mergeFloorUtteranceAnnotations(previous = [], incoming = []) {
  const byId = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    const normalized = normalizeFloorUtteranceAnnotation(item, item);
    if (normalized.utteranceId) byId.set(normalized.utteranceId, normalized);
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const normalized = normalizeFloorUtteranceAnnotation(item, item);
    if (normalized.utteranceId) byId.set(normalized.utteranceId, normalized);
  }
  return [...byId.values()].slice(-220);
}

function mergeFloorSpeakerDecisions(previous = [], incoming = [], utterances = [], state = {}) {
  const merged = normalizeFloorSpeakerDecisions(incoming, utterances, previous);
  const knownSpeakers = new Set([...(state.speakers || []).map((speaker) => speaker.speakerId), ...merged.map((speaker) => speaker.speakerId)].filter(Boolean));
  return [...knownSpeakers].map((speakerId) => {
    const decision = merged.find((item) => item.speakerId === speakerId)
      || previous.find((item) => item.speakerId === speakerId)
      || { speakerId, role: UNKNOWN_SPEAKER, confidence: 0.2, roleReason: "Awaiting floor-role evidence." };
    return normalizeFloorSpeakerDecision(decision);
  }).slice(-16);
}

function applyFloorAnnotationToUtterance(utterance = {}, annotation = {}) {
  return {
    ...utterance,
    speakerRole: annotation.speakerRole,
    floorRoleConfidence: annotation.roleConfidence,
    speechFunction: annotation.speechFunction,
    debatePhase: annotation.debatePhase,
    stanceBearing: Boolean(annotation.stanceBearing),
    sideMapEligible: Boolean(annotation.sideMapEligible),
    claimEligible: Boolean(annotation.claimEligible),
    challengeEligible: Boolean(annotation.challengeEligible),
    scoreEligible: Boolean(annotation.scoreEligible),
    contextOnly: Boolean(annotation.contextOnly),
    floorReason: annotation.reason || "",
    ownerSideId: normalizeSideId(annotation.ownerSideId) || "",
    ownerSideConfidence: annotation.ownerSideConfidence === undefined ? undefined : clamp01(annotation.ownerSideConfidence, 0),
    ownerSideReason: cleanAgentDisplayText(annotation.ownerSideReason || ""),
    ownershipMode: normalizeUtteranceOwnershipMode(annotation.ownershipMode)
  };
}

function applyFloorSpeakerDecisionsToRegistry(state = {}, decisions = []) {
  const bySpeaker = new Map((state.speakers || []).map((speaker) => [speaker.speakerId, { ...speaker }]));
  for (const decision of decisions || []) {
    if (!decision?.speakerId) continue;
    const existing = bySpeaker.get(decision.speakerId) || {
      speakerId: decision.speakerId,
      sideConfidence: 0,
      lastSpokenAt: 0,
      turnIds: [],
      assignmentReason: "Awaiting side assignment."
    };
    const role = normalizeFloorSpeakerRole(decision.role);
    const confidence = clamp01(decision.confidence, 0);
    const next = {
      ...existing,
      speakerRole: role,
      floorRoleConfidence: Math.max(Number(existing.floorRoleConfidence || 0), confidence),
      floorRoleReason: cleanAgentDisplayText(decision.roleReason || existing.floorRoleReason || "")
    };
    const sideHintId = normalizeAgentSideId({ side: decision.sideHint });
    if (role === NEUTRAL_SPEAKER && confidence >= 0.78 && (!speakerHasDurableDebaterEvidence(state, decision.speakerId) || Number(existing.sideConfidence || 0) < 0.92)) {
      next.sideId = undefined;
      next.sideConfidence = 0;
      next.assignmentReason = decision.roleReason || "Kept neutral because this speaker manages the debate floor rather than owning a side.";
    } else if (role === DEBATER_SPEAKER && sideHintId && clamp01(decision.sideHintConfidence, 0) >= 0.78) {
      const guardedSideHintId = coerceInitialSideAnchor(state, decision.speakerId, sideHintId);
      if (!normalizeSideId(next.sideId) || Number(next.sideConfidence || 0) < clamp01(decision.sideHintConfidence, 0)) {
        next.sideId = guardedSideHintId;
        next.sideConfidence = Math.max(Number(next.sideConfidence || 0), clamp01(decision.sideHintConfidence, 0));
        next.assignmentReason = initialSideAnchorReason(state, sideHintId, decision.roleReason || `Assigned to ${sideName(guardedSideHintId)} from explicit debate-role framing.`);
      }
    }
    bySpeaker.set(decision.speakerId, next);
  }
  return [...bySpeaker.values()];
}

function normalizeFloorSpeakerRole(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["debater", "debate_speaker", "participant", "side_speaker"].includes(normalized)) return DEBATER_SPEAKER;
  if (["neutral", "neutral_speaker", "moderator", "mediator", "host", "interviewer", "questioner", "audience", "narrator", "timekeeper"].includes(normalized)) return NEUTRAL_SPEAKER;
  if (["possible_alias", "alias", "speaker_alias"].includes(normalized)) return POSSIBLE_ALIAS_SPEAKER;
  return UNKNOWN_SPEAKER;
}

function normalizeDebatePhase(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["prelude", "openings", "active_debate", "cross_exam", "closing", "unknown"].includes(normalized)) return normalized;
  if (["intro", "introduction", "setup"].includes(normalized)) return "prelude";
  if (["opening", "opening_statement"].includes(normalized)) return "openings";
  if (["discussion", "debate", "exchange"].includes(normalized)) return "active_debate";
  if (["qa", "q_a", "cross_examination"].includes(normalized)) return "cross_exam";
  return "unknown";
}

function normalizeSpeechFunction(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["topic_setup", "opening_statement", "claim", "challenge_question", "procedural", "clarification", "off_topic"].includes(normalized)) return normalized;
  if (["intro", "introduction", "setup", "framing"].includes(normalized)) return "topic_setup";
  if (["opening", "opening_claim"].includes(normalized)) return "opening_statement";
  if (["claim", "rebuttal", "evidence"].includes(normalized)) return "claim";
  if (["question", "challenge", "cross_exam"].includes(normalized)) return "challenge_question";
  if (["moderation", "routing", "timekeeping"].includes(normalized)) return "procedural";
  return "clarification";
}

function normalizeUtteranceOwnershipMode(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["speaker_side", "utterance_side", "neutral_context", "unknown"].includes(normalized)) return normalized;
  if (["side_profile", "profile_side", "stance_side"].includes(normalized)) return "utterance_side";
  return "unknown";
}

function completeUtteranceSideOwnership(annotation = {}, source = {}, state = {}) {
  const normalized = normalizeFloorUtteranceAnnotation(annotation, source);
  if (normalized.contextOnly || normalized.speakerRole === NEUTRAL_SPEAKER || !normalized.stanceBearing) {
    return {
      ...normalized,
      ownerSideId: "",
      ownerSideConfidence: 0,
      ownerSideReason: normalized.ownerSideReason || "Context-only or neutral floor turn.",
      ownershipMode: "neutral_context"
    };
  }
  const deterministic = resolveUtteranceSideOwnership({
    state,
    utterance: source,
    speakerRole: normalized.speakerRole,
    stanceBearing: normalized.stanceBearing,
    contextOnly: normalized.contextOnly
  });
  const proposedSideId = coerceInitialSideAnchor(state, normalized.speakerId, normalized.ownerSideId);
  const proposedConfidence = clamp01(normalized.ownerSideConfidence, proposedSideId ? 0.65 : 0);
  const speakerSideId = speakerHasSideOwnershipCollision(state, normalized.speakerId)
    ? ""
    : coerceInitialSideAnchor(state, normalized.speakerId, speakerSideFromState(state, normalized.speakerId));

  let ownerSideId = proposedSideId || "";
  let ownerSideConfidence = proposedConfidence;
  let ownerSideReason = normalized.ownerSideReason || normalized.reason || "";
  let ownershipMode = normalizeUtteranceOwnershipMode(normalized.ownershipMode);

  const deterministicIsStrong = deterministic.sideId && deterministic.confidence >= OWNER_SIDE_CONFIDENCE_MIN;
  const proposedIsWeak = !proposedSideId || proposedConfidence < OWNER_SIDE_CONFIDENCE_MIN;
  const proposedFollowsSpeakerButProfileDiffers = proposedSideId
    && speakerSideId
    && proposedSideId === speakerSideId
    && deterministic.sideId
    && deterministic.sideId !== speakerSideId
    && deterministic.confidence >= Math.max(OWNER_SIDE_CONFIDENCE_MIN, proposedConfidence - 0.02);
  if (deterministicIsStrong && (proposedIsWeak || proposedFollowsSpeakerButProfileDiffers || deterministic.confidence >= proposedConfidence + 0.1)) {
    ownerSideId = deterministic.sideId;
    ownerSideConfidence = deterministic.confidence;
    ownerSideReason = deterministic.reason;
    ownershipMode = deterministic.mode;
  } else if (ownerSideId) {
    ownershipMode = speakerSideId && speakerSideId !== ownerSideId ? "utterance_side" : "speaker_side";
  } else if (speakerSideId && normalized.speakerRole === DEBATER_SPEAKER) {
    ownerSideId = speakerSideId;
    ownerSideConfidence = Math.max(0.65, Number((state.speakers || []).find((speaker) => speaker.speakerId === normalized.speakerId)?.sideConfidence || 0.65));
    ownerSideReason = "Inherited from stable speaker-side assignment.";
    ownershipMode = "speaker_side";
  }

  const stableSpeakerConfidence = stableSpeakerSideConfidence(state, normalized.speakerId);
  if (
    speakerSideId
    && ownerSideId
    && ownerSideId !== speakerSideId
    && stableSpeakerConfidence >= 0.86
    && !(deterministic.sideId === ownerSideId && deterministic.confidence >= 0.84)
  ) {
    ownerSideId = speakerSideId;
    ownerSideConfidence = stableSpeakerConfidence;
    ownerSideReason = "Kept stable speaker-side ownership; opposing-side profile evidence was not strong enough for an utterance-level override.";
    ownershipMode = "speaker_side";
  }

  return {
    ...normalized,
    ownerSideId: ownerSideId || "",
    ownerSideConfidence: ownerSideId ? clamp01(ownerSideConfidence, 0) : 0,
    ownerSideReason: cleanAgentDisplayText(ownerSideReason || ""),
    ownershipMode: ownerSideId ? ownershipMode : "unknown"
  };
}

function resolveUtteranceSideOwnership({ state = {}, utterance = {}, speakerRole = UNKNOWN_SPEAKER, stanceBearing = false, contextOnly = false } = {}) {
  if (contextOnly || speakerRole === NEUTRAL_SPEAKER || !stanceBearing) {
    return { sideId: "", confidence: 0, mode: "neutral_context", reason: "No debate-side owner for a neutral/context turn." };
  }
  const speakerId = cleanClaimText(utterance.speakerId || "");
  const speakerSideId = speakerHasSideOwnershipCollision(state, speakerId)
    ? ""
    : coerceInitialSideAnchor(state, speakerId, speakerSideFromState(state, speakerId));
  const profile = inferSideOwnershipFromProfiles(utterance.text || "", state);
  if (profile.sideId && profile.confidence >= OWNER_SIDE_CONFIDENCE_MIN) {
    const profileSideId = coerceInitialSideAnchor(state, speakerId, profile.sideId);
    return {
      sideId: profileSideId,
      confidence: profile.confidence,
      mode: speakerSideId && speakerSideId !== profileSideId ? "utterance_side" : "speaker_side",
      reason: profile.reason
    };
  }
  if (speakerSideId) {
    const speaker = (state.speakers || []).find((item) => item.speakerId === speakerId) || {};
    return {
      sideId: speakerSideId,
      confidence: Math.max(0.65, Number(speaker.sideConfidence || 0.65)),
      mode: "speaker_side",
      reason: "Inherited from stable speaker-side assignment."
    };
  }
  return { sideId: "", confidence: 0, mode: "unknown", reason: "No reliable side owner yet." };
}

function buildSideOwnershipProfiles(state = {}) {
  const normalized = normalizeClaimStateShallow(state);
  const artifacts = normalizeArtifacts(normalized.artifacts || {});
  const sides = ensureTwoSides(normalized.sides || []);
  return sides.map((side) => {
    const sideId = side.id;
    const pointClaims = (normalized.points || [])
      .filter((point) => point.sideId === sideId && isAssertedPoint(point))
      .slice(-18)
      .flatMap((point) => [point.claim, point.quote, point.burden].filter(Boolean));
    const artifactClaims = (artifacts.claims || [])
      .filter((claim) => claim.sideId === sideId)
      .slice(-14)
      .flatMap((claim) => [claim.claim, claim.quote, claim.burdenWhy].filter(Boolean));
    const memoryClaims = (normalized.speakerPositionMemory || [])
      .filter((memory) => normalizeSideId(memory.likelySide) === sideId)
      .slice(-8)
      .flatMap((memory) => [memory.stanceSummary, ...(memory.supportingEvidence || [])].filter(Boolean));
    const label = confirmedSideLabel(side) || side.label || side.workingThesis || "";
    const claims = uniqueStrings([...pointClaims, ...artifactClaims, ...memoryClaims])
      .map((text) => truncatePromptText(cleanClaimText(text || ""), 240))
      .filter(Boolean);
    return {
      sideId,
      label: cleanClaimText(label || ""),
      speakerIds: side.speakerIds || [],
      claims,
      text: cleanClaimText([label, ...claims].join(" "))
    };
  });
}

function normalizeClaimStateShallow(state = {}) {
  return {
    ...state,
    sides: ensureTwoSides(state.sides || []),
    speakers: Array.isArray(state.speakers) ? state.speakers : [],
    points: Array.isArray(state.points) ? state.points : [],
    speakerPositionMemory: normalizeSpeakerPositionMemory(state.speakerPositionMemory || []),
    artifacts: normalizeArtifacts(state.artifacts || {})
  };
}

function inferSideOwnershipFromProfiles(text = "", state = {}) {
  const clean = cleanClaimText(text || "");
  if (wordCount(clean) < 8) return { sideId: "", confidence: 0, reason: "" };
  const profiles = buildSideOwnershipProfiles(state).filter((profile) => normalizeSideId(profile.sideId) && wordCount(profile.text || "") >= 18);
  if (profiles.length < 2) return { sideId: "", confidence: 0, reason: "" };
  const scored = profiles
    .map((profile) => ({
      sideId: profile.sideId,
      score: sideProfileTextScore(clean, profile),
      label: profile.label
    }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1] || { score: 0 };
  const margin = Number(best.score || 0) - Number(second.score || 0);
  if (!best?.sideId || best.score < 0.14 || margin < OWNER_SIDE_PROFILE_MARGIN_MIN) {
    return { sideId: "", confidence: 0, reason: "" };
  }
  const confidence = clamp01(0.58 + best.score * 0.55 + margin * 0.7, 0);
  return {
    sideId: best.sideId,
    confidence,
    reason: `${sideName(best.sideId)} profile continuity beat the other side by ${margin.toFixed(2)}.`
  };
}

function sideProfileTextScore(text = "", profile = {}) {
  const profileText = cleanClaimText(profile.text || "");
  if (!profileText) return 0;
  const support = textSupportScore(text, profileText);
  const overlap = tokenOverlapRatio(normalizeTranscript(text), normalizeTranscript(profileText));
  const claimHit = (profile.claims || []).some((claim) => textSupportScore(text, claim) >= 0.42) ? 0.08 : 0;
  const labelHit = profile.label && textSupportScore(text, profile.label) >= 0.34 ? 0.04 : 0;
  return Math.max(support, overlap) + claimHit + labelHit;
}

function sideOwnershipForTurnIds(state = {}, speakerId = "", turnIds = []) {
  const annotations = floorUtterancesFor(state, turnIds)
    .filter((item) => !speakerId || item.speakerId === speakerId)
    .filter((item) => normalizeSideId(item.ownerSideId) && Number(item.ownerSideConfidence || 0) >= OWNER_SIDE_CONFIDENCE_MIN);
  if (!annotations.length) return { sideId: "", confidence: 0, mode: "unknown", reason: "" };
  const totals = new Map();
  for (const annotation of annotations) {
    const sideId = normalizeSideId(annotation.ownerSideId);
    const current = totals.get(sideId) || { score: 0, count: 0, reasons: [] };
    current.score += clamp01(annotation.ownerSideConfidence, 0);
    current.count += 1;
    if (annotation.ownerSideReason) current.reasons.push(annotation.ownerSideReason);
    totals.set(sideId, current);
  }
  const ranked = [...totals.entries()]
    .map(([sideId, value]) => ({ sideId, ...value, confidence: clamp01(value.score / Math.max(1, value.count), 0) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || (second && best.score - second.score < 0.2)) return { sideId: "", confidence: 0, mode: "unknown", reason: "" };
  const speakerSideId = speakerHasSideOwnershipCollision(state, speakerId) ? "" : speakerSideFromState(state, speakerId);
  const guardedSideId = coerceInitialSideAnchor(state, speakerId, best.sideId);
  return {
    sideId: guardedSideId,
    confidence: best.confidence,
    mode: speakerSideId && speakerSideId !== guardedSideId ? "utterance_side" : "speaker_side",
    reason: best.reasons[0] || "Resolved from utterance-level side ownership."
  };
}

function turnOwnerSideFromState(state = {}, turn = {}) {
  const directSideId = coerceInitialSideAnchor(state, turn.speakerId, turn.ownerSideId);
  if (directSideId && Number(turn.ownerSideConfidence || 0) >= OWNER_SIDE_CONFIDENCE_MIN) return directSideId;
  const ownership = sideOwnershipForTurnIds(state, turn.speakerId, [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])]);
  if (ownership.sideId && ownership.confidence >= OWNER_SIDE_CONFIDENCE_MIN) return ownership.sideId;
  if (speakerHasSideOwnershipCollision(state, turn.speakerId)) return undefined;
  return coerceInitialSideAnchor(state, turn.speakerId, speakerSideFromState(state, turn.speakerId));
}

function summarizeWindowSpeakerOwnership(state = {}, speakerId = "", turns = []) {
  const speakerTurns = (turns || []).filter((turn) => turn.speakerId === speakerId);
  const totals = new Map();
  for (const turn of speakerTurns) {
    const sideId = turnOwnerSideFromState(state, turn);
    if (!sideId) continue;
    const current = totals.get(sideId) || { sideId, turns: 0, words: 0 };
    current.turns += 1;
    current.words += wordCount(turn.text || "");
    totals.set(sideId, current);
  }
  return [...totals.values()].map((item) => ({
    side: sideColorName(item.sideId),
    turns: item.turns,
    words: item.words
  }));
}

function pointUtteranceOwnership(state = {}, point = {}) {
  const ownership = sideOwnershipForTurnIds(state, point.speakerId, point.turnIds || []);
  if (ownership.sideId && ownership.confidence >= OWNER_SIDE_CONFIDENCE_MIN) return ownership;
    const auditSideId = coerceInitialSideAnchor(state, point.speakerId, point.audit?.ownerSideId);
  if (auditSideId && Number(point.audit?.ownerSideConfidence || 0) >= OWNER_SIDE_CONFIDENCE_MIN) {
    return {
      sideId: auditSideId,
      confidence: clamp01(point.audit.ownerSideConfidence, 0),
      mode: normalizeUtteranceOwnershipMode(point.audit.sideOwnershipMode || point.sideOwnershipMode || "utterance_side"),
      reason: point.audit.sideOwnershipReason || point.sideOwnershipReason || "Resolved from point audit ownership."
    };
  }
  const directSideId = coerceInitialSideAnchor(state, point.speakerId, point.ownerSideId);
  if (directSideId && Number(point.ownerSideConfidence || 0) >= OWNER_SIDE_CONFIDENCE_MIN) {
    return {
      sideId: directSideId,
      confidence: clamp01(point.ownerSideConfidence, 0),
      mode: normalizeUtteranceOwnershipMode(point.sideOwnershipMode || "utterance_side"),
      reason: point.sideOwnershipReason || "Resolved from point ownership."
    };
  }
  return { sideId: "", confidence: 0, mode: "unknown", reason: "" };
}

function speakerSideOwnershipSummary(state = {}, speakerId = "") {
  const floor = normalizeFloorState(state.floorState || state.floorState || {});
  const totals = {
    [BLUE_SIDE_ID]: { score: 0, count: 0, words: 0 },
    [RED_SIDE_ID]: { score: 0, count: 0, words: 0 }
  };
  const utteranceTextById = new Map((state.utterances || []).map((utterance) => [utterance.utteranceId, utterance.text || ""]));
  for (const annotation of floor.utterances || []) {
    if (annotation.speakerId !== speakerId) continue;
    const sideId = normalizeSideId(annotation.ownerSideId);
    if (!sideId || Number(annotation.ownerSideConfidence || 0) < SIDE_COLLISION_CONFIDENCE_MIN) continue;
    if (!annotation.claimEligible && !annotation.scoreEligible && !annotation.stanceBearing) continue;
    totals[sideId].score += Number(annotation.ownerSideConfidence || 0);
    totals[sideId].count += 1;
    totals[sideId].words += Math.max(1, wordCount(utteranceTextById.get(annotation.utteranceId) || ""));
  }
  for (const point of state.points || []) {
    if (point.speakerId !== speakerId) continue;
    const sideId = normalizeSideId(point.sideId);
    if (!sideId || normalizeUtteranceOwnershipMode(point.sideOwnershipMode) !== "utterance_side") continue;
    totals[sideId].score += clamp01(point.sideOwnershipConfidence, 0.74);
    totals[sideId].count += 1;
    totals[sideId].words += Math.max(1, wordCount(`${point.claim || ""} ${point.quote || ""}`));
  }
  return totals;
}

function speakerHasSideOwnershipCollision(state = {}, speakerId = "") {
  if (!speakerId) return false;
  const speaker = (state.speakers || []).find((item) => item.speakerId === speakerId);
  if (speaker?.identityStatus === "side_collision") return true;
  if (stableSpeakerSideConfidence(state, speakerId) >= 0.86) return false;
  const summary = speakerSideOwnershipSummary(state, speakerId);
  const blue = summary[BLUE_SIDE_ID];
  const red = summary[RED_SIDE_ID];
  return Boolean(
    blue.count > 0
    && red.count > 0
    && blue.words >= 8
    && red.words >= 8
    && blue.score >= SIDE_COLLISION_CONFIDENCE_MIN
    && red.score >= SIDE_COLLISION_CONFIDENCE_MIN
  );
}

function stableSpeakerSideConfidence(state = {}, speakerId = "") {
  const speaker = (state.speakers || []).find((item) => item.speakerId === speakerId) || {};
  const sideId = normalizeSideId(speaker.sideId);
  if (!sideId) return 0;
  if (isModeratorSideAssignment({
    speakerId,
    reason: speaker.assignmentReason || speaker.floorRoleReason || "",
    evidenceQuote: speaker.sampleText || "",
    state
  })) return 0;
  if (Number(speaker.turnCount || 0) >= 4 || Number(speaker.wordCount || 0) >= 120 || Number(speaker.sideConfidence || 0) >= 0.86) {
    return clamp01(speaker.sideConfidence, 0);
  }
  return 0;
}

function applyDiarizationSideCollisionState(state = {}, floorState = {}) {
  return (state.speakers || []).map((speaker) => {
    if (!speaker?.speakerId || !speakerHasSideOwnershipCollision({ ...state, floorState }, speaker.speakerId)) return speaker;
    return {
      ...speaker,
      sideId: undefined,
      sideConfidence: Math.min(Number(speaker.sideConfidence || 0), 0.49),
      identityStatus: "side_collision",
      identityConfidence: Math.max(Number(speaker.identityConfidence || 0), 0.84),
      aliasReason: "Raw diarization label carried stance-bearing content for both debate sides.",
      assignmentReason: "Using utterance-level side ownership because this raw speaker label carried both Blue side and Red side content."
    };
  });
}

function floorSpeakerStateFor(state = {}, speakerId = "") {
  const normalizedId = cleanClaimText(speakerId || "");
  if (!normalizedId) return null;
  const floorState = normalizeFloorState(state.floorState || state.floorState || {});
  return (floorState.speakers || []).find((speaker) => speaker.speakerId === normalizedId) || null;
}

function floorUtterancesFor(state = {}, turnIds = []) {
  const ids = new Set(uniqueStrings(turnIds || []));
  if (!ids.size) return [];
  const floorState = normalizeFloorState(state.floorState || state.floorState || {});
  return (floorState.utterances || []).filter((utterance) => ids.has(utterance.utteranceId) || (utterance.rawTurnIds || []).some((id) => ids.has(id)));
}

function speakerHasDurableDebaterEvidence(state = {}, speakerId = "") {
  const points = (state.points || []).filter((point) => point.speakerId === speakerId && isScoredPoint(point));
  if (points.length >= 2) return true;
  return points.some((point) => wordCount(`${point.claim || ""} ${point.quote || ""}`) >= 28 && !isQuestionOnlyPoint(point.claim || "", point.quote || "", point.quote || ""));
}

function speakerHasFloorDebaterEvidence(state = {}, speakerId = "", turnIds = []) {
  const floor = floorSpeakerStateFor(state, speakerId);
  if (floor?.role === DEBATER_SPEAKER && Number(floor.confidence || 0) >= 0.52) return true;
  if (hasStrongDebaterSideHint(floor)) return true;
  const annotations = floorUtterancesFor(state, turnIds);
  if (annotations.some((item) => (
    item.speakerRole === DEBATER_SPEAKER
    && Number(item.roleConfidence || 0) >= 0.58
    && (item.claimEligible || item.sideMapEligible || item.stanceBearing)
  ))) return true;
  return speakerHasDurableDebaterEvidence(state, speakerId);
}

function isNeutralFloorSpeaker(state = {}, speakerId = "") {
  if (!hasUsableFloorState(state)) return false;
  const speaker = (state.speakers || []).find((item) => item.speakerId === speakerId);
  const floor = floorSpeakerStateFor(state, speakerId);
  const role = normalizeFloorSpeakerRole(floor?.role || speaker?.speakerRole);
  const confidence = Math.max(Number(floor?.confidence || 0), Number(speaker?.floorRoleConfidence || 0));
  return role === NEUTRAL_SPEAKER && confidence >= 0.68;
}

function hasUsableFloorState(state = {}) {
  const floorInput = state.floorState || state.floorState;
  if (!floorInput || typeof floorInput !== "object") return false;
  const floor = normalizeFloorState(floorInput);
  return Boolean(
    (floor.speakers || []).length
    || (floor.utterances || []).length
    || (floor.phase !== "unknown" && Number(floor.phaseConfidence || 0) >= 0.35)
  );
}

function isSpeakerSideMapEligible(state = {}, speakerId = "", turnIds = []) {
  if (!speakerId) return false;
  if (!hasUsableFloorState(state)) return true;
  if (isNeutralFloorSpeaker(state, speakerId)) return false;
  if (speakerHasSideOwnershipCollision(state, speakerId)) return false;
  return speakerHasFloorDebaterEvidence(state, speakerId, turnIds);
}

function isSpeakerClaimEligible(state = {}, speakerId = "", turnIds = []) {
  if (!speakerId) return false;
  if (!hasUsableFloorState(state)) return true;
  if (isNeutralFloorSpeaker(state, speakerId)) return false;
  const annotations = floorUtterancesFor(state, turnIds);
  if (annotations.length) {
    if (annotations.some((item) => item.claimEligible || item.scoreEligible || item.speakerRole === DEBATER_SPEAKER)) return true;
    if (annotations.some((item) => item.contextOnly && item.speakerRole === NEUTRAL_SPEAKER)) return false;
  }
  return speakerHasFloorDebaterEvidence(state, speakerId, turnIds);
}

function isTurnClaimEligible(state = {}, turn = {}) {
  if (!turn?.speakerId) return false;
  if (!isAnalyzableTurn(turn)) return false;
  if (!hasUsableFloorState(state)) return true;
  if (turn.contextOnly && normalizeFloorSpeakerRole(turn.speakerRole) === NEUTRAL_SPEAKER) return false;
  return isSpeakerClaimEligible(state, turn.speakerId, [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])]);
}

function normalizeCleaningAgentUtterances(items = [], rawTurns = [], fallbackUtterances = []) {
  const rawTurnsById = new Map((rawTurns || []).filter((turn) => turn?.id).map((turn) => [turn.id, turn]));
  const output = [];
  for (const item of Array.isArray(items) ? items : []) {
    const speakerId = cleanClaimText(item?.speakerId || "");
    const rawTurnIds = uniqueStrings(Array.isArray(item?.rawTurnIds) ? item.rawTurnIds.map((id) => cleanClaimText(id)) : []);
    const sourceTurns = rawTurnIds.map((id) => rawTurnsById.get(id)).filter((turn) => turn?.speakerId === speakerId);
    if (!speakerId || !sourceTurns.length || sourceTurns.length !== rawTurnIds.length) continue;

    const sourceText = cleanClaimText(sourceTurns.map((turn) => turn.text || "").join(" "));
    let text = cleanClaimText(item?.text || sourceText);
    if (!isCleanedTextFaithful(text, sourceText)) {
      text = sourceText;
    }
    if (!text || !shouldEmitTranscriptSegment(text)) continue;

    const utteranceId = `utt-${stableTextHash(`${speakerId} ${rawTurnIds.join(" ")} ${text}`)}`;
    output.push({
      utteranceId,
      speakerId,
      text,
      quote: text,
      rawTurnIds,
      startSec: sourceTurns.find((turn) => turn.startSec !== undefined)?.startSec,
      endSec: [...sourceTurns].reverse().find((turn) => turn.endSec !== undefined)?.endSec,
      at: Math.max(...sourceTurns.map((turn) => Number(turn.at || 0)), Date.now()),
      speakerOwnershipConfidence: Math.max(0, Math.min(1, Number(item?.speakerOwnershipConfidence ?? 0.85))),
      isComplete: Boolean(item?.isComplete ?? /[.!?]$/.test(text)),
      cleanupNotes: cleanClaimText(item?.cleanupNotes || "Cleaned punctuation and sentence boundary while preserving speaker ownership.")
    });
  }

  const seen = new Set();
  return output
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    .filter((utterance) => {
      const key = `${utterance.speakerId}:${utterance.rawTurnIds.join("+")}:${normalizeTranscript(utterance.text)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(output.length, fallbackUtterances.length));
}

function isCleanedTextFaithful(cleaned = "", source = "") {
  const sourceTokens = meaningfulTokens(source);
  const cleanedTokens = meaningfulTokens(cleaned);
  if (!sourceTokens.length || !cleanedTokens.length) return false;
  const sourceSet = new Set(sourceTokens);
  const overlap = cleanedTokens.filter((token) => sourceSet.has(token)).length / Math.max(1, cleanedTokens.length);
  const lengthRatio = cleaned.length / Math.max(1, source.length);
  return overlap >= 0.62 && lengthRatio >= 0.55 && lengthRatio <= 1.6;
}

function alignPointSidesToSpeakers(points = [], state = {}) {
  return (points || []).map((point) => {
    const utteranceOwner = pointUtteranceOwnership(state, point);
    if (utteranceOwner.sideId && utteranceOwner.confidence >= OWNER_SIDE_CONFIDENCE_MIN) {
      return {
        ...point,
        sideId: utteranceOwner.sideId,
        sideOwnershipMode: utteranceOwner.mode,
        sideOwnershipConfidence: utteranceOwner.confidence,
        sideOwnershipReason: utteranceOwner.reason || point.sideOwnershipReason || ""
      };
    }
    if (speakerHasSideOwnershipCollision(state, point.speakerId)) return point;
    const speakerSide = coerceInitialSideAnchor(state, point.speakerId, speakerSideFromState(state, point.speakerId));
    return speakerSide && speakerSide !== point.sideId ? { ...point, sideId: speakerSide } : point;
  });
}

function isValidOwnedInconsistencyCandidate(candidate, state, pointsById) {
  const speakerId = candidate?.speakerId || "";
  const accusedSideId = inconsistencySideId(candidate);
  if (!speakerId || !accusedSideId) return false;
  if (!isDeclarativeSpeakerStandardQuote(candidate.quoteA) || !isDeclarativeSpeakerStandardQuote(candidate.quoteB)) return false;
  const referencedPoints = (candidate.pointIds || []).map((id) => pointsById.get(id)).filter(Boolean);
  if (referencedPoints.length !== 2) return false;
  if ((candidate.pointIds || []).length && referencedPoints.length !== candidate.pointIds.length) return false;
  if (referencedPoints.some((point) => point.sideId !== accusedSideId || !isEligibleInconsistencyPoint(point))) return false;
  const quoteASpeakerId = candidate.quoteASpeakerId || referencedPoints[0]?.speakerId || speakerId;
  const quoteBSpeakerId = candidate.quoteBSpeakerId || referencedPoints[1]?.speakerId || speakerId;
  if (!quoteASpeakerId || !quoteBSpeakerId) return false;
  if (referencedPoints[0]?.speakerId !== quoteASpeakerId || referencedPoints[1]?.speakerId !== quoteBSpeakerId) return false;
  if (isOpponentInconsistencyAccusation(candidate)) return false;
  const quoteAText = [
    ...(state.utterances || [])
      .filter((utterance) => utterance.speakerId === quoteASpeakerId)
      .map((utterance) => utterance.text),
    ...(state.points || [])
      .filter((point) => point.speakerId === quoteASpeakerId)
      .flatMap((point) => [point.claim, point.quote])
  ].join(" ");
  const quoteBText = [
    ...(state.utterances || [])
      .filter((utterance) => utterance.speakerId === quoteBSpeakerId)
      .map((utterance) => utterance.text),
    ...(state.points || [])
      .filter((point) => point.speakerId === quoteBSpeakerId)
      .flatMap((point) => [point.claim, point.quote])
  ].join(" ");
  return quoteMatchesOwnershipText(candidate.quoteA, quoteAText) && quoteMatchesOwnershipText(candidate.quoteB, quoteBText);
}

function isValidDeterministicInconsistencyArtifact(candidate, state, pointsById) {
  const speakerId = candidate?.speakerId || "";
  const accusedSideId = inconsistencySideId(candidate);
  if (!speakerId || !accusedSideId) return false;
  const referencedPoints = (candidate.pointIds || []).map((id) => pointsById.get(id)).filter(Boolean);
  if (referencedPoints.length !== 2) return false;
  if (referencedPoints.some((point) => point.sideId !== accusedSideId)) return false;
  const quoteASpeakerId = candidate.quoteASpeakerId || referencedPoints[0]?.speakerId || speakerId;
  const quoteBSpeakerId = candidate.quoteBSpeakerId || referencedPoints[1]?.speakerId || speakerId;
  if (!quoteASpeakerId || !quoteBSpeakerId) return false;
  if (!isDeclarativeSpeakerStandardQuote(candidate.quoteA) || !isDeclarativeSpeakerStandardQuote(candidate.quoteB)) return false;
  if (isOpponentInconsistencyAccusation(candidate)) return false;
  if (standardsAreSameRuleDifferentConclusion(candidate.standardA, candidate.standardB, candidate.quoteA, candidate.quoteB)) return false;
  const quoteAText = [
    ...(state.utterances || [])
      .filter((utterance) => utterance.speakerId === quoteASpeakerId)
      .map((utterance) => utterance.text),
    ...referencedPoints.filter((point) => point.speakerId === quoteASpeakerId).flatMap((point) => [point.claim, point.quote])
  ].join(" ");
  const quoteBText = [
    ...(state.utterances || [])
      .filter((utterance) => utterance.speakerId === quoteBSpeakerId)
      .map((utterance) => utterance.text),
    ...referencedPoints.filter((point) => point.speakerId === quoteBSpeakerId).flatMap((point) => [point.claim, point.quote])
  ].join(" ");
  return quoteMatchesOwnershipText(candidate.quoteA, quoteAText) && quoteMatchesOwnershipText(candidate.quoteB, quoteBText);
}

function isOpponentInconsistencyAccusation(candidate) {
  const text = normalizeTranscript(`${candidate.summary || ""} ${candidate.standardA || ""} ${candidate.standardB || ""} ${candidate.quoteA || ""} ${candidate.quoteB || ""}`);
  const hasSecondPerson = /\b(you|your|youre|youve|youll|you'd)\b/.test(text);
  const isCallout = /\b(why is|why are|what i find|happy to say|get mad|double standard|inconsistent|inconsistency|selective|apply|applied|label)\b/.test(text);
  const quoteQuestion = /\?/.test(`${candidate.quoteA || ""} ${candidate.quoteB || ""}`);
  return quoteQuestion || (hasSecondPerson && isCallout);
}

function standardsAreSameRuleDifferentConclusion(standardA = "", standardB = "", quoteA = "", quoteB = "") {
  const a = normalizeTranscript(`${standardA} ${quoteA}`);
  const b = normalizeTranscript(`${standardB} ${quoteB}`);
  if (!a || !b) return false;
  const bothIntent = /\b(intent|motive)\b/.test(a) && /\b(intent|motive)\b/.test(b);
  const bothCapability = /\b(could|capable|capability)\b/.test(a) && /\b(could|capable|capability)\b/.test(b);
  const bothCasualty = /\b(killed|displaced|casualt|death|civilian)\b/.test(a) && /\b(killed|displaced|casualt|death|civilian)\b/.test(b);
  const changedEvidenceRule = /\b(actions?|words?|statements?|minority|majority|official|government|policy|intent)\b/.test(a)
    && /\b(actions?|words?|statements?|minority|majority|official|government|policy|intent)\b/.test(b)
    && (
      (/\b(actions?)\b/.test(a) && /\b(statements?|minority|majority|official)\b/.test(b))
      || (/\b(statements?|minority|majority|official)\b/.test(a) && /\b(actions?)\b/.test(b))
    );
  if (changedEvidenceRule) return false;
  if (!(bothIntent || bothCapability || bothCasualty)) return false;
  const aTokens = meaningfulTokens(standardA);
  const bTokens = meaningfulTokens(standardB);
  if (!aTokens.length || !bTokens.length) return false;
  const bSet = new Set(bTokens);
  const overlap = aTokens.filter((token) => bSet.has(token)).length / Math.max(1, Math.min(aTokens.length, bTokens.length));
  return overlap >= 0.48;
}

function quoteMatchesOwnershipText(quote = "", ownershipText = "") {
  const quoteTokens = meaningfulTokens(quote);
  if (quoteTokens.length < 3) return false;
  const ownerTokens = new Set(meaningfulTokens(ownershipText));
  if (!ownerTokens.size) return false;
  const overlap = quoteTokens.filter((token) => ownerTokens.has(token)).length / Math.max(1, quoteTokens.length);
  return overlap >= 0.62;
}

function compactDebateForVerification(state = {}) {
  const normalized = normalizeClaimState(state);
  return {
    topic: truncatePromptText(normalized.topic || "", 120),
    sides: normalized.sides.map((side) => ({
      side: sideColorName(side.id),
      label: truncatePromptText(confirmedSideLabel(side), 90),
      speakerIds: side.speakerIds || []
    })),
    speakers: normalized.speakers.map((speaker) => ({
      speakerId: speaker.speakerId,
      side: sideColorName(speaker.sideId),
      confidence: Number(speaker.sideConfidence || 0).toFixed(2)
    }))
  };
}

function formatTurnsBySpeaker(turns = []) {
  const grouped = new Map();
  for (const turn of turns || []) {
    if (!turn?.speakerId || !turn?.text) continue;
    grouped.set(turn.speakerId, [
      ...(grouped.get(turn.speakerId) || []),
      {
        id: turn.id,
        rawTurnIds: Array.isArray(turn.rawTurnIds) ? turn.rawTurnIds : turn.turnIds || [],
        text: cleanClaimText(turn.text),
        isFinal: Boolean(turn.isFinal)
      }
    ]);
  }
  return [...grouped.entries()].map(([speakerId, speakerTurns]) => ({ speakerId, turns: speakerTurns }));
}

function formatTurnsInOrder(turns = []) {
  return (turns || [])
    .filter((turn) => turn?.speakerId && turn?.text)
    .map((turn) => ({
      id: turn.id,
      speakerId: turn.speakerId,
      rawTurnIds: Array.isArray(turn.rawTurnIds) ? turn.rawTurnIds : turn.turnIds || [],
      text: cleanClaimText(turn.text),
      isFinal: Boolean(turn.isFinal)
    }));
}

async function verifySelectedPoints(points, state, turns, { model = config.groundingModel, timeoutMs = FACT_CHECKER_DEFAULT_TIMEOUT_MS, trace } = {}) {
  const contextualPoints = points.filter((point) => !shouldExternallyVerifyPoint(point));
  const searchablePoints = points.filter(shouldExternallyVerifyPoint);
  const contextualResults = contextualPoints.map(markPointNeedsContextWithoutSearch);
  if (!searchablePoints.length) {
    logDeterministicStep(trace, "Fact Checker Agent:skipped", {
      reason: "no-searchable-factual-points",
      contextualPoints: contextualPoints.length
    });
    return contextualResults;
  }
  const verificationInputs = searchablePoints.map((point) => buildVerificationContext(point, state, turns));
  let audit = {};
  if (config.firecrawlApiKey) {
    audit = await runFirecrawlSearchFactAudit({
      trace,
      points: searchablePoints,
      verificationInputs,
      state,
      timeoutMs
    }).catch((error) => {
      console.log(`firecrawl search fact audit fallback: ${error instanceof Error ? error.message : "unknown error"}`);
      return {};
    });
  }

  if (!Array.isArray(audit?.points) || !audit.points.length) {
    const prompt = [
      "You are debatly's factual audit pass.",
      "Use Google Search grounding only for concrete public facts in the supplied Claim cards / fact-check jobs. Do not add new claims.",
      "Do not change speakerId, role, claim, quote, turnIds, or assertion fields. Only decide factStatus, evidenceBasis, scoreEligible, confidence, why, sources, and noSourceReason.",
      "Return strict JSON only.",
      "Schema:",
      "{",
      '  "points": [{"id":"same id","factStatus":"verified|contradicted|no_clear_source|cannot_verify","evidenceBasis":"external_fact|contextual|transcript_only","scoreEligible":false,"confidence":0.0,"why":"one sentence explanation","sources":[{"title":"source title","uri":"https://..."}],"noSourceReason":"why no source is attached, if none"}]',
      "}",
      "Fact status meanings:",
      "- verified: reliable external evidence supports the factual core of the claim, not merely that the transcript or a source repeats the topic.",
      "- contradicted: reliable external evidence contradicts the factual core.",
      "- no_clear_source: no reliable source was found that clearly verifies or contradicts the factual core.",
      "- cannot_verify: the point is opinion, hypothetical, framing, legal interpretation, motive, or debate logic rather than an external fact.",
      "Evidence basis meanings:",
      "- external_fact: public evidence directly supports or contradicts the factual core.",
      "- contextual: the point depends on interpretation, comparison, legal framing, motive, or debate context.",
      "- transcript_only: the only support is that the speaker said it or a source repeats/mentions the topic.",
      "Set scoreEligible true only when evidenceBasis is external_fact and factStatus is verified or contradicted.",
      "Every fact-check job must receive a status and explanation. If there is no useful source, say that explicitly in why.",
      "Write why for a normal audience: one short sentence, maximum 35 words.",
      "Return at most 2 sources per claim. Prefer primary or highly credible sources.",
      "Do not use internal phrases like 'grounding returned' or 'additional context found'.",
      "Verify only when every material part of the claim is supported, including numbers, dates, named sources, and qualifiers like 'including natural causes'. If sources support only part of a compound claim, return no_clear_source.",
      "Use the local transcript context to resolve phrases like 'day one', 'this', 'that', and 'they' before searching.",
      "If the claim is a rhetorical comparison, legal interpretation, transcript interpretation, intent claim, or hypothetical rather than a concrete external factual claim, return cannot_verify with noSourceReason and no sources.",
      `Compact debate state: ${stringifyAgentContext(compactDebateForVerification(state))}`,
      `Supplied Claim cards with context: ${stringifyAgentContext(verificationInputs)}`
    ].join("\n");

    audit = await runGroundedFactAudit({
      trace,
      model,
      prompt,
      timeoutMs,
      pointCount: searchablePoints.length,
      speakerCount: uniqueStrings(searchablePoints.map((point) => point.speakerId)).length
    }).catch((error) => {
      console.log(`point verification fallback: ${error instanceof Error ? error.message : "unknown error"}`);
      return {};
    });
  }

  const auditsById = new Map((Array.isArray(audit?.points) ? audit.points : []).map((point) => [point?.id, point]));
  const searchableResults = await Promise.all(searchablePoints.map(async (point) => {
    const audited = auditsById.get(point.id) || {};
    const fallbackStatus = point.factStatus === "checking" ? "no_clear_source" : point.factStatus;
    const factStatus = normalizeFactStatus(audited.factStatus || fallbackStatus || "no_clear_source");
    let sources = normalizeSources(audited.sources);
    const fallbackWhy = point.factStatus === "checking"
      ? "No completed source result was returned for this point yet."
      : point.why;
    let why = cleanClaimText(audited.why || fallbackWhy || (sources.length ? "Relevant source context found." : "No useful source was found for this point yet."));
    let noSourceReason = cleanClaimText(audited.noSourceReason || (!sources.length ? why : ""));
    if (!sources.length && shouldUseFirecrawlFallback(point, factStatus, audited)) {
      const fallback = await firecrawlPointFallback(point, trace);
      if (fallback.sources.length) {
        sources = fallback.sources;
        why = fallback.why;
        noSourceReason = "";
      }
    }
    const evidenceBasis = normalizeSourceEvidenceBasis(audited.evidenceBasis || point.evidenceBasis, {
      status: factStatus,
      sources,
      explanation: why,
      point
    });
    const scoreEligible = isSourceScoreEligible({
      ...point,
      ...audited,
      factStatus,
      status: factStatus,
      evidenceBasis,
      sources,
      why
    });
    return {
      ...point,
      factStatus,
      evidenceBasis,
      scoreEligible,
      confidence: Math.max(0, Math.min(1, Number(audited.confidence ?? point.confidence ?? 0.5))),
      why,
      sources,
      noSourceReason,
      audit: {
        ...point.audit,
        factExplanation: why,
        evidenceBasis,
        scoreEligible,
        liveSourceTimedOut: false,
        sources
      }
    };
  }));
  const byId = new Map([...contextualResults, ...searchableResults].map((point) => [point.id, point]));
  return points.map((point) => byId.get(point.id) || point);
}

async function runGroundedFactAudit({ trace, model, prompt, timeoutMs, pointCount, speakerCount }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const thinkingConfig = /^gemini-3/i.test(String(model || ""))
    ? { thinkingLevel: "MEDIUM", includeThoughts: false }
    : { thinkingBudget: FACT_CHECKER_THINKING_BUDGET, includeThoughts: false };
  try {
    const response = await generateContentForAgent({
      trace,
      agent: "Fact Checker Agent",
      model,
      contents: prompt,
      config: {
        temperature: 0,
        maxOutputTokens: factCheckerOutputTokenLimit(pointCount),
        thinkingConfig,
        httpOptions: { timeout: timeoutMs },
        abortSignal: controller.signal,
        tools: [{ googleSearch: {} }]
      },
      meta: {
        points: pointCount,
        speakers: speakerCount,
        grounding: "google_search",
        timeoutMs
      }
    });
    try {
      return parseJsonWithLocalRepair(response.text || "{}");
    } catch (parseError) {
      logDeterministicStep(trace, "Fact Checker Agent:json_parse_error", {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        outputChars: String(response.text || "").length
      });
      const repairResponse = await withTimeout(
        generateContentForAgent({
          trace,
          agent: "Fact Checker Agent JSON Repair",
          model: config.fastModel,
          contents: [
            "Repair this invalid JSON response from the Fact Checker Agent.",
            "Return strict JSON only. Preserve claim ids, factStatus, evidenceBasis, scoreEligible, confidence, why, sources, and noSourceReason.",
            "Schema: {\"points\":[{\"id\":\"same id\",\"factStatus\":\"verified|contradicted|no_clear_source|cannot_verify\",\"evidenceBasis\":\"external_fact|contextual|transcript_only\",\"scoreEligible\":false,\"confidence\":0.0,\"why\":\"short explanation\",\"sources\":[{\"title\":\"source title\",\"uri\":\"https://...\"}],\"noSourceReason\":\"optional\"}]}",
            `Invalid JSON text: ${response.text || ""}`
          ].join("\n"),
          config: {
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: factCheckerOutputTokenLimit(pointCount)
          },
          meta: {
            points: pointCount,
            repairFor: "fact_checker_json"
          }
        }),
        Math.min(7000, Math.max(2500, timeoutMs)),
        "Fact Checker JSON repair timed out"
      );
      return parseJsonWithLocalRepair(repairResponse.text || "{}");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runFirecrawlSearchFactAudit({ trace, points = [], verificationInputs = [], state = {}, timeoutMs = FACT_CHECKER_DEFAULT_TIMEOUT_MS }) {
  const retrievalStartedAt = Date.now();
  const searchPackages = await Promise.all(points.map(async (point, index) => {
    const context = verificationInputs[index] || buildVerificationContext(point, state, []);
    const search = await firecrawlSearchForPoint(point, context, trace).catch((error) => ({
      query: buildFirecrawlSearchQuery(point, context),
      sources: [],
      error: error instanceof Error ? error.message : String(error)
    }));
    return {
      id: point.id,
      speakerId: point.speakerId,
      sideId: point.sideId,
      role: point.role,
      claim: context.claim || point.claim,
      quote: context.quote || point.quote,
      query: search.query,
      searchError: search.error || "",
      sources: normalizeSources(search.sources).slice(0, 4),
      sourceSnippets: (search.sources || []).slice(0, 4).map((source) => ({
        title: source.title,
        uri: source.uri || source.url,
        description: truncatePromptText(source.description || source.snippet || "", 320)
      }))
    };
  }));
  const retrievalMs = Date.now() - retrievalStartedAt;
  const sourceCount = searchPackages.reduce((sum, item) => sum + item.sources.length, 0);
  logDeterministicStep(trace, "Firecrawl Search:retrieval-complete", {
    points: points.length,
    sourceCount,
    elapsedMs: retrievalMs
  });

  const verdictPackages = searchPackages.map((item) => ({
    id: item.id,
    claim: item.claim,
    quote: item.quote,
    searchError: item.searchError,
    sources: item.sourceSnippets
  }));
  const prompt = [
    "You are debatly's source verdict writer.",
    "Use only the supplied Firecrawl Search snippets. Do not search, browse, or use outside knowledge.",
    "Do not change claim ids. Return strict JSON only.",
    "Schema:",
    "{",
    '  "points": [{"id":"same id","factStatus":"verified|contradicted|no_clear_source|cannot_verify","evidenceBasis":"external_fact|contextual|transcript_only","scoreEligible":false,"confidence":0.0,"why":"one short audience sentence","sources":[{"title":"source title","uri":"https://..."}],"noSourceReason":"why no source is attached, if none"}]',
    "}",
    "Status meanings:",
    "- verified: the supplied sources externally support the factual core of the claim, not merely the topic or the transcript wording.",
    "- contradicted: the supplied sources externally contradict the factual core.",
    "- no_clear_source: the supplied sources are not enough to verify or contradict the claim.",
    "- cannot_verify: the claim is opinion, hypothetical, framing, legal interpretation, or debate logic rather than an external fact.",
    "Evidence basis meanings:",
    "- external_fact: public evidence directly supports or contradicts the factual core.",
    "- contextual: the point depends on interpretation, comparison, legal framing, motive, or debate context.",
    "- transcript_only: the only support is that the speaker said it or a source repeats/mentions the topic.",
    "Rules:",
    "- Prefer sources already supplied under the same claim id.",
    "- Return at most 2 sources per claim.",
    "- If a claim has no supplied sources, use no_clear_source unless it is clearly cannot_verify.",
    "- Verify only when every material part of the claim is supported, including numbers, dates, named sources, and qualifiers like 'including natural causes'. If sources support only part of a compound claim, return no_clear_source.",
    "- If the sources only mention the topic, name, event, or repeat the claim without checking the factual core, return no_clear_source with scoreEligible false.",
    "- Set scoreEligible true only when evidenceBasis is external_fact and factStatus is verified or contradicted.",
    "- Write why for a normal audience, maximum 35 words.",
    "- Do not say 'Firecrawl', 'search result', 'snippet', 'pipeline', or 'agent'.",
    `Claim cards and retrieved sources: ${stringifyAgentContext(verdictPackages)}`
  ].join("\n");

  const response = await withTimeout(
    generateContentForAgent({
      trace,
      agent: "Fact Checker Verdict Agent",
      model: config.fastModel,
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        maxOutputTokens: factCheckerOutputTokenLimit(points.length)
      },
      meta: {
        points: points.length,
        grounding: "firecrawl_search",
        retrievalMs,
        sourceCount,
        timeoutMs
      }
    }),
    Math.max(2500, timeoutMs),
    "Fact Checker Verdict Agent timed out"
  );

  const parsed = parseJsonWithLocalRepair(response.text || "{}");
  const retrievedSourcesById = new Map(searchPackages.map((item) => [item.id, item.sources]));
  const normalizedPoints = (Array.isArray(parsed?.points) ? parsed.points : []).map((item) => {
    const status = normalizeFactStatus(item?.factStatus || "no_clear_source");
    let sources = normalizeSources(item?.sources);
    const retrievedSources = retrievedSourcesById.get(item?.id) || [];
    if (!sources.length && ["verified", "contradicted"].includes(status)) {
      sources = retrievedSources.slice(0, 2);
    }
    const evidenceBasis = normalizeSourceEvidenceBasis(item?.evidenceBasis, {
      status,
      sources,
      explanation: item?.why || item?.explanation || "",
      point: points.find((point) => point.id === item?.id)
    });
    const scoreEligible = isSourceScoreEligible({
      ...item,
      factStatus: status,
      status,
      evidenceBasis,
      sources,
      why: item?.why || item?.explanation || ""
    });
    return {
      ...item,
      factStatus: status,
      evidenceBasis,
      scoreEligible,
      why: cleanClaimText(item?.why || item?.explanation || "No clear source result was returned for this point."),
      noSourceReason: cleanClaimText(item?.noSourceReason || (!sources.length ? item?.why || "No clear source result was returned for this point." : "")),
      sources
    };
  });

  return { points: normalizedPoints };
}

async function firecrawlSearchForPoint(point, context = {}, trace) {
  const query = buildFirecrawlSearchQuery(point, context);
  const result = await researchWithFirecrawl(query, trace, {
    agent: "Firecrawl Search",
    pointId: point.id || "",
    speakerId: point.speakerId || ""
  });
  return {
    query,
    sources: extractFirecrawlSearchResults(result)
  };
}

function buildFirecrawlSearchQuery(point, context = {}) {
  const exactClaim = cleanSearchableClaim(context.claim || point?.claim || "");
  const contextText = [
    context.quote || point?.quote || "",
    ...(Array.isArray(context.exchangeContext) ? context.exchangeContext.map((turn) => turn.text || "") : []),
    ...(Array.isArray(context.sameSpeakerContext) ? context.sameSpeakerContext.map((turn) => turn.text || "") : [])
  ].join(" ");
  const needsContext = searchClaimNeedsContext(exactClaim);
  const contextHints = needsContext ? extractSearchContextHints(contextText, exactClaim).join(" ") : "";
  const query = cleanClaimText(`${exactClaim} ${contextHints}`).replace(/\s+/g, " ").trim();
  if (query.length <= 260) return query;
  return trimSearchQuery(query);
}

function cleanSearchableClaim(text = "") {
  return cleanClaimText(text)
    .replace(/^\s*(the\s+speaker|speaker\s+\d+|blue\s+side|red\s+side)\s+(claims?|argues?|says?|states?|asserts?)\s+(that\s+)?/i, "")
    .replace(/\baccording to the speaker\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function searchClaimNeedsContext(claim = "") {
  const text = cleanClaimText(claim || "");
  if (!text) return false;
  const hasNamedEntity = /\b[A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){1,}\b|\b[A-Z]{2,}\b/.test(text);
  const hasNumber = /\b\d{2,4}\b|\b\d+(?:,\d{3})+\b|%|\bpercent\b/i.test(text);
  const hasStrongSource = /\b(court|tribunal|report|study|poll|survey|newspaper|magazine|agency|department|commission|prosecutor|minister|president|prime minister|official|law|treaty|program|doctrine|system)\b/i.test(text);
  if (hasNamedEntity && (hasNumber || hasStrongSource || text.length >= 70)) return false;
  if (/\b(an?|the)\s+(official|minister|spokesperson|general|commander|doctor|researcher|witness|report|study|article|newspaper|magazine|committee)\b/i.test(text) && !hasNamedEntity) return true;
  if (/\b(this|that|these|those|it|its|the plan|the policy|the report|the case|the court|the car|the attack|the bombing|the war|last year|currently)\b/i.test(text)) return true;
  if (hasNumber && !hasNamedEntity) return true;
  if (text.length < 90 && !hasNamedEntity && !hasNumber) return true;
  return false;
}

function extractSearchContextHints(contextText = "", claim = "") {
  const raw = cleanClaimText(contextText || "");
  const claimKey = normalizeTranscript(claim || "");
  const hints = [];
  const properPhrases = raw.match(/\b[A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){1,}\b/g) || [];
  const acronyms = raw.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+)?\b/g) || [];
  const numbers = raw.match(/\b(?:\d{2,4}|\d+(?:,\d{3})+|[$€£]\s?\d+(?:\.\d+)?|[A-Za-z]+\s+\d{1,2},?\s+\d{4})\b/g) || [];
  for (const value of [...properPhrases, ...acronyms, ...numbers]) {
    const cleaned = cleanClaimText(value || "");
    if (!cleaned || cleaned.length < 2) continue;
    if (!isUsefulSearchContextHint(cleaned)) continue;
    if (claimKey.includes(normalizeTranscript(cleaned))) continue;
    hints.push(cleaned);
  }
  return uniqueStrings(hints).slice(0, 6);
}

function isUsefulSearchContextHint(value = "") {
  const normalized = normalizeTranscript(value || "");
  if (!normalized) return false;
  if (/^(okay|ok|right|so|yes|no|yeah|well|like|kind|sort|hold|wait|speaker|blue side|red side)\b/.test(normalized)) return false;
  if (/\b(they|them|their|there|theyre|we|you|i|im|hes|shes|thats|whats|heres|this|that)\b/.test(normalized)) return false;
  if (normalized.split(/\s+/).length === 1 && !/\b[A-Z]{2,}\b|\d/.test(value)) return false;
  return true;
}

function trimSearchQuery(query = "") {
  const cleaned = cleanClaimText(query || "");
  if (cleaned.length <= 260) return cleaned;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const kept = [];
  let length = 0;
  for (const token of tokens) {
    const nextLength = length + token.length + (kept.length ? 1 : 0);
    if (nextLength > 260) break;
    kept.push(token);
    length = nextLength;
  }
  return kept.join(" ");
}

function factCheckerOutputTokenLimit(pointCount = 1) {
  const count = Math.max(1, Number(pointCount || 1));
  return Math.min(FACT_CHECKER_MAX_OUTPUT_TOKENS, FACT_CHECKER_BASE_OUTPUT_TOKENS + (count - 1) * 280);
}

function shouldExternallyVerifyPoint(point) {
  if (!point?.id || !isAssertedPoint(point)) return false;
  const role = normalizePointRole(point.role);
  if (["framing", "dropped_point", "concession"].includes(role)) return false;
  const hasConcreteAnchor = hasConcreteVerificationAnchor(point);
  const hasResearchableAnchor = hasResearchableDebateAnchor(point);
  if (!hasConcreteAnchor && !hasResearchableAnchor) return false;
  if (isRhetoricalOrInterpretivePoint(point) && !hasQuotedStatementAnchor(point) && !hasResearchableAnchor) return false;
  return true;
}

function hasStandaloneDebateClaimAnchor(text = "") {
  const normalized = normalizeTranscript(text || "");
  if (!normalized) return false;
  return /\b(should|shouldnt|should not|must|must not|ought|ought not|legal|illegal|law|policy|ban|allow|require|forbid|right|rights|responsibility|moral|immoral|ethical|unethical|justified|unjustified|acceptable|unacceptable|harm|protect|force|freedom|authority|definition|defines|means|counts as|is not|are not|is a|are a|less worth|more worth)\b/.test(normalized);
}

function hasGenericSourceCheckAnchor(text = "") {
  const raw = String(text || "");
  const normalized = normalizeTranscript(raw);
  if (!normalized) return false;
  if (/\b\d{2,4}\b|%|\bpercent\b|\b(thousand|million|billion)\b|[$€£]\s?\d+/i.test(raw)) return true;
  if (/\b(report|study|poll|survey|research|data|source|published|according to|found|concluded|estimated|warned|charged|indicted|ruled|filed|announced|stated|said)\b/i.test(raw)) return true;
  if (/\b(court|tribunal|government|agency|department|parliament|congress|company|university|newspaper|magazine|organization|commission|prosecutor|minister|president|prime minister|official|law|policy|bill|treaty|program|plan)\b/i.test(raw)) return true;
  const namedPhrases = raw.match(/\b[A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){1,}\b/g) || [];
  const acronyms = raw.match(/\b[A-Z]{2,}(?:-[A-Z0-9]+)?\b/g) || [];
  return namedPhrases.length > 0 || acronyms.length > 0;
}

function hasNamedAttributionOrMeasurement(text = "") {
  return /\b\d{2,4}\b|%|\bpercent\b|\b(report|study|poll|survey|research|according to|published|said|stated|warned|charged|indicted|ruled|filed|court|government|agency|official)\b/i.test(text || "");
}

function isPureOpinionOrDebateLogicClaim(text = "") {
  const normalized = normalizeTranscript(text || "");
  if (!normalized) return true;
  return /\b(should|must|ought|right|wrong|good|bad|better|worse|justified|unjustified|acceptable|unacceptable|moral|immoral|proves|shows that|means that|trying to|wants to|intends to)\b/.test(normalized);
}

function markPointNeedsContextWithoutSearch(point) {
  const noSourceReason = "This point is opinion, framing, hypotheticals, or debate logic rather than a standalone external factual claim.";
  return {
    ...point,
    factStatus: point.factStatus === "checking" ? "cannot_verify" : point.factStatus,
    evidenceBasis: "contextual",
    scoreEligible: false,
    why: point.why && point.why !== "Fact check pending." ? point.why : noSourceReason,
    noSourceReason,
    sources: point.sources || [],
    audit: {
      ...point.audit,
      factExplanation: point.why && point.why !== "Fact check pending." ? point.why : noSourceReason,
      evidenceBasis: "contextual",
      scoreEligible: false,
      sources: point.sources || []
    }
  };
}

function buildVerificationContext(point, state, turns = []) {
  const allTurns = Array.isArray(turns) ? turns.filter(Boolean) : [];
  const turnIds = new Set(point.turnIds || []);
  const pointTurnIndexes = allTurns
    .map((turn, index) => (turnIds.has(turn.id) ? index : -1))
    .filter((index) => index !== -1);
  const firstIndex = pointTurnIndexes.length ? Math.min(...pointTurnIndexes) : -1;
  const lastIndex = pointTurnIndexes.length ? Math.max(...pointTurnIndexes) : -1;
  const exchange = firstIndex === -1
    ? allTurns.slice(-3)
    : allTurns.slice(Math.max(0, firstIndex - 1), Math.min(allTurns.length, lastIndex + 2));
  const sameSpeaker = allTurns
    .filter((turn) => turn.speakerId === point.speakerId)
    .slice(-3);
  return {
    id: point.id,
    speakerId: point.speakerId,
    sideId: point.sideId,
    role: point.role,
    claim: truncatePromptText(point.claim || "", 260),
    quote: truncatePromptText(point.quote || "", 320),
    burden: point.burden || "",
    assertionStatus: point.assertionStatus,
    assertionWhy: truncatePromptText(point.assertionWhy || "", 180),
    sameSpeakerContext: sameSpeaker.map(compactTurnForPrompt),
    exchangeContext: exchange.map(compactTurnForPrompt),
    currentPointReceipts: {
      turnIds: point.turnIds || [],
      sourceSpeakerId: point.sourceSpeakerId || point.speakerId
    }
  };
}

function compactTurnForPrompt(turn) {
  return {
    id: turn.id,
    speakerId: turn.speakerId,
    text: truncatePromptText(cleanClaimText(turn.text || ""), 260)
  };
}

function truncatePromptText(text = "", maxLength = 300) {
  const cleaned = cleanClaimText(text || "");
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function isRhetoricalOrInterpretivePoint(point) {
  const text = normalizeTranscript(`${point.claim || ""} ${point.quote || ""}`);
  if (/\b(intent|motive|genocidal intent|valid stance|morally right|morally wrong)\b/.test(text) && !/\b(said|stated|reported|court|icj|un|treaty|law|statute|quote|called|published)\b/.test(text)) return true;
  if (/\b(could|would|should|might)\b.*\b(if|because|therefore|according to)\b/.test(text) && !/\b\d{2,}|percent|killed|displaced|source|report\b/.test(text)) return true;
  if (/\b(genocide|war crime|crime against humanity|defensive war)\b/.test(text) && !/\b(icj|icc|court|convention|law|statute|scholar|report|un|amnesty|human rights|said|stated|ruled|filed)\b/.test(text)) return true;
  if (normalizePointRole(point.role) === "rebuttal" && /\b(your claim|according to .* logic|therefore according|worst claim|that does not make)\b/.test(text)) return true;
  if (/\b(used as an claim|characterizes|implying that|hypothetical|could kill everyone.*has not|could have erased.*has not)\b/.test(text)) return true;
  if (/\b(comparable to|worse than|better than)\b/.test(text) && !/\b\d{2,}|report|court|law|government|minister|official|statement\b/.test(text)) return true;
  return false;
}

function hasConcreteVerificationAnchor(point) {
  const raw = `${point.claim || ""} ${point.quote || ""}`;
  const text = normalizeTranscript(raw);
  if (/\b(definition|defined|legal definition)\b/.test(text) && /\b(genocide|war crime|crime against humanity|international law)\b/.test(text)) return true;
  if (/\b\d{2,4}\b|%|\bpercent\b|\bthousand\b|\bmillion\b|\bbillion\b|\b(killed|displaced|recognized|signed|voted|passed|filed|ruled|investigating|published|reported|estimated|separated)\b/.test(text)) return true;
  if (/\b(said|stated|called|claimed|announced|wrote|published|reported|found|concluded|testified|recognized|referred|referring|suggested|suggesting)\b/.test(text) && /["'‘’“”]/.test(raw)) return true;
  if (/\b(court|tribunal|parliament|congress|government|minister|president|prime minister|agency|commission|university|organization|company|party|speaker|member)\b/.test(text) && /\b(said|stated|reported|found|concluded|filed|ruled|investigating|recognized|killed|displaced|called|referred|suggested|suggesting)\b/.test(text)) return true;
  const capitalizedTerms = raw.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,}\b/g) || [];
  if (capitalizedTerms.length >= 1 && /\b(said|stated|called|reported|found|concluded|recognized|killed|displaced|kidnapped|targeted)\b/.test(text)) return true;
  return false;
}

function hasResearchableDebateAnchor(point) {
  const text = normalizeTranscript(`${point.claim || ""} ${point.quote || ""} ${point.burden || ""}`);
  if (!text || wordCount(text) < 5) return false;
  if (/\b(definition|defined|legal definition|genocide convention|international law)\b/.test(text) && /\b(genocide|war crime|crime against humanity|civilian|protected group)\b/.test(text)) return true;
  const hasNamedSubject = /\b(israel|israeli|gaza|hamas|palestinian|ukraine|ukrainian|russia|russian|putin|netanyahu|smotrich|gallant|icj|icc|un|amnesty|human rights watch|holocaust scholar|parliament|knesset)\b/.test(text);
  const hasVerifiableDomain = /\b(genocide|genocidal|war crime|civilian|intent|motive|destroy|destruction|buildings?|killed|displaced|children|human shields?|sovereign|military|nuclear|nuke|minority view|official statements?)\b/.test(text);
  if (hasNamedSubject && hasVerifiableDomain) return true;
  if (/\b\d{2,}|percent|killed|displaced|buildings?|children|civilians?|human shields?|official statements?|genocide convention|international law\b/.test(text)) return true;
  return false;
}

function hasQuotedStatementAnchor(point) {
  const raw = `${point.claim || ""} ${point.quote || ""}`;
  const text = normalizeTranscript(raw);
  return /\b(said|stated|called|referred|referring|suggested|suggesting|quote|his words|her words|their words)\b/.test(text)
    && /\b(parliament|congress|government|minister|president|prime minister|party|speaker|member|official|court|commission|agency|organization|company)\b/.test(text);
}

function shouldUseFirecrawlFallback(point, factStatus, audited) {
  if (!config.firecrawlApiKey) return false;
  if (audited?.sources?.length) return false;
  if (factStatus === "verified" || factStatus === "contradicted") return false;
  return point.factStatus === "checking" || /no completed source|no useful source|timed out|not enough public evidence/i.test(audited?.why || point.why || "");
}

async function firecrawlPointFallback(point, trace) {
  const result = await researchWithFirecrawl(
    buildFirecrawlSearchQuery(point, { claim: point.claim, quote: point.quote }),
    trace,
    {
      agent: "Firecrawl Fallback",
      pointId: point.id || "",
      speakerId: point.speakerId || ""
    }
  ).catch((error) => {
    console.log(`firecrawl point fallback skipped: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  });
  if (!result) return { sources: [], why: "" };
  return {
    sources: extractFirecrawlSources(result),
    why: summarizeFirecrawl(result)
  };
}

function normalizeThesisStatus(status, confirmedLabel) {
  if (status === "confirmed" && confirmedLabel) return "confirmed";
  return "forming";
}

function normalizeSidePositionLabel(candidate = "", fallback = "", context = "") {
  const direct = normalizeSideThesisLabel(candidate, context);
  if (direct) return direct;
  return normalizeSideThesisLabel(fallback, context);
}

function normalizeSideThesisLabel(label = "", context = "") {
  let cleaned = cleanAgentDisplayText(label || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.!?-]+|[\s]+$/g, "")
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length >= 44 && /\s[A-Za-z]{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/\s+[A-Za-z]{1,2}$/g, "").trim();
  }
  return isValidSidePositionLabel(cleaned, context) ? cleaned : "";
}

function isValidSidePositionLabel(label = "", context = "") {
  const cleaned = String(label || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  if (cleaned.length > SIDE_POSITION_MAX_CHARS) return false;
  if (/[,:;]$|\.\.\.$/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 14) return false;
  if (/[?!.]$/.test(cleaned) && cleaned.length < 16) return false;
  if (/\b(the|a|an|of|to|for|with|without|and|or|but|not|no|is|are|was|were|be|being|by|from|than|as|that|which|who|they|it|this|while|whereas|because|although|if|when|where|against|toward|towards|between|versus|vs|unlike|including|regarding|concerning|instead|rather)$/i.test(cleaned)) return false;
  if (/^(the\s+view\s+that|statements?\s+from|evidence\s+from|claims?\s+from|reports?\s+from|officials?\b|experts?\b)/i.test(cleaned)) return false;
  if (/\b(position\s+forming|thesis\s+forming|under\s+review|still\s+forming)\b/i.test(cleaned)) return false;
  if (isBroadNonContextualSideLabel(cleaned, context)) return false;
  return true;
}

function isBroadNonContextualSideLabel(label = "", context = "") {
  const normalizedLabel = normalizeTranscript(label);
  const normalizedContext = normalizeTranscript(context);
  if (!normalizedLabel || !normalizedContext) return false;
  const moralAbsolute = /\b(always|never|inherently|categorically)\b/.test(normalizedLabel)
    || /\b(is|are|was|were)\s+(not\s+)?(justified|acceptable|moral|immoral|right|wrong)\b/.test(normalizedLabel);
  if (!moralAbsolute) return false;
  const generic = new Set(["should", "would", "could", "were", "was", "are", "is", "did", "does", "do", "actions", "action", "side", "debate", "question", "claim", "justified", "justify", "acceptable", "moral", "right", "wrong", "prioritize", "whether"]);
  const contextTokens = meaningfulTokens(normalizedContext).filter((token) => !generic.has(token));
  if (contextTokens.length < 2) return false;
  const labelTokens = new Set(meaningfulTokens(normalizedLabel).filter((token) => !generic.has(token)));
  return contextTokens.every((token) => !labelTokens.has(token));
}

function normalizeSideThesisFields(side = {}) {
  const rawConfirmed = cleanClaimText(side.confirmedThesis || "");
  const rawLabel = cleanClaimText(side.label || side.stance || "");
  const confirmedLabel = normalizeSidePositionLabel(rawConfirmed || rawLabel);
  const thesisStatus = normalizeThesisStatus(side.thesisStatus, confirmedLabel);
  return {
    label: thesisStatus === "confirmed" ? confirmedLabel : "",
    thesisStatus,
    workingThesis: thesisStatus === "confirmed" ? "" : normalizeSidePositionLabel(side.workingThesis || rawLabel || ""),
    confirmedThesis: thesisStatus === "confirmed" ? confirmedLabel : "",
    thesisEvidencePointIds: uniqueStrings(Array.isArray(side.thesisEvidencePointIds) ? side.thesisEvidencePointIds : []),
    thesisUpdatedAt: Number.isFinite(Number(side.thesisUpdatedAt)) ? Number(side.thesisUpdatedAt) : undefined
  };
}

function confirmedSideLabel(side = {}) {
  const label = normalizeSidePositionLabel(side.confirmedThesis || side.label || "");
  return side.thesisStatus === "confirmed" && label ? label : "";
}

function clearSideThesis(side = {}, workingThesis = "") {
  return {
    ...side,
    label: "",
    confirmedThesis: "",
    workingThesis: normalizeSidePositionLabel(workingThesis || side.workingThesis || ""),
    thesisStatus: "forming",
    thesisEvidencePointIds: [],
    thesisUpdatedAt: side.thesisUpdatedAt
  };
}

function confirmSideThesis(side = {}, label = "", evidencePoints = []) {
  const confirmed = normalizeSidePositionLabel(label);
  return {
    ...side,
    label: confirmed,
    confirmedThesis: confirmed,
    workingThesis: "",
    thesisStatus: "confirmed",
    thesisEvidencePointIds: uniqueStrings((evidencePoints || []).map((point) => point.id).filter(Boolean)).slice(0, 8),
    thesisUpdatedAt: Date.now()
  };
}

function preserveConfirmedSideThesis(side = {}, label = "") {
  const confirmed = normalizeSidePositionLabel(label);
  return {
    ...side,
    label: confirmed,
    confirmedThesis: confirmed,
    workingThesis: "",
    thesisStatus: "confirmed",
    thesisEvidencePointIds: uniqueStrings(Array.isArray(side.thesisEvidencePointIds) ? side.thesisEvidencePointIds : []),
    thesisUpdatedAt: side.thesisUpdatedAt
  };
}

function resolveSideTheses(state = {}, candidateLabelsById = new Map()) {
  const baseSides = ensureTwoSides(state.sides || []);
  const sides = baseSides.map((side) => {
    const sidePoints = thesisEvidencePointsForSide(state, side.id);
    const opponentSide = baseSides.find((candidate) => candidate.id !== side.id) || {};
    const opponentPoints = thesisEvidencePointsForSide(state, opponentSide.id);
    const existingLabel = confirmedSideLabel(side);
    if (sidePoints.length < MIN_SIDE_THESIS_POINTS) {
      if (isUsableSideLabel(existingLabel, sidePoints, state.topic)) {
        return preserveConfirmedSideThesis(side, existingLabel);
      }
      return clearSideThesis(side, "");
    }

    const candidateLabel = cleanClaimText(candidateLabelsById.get(side.id) || "");
    if (isUsableSideLabel(candidateLabel, sidePoints, state.topic)) {
      return confirmSideThesis(side, candidateLabel, sidePoints);
    }
    if (isUsableSideLabel(existingLabel, sidePoints, state.topic)) {
      return preserveConfirmedSideThesis(side, existingLabel);
    }
    const fallbackLabel = deriveFallbackSideLabel(sidePoints, opponentPoints, state.topic)
      || deriveSinglePointSideLabel(sidePoints[0], state.topic)
      || deriveEarlyFallbackSideLabelFromClaim(sidePoints[0]?.claim || "");
    if (isUsableSideLabel(fallbackLabel, sidePoints, state.topic)) {
      return confirmSideThesis(side, fallbackLabel, sidePoints);
    }
    return clearSideThesis(side, "");
  });
  return {
    ...state,
    sides: dedupeSideThesisLabels({ ...state, sides })
  };
}

function thesisEvidencePointsForSide(state = {}, sideId = "") {
  const normalizedSideId = normalizeSideId(sideId);
  if (!normalizedSideId) return [];
  const pointClaims = (state.points || []).filter((point) => point.sideId === normalizedSideId && isThesisPoint(point));
  if (pointClaims.length) return pointClaims;
  return (state.artifacts?.claims || [])
    .filter((claim) => claim.sideId === normalizedSideId)
    .map((claim) => ({
      id: claim.pointId || claim.id,
      speakerId: claim.speakerId || "",
      sideId: claim.sideId,
      role: "claim",
      claim: claim.claim || "",
      quote: claim.quote || claim.claim || "",
      factStatus: claim.status === "verified" ? "verified" : claim.status === "contradicted" ? "contradicted" : "checking",
      confidence: 0.78,
      at: claim.at || Date.now()
    }))
    .filter((point) => cleanClaimText(point.claim || "").length >= 18);
}

function normalizeClaimState(input = {}) {
  const sides = ensureTwoSides(Array.isArray(input.sides) ? input.sides : []).map((side, index) => ({
    id: index === 0 ? "side-a" : "side-b",
    ...normalizeSideThesisFields(side),
    score: Number.isFinite(Number(side.score)) ? Math.round(Number(side.score)) : 0,
    speakerIds: Array.isArray(side.speakerIds) ? uniqueStrings(side.speakerIds) : [],
    color: index === 0 ? "blue" : "red",
    metrics: side.metrics || emptyCoreMetrics()
  }));

  const pointsFromInput = Array.isArray(input.points) ? input.points : [];
  const points = pointsFromInput.map((point) => normalizeDebatePoint(point, sides)).filter(Boolean);
  const speakers = mergeSpeakerProfiles(input.speakers || [], sides, points);
  const rebuttals = Array.isArray(input.rebuttals) ? input.rebuttals.map(normalizeRebuttal).filter(Boolean) : [];

  return enforceSpeakerPointSides({
    topic: input.topic || "",
    speakerDisplayNames: normalizeSpeakerDisplayNames(input.speakerDisplayNames),
    speakers,
    sides,
    points,
    rebuttals,
    speakerPositionMemory: normalizeSpeakerPositionMemory(input.speakerPositionMemory || []),
    featuredQuote: normalizeFeaturedQuoteState(input.featuredQuote),
    featuredQuoteAttemptedAt: Number(input.featuredQuoteAttemptedAt || 0),
    scores: normalizeScores(input.scores),
    floorState: normalizeFloorState(input.floorState),
    utterances: normalizeCleanUtterances(input.utterances),
    dialogueWindows: normalizeDialogueWindows(input.dialogueWindows),
    analysis: normalizeDirectAnalysisState(input.analysis),
    artifacts: normalizeArtifacts(input.artifacts),
    scorecard: normalizeScorecard(input.scorecard),
    claims: [],
    contradictions: Array.isArray(input.contradictions) ? input.contradictions : []
  });
}

function normalizeSpeakerDisplayNames(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const names = {};
  for (const [rawId, rawName] of Object.entries(value)) {
    const speakerId = cleanClaimText(rawId || "");
    const displayName = cleanClaimText(rawName || "");
    if (!speakerId || !/^Speaker\s+\d+$/i.test(speakerId) || !displayName) continue;
    names[speakerId] = displayName.slice(0, 48);
  }
  return names;
}

function normalizeDialogueWindows(windows) {
  return Array.isArray(windows)
    ? windows
        .filter((window) => window?.windowId && Array.isArray(window.turns))
        .map((window) => ({
          windowId: cleanClaimText(window.windowId),
          windowStatus: ["open", "ready", "processed", "held"].includes(window.windowStatus) ? window.windowStatus : "processed",
          reason: ["exchange", "same_speaker_claim", "max_delay", "forced", "possible_ad_or_sponsor_break"].includes(window.reason) ? window.reason : "exchange",
          turns: (window.turns || []).filter((turn) => turn?.speakerId && turn?.text).map(normalizeTranscriptTurnForWindow),
          speakerBlocks: Array.isArray(window.speakerBlocks) ? window.speakerBlocks : [],
          speakerColumns: Array.isArray(window.speakerColumns) ? window.speakerColumns : Array.isArray(window.speakerBlocks) ? window.speakerBlocks : [],
          sideColumns: Array.isArray(window.sideColumns) ? window.sideColumns.map((column) => ({
            sideId: normalizeSideId(column.sideId),
            speakerIds: uniqueStrings(Array.isArray(column.speakerIds) ? column.speakerIds : []),
            text: cleanClaimText(column.text || ""),
            turnIds: uniqueStrings(Array.isArray(column.turnIds) ? column.turnIds : [])
          })).filter((column) => column.sideId && (column.text || column.speakerIds.length)) : [],
          turnIds: uniqueStrings(Array.isArray(window.turnIds) ? window.turnIds : []),
          speakerIds: uniqueStrings(Array.isArray(window.speakerIds) ? window.speakerIds : []),
          contextOnly: Boolean(window.contextOnly),
          contextKind: cleanClaimText(window.contextKind || ""),
          contextSignals: uniqueStrings(Array.isArray(window.contextSignals) ? window.contextSignals.map(cleanClaimText) : []),
          contextReason: cleanAgentDisplayText(window.contextReason || ""),
          contextScore: window.contextScore && typeof window.contextScore === "object" ? {
            adScore: Number(window.contextScore.adScore || 0),
            debateScore: Number(window.contextScore.debateScore || 0)
          } : undefined,
          priorContext: Array.isArray(window.priorContext) ? window.priorContext.filter((turn) => turn?.speakerId && turn?.text).map(normalizeTranscriptTurnForWindow) : [],
          nextContext: Array.isArray(window.nextContext) ? window.nextContext.filter((turn) => turn?.speakerId && turn?.text).map(normalizeTranscriptTurnForWindow) : [],
          startSec: window.startSec,
          endSec: window.endSec,
          at: Number(window.at || Date.now())
        }))
        .slice(-120)
    : [];
}

function normalizeTranscriptTurnForWindow(turn) {
  return {
    id: cleanClaimText(turn.id || randomUUID()),
    speakerId: cleanClaimText(turn.speakerId || "Speaker 1"),
    text: cleanClaimText(turn.text || ""),
    isFinal: Boolean(turn.isFinal ?? true),
    at: Number(turn.at || Date.now()),
    startSec: turn.startSec,
    endSec: turn.endSec,
    rawTurnIds: Array.isArray(turn.rawTurnIds) ? uniqueStrings(turn.rawTurnIds) : [],
    turnIds: Array.isArray(turn.turnIds) ? uniqueStrings(turn.turnIds) : [],
    speakerRole: normalizeFloorSpeakerRole(turn.speakerRole),
    floorRoleConfidence: turn.floorRoleConfidence === undefined ? undefined : clamp01(turn.floorRoleConfidence, 0),
    speechFunction: normalizeSpeechFunction(turn.speechFunction),
    debatePhase: normalizeDebatePhase(turn.debatePhase),
    stanceBearing: Boolean(turn.stanceBearing),
    sideMapEligible: Boolean(turn.sideMapEligible),
    claimEligible: Boolean(turn.claimEligible),
    challengeEligible: Boolean(turn.challengeEligible),
    scoreEligible: Boolean(turn.scoreEligible),
    contextOnly: Boolean(turn.contextOnly),
    contextKind: cleanClaimText(turn.contextKind || ""),
    contextSignals: uniqueStrings(Array.isArray(turn.contextSignals) ? turn.contextSignals.map(cleanClaimText) : []),
    floorReason: cleanAgentDisplayText(turn.floorReason || ""),
    ownerSideId: normalizeSideId(turn.ownerSideId) || "",
    ownerSideConfidence: turn.ownerSideConfidence === undefined ? undefined : clamp01(turn.ownerSideConfidence, 0),
    ownerSideReason: cleanAgentDisplayText(turn.ownerSideReason || ""),
    ownershipMode: normalizeUtteranceOwnershipMode(turn.ownershipMode)
  };
}

function normalizeCleanUtterances(utterances) {
  return Array.isArray(utterances)
    ? utterances
        .filter((utterance) => utterance?.utteranceId && utterance?.speakerId && utterance?.text)
        .map((utterance) => ({
          utteranceId: cleanClaimText(utterance.utteranceId),
          speakerId: cleanClaimText(utterance.speakerId),
          text: cleanClaimText(utterance.text),
          quote: cleanClaimText(utterance.quote || utterance.text),
          rawTurnIds: uniqueStrings(Array.isArray(utterance.rawTurnIds) ? utterance.rawTurnIds : []),
          startSec: utterance.startSec,
          endSec: utterance.endSec,
          at: Number(utterance.at || Date.now()),
          speakerOwnershipConfidence: utterance.speakerOwnershipConfidence === undefined
            ? undefined
            : Math.max(0, Math.min(1, Number(utterance.speakerOwnershipConfidence))),
          isComplete: utterance.isComplete === undefined ? undefined : Boolean(utterance.isComplete),
          cleanupNotes: cleanClaimText(utterance.cleanupNotes || ""),
          speakerRole: normalizeFloorSpeakerRole(utterance.speakerRole),
          floorRoleConfidence: utterance.floorRoleConfidence === undefined ? undefined : clamp01(utterance.floorRoleConfidence, 0),
          speechFunction: normalizeSpeechFunction(utterance.speechFunction),
          debatePhase: normalizeDebatePhase(utterance.debatePhase),
          stanceBearing: Boolean(utterance.stanceBearing),
          sideMapEligible: Boolean(utterance.sideMapEligible),
          claimEligible: Boolean(utterance.claimEligible),
          challengeEligible: Boolean(utterance.challengeEligible),
          scoreEligible: Boolean(utterance.scoreEligible),
          contextOnly: Boolean(utterance.contextOnly),
          contextKind: cleanClaimText(utterance.contextKind || ""),
          contextSignals: uniqueStrings(Array.isArray(utterance.contextSignals) ? utterance.contextSignals.map(cleanClaimText) : []),
          floorReason: cleanAgentDisplayText(utterance.floorReason || ""),
          ownerSideId: normalizeSideId(utterance.ownerSideId) || "",
          ownerSideConfidence: utterance.ownerSideConfidence === undefined ? undefined : clamp01(utterance.ownerSideConfidence, 0),
          ownerSideReason: cleanAgentDisplayText(utterance.ownerSideReason || ""),
          ownershipMode: normalizeUtteranceOwnershipMode(utterance.ownershipMode)
        }))
        .slice(-160)
    : [];
}

function normalizeArtifacts(artifacts = {}) {
  const source = artifacts && typeof artifacts === "object" ? artifacts : {};
  return {
    claims: Array.isArray(source.claims) ? source.claims : [],
    clashes: Array.isArray(source.clashes) ? source.clashes : [],
    inconsistencies: Array.isArray(source.inconsistencies) ? source.inconsistencies : [],
    keyMoments: Array.isArray(source.keyMoments) ? source.keyMoments : [],
    sourceChecks: Array.isArray(source.sourceChecks) ? source.sourceChecks : []
  };
}

function normalizeFeaturedQuoteState(value = null) {
  if (!value || typeof value !== "object") return null;
  const text = cleanClaimText(value.text || "");
  const rawText = cleanClaimText(value.rawText || "");
  if (!text) return null;
  return {
    id: cleanClaimText(value.id || `quote-${stableTextHash(text)}`),
    speakerId: cleanClaimText(value.speakerId || "Debate audio"),
    sideId: normalizeSideId(value.sideId) || undefined,
    sideColor: value.sideColor === "blue" || value.sideColor === "red" ? value.sideColor : undefined,
    text,
    rawText: rawText || undefined,
    atSec: Number.isFinite(Number(value.atSec)) ? Number(value.atSec) : undefined,
    updatedAt: Number(value.updatedAt || Date.now()),
    source: cleanClaimText(value.source || "cleaned_transcript"),
    cardId: cleanClaimText(value.cardId || ""),
    cardType: cleanClaimText(value.cardType || ""),
    utteranceIds: uniqueStrings(Array.isArray(value.utteranceIds) ? value.utteranceIds : []),
    rawTurnIds: uniqueStrings(Array.isArray(value.rawTurnIds) ? value.rawTurnIds : [])
  };
}

function normalizeSpeakerPositionMemory(items = []) {
  return Array.isArray(items)
    ? items
        .filter((item) => item?.speakerId)
        .map((item) => ({
          speakerId: cleanClaimText(item.speakerId),
          likelySide: normalizeAgentSideId({ ...item, side: item.likelySide }) || "",
          confidence: Math.max(0, Math.min(1, Number(item.confidence ?? item.sideConfidence ?? 0))),
          stanceSummary: cleanAgentDisplayText(item.stanceSummary || item.summary || ""),
          supportingEvidence: Array.isArray(item.supportingEvidence)
            ? item.supportingEvidence.map((text) => cleanAgentDisplayText(text || "")).filter(Boolean).slice(-8)
            : [],
          recentShiftRisk: ["low", "medium", "high"].includes(item.recentShiftRisk) ? item.recentShiftRisk : "low",
          updatedAt: Number(item.updatedAt || Date.now())
        }))
        .slice(-12)
    : [];
}

function mergeSpeakerPositionMemory(state = {}, incomingMemory = [], dialogueWindows = []) {
  const existing = new Map(normalizeSpeakerPositionMemory(state.speakerPositionMemory || []).map((item) => [item.speakerId, item]));
  const windowSpeakerIds = uniqueStrings((dialogueWindows || []).flatMap((window) => window.speakerIds || []));
  for (const item of normalizeSpeakerPositionMemory(incomingMemory || [])) {
    if (!item.speakerId) continue;
    existing.set(item.speakerId, {
      ...(existing.get(item.speakerId) || {}),
      ...item,
      supportingEvidence: uniqueStrings([
        ...((existing.get(item.speakerId) || {}).supportingEvidence || []),
        ...(item.supportingEvidence || [])
      ]).slice(-8),
      updatedAt: Date.now()
    });
  }
  for (const speakerId of windowSpeakerIds) {
    if (existing.has(speakerId)) continue;
    const profile = (state.speakers || []).find((speaker) => speaker.speakerId === speakerId) || {};
    const points = (state.points || []).filter((point) => point.speakerId === speakerId && isAssertedPoint(point)).slice(-4);
    existing.set(speakerId, {
      speakerId,
      likelySide: speakerSideFromState(state, speakerId) || "",
      confidence: Number(profile.sideConfidence || 0),
      stanceSummary: cleanClaimText(profile.assignmentReason || points.map((point) => point.claim).join(" ")).slice(0, 360),
      supportingEvidence: points.map((point) => point.claim).filter(Boolean).slice(-4),
      recentShiftRisk: "low",
      updatedAt: Date.now()
    });
  }
  return {
    ...state,
    speakerPositionMemory: [...existing.values()]
      .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
      .slice(-12)
  };
}

function mergeSpeakerSideProposals(...groups) {
  const bySpeaker = new Map();
  for (const proposal of groups.flatMap((group) => Array.isArray(group) ? group : [])) {
    const speakerId = cleanClaimText(proposal?.speakerId || "");
    const sideId = normalizeAgentSideId(proposal);
    if (!speakerId || !sideId) continue;
    const confidence = Math.max(0, Math.min(1, Number(proposal.sideConfidence ?? proposal.confidence ?? 0)));
    const existing = bySpeaker.get(speakerId);
    if (!existing || confidence >= Number(existing.sideConfidence || 0)) {
      bySpeaker.set(speakerId, {
        ...proposal,
        speakerId,
        sideId,
        sideConfidence: confidence
      });
    }
  }
  return [...bySpeaker.values()];
}

function normalizeScorecard(scorecard) {
  return scorecard && typeof scorecard === "object" ? scorecard : null;
}

function registerTranscriptSpeakers(state, turns) {
  const speakers = new Map(state.speakers.map((speaker) => [speaker.speakerId, { ...speaker, turnIds: [...(speaker.turnIds || [])] }]));
  for (const turn of turns || []) {
    if (isSpeechmaticsUnassignedTurn(turn)) continue;
    if (!turn?.speakerId || !turn?.isFinal || !isDurableSpeakerTurnText(turn.text || "")) continue;
    const existingSideId = speakerSideFromState(state, turn.speakerId);
    const inferredSideId = existingSideId || undefined;
    const existing = speakers.get(turn.speakerId) || {
      speakerId: turn.speakerId,
      sideId: inferredSideId,
      sideConfidence: inferredSideId ? 0.75 : 0,
      lastSpokenAt: 0,
      turnIds: [],
      speakerRole: normalizeFloorSpeakerRole(floorSpeakerStateFor(state, turn.speakerId)?.role),
      floorRoleConfidence: floorSpeakerStateFor(state, turn.speakerId)?.confidence || 0,
      floorRoleReason: floorSpeakerStateFor(state, turn.speakerId)?.roleReason || "",
      assignmentReason: inferredSideId
        ? "Previously assigned from debate state."
        : "Awaiting side assignment."
    };
    const alreadyCounted = (existing.turnIds || []).includes(turn.id);
    existing.lastSpokenAt = Math.max(existing.lastSpokenAt || 0, Number(turn.at || Date.now()));
    existing.firstSpokenAt = existing.firstSpokenAt
      ? Math.min(Number(existing.firstSpokenAt || 0), Number(turn.at || Date.now()))
      : Number(turn.at || Date.now());
    existing.firstStartSec = minDefinedNumber(existing.firstStartSec, turn.startSec);
    existing.lastStartSec = maxDefinedNumber(existing.lastStartSec, turn.startSec);
    existing.lastEndSec = maxDefinedNumber(existing.lastEndSec, turn.endSec);
    existing.speakerSource = existing.speakerSource || turn.speakerSource || "transcript";
    if (!alreadyCounted) {
      existing.turnCount = Number(existing.turnCount || 0) + 1;
      existing.wordCount = Number(existing.wordCount || 0) + wordCount(turn.text || "");
      existing.voicedDurationSec = Number(existing.voicedDurationSec || 0) + estimateTurnVoicedDurationSec(turn);
      existing.sampleText = truncatePromptText(cleanClaimText(`${existing.sampleText || ""} ${turn.text || ""}`), 1200);
    }
    existing.turnIds = uniqueStrings([...(existing.turnIds || []), turn.id].filter(Boolean));
    speakers.set(turn.speakerId, existing);
  }
  return resolveSpeakerIdentityAliases({ ...state, speakers: [...speakers.values()] });
}

function estimateTurnVoicedDurationSec(turn = {}) {
  const words = Array.isArray(turn.words) ? turn.words : [];
  const wordDurations = words
    .map((word) => {
      const start = Number(word?.startSec);
      const end = Number(word?.endSec);
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.min(3, end - start) : 0;
    })
    .reduce((sum, value) => sum + value, 0);
  if (wordDurations > 0) return wordDurations;
  const start = Number(turn.startSec);
  const end = Number(turn.endSec);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return Math.min(30, end - start);
  return Math.min(12, Math.max(0.8, wordCount(turn.text || "") / 3.2));
}

function resolveSpeakerIdentityAliases(state = {}) {
  const speakers = (state.speakers || []).map((speaker) => ({ ...speaker }));
  if (speakers.length <= 2) return { ...state, speakers };
  const byId = new Map(speakers.map((speaker) => [speaker.speakerId, speaker]));
  const sessionFirstSec = Math.min(
    ...speakers
      .map((speaker) => Number(speaker.firstStartSec))
      .filter(Number.isFinite)
  );
  const hasTimedSession = Number.isFinite(sessionFirstSec);
  const representativeTargetFor = (speaker) => {
    const targetId = speaker.representativeSpeakerId || speaker.aliasOf || speaker.speakerId;
    const target = byId.get(targetId);
    return target && target.speakerId !== speaker.speakerId ? target : speaker;
  };
  const stablePeers = (candidate) => speakers
    .filter((speaker) => {
      if (!speaker?.speakerId || speaker.speakerId === candidate.speakerId) return false;
      const peerSideId = normalizeSideId(speaker.sideId);
      const candidateSideId = normalizeSideId(candidate.sideId);
      if (candidateSideId && peerSideId !== candidateSideId) return false;
      if (!candidateSideId && speakerTextAffinity(candidate, speaker) < 0.08) return false;
      if (representativeTargetFor(speaker).speakerId !== speaker.speakerId) return false;
      const peerFirst = Number(speaker.firstStartSec);
      const candidateFirst = Number(candidate.firstStartSec);
      if (Number.isFinite(peerFirst) && Number.isFinite(candidateFirst) && peerFirst >= candidateFirst) return false;
      return isDurableSpeakerIdentity(speaker);
    })
    .sort((a, b) => {
      if (!normalizeSideId(candidate.sideId)) {
        const affinityDelta = speakerTextAffinity(candidate, b) - speakerTextAffinity(candidate, a);
        if (Math.abs(affinityDelta) > 0.02) return affinityDelta;
      }
      return speakerIdentityStrength(b) - speakerIdentityStrength(a);
    });

  const next = speakers.map((speaker) => {
    const existingTarget = representativeTargetFor(speaker);
    if (existingTarget.speakerId !== speaker.speakerId && isDurableIndependentSpeaker(speaker)) {
      return {
        ...speaker,
        representativeSpeakerId: speaker.speakerId,
        aliasOf: undefined,
        identityStatus: "confirmed",
        identityConfidence: Math.max(Number(speaker.identityConfidence || 0), 0.82),
        aliasReason: ""
      };
    }
    const firstSecForSide = Number(speaker.firstStartSec);
    const canAttemptMissingSideAlias = hasTimedSession
      && Number.isFinite(firstSecForSide)
      && firstSecForSide - sessionFirstSec >= 300
      && (isLowEvidenceSpeakerIdentity(speaker) || isFragmentLikeSpeakerIdentity(speaker));
    if (!normalizeSideId(speaker.sideId) && !canAttemptMissingSideAlias) return speaker;
    if (isDurableIndependentSpeaker(speaker) && !speaker.aliasOf) {
      return {
        ...speaker,
        representativeSpeakerId: speaker.speakerId,
        identityStatus: speaker.identityStatus || "confirmed",
        identityConfidence: Math.max(Number(speaker.identityConfidence || 0), 0.78)
      };
    }
    const peers = stablePeers(speaker);
    if (!peers.length) return speaker;
    const firstSec = Number(speaker.firstStartSec);
    const lateEnough = hasTimedSession && Number.isFinite(firstSec) && firstSec - sessionFirstSec >= 300;
    const lowEvidence = isLowEvidenceSpeakerIdentity(speaker);
    const fragmentLike = isFragmentLikeSpeakerIdentity(speaker);
    if (!lateEnough || (!lowEvidence && !fragmentLike)) return speaker;
    const target = peers[0];
    const confidence = Math.min(0.94, 0.66 + (lowEvidence ? 0.12 : 0) + (fragmentLike ? 0.1 : 0) + Math.min(0.06, speakerTextAffinity(speaker, target) * 0.1));
    if (confidence < 0.72) return speaker;
    return {
      ...speaker,
      sideId: target.sideId,
      representativeSpeakerId: target.representativeSpeakerId || target.speakerId,
      aliasOf: target.representativeSpeakerId || target.speakerId,
      identityStatus: "provisional_alias",
      identityConfidence: confidence,
      sideConfidence: Math.max(Number(speaker.sideConfidence || 0), Math.min(0.88, Number(target.sideConfidence || 0.8))),
      aliasReason: `Late low-evidence ${speaker.speakerSource || "diarized"} label matched the existing ${target.sideId === "side-b" ? "Red" : "Blue"} side speaker instead of a durable new participant.`
    };
  });
  return { ...state, speakers: next };
}

function isDurableSpeakerIdentity(speaker = {}) {
  return Number(speaker.wordCount || 0) >= 260
    || Number(speaker.turnCount || 0) >= 10
    || Number(speaker.voicedDurationSec || 0) >= 18
    || Number(speaker.sideConfidence || 0) >= 0.93;
}

function isDurableIndependentSpeaker(speaker = {}) {
  if (speaker.aliasOf || speaker.identityStatus === "provisional_alias") {
    return Number(speaker.wordCount || 0) >= 520
      || Number(speaker.turnCount || 0) >= 70
      || Number(speaker.voicedDurationSec || 0) >= 42;
  }
  return Number(speaker.wordCount || 0) >= 520
    || Number(speaker.turnCount || 0) >= 70
    || Number(speaker.voicedDurationSec || 0) >= 42
    || Number(speaker.identityConfidence || 0) >= 0.9;
}

function isLowEvidenceSpeakerIdentity(speaker = {}) {
  return Number(speaker.wordCount || 0) <= 360
    || Number(speaker.turnCount || 0) <= 50
    || Number(speaker.voicedDurationSec || 0) <= 24;
}

function isFragmentLikeSpeakerIdentity(speaker = {}) {
  const text = normalizeTranscript(speaker.sampleText || "");
  if (!text) return false;
  const words = wordCount(text);
  const fragmentMarkers = /\b(stop|hold on|wait|but|well|no|yes|right|exactly|i condemn|i don t trust|i do not trust|that s not|thats not|not as a policy)\b/.test(text);
  return words <= 360 && fragmentMarkers;
}

function speakerIdentityStrength(speaker = {}) {
  return Number(speaker.wordCount || 0) + Number(speaker.turnCount || 0) * 12 + Number(speaker.voicedDurationSec || 0) * 8 + Number(speaker.sideConfidence || 0) * 40;
}

function speakerTextAffinity(left = {}, right = {}) {
  return tokenOverlapRatio(normalizeTranscript(left.sampleText || ""), normalizeTranscript(right.sampleText || ""));
}

function representativeSpeakerIdForState(state = {}, speakerId = "") {
  const speaker = (state.speakers || []).find((item) => item.speakerId === speakerId);
  const target = speaker?.representativeSpeakerId || speaker?.aliasOf || speakerId;
  return cleanClaimText(target || speakerId);
}

function stitchTranscriptTurns(turns = []) {
  const stitched = [];
  for (const turn of turns || []) {
    if (!turn?.speakerId || !turn?.text) continue;
    const current = {
      ...turn,
      turnIds: Array.isArray(turn.turnIds) ? turn.turnIds : [turn.id].filter(Boolean)
    };
    const previous = stitched.at(-1);
    if (previous && shouldStitchTurns(previous, current)) {
      previous.text = cleanClaimText(`${previous.text} ${current.text}`);
      previous.turnIds = uniqueStrings([...(previous.turnIds || []), ...(current.turnIds || [])]);
      previous.id = previous.turnIds.join("+");
      previous.at = Math.max(Number(previous.at || 0), Number(current.at || 0));
      previous.endSec = current.endSec ?? previous.endSec;
      if (current.words?.length) previous.words = [...(previous.words || []), ...current.words];
      continue;
    }
    stitched.push(current);
  }
  return stitched;
}

function classifyContextOnlyTranscriptTurns(turns = []) {
  const text = cleanClaimText((turns || []).map((turn) => turn?.text || "").join(" "));
  const normalized = normalizeTranscript(text);
  if (!normalized) {
    return { contextOnly: false, contextKind: "", signals: [], adScore: 0, debateScore: 0, reason: "" };
  }

  const signalDefs = [
    { label: "sponsor read", score: 4, anchor: true, regex: /\b(today'?s sponsor|sponsored by|brought to you by|sponsor(?:ed|ship)?|paid partnership|advertiser)\b/i },
    { label: "commercial break", score: 4, anchor: true, regex: /\b(ad break|commercial break|advertisement|this ad)\b/i },
    { label: "promo code", score: 4, anchor: true, regex: /\b(promo code|discount code|use code)\b/i },
    { label: "support callout", score: 3, anchor: true, regex: /\b(support(?:ing)? (?:this|the) (?:channel|show|podcast|program)|support our (?:channel|show|podcast|program))\b/i },
    { label: "link call to action", score: 3, cta: true, regex: /\b(click|tap|use|visit|go to|head to|sign up|get started|download)\b.{0,70}\b(link|description|website|site|app|promo code|discount code|free trial)\b/i },
    { label: "sales call to action", score: 2, cta: true, regex: /\b(sign up|get started|start today|try it|download the app|visit the website|go to the website|click the link)\b/i },
    { label: "product or service pitch", score: 2, product: true, regex: /\b(product|service|subscription|plan|offer|free trial|app|website|site|licensed professional|professional service|matched with|online service)\b/i }
  ];
  let adScore = 0;
  let hasAnchor = false;
  let hasCta = false;
  let hasProduct = false;
  const signals = [];
  for (const def of signalDefs) {
    if (!def.regex.test(text)) continue;
    adScore += def.score;
    hasAnchor = hasAnchor || Boolean(def.anchor);
    hasCta = hasCta || Boolean(def.cta);
    hasProduct = hasProduct || Boolean(def.product);
    signals.push(def.label);
  }

  const debateSignals = [
    /\b(i think|i believe|we think|we believe|my position|our position|i argue|we argue|i support|i oppose|i defend)\b/i,
    /\b(because|therefore|that proves|that shows|evidence|claim|argument|rebuttal|opponent|challenge)\b/i,
    /\b(should|should not|must|must not|policy|law|legal|moral|right|wrong|true|false)\b/i,
    /\b(blue side|red side)\b/i
  ];
  const debateScore = debateSignals.reduce((sum, regex) => sum + (regex.test(text) ? 1 : 0), 0);
  const adShape = hasAnchor || (hasCta && hasProduct);
  const contextOnly = Boolean(adShape && adScore >= 4 && adScore >= debateScore + 1);
  return {
    contextOnly,
    contextKind: contextOnly ? "ad_or_sponsor" : "",
    signals: uniqueStrings(signals),
    adScore,
    debateScore,
    reason: contextOnly ? "Promotional or sponsor-style segment." : ""
  };
}

function buildCleanUtterances(stitchedTurns = []) {
  return (stitchedTurns || [])
    .filter((turn) => turn?.speakerId && turn?.text)
    .map((turn) => {
      const rawTurnIds = uniqueStrings(Array.isArray(turn.turnIds) && turn.turnIds.length ? turn.turnIds : [turn.id].filter(Boolean));
      const utteranceId = `utt-${stableTextHash(`${turn.speakerId} ${rawTurnIds.join(" ")} ${turn.text}`)}`;
      const text = cleanClaimText(turn.text || "");
      const contextSignal = classifyContextOnlyTranscriptTurns([{ ...turn, text }]);
      const contextOnly = Boolean(turn.contextOnly || contextSignal.contextOnly);
      return {
        utteranceId,
        speakerId: turn.speakerId,
        text,
        quote: text,
        rawTurnIds,
        startSec: turn.startSec,
        endSec: turn.endSec,
        at: Number(turn.at || Date.now()),
        speakerOwnershipConfidence: 1,
        isComplete: /[.!?]$/.test(text) || isCompleteDebatePoint(text),
        cleanupNotes: contextOnly
          ? "Deterministic fallback cleanup preserved the original speaker text and marked it as context-only."
          : "Deterministic fallback cleanup preserved the original speaker text.",
        speakerRole: contextOnly ? NEUTRAL_SPEAKER : turn.speakerRole,
        floorRoleConfidence: contextOnly ? 0.82 : turn.floorRoleConfidence,
        speechFunction: contextOnly ? "off_topic" : turn.speechFunction,
        stanceBearing: contextOnly ? false : turn.stanceBearing,
        sideMapEligible: contextOnly ? false : turn.sideMapEligible,
        claimEligible: contextOnly ? false : turn.claimEligible,
        challengeEligible: contextOnly ? false : turn.challengeEligible,
        scoreEligible: contextOnly ? false : turn.scoreEligible,
        contextOnly,
        contextKind: contextSignal.contextKind || turn.contextKind || "",
        contextSignals: contextSignal.signals?.length ? contextSignal.signals : turn.contextSignals,
        floorReason: contextOnly ? contextSignal.reason : turn.floorReason,
        ownershipMode: contextOnly ? "neutral_context" : turn.ownershipMode
      };
    });
}

function selectRawTurnsForCleaning(rawTurns = [], dialogueWindows = [], maxTurns = CLEANING_MAX_TURNS_PER_BATCH) {
  const orderedRawTurns = (rawTurns || []).filter((turn) => turn?.id && turn?.speakerId && turn?.text);
  if (!orderedRawTurns.length) return [];
  const rawIds = new Set(
    (dialogueWindows || [])
      .flatMap((window) => window?.turns || [])
      .flatMap((turn) => turn.rawTurnIds || turn.turnIds || [turn.id])
      .filter(Boolean)
  );
  const selected = rawIds.size
    ? orderedRawTurns.filter((turn) => rawIds.has(turn.id))
    : orderedRawTurns.slice(-maxTurns);
  return selected.slice(-Math.max(1, maxTurns));
}

function cleanUtteranceToTurn(utterance) {
  return {
    id: utterance.utteranceId,
    speakerId: utterance.speakerId,
    text: utterance.text,
    isFinal: true,
    at: utterance.at,
    startSec: utterance.startSec,
    endSec: utterance.endSec,
    rawTurnIds: utterance.rawTurnIds,
    turnIds: [utterance.utteranceId],
    speakerRole: normalizeFloorSpeakerRole(utterance.speakerRole),
    floorRoleConfidence: utterance.floorRoleConfidence,
    speechFunction: normalizeSpeechFunction(utterance.speechFunction),
    debatePhase: normalizeDebatePhase(utterance.debatePhase),
    stanceBearing: Boolean(utterance.stanceBearing),
    sideMapEligible: Boolean(utterance.sideMapEligible),
    claimEligible: Boolean(utterance.claimEligible),
    challengeEligible: Boolean(utterance.challengeEligible),
    scoreEligible: Boolean(utterance.scoreEligible),
    contextOnly: Boolean(utterance.contextOnly),
    contextKind: cleanClaimText(utterance.contextKind || ""),
    contextSignals: uniqueStrings(Array.isArray(utterance.contextSignals) ? utterance.contextSignals.map(cleanClaimText) : []),
    floorReason: cleanAgentDisplayText(utterance.floorReason || ""),
    ownerSideId: normalizeSideId(utterance.ownerSideId) || "",
    ownerSideConfidence: utterance.ownerSideConfidence === undefined ? undefined : clamp01(utterance.ownerSideConfidence, 0),
    ownerSideReason: cleanAgentDisplayText(utterance.ownerSideReason || ""),
    ownershipMode: normalizeUtteranceOwnershipMode(utterance.ownershipMode)
  };
}

function selectRollingCleanTurnsForWindows(state = {}, currentCleanTurns = []) {
  const latestAt = Math.max(
    ...[
      ...(currentCleanTurns || []).map((turn) => Number(turn.at || 0)),
      Date.now()
    ]
  );
  const windowMs = Math.max(LIVE_BATCH_DEBATE_WINDOW_MS, LIVE_BATCH_DEBATE_WINDOW_MS * LIVE_DIALOGUE_WINDOW_BATCHES);
  const minAt = latestAt - windowMs - LIVE_BATCH_IDLE_DEBOUNCE_MS;
  const ledgerTurns = (state.utterances || [])
    .map(cleanUtteranceToTurn)
    .filter((turn) => Number(turn.at || 0) >= minAt);
  const byId = new Map();
  for (const turn of [...ledgerTurns, ...(currentCleanTurns || [])]) {
    if (!turn?.id) continue;
    byId.set(turn.id, turn);
  }
  return [...byId.values()]
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    .slice(-24);
}

function mergeCleanUtterances(state, utterances = []) {
  const byId = new Map((state.utterances || []).map((utterance) => [utterance.utteranceId, utterance]));
  for (const utterance of utterances || []) {
    if (!utterance?.utteranceId || !utterance?.speakerId || !utterance?.text) continue;
    byId.set(utterance.utteranceId, utterance);
  }
  return {
    ...state,
    utterances: [...byId.values()].sort((a, b) => Number(a.at || 0) - Number(b.at || 0)).slice(-160)
  };
}

function buildDialogueWindows(cleanTurns = [], transcriptWindow = [], state = {}) {
  const turns = (cleanTurns || [])
    .filter((turn) => turn?.speakerId && turn?.text && turn.isFinal && !isSpeechmaticsUnassignedSpeakerId(turn.speakerId))
    .map((turn) => ({
      ...turn,
      text: cleanClaimText(turn.text || ""),
      turnIds: uniqueStrings(Array.isArray(turn.turnIds) && turn.turnIds.length ? turn.turnIds : [turn.id].filter(Boolean))
    }))
    .filter((turn) => isDurableSpeakerTurnText(turn.text || ""));
  if (!turns.length) return [];

  const contextTurnIds = new Set(turns
    .filter((turn) => turn.contextOnly || classifyContextOnlyTranscriptTurns([turn]).contextOnly)
    .map((turn) => turn.id));
  const debateCandidateTurns = contextTurnIds.size
    ? turns.filter((turn) => !contextTurnIds.has(turn.id))
    : turns;
  if (!debateCandidateTurns.length) {
    const contextSignal = classifyContextOnlyTranscriptTurns(turns);
    return [createDialogueWindow(turns.slice(-16), transcriptWindow, "possible_ad_or_sponsor_break", state, {
      windowStatus: "held",
      contextOnly: true,
      contextKind: contextSignal.contextKind || "ad_or_sponsor",
      contextSignals: contextSignal.signals,
      contextReason: contextSignal.reason || "Context-only segment.",
      contextScore: {
        adScore: contextSignal.adScore,
        debateScore: contextSignal.debateScore
      }
    })];
  }

  const contextSignal = classifyContextOnlyTranscriptTurns(debateCandidateTurns);
  if (contextSignal.contextOnly) {
    return [createDialogueWindow(debateCandidateTurns.slice(-16), transcriptWindow, "possible_ad_or_sponsor_break", state, {
      windowStatus: "held",
      contextOnly: true,
      contextKind: contextSignal.contextKind,
      contextSignals: contextSignal.signals,
      contextReason: contextSignal.reason,
      contextScore: {
        adScore: contextSignal.adScore,
        debateScore: contextSignal.debateScore
      }
    })];
  }

  const analyzableTurns = debateCandidateTurns.filter((turn) => !isObviousNonPoint(turn.text || ""));
  if (!analyzableTurns.length) return [];

  const speakerIds = uniqueStrings(analyzableTurns.map((turn) => turn.speakerId));
  const totalWords = wordCount(analyzableTurns.map((turn) => turn.text).join(" "));
  const hasExchange = speakerIds.length >= 2 && analyzableTurns.length >= 2;
  const hasSameSpeakerClaim = speakerIds.length === 1 && (totalWords >= 22 || analyzableTurns.length >= 3);
  const hasMaxDelayClaim = totalWords >= 10 && analyzableTurns.some((turn) => isCompleteDebatePoint(turn.text));
  if (!hasExchange && !hasSameSpeakerClaim && !hasMaxDelayClaim) return [];

  const limitedTurns = hasExchange ? analyzableTurns.slice(-16) : analyzableTurns.slice(-10);
  const reason = hasExchange ? "exchange" : hasSameSpeakerClaim ? "same_speaker_claim" : "max_delay";
  return [createDialogueWindow(limitedTurns, transcriptWindow, reason, state)];
}

function createDialogueWindow(turns, transcriptWindow = [], reason = "exchange", state = {}, metadata = {}) {
  const orderedTurns = [...turns].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
  const turnIds = uniqueStrings(orderedTurns.flatMap((turn) => Array.isArray(turn.turnIds) && turn.turnIds.length ? turn.turnIds : [turn.id]));
  const speakerIds = uniqueStrings(orderedTurns.map((turn) => turn.speakerId));
  const speakerBlocks = speakerIds.map((speakerId) => ({
    speakerId,
    text: cleanClaimText(orderedTurns.filter((turn) => turn.speakerId === speakerId).map((turn) => turn.text).join(" ")),
    turnIds: uniqueStrings(orderedTurns.filter((turn) => turn.speakerId === speakerId).flatMap((turn) => turn.turnIds || [turn.id]))
  }));
  const sideColumns = buildSideColumnsForTurns(orderedTurns, state);
  const priorContext = buildPriorWindowContext(orderedTurns, transcriptWindow);
  const windowId = `win-${stableTextHash(`${reason} ${turnIds.join(" ")} ${orderedTurns.map((turn) => turn.text).join(" ")}`)}`;
  const existing = (state.dialogueWindows || []).find((window) => window.windowId === windowId);
  return {
    windowId,
    windowStatus: existing?.windowStatus === "processed" ? "processed" : metadata.windowStatus || "ready",
    reason,
    turns: orderedTurns,
    speakerBlocks,
    speakerColumns: speakerBlocks,
    sideColumns,
    turnIds,
    speakerIds,
    contextOnly: Boolean(metadata.contextOnly),
    contextKind: cleanClaimText(metadata.contextKind || ""),
    contextSignals: uniqueStrings(Array.isArray(metadata.contextSignals) ? metadata.contextSignals.map(cleanClaimText) : []),
    contextReason: cleanAgentDisplayText(metadata.contextReason || ""),
    contextScore: metadata.contextScore && typeof metadata.contextScore === "object" ? {
      adScore: Number(metadata.contextScore.adScore || 0),
      debateScore: Number(metadata.contextScore.debateScore || 0)
    } : undefined,
    priorContext,
    nextContext: [],
    startSec: orderedTurns.find((turn) => turn.startSec !== undefined)?.startSec,
    endSec: [...orderedTurns].reverse().find((turn) => turn.endSec !== undefined)?.endSec,
    at: Math.max(...orderedTurns.map((turn) => Number(turn.at || 0)), Date.now())
  };
}

function buildSideColumnsForTurns(turns = [], state = {}) {
  return ensureTwoSides(state.sides || []).map((side) => {
    const sideTurns = (turns || []).filter((turn) => turnOwnerSideFromState(state, turn) === side.id && isSpeakerClaimEligible(state, turn.speakerId, [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])]));
    return {
      sideId: side.id,
      speakerIds: uniqueStrings(sideTurns.map((turn) => turn.speakerId)),
      text: cleanClaimText(sideTurns.map((turn) => turn.text || "").join(" ")),
      turnIds: uniqueStrings(sideTurns.flatMap((turn) => turn.turnIds || [turn.id]))
    };
  }).filter((column) => column.text || column.speakerIds.length);
}

function buildReadyClaimWindows(windows = [], state = {}) {
  return (windows || []).map((window) => ({
    ...window,
    pipelineObject: "ReadyClaimWindows",
    speakerColumns: window.speakerColumns || window.speakerBlocks || [],
    sideColumns: buildSideColumnsForTurns(window.turns || [], state),
    speakerSideRegistry: uniqueStrings(window.speakerIds || []).map((speakerId) => {
      const profile = (state.speakers || []).find((speaker) => speaker.speakerId === speakerId) || {};
      return {
        speakerId,
        sideId: speakerSideFromState(state, speakerId) || "",
        confidence: Number(profile.sideConfidence || 0),
        floorRole: normalizeFloorSpeakerRole(profile.speakerRole || floorSpeakerStateFor(state, speakerId)?.role),
        floorRoleConfidence: Math.max(Number(profile.floorRoleConfidence || 0), Number(floorSpeakerStateFor(state, speakerId)?.confidence || 0)),
        utteranceSideSummary: summarizeWindowSpeakerOwnership(state, speakerId, window.turns || []),
        sideMapEligible: isSpeakerSideMapEligible(state, speakerId, (window.turns || [])
          .filter((turn) => turn.speakerId === speakerId)
          .flatMap((turn) => [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])])),
        claimEligible: isSpeakerClaimEligible(state, speakerId, (window.turns || [])
          .filter((turn) => turn.speakerId === speakerId)
          .flatMap((turn) => [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])])),
        reason: profile.assignmentReason || ""
      };
    })
  }));
}

function buildPriorWindowContext(turns, transcriptWindow = []) {
  const firstTurn = turns[0];
  const currentIds = new Set(turns.map((turn) => turn.id));
  const before = (transcriptWindow || [])
    .filter((turn) => turn?.isFinal && turn?.speakerId && turn?.text && !currentIds.has(turn.id))
    .filter((turn) => !firstTurn?.at || Number(turn.at || 0) <= Number(firstTurn.at || 0))
    .slice(-4);
  return before.map((turn) => ({
    id: turn.id,
    speakerId: turn.speakerId,
    text: cleanClaimText(turn.text || ""),
    isFinal: true,
    at: Number(turn.at || Date.now()),
    startSec: turn.startSec,
    endSec: turn.endSec,
    turnIds: Array.isArray(turn.turnIds) ? turn.turnIds : [turn.id].filter(Boolean)
  }));
}

function mergeDialogueWindows(state, windows = []) {
  const byId = new Map((state.dialogueWindows || []).map((window) => [window.windowId, window]));
  for (const window of windows || []) {
    if (!window?.windowId) continue;
    byId.set(window.windowId, window);
  }
  return {
    ...state,
    dialogueWindows: [...byId.values()]
      .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
      .slice(-120)
  };
}

function flattenDialogueWindowTurns(windows = []) {
  const byId = new Map();
  for (const window of windows || []) {
    for (const turn of window.turns || []) {
      if (!turn?.id) continue;
      byId.set(turn.id, turn);
    }
  }
  return [...byId.values()].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function buildArtifactContextDialogueWindows(contextTurns = [], transcriptWindow = [], state = {}, fallbackWindows = []) {
  const turns = uniqueTurnsById(contextTurns).filter(isAnalyzableTurn);
  if (!turns.length) return fallbackWindows;
  const cleanTurns = buildCleanUtterances(stitchTranscriptTurns(turns)).map(cleanUtteranceToTurn);
  const windows = buildDialogueWindows(cleanTurns, transcriptWindow, state).filter((window) => window.windowStatus === "ready");
  return windows.length ? windows : fallbackWindows;
}

function selectArtifactContextPoints(state = {}, newPoints = [], dialogueWindows = []) {
  const contextTurnIds = new Set(
    flattenDialogueWindowTurns(dialogueWindows)
      .flatMap((turn) => [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])])
      .filter(Boolean)
  );
  const recentPoints = (state.points || [])
    .filter(isScoredPoint)
    .filter((point) => isSpeakerClaimEligible(state, point.speakerId, point.turnIds || []))
    .filter((point) => (point.turnIds || []).some((turnId) => contextTurnIds.has(turnId)));
  return uniqueById([...(newPoints || []), ...recentPoints]).slice(0, 18);
}

function uniqueTurnsById(turns = []) {
  const byId = new Map();
  for (const turn of turns || []) {
    if (!turn?.id) continue;
    byId.set(turn.id, turn);
  }
  return [...byId.values()].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
}

function shouldStitchTurns(previous, current) {
  if (previous.speakerId !== current.speakerId) return false;
  const previousWords = wordCount(previous.text || "");
  const currentWords = wordCount(current.text || "");
  if (currentWords <= 6 || previousWords <= 14) return true;
  return /[-—–]\s*$/.test(previous.text || "") || /\b(and|but|because|that|the|a|an|of|to|with|for)\s*$/i.test(previous.text || "");
}

function wordCount(text = "") {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function applyTopicAndSides(state, candidate = {}) {
  return {
    ...state,
    topic: candidate?.topic && !isGenericTopic(candidate.topic) ? compactTopic(candidate.topic) : state.topic,
    sides: state.sides.map((side) => ({ ...side, speakerIds: [...(side.speakerIds || [])] }))
  };
}

function applyTopicOnly(state, candidate = {}) {
  return {
    ...state,
    topic: candidate?.topic && !isGenericTopic(candidate.topic) ? compactTopic(candidate.topic) : state.topic
  };
}

function applySpeakerAssignments(state, assignments, turns, points = []) {
  const turnSpeakerIds = new Set((turns || []).map((turn) => turn.speakerId).filter(Boolean));
  const speakers = new Map(state.speakers.map((speaker) => [speaker.speakerId, { ...speaker }]));
  const assignmentList = Array.isArray(assignments) ? assignments : [];
  const assignmentBatchHasBlueAnchor = hasBlueSideAnchor(state)
    || assignmentList.some((assignment) => normalizeAgentSideId(assignment) === BLUE_SIDE_ID);
  for (const point of points || []) {
    if (!point?.speakerId || !isScoredPoint(point)) continue;
    if (!isSpeakerSideMapEligible(state, point.speakerId, point.turnIds || [])) continue;
    const existing = speakers.get(point.speakerId) || {
      speakerId: point.speakerId,
      sideConfidence: 0,
      lastSpokenAt: 0,
      turnIds: [],
      assignmentReason: "Awaiting side assignment."
    };
    const pointSideId = coerceInitialSideAnchor(state, point.speakerId, point.sideId);
    if (!existing.sideId) {
      existing.sideId = pointSideId;
      existing.sideConfidence = Math.max(existing.sideConfidence || 0, 0.78);
      existing.assignmentReason = initialSideAnchorReason(state, point.sideId, "Assigned from an asserted debate point.");
      existing.turnIds = uniqueStrings([...(existing.turnIds || []), ...(point.turnIds || [])]);
      speakers.set(point.speakerId, existing);
    }
  }
  for (const assignment of assignmentList) {
    const speakerId = assignment?.speakerId;
    const rawSideId = normalizeAgentSideId(assignment);
    const sideId = coerceSideAnchorForAssignmentBatch(state, speakerId, rawSideId, assignmentBatchHasBlueAnchor);
    const confidence = Math.max(0, Math.min(1, Number(assignment?.sideConfidence ?? assignment?.confidence ?? 0)));
    if (!speakerId || !sideId) continue;
    if (isModeratorSideAssignment({
      speakerId,
      reason: assignment.assignmentReason || assignment.reason || "",
      evidenceQuote: assignment.evidenceQuote || assignment.quote || "",
      state
    })) continue;
    if (isWeakSideAssignmentEvidence({
      reason: assignment.assignmentReason || assignment.reason || "",
      evidenceQuote: assignment.evidenceQuote || assignment.quote || ""
    })) continue;
    if (!isSpeakerSideMapEligible(state, speakerId, (turns || [])
      .filter((turn) => turn.speakerId === speakerId)
      .flatMap((turn) => [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])]))) continue;
    const existing = speakers.get(speakerId) || {
      speakerId,
      sideConfidence: 0,
      lastSpokenAt: 0,
      turnIds: [],
      assignmentReason: "Awaiting side assignment."
    };
    const speakerAssignmentTurnIds = uniqueStrings((turns || [])
      .filter((turn) => turn.speakerId === speakerId)
      .flatMap((turn) => [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])]));
    const hasAssertedPoint = (points || []).some((point) => point.speakerId === speakerId && point.sideId === sideId && isScoredPoint(point));
    const hasOrphaningRisk = (state.points || []).some((point) => point.speakerId === speakerId && isScoredPoint(point) && point.sideId !== sideId);
    const earlyAnchorRepair = existing.sideId === RED_SIDE_ID && sideId === BLUE_SIDE_ID && !hasBlueSideAnchor(state);
    const freshSideBuilderAssignment = !existing.sideId
      && turnSpeakerIds.has(speakerId)
      && !hasOrphaningRisk
      && confidence >= 0.78
      && isSpeakerSideMapEligible(state, speakerId, speakerAssignmentTurnIds);
    const canAssign = earlyAnchorRepair
      || freshSideBuilderAssignment
      || (hasAssertedPoint && !existing.sideId)
      || existing.sideId === sideId
      || (turnSpeakerIds.has(speakerId) && !hasOrphaningRisk && confidence >= 0.9 && confidence > (existing.sideConfidence || 0) + 0.18);
    if (!canAssign) continue;
    existing.sideId = sideId;
    existing.sideConfidence = Math.max(existing.sideConfidence || 0, confidence || 0.65);
    existing.assignmentReason = rawSideId !== sideId
      ? initialSideAnchorReason(state, rawSideId, assignment.assignmentReason || assignment.reason || "Assigned by stance in debate batch.")
      : cleanAgentDisplayText(assignment.assignmentReason || assignment.reason || "Assigned by stance in debate batch.");
    speakers.set(speakerId, existing);
  }
  return syncSidesFromSpeakers(resolveSpeakerIdentityAliases({ ...state, speakers: [...speakers.values()] }));
}

function normalizeClaimBuilderOutput(candidatePoints, turns, state, trace = null) {
  const turnsById = new Map();
  for (const turn of turns) {
    if (!turn?.id) continue;
    turnsById.set(turn.id, turn);
    for (const alias of uniqueStrings([...(turn.turnIds || []), ...(turn.rawTurnIds || [])])) {
      turnsById.set(alias, turn);
    }
  }
  const output = [];
  const malformedByReason = {};
  const candidates = Array.isArray(candidatePoints) ? candidatePoints : [];
  const exactClaimKeys = new Set(
    (state.points || [])
      .filter((point) => point?.claim && normalizeSideId(point.sideId))
      .map((point) => `${normalizeSideId(point.sideId)}:${directTextSignature(point.claim)}`)
  );
  const debatePointLedger = debatePointLedgerFromState(state);
  const acceptedClaimsBySide = new Map();

  const markMalformed = (reason) => {
    malformedByReason[reason] = (malformedByReason[reason] || 0) + 1;
  };

  for (const candidate of candidates) {
    const rawSpeakerId = cleanClaimText(candidate?.speakerId || "");
    const speakerId = representativeSpeakerIdForState(state, rawSpeakerId) || rawSpeakerId;
    const claim = cleanAgentDisplayText(candidate?.claim || "");
    const explicitTurnIds = uniqueStrings(Array.isArray(candidate?.turnIds) ? candidate.turnIds : []);
    const candidateTurns = explicitTurnIds.map((id) => turnsById.get(id)).filter(Boolean);
    const speakerTurns = (candidateTurns.length ? candidateTurns : turns).filter((turn) => !speakerId || turn.speakerId === rawSpeakerId || turn.speakerId === speakerId);
    const sourceTurn = speakerTurns.find((turn) => turn?.text && textSupportScore(candidate?.quote || candidate?.claim || "", turn.text) >= 0.35)
      || speakerTurns[0]
      || {};
    const quote = cleanClaimText(candidate?.quote || sourceTurn.text || claim);
    const sideId = normalizeAgentSideId(candidate)
      || speakerSideFromState(state, rawSpeakerId)
      || speakerSideFromState(state, speakerId)
      || inferSideIdForSpeakerFromTurns(state, speakerId, turns);

    if (!speakerId) {
      markMalformed("missing_speaker");
      continue;
    }
    if (!sideId) {
      markMalformed("missing_side");
      continue;
    }
    if (!claim) {
      markMalformed("missing_claim");
      continue;
    }
    if (!quote) {
      markMalformed("missing_quote");
      continue;
    }

    const exactClaimKey = `${normalizeSideId(sideId)}:${directTextSignature(claim)}`;
    if (exactClaimKeys.has(exactClaimKey)) {
      markMalformed("duplicate_exact_claim");
      continue;
    }
    const sameSideExisting = [
      ...(state.points || []).filter((point) => normalizeSideId(point.sideId) === normalizeSideId(sideId)),
      ...(acceptedClaimsBySide.get(normalizeSideId(sideId)) || [])
    ];
    if (sameSideExisting.some((existing) => isNearDuplicateClaim(claim, existing.claim || existing.quote || ""))) {
      markMalformed("duplicate_semantic_claim");
      continue;
    }

    let sourceTurns = explicitTurnIds.length
      ? expandSourceTurnIds(explicitTurnIds, turnsById)
      : uniqueStrings([sourceTurn.id, ...(sourceTurn.turnIds || []), ...(sourceTurn.rawTurnIds || [])].filter(Boolean));
    const claimMode = normalizeClaimMode(candidate?.claimMode || "speaker_assertion");
    const quoteRole = normalizeQuoteRole(candidate?.quoteRole || "owned_statement");
    const topicContinuity = normalizeTopicContinuity(candidate?.topicContinuity || "main_thread");
    const ownershipType = normalizeOwnershipType(candidate?.ownershipType || "owned_assertion");
    const speechAct = normalizeSpeechAct(candidate?.speechAct || "assertion");
    const requestedSourceDebatePointId = cleanClaimText(candidate?.sourceDebatePointId || candidate?.parentPointId || candidate?.pointId || "");
    const requestedDebatePoint = requestedSourceDebatePointId
      ? debatePointLedger.find((point) => point.pointId === requestedSourceDebatePointId)
      : null;
    const sourceTurnIdSet = new Set(sourceTurns);
    const matchedDebatePoint = requestedDebatePoint || debatePointLedger.find((point) => (
      point.speakerId === speakerId
      && normalizeSideId(point.sideId) === normalizeSideId(sideId)
      && (
        (point.turnIds || []).some((turnId) => sourceTurnIdSet.has(turnId))
        ||
        textSupportScore(quote, point.quote || "") >= 0.35
        || tokenOverlapRatio(normalizeTranscript(claim), normalizeTranscript(point.point || "")) >= 0.55
      )
    ));
    const sourceDebatePointId = cleanClaimText(matchedDebatePoint?.pointId || "");
    if (!sourceDebatePointId) {
      markMalformed(requestedSourceDebatePointId ? "source_debate_point_not_found" : "missing_source_debate_point");
      continue;
    }
    if (matchedDebatePoint?.speakerId && matchedDebatePoint.speakerId !== speakerId) {
      markMalformed("source_debate_point_speaker_mismatch");
      continue;
    }
    if (normalizeSideId(matchedDebatePoint?.sideId) && normalizeSideId(matchedDebatePoint.sideId) !== normalizeSideId(sideId)) {
      markMalformed("source_debate_point_side_mismatch");
      continue;
    }
    if (!sourceTurns.length) sourceTurns = uniqueStrings(matchedDebatePoint.turnIds || []);
    const parentPointId = sourceDebatePointId;
    const ownershipConfidence = clamp01(candidate?.ownershipConfidence, 1);
    const boundaryConfidence = clamp01(candidate?.boundaryConfidence, 1);
    const normalizedPoint = {
      id: sourceDebatePointId,
      speakerId,
      rawSpeakerId: rawSpeakerId !== speakerId ? rawSpeakerId : undefined,
      sideId,
      sideOwnershipMode: "claim_builder",
      sideOwnershipConfidence: 1,
      sideOwnershipReason: "Claim Builder selected the side from the source debate point.",
      role: "claim",
      claimMode,
      quoteRole,
      topicContinuity,
      ownershipType,
      ownershipConfidence,
      ownershipReason: cleanAgentDisplayText(candidate?.ownershipReason || ""),
      speechAct,
      boundaryConfidence,
      familyHint: cleanClaimText(candidate?.familyHint || directClaimKey(claim) || directTextSignature(claim)),
      assertionStatus: "asserted",
      assertionWhy: "Claim Builder selected this as a Claims tab claim.",
      sourceSpeakerId: rawSpeakerId,
      sourceDebatePointId,
      parentPointId,
      claim,
      quote,
      turnIds: sourceTurns,
      at: Number(sourceTurn.at || Date.now()),
      startSec: sourceTurn.startSec ?? matchedDebatePoint.startSec,
      endSec: sourceTurn.endSec ?? matchedDebatePoint.endSec,
      factStatus: "checking",
      confidence: 0.5,
      why: "Fact check pending.",
      sources: [],
      burden: cleanAgentDisplayText(candidate?.burden || ""),
      audit: {
        quote,
        turnIds: sourceTurns,
        at: Number(sourceTurn.at || Date.now()),
        startSec: sourceTurn.startSec ?? matchedDebatePoint.startSec,
        endSec: sourceTurn.endSec ?? matchedDebatePoint.endSec,
        ownershipContextText: truncatePromptText(sourceTurn.text || quote, 900),
        ownershipRisk: "",
        ownershipRiskReason: "",
        rawSpeakerId,
        representativeSpeakerId: speakerId,
        sourceDebatePointId,
        ownerSideId: sideId,
        ownerSideConfidence: 1,
        sideOwnershipMode: "claim_builder",
        sideOwnershipReason: "Claim Builder selected the side from the source debate point.",
        speakerRole: normalizeFloorSpeakerRole(floorSpeakerStateFor(state, speakerId)?.role || DEBATER_SPEAKER),
        factExplanation: "Fact check pending.",
        sources: []
      }
    };
    if (!isClaimBuilderContractPoint(normalizedPoint)) {
      markMalformed("not_checkable_or_material");
      continue;
    }
    exactClaimKeys.add(exactClaimKey);
    output.push(normalizedPoint);
    const acceptedForSide = acceptedClaimsBySide.get(normalizeSideId(sideId)) || [];
    acceptedForSide.push(normalizedPoint);
    acceptedClaimsBySide.set(normalizeSideId(sideId), acceptedForSide);
  }
  if (trace) {
    logDeterministicStep(trace, "ClaimBuilder:normalized", createDirectTracePayload("ClaimBuilder", {
      RawClaimCandidates: candidates.length
    }, {
      ClaimCards: output.length
    }, {
      malformedByReason
    }));
  }
  return output;
}

function isClaimBuilderContractPoint(point = {}) {
  if (!shouldExternallyVerifyPoint(point)) return false;
  const claim = cleanAgentDisplayText(point.claim || "");
  const quote = cleanClaimText(point.quote || "");
  const normalized = normalizeTranscript(`${claim} ${quote}`);
  if (!claim || !quote) return false;
  if (isMetaNarrationPoint(claim) || isReportedSetupPoint(claim, quote, quote)) return false;
  if (isPlainValueOrDebateJudgmentClaim(claim)) return false;
  const hasAttribution = hasNamedAttributionOrMeasurement(`${claim} ${quote}`);
  const hasSourceAttribution = /\b(according to|report|reported|study|published|said|stated|testimony|quoted|court|tribunal|committee|official|minister|prosecutor|ruled|charged|indicted|found|filed|announced)\b/.test(normalized);
  if (/\b(if|assuming|suppose|hypothetically|could|might|may)\b/.test(normalized) && !hasSourceAttribution) {
    return false;
  }
  if (/\b(presented as evidence|evidence against|as evidence|evidence of|would constitute|would not necessarily|would know|not intended to|actions are not intended|every action|sometimes|pops out of nowhere|no ability to|could be|might be|implying|implies|implied|suggests|suggesting|proves|proving|shows that|demonstrates|great act)\b/.test(normalized) && !hasAttribution) {
    return false;
  }
  if (/\b(murdering|murdered|mass murder|en masse|demise|bring about the demise|unfit for human existence|decimating civilian infrastructure|genocidal)\b/.test(normalized) && !hasSourceAttribution) {
    return false;
  }
  if (/\b(intent|intended|intentionally|genocide requires|ethnic cleansing|would constitute|legal|illegal|required by international law)\b/.test(normalized)
    && !/\b(court|tribunal|law|statute|convention|report|reported|said|stated|quoted|published|ruled|charged|indicted|testimony|committee|official)\b/.test(normalized)) {
    return false;
  }
  if (/\b(ridiculous|absurd|reasonable|unreasonable|justification|possibility|belief|believe|better|worse|good|bad|love|hate)\b/.test(normalizeTranscript(claim))
    && !hasSourceAttribution
    && !/\b(data|poll|survey|study|report|reported|published|court|law|statute|official|committee)\b/.test(normalized)) {
    return false;
  }
  if (/\b(right to|wrong|opposed|outrageous|condemn|necessary action|bare minimum|justified reason|moral|immoral|ethical|unethical)\b/.test(normalizeTranscript(claim))
    && !hasSourceAttribution
    && !/\b(required by international law|law requires|court|statute|treaty|convention|official|committee|report|reported|published)\b/.test(normalized)) {
    return false;
  }
  if (/\b(genocide|apartheid|war crime|crime against humanity|ethnic cleansing)\b/.test(normalized)
    && /\b(is|are|was|were|constitutes?|implies|suggests|shows|proves|evidence)\b/.test(normalized)
    && !/\b(icj|icc|court|tribunal|law|statute|convention|prosecutor|report|reported|published|ruled|charged|indicted|found|said|stated|united nations|human rights watch|amnesty)\b/.test(normalized)) {
    return false;
  }
  if (wordCount(claim) > 34 && !hasAttribution) return false;
  return true;
}

function isPlainValueOrDebateJudgmentClaim(claim = "") {
  const normalized = normalizeTranscript(claim || "");
  if (!normalized) return true;
  const hasExternalAnchor = /\b(according to|report|reported|study|published|said|stated|testimony|quoted|court|tribunal|committee|official|minister|prosecutor|ruled|charged|indicted|found|filed|announced|required by international law|law requires|statute|treaty|convention)\b/.test(normalized);
  if (hasExternalAnchor) return false;
  return /\b(right to|wrong|opposed|outrageous|condemn|condemned|understandable|necessary first step|necessary action|bare minimum|justified reason|moral|immoral|ethical|unethical|should|ought|belief|believe|love|family)\b/.test(normalized);
}

function inferSideIdForSpeakerFromTurns(state, speakerId, turns = []) {
  if (!speakerId) return undefined;
  const existing = speakerSideFromState(state, speakerId);
  if (existing) return existing;
  const speakerTurnIds = (turns || [])
    .filter((turn) => turn.speakerId === speakerId)
    .flatMap((turn) => [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])]);
  if (!isSpeakerSideMapEligible(state, speakerId, speakerTurnIds)) return undefined;
  const floor = floorSpeakerStateFor(state, speakerId);
  const floorSideHint = normalizeAgentSideId({ side: floor?.sideHint });
  if (floorSideHint && Number(floor?.sideHintConfidence || 0) >= 0.78) {
    return coerceInitialSideAnchor(state, speakerId, floorSideHint);
  }
  const currentSideMap = buildCurrentSpeakerSideMap(state);
  const sideA = new Set(currentSideMap.filter((entry) => entry.sideId === "side-a").map((entry) => entry.speakerId));
  const sideB = new Set(currentSideMap.filter((entry) => entry.sideId === "side-b").map((entry) => entry.speakerId));
  const orderedSpeakers = uniqueStrings([...(state.speakers || []).map((speaker) => speaker.speakerId), ...(turns || []).map((turn) => turn.speakerId)]);
  const eligibleOrderedSpeakers = orderedSpeakers.filter((candidate) => isSpeakerSideMapEligible(state, candidate, (turns || [])
    .filter((turn) => turn.speakerId === candidate)
    .flatMap((turn) => [turn.id, ...(turn.turnIds || []), ...(turn.rawTurnIds || [])])));
  if (!sideA.size && !sideB.size && eligibleOrderedSpeakers.length === 1 && eligibleOrderedSpeakers[0] === speakerId) {
    return BLUE_SIDE_ID;
  }
  return undefined;
}

function auditCandidateAssertion(candidate, turns, turnsById, turnTextBySpeaker) {
  const speakerId = candidate?.speakerId;
  const claim = cleanClaimText(candidate?.claim || "");
  const quote = cleanClaimText(candidate?.quote || claim);
  const explicitTurnIds = uniqueStrings(Array.isArray(candidate?.turnIds) ? candidate.turnIds : []);
  const candidateTurns = explicitTurnIds.map((id) => turnsById.get(id)).filter(Boolean);
  const candidateSpeakerTurns = candidateTurns.filter((turn) => turn.speakerId === speakerId);
  const otherSpeakerTurns = candidateTurns.filter((turn) => turn.speakerId !== speakerId);
  const speakerText = candidateSpeakerTurns.map((turn) => turn.text).join(" ") || turnTextBySpeaker.get(speakerId) || "";

  if (!speakerId) {
    return assertionAudit("unfaithful", "Candidate did not include a speaker.", speakerId, quote, explicitTurnIds, speakerText);
  }

  const answerAudit = auditQuestionAnswerOwnership(candidate, turns, turnsById);
  if (answerAudit) return answerAudit;

  if (isQuestionOnlyPoint(claim, quote, speakerText)) {
    return assertionAudit("question_only", "The assigned speaker asked or framed a question rather than endorsing the claim.", speakerId, quote, explicitTurnIds, speakerText);
  }

  if (otherSpeakerTurns.length && !candidateSpeakerTurns.length) {
    const best = bestSpeakerForClaimOrQuote(claim, quote, turnTextBySpeaker);
    return assertionAudit("cross_speaker", "The quote belongs to a different speaker.", best?.speakerId || speakerId, quote, explicitTurnIds, best?.sourceText || "");
  }

  if (otherSpeakerTurns.length && candidateSpeakerTurns.length) {
    const speakerSupport = textSupportScore(`${claim} ${quote}`, speakerText);
    const otherSupport = Math.max(...otherSpeakerTurns.map((turn) => textSupportScore(`${claim} ${quote}`, turn.text)), 0);
    if (otherSupport > speakerSupport + 0.18) {
      return assertionAudit("cross_speaker", "The candidate mixes another speaker's words into this speaker's point.", speakerId, quote, explicitTurnIds, speakerText);
    }
  }

  if (isReportedOnlyPoint(claim, quote, speakerText)) {
    return assertionAudit("reported_only", "The assigned speaker appears to be reporting another person's position without endorsing it.", speakerId, quote, explicitTurnIds, speakerText);
  }

  if (isLikelyVocativeMisattribution(claim, speakerText)) {
    return assertionAudit("unfaithful", "The candidate turns a person being addressed into a credentialed source or actor.", speakerId, quote, explicitTurnIds, speakerText);
  }

  const faithful = isClaimFaithfulToTurn(quote, speakerText) || isClaimFaithfulToTurn(claim, speakerText);
  if (!faithful) {
    const best = bestSpeakerForClaimOrQuote(claim, quote, turnTextBySpeaker);
    if (best && best.speakerId !== speakerId && best.score >= 0.72) {
      return assertionAudit("cross_speaker", "The point is better supported by another speaker's words.", best.speakerId, quote, explicitTurnIds, best.sourceText);
    }
    return assertionAudit("unfaithful", "The assigned speaker's transcript does not support this claim or quote.", speakerId, quote, explicitTurnIds, speakerText);
  }

  return assertionAudit("asserted", "The assigned speaker asserted or endorsed this point in their own transcript.", speakerId, quote, explicitTurnIds, speakerText);
}

function assertionAudit(assertionStatus, assertionWhy, sourceSpeakerId, quote, turnIds, sourceText, extras = {}) {
  return {
    assertionStatus,
    assertionWhy,
    sourceSpeakerId,
    quote,
    turnIds,
    sourceText,
    ...extras
  };
}

function auditQuestionAnswerOwnership(candidate, turns, turnsById) {
  const claim = cleanClaimText(candidate?.claim || "");
  const quote = cleanClaimText(candidate?.quote || claim);
  const explicitTurnIds = uniqueStrings(Array.isArray(candidate?.turnIds) ? candidate.turnIds : []);
  const orderedTurns = explicitTurnIds.length ? explicitTurnIds.map((id) => turnsById.get(id)).filter(Boolean) : turns;
  for (let index = 1; index < orderedTurns.length; index += 1) {
    const questionTurn = orderedTurns[index - 1];
    const answerTurn = orderedTurns[index];
    if (!questionTurn || !answerTurn || questionTurn.speakerId === answerTurn.speakerId) continue;
    if (!isQuestionLike(questionTurn.text)) continue;
    if (!isAffirmativeAnswer(answerTurn.text)) continue;
    const questionSupport = textSupportScore(claim, questionTurn.text);
    if (questionSupport < 0.38 && !isClaimFaithfulToTurn(claim, questionTurn.text)) continue;
    const answerQuote = cleanClaimText(answerTurn.text);
    return assertionAudit(
      "asserted",
      `${answerTurn.speakerId} endorsed the immediately previous question from ${questionTurn.speakerId}.`,
      answerTurn.speakerId,
      answerQuote,
      [answerTurn.id],
      answerQuote,
      { answerContext: { questionTurnId: questionTurn.id, question: questionTurn.text, answerTurnId: answerTurn.id } }
    );
  }
  if ((isQuestionLike(quote) || isQuestionLike(claim)) && !hasAssertedPremiseInQuestion(claim, quote)) {
    return assertionAudit("question_only", "The candidate is a question without an endorsement in the same batch.", candidate?.speakerId, quote, explicitTurnIds, "");
  }
  return null;
}

function bestSpeakerForClaimOrQuote(claim, quote, turnTextBySpeaker) {
  let best = null;
  for (const [speakerId, sourceText] of turnTextBySpeaker.entries()) {
    const score = Math.max(textSupportScore(claim, sourceText), textSupportScore(quote, sourceText));
    if (!best || score > best.score) best = { speakerId, sourceText, score };
  }
  return best;
}

function textSupportScore(candidateText, sourceText) {
  const candidateTokens = meaningfulTokens(candidateText || "");
  const sourceTokens = new Set(meaningfulTokens(sourceText || ""));
  if (!candidateTokens.length || !sourceTokens.size) return 0;
  const overlap = candidateTokens.filter((token) => sourceTokens.has(token)).length;
  return overlap / candidateTokens.length;
}

function isAcceptablePointQuote(quote, audit) {
  if (audit?.answerContext && isAffirmativeAnswer(quote)) return true;
  if (hasAssertedPremiseInQuestion(audit?.sourceText || "", quote)) return true;
  return isCompleteDebatePoint(quote);
}

function isQuestionOnlyPoint(claim, quote, sourceText) {
  const text = cleanClaimText(`${claim} ${quote}`);
  if (!text) return false;
  if (hasAssertedPremiseInQuestion(claim, quote)) return false;
  if (!isQuestionLike(claim) && isQuestionLike(quote) && /\b(more|less|greater|fewer|higher|lower|killed|displaced|cost|risk|percent|\d{2,})\b/i.test(claim)) {
    return false;
  }
  if (isQuestionLike(claim) || isQuestionLike(quote)) {
    return !/\b(i|we)\s+(think|believe|argue|say|maintain)|\b(100%|yes|no|exactly|correct|right)\b/i.test(sourceText || "");
  }
  return /^\s*(why|what|how|is|are|do|does|did|can|could|should|would|will)\b/i.test(text) && /\?$/.test(text);
}

function isQuestionLike(text = "") {
  const trimmed = cleanClaimText(text);
  return trimmed.endsWith("?") || /^(why|what|how|is|are|do|does|did|can|could|should|would|will)\b/i.test(trimmed);
}

function hasAssertedPremiseInQuestion(claim = "", quote = "") {
  const claimText = cleanClaimText(claim);
  const quoteText = cleanClaimText(quote);
  if (!isQuestionLike(quoteText) && !isQuestionLike(claimText)) return false;
  const combined = `${claimText} ${quoteText}`;
  const hasComparativePremise = /\b(more|less|greater|fewer|higher|lower|far more|not the same|double standard|same standard|whereas|while|but not)\b/i.test(combined);
  const hasConcreteEvidence = /\b(killed|displaced|cost|risk|percent|official|minister|government|court|law|intent|genocide|war crime|\d{2,})\b/i.test(combined);
  const hasBurdenLanguage = /\b(because|given|when|despite|even though|based on)\b/i.test(combined);
  return hasConcreteEvidence && (hasComparativePremise || hasBurdenLanguage);
}

function isAffirmativeAnswer(text = "") {
  const normalized = normalizeTranscript(text);
  return /^(100|yes|yeah|yep|correct|exactly|right|absolutely|i do|it is|they do|that is|thats right)\b/.test(normalized);
}

function isReportedOnlyPoint(claim, quote, sourceText) {
  const text = cleanClaimText(`${claim} ${quote}`);
  const source = cleanClaimText(sourceText || text);
  if (isReportedSpeechWithoutInference(claim, quote, sourceText)) return true;
  if (/^(you|he|she|they|someone|people|critics|supporters)\s+(said|say|says|argued|argue|claimed|claim|believe|think)\b/i.test(text)) return true;
  if (/\b(you have been|you've been|you said|you called|you criticized|people are asking)\b/i.test(source)
    && !/\b(i|we)\s+(think|believe|argue|say|maintain)|\b(this shows|this proves|therefore|so that means)\b/i.test(source)) {
    return true;
  }
  return false;
}

function inferClaimModeFromCandidate(candidate = {}) {
  const role = normalizePointRole(candidate?.role || "claim");
  const text = `${candidate?.claim || ""} ${candidate?.quote || ""}`;
  if (isMetaNarrationPoint(text) || isDebateStrategyMetaText(text)) return "meta_commentary";
  if (hasReportedSpeechCue(text) && !hasCurrentSpeakerInference(text)) return "reported_opponent_claim";
  if (hasReportedSpeechCue(text) && hasCurrentSpeakerInference(text)) return "quoted_evidence";
  if (role === "rebuttal") return "speaker_challenge";
  if (role === "evidence") return "quoted_evidence";
  return "speaker_assertion";
}

function inferQuoteRoleFromCandidate(candidate = {}) {
  const text = `${candidate?.claim || ""} ${candidate?.quote || ""}`;
  if (hasReportedSpeechCue(text) && !hasCurrentSpeakerInference(text)) return "opponent_quote";
  if (hasReportedSpeechCue(text)) return "external_quote";
  if (isQuestionLike(candidate?.quote || candidate?.claim || "")) return "owned_question";
  return "owned_statement";
}

function inferTopicContinuityFromCandidate(candidate = {}, state = {}) {
  const text = cleanClaimText(`${candidate?.claim || ""} ${candidate?.quote || ""}`);
  if (isDebateStrategyMetaText(text) || isMetaNarrationPoint(text)) return "meta";
  const scored = (state?.points || []).filter(isScoredPoint);
  if (scored.length < 4) return "main_thread";
  const topicText = normalizeTranscript([
    state.topic || "",
    ...(state.sides || []).map(confirmedSideLabel),
    ...scored.slice(0, 16).map((point) => point.claim || "")
  ].join(" "));
  const overlap = tokenOverlapRatio(normalizeTranscript(text), topicText);
  if (overlap >= 0.12 || hasDirectResponseCue(text)) return "main_thread";
  if (isDebateStrategyMetaText(text)) return "meta";
  return "off_topic";
}

function isCandidateOwnershipEligible({ claim = "", quote = "", claimMode = "", quoteRole = "", topicContinuity = "", ownershipType = "", ownershipConfidence = undefined, boundaryConfidence = undefined } = {}) {
  const mode = normalizeClaimMode(claimMode);
  const role = normalizeQuoteRole(quoteRole);
  const continuity = normalizeTopicContinuity(topicContinuity);
  const ownership = ownershipType ? normalizeOwnershipType(ownershipType) : "";
  if (["reported_opponent_claim", "meta_commentary", "off_topic"].includes(mode)) return false;
  if (["meta", "off_topic"].includes(continuity)) return false;
  if (ownership && !isOwnedOwnershipType(ownership)) return false;
  if (ownership && clamp01(ownershipConfidence, 0.7) < 0.55) return false;
  if (boundaryConfidence !== undefined && clamp01(boundaryConfidence, 0.8) < 0.45) return false;
  if (role === "opponent_quote" || role === "external_quote") {
    return mode === "quoted_evidence" && hasCurrentSpeakerInference(`${claim} ${quote}`);
  }
  return true;
}

function hasReportedSpeechCue(text = "") {
  const normalized = normalizeTranscript(text);
  return /\b(you said|you have said|you ve said|you keep saying|you called|you wrote|you argued|you are saying|you re saying|you're saying|he says|he said|he would say|she says|she said|she would say|they say|they said|they would say|they are saying|they re saying|they're saying|people would say|critics would say|supporters would say|his words|her words|their words|i have a quote|i've got a quote|got a quote|according to you|according to him|according to her|quote from you|quote from him|quote from her)\b/.test(normalized);
}

function hasCurrentSpeakerInference(text = "") {
  const normalized = normalizeTranscript(text);
  return /\b(i|we|my|our)\s+(argue|claim|think|believe|say|maintain|contend|mean|am saying|are saying)\b/.test(normalized)
    || /\b(this|that|these|those|it)\s+(shows|show|proves|prove|means|mean|demonstrates|demonstrate|reveals|reveal|undercuts|weakens|supports|establishes)\b/.test(normalized)
    || /\b(therefore|so that means|which means|because of that|for that reason)\b/.test(normalized);
}

function hasDirectResponseCue(text = "") {
  return /\b(your claim|you are saying|you said|that does not|that is not|no because|but|however|therefore|answer|respond|challenge|refute|concede)\b/i.test(text);
}

function isReportedSpeechWithoutInference(claim = "", quote = "", sourceText = "") {
  const combined = `${claim} ${quote} ${sourceText}`;
  return hasReportedSpeechCue(combined) && !hasCurrentSpeakerInference(combined);
}

function isVagueSetupPoint(claim = "", quote = "") {
  const text = normalizeTranscript(`${claim} ${quote}`);
  if (!text) return true;
  const words = wordCount(text);
  const concreteTokens = meaningfulTokens(text)
    .filter((token) => !["think", "goes", "motive", "intent", "point", "claim", "side", "issue", "thing", "true", "valid", "context"].includes(token));
  if (/\b(i think it goes to|it goes to|this goes to|that goes to)\b/.test(text) && /\b(intent|motive|definition|standard|context|point)\b/.test(text) && (words <= 12 || concreteTokens.length < 3)) return true;
  if (/^(that is|that s|thats|this is|it is|its)\s+(true|fair|right|wrong|bad|good|important|interesting|valid|not true)\b/.test(text) && words <= 12) return true;
  if (/^(there is|there s|theres)\s+(truth|some truth|a point)\b/.test(text) && words <= 12) return true;
  if (/^(i agree|i accept|fair enough|fair point|sure|okay|right)\b/.test(text) && words <= 10) return true;
  if (words <= 9 && concreteTokens.length < 3 && !/\b(should|must|because|therefore|killed|cost|risk|law|evidence|source|data|\d{2,})\b/.test(text)) return true;
  return false;
}

function looksLikeBadSttClaim(claim = "", quote = "") {
  const text = cleanClaimText(`${claim} ${quote}`);
  const normalized = normalizeTranscript(text);
  if (!normalized) return true;
  if (looksLikeIncompleteClaimQuote(quote || claim)) return true;
  if (/^\d+(?:[.,]\d+)?\s+(million|billion|thousand)\s+(is|are|was|were)\s+(a\s+)?(war crime|crime|genocide|burden|claim)\b/.test(normalized)) return true;
  if (/\b(oh|uh|um|yeah)\s+\d{2,}\b/.test(normalized) && wordCount(normalized) < 10) return true;
  if (/\b(000|00|million million|percent percent)\b/.test(normalized) && wordCount(normalized) < 16) return true;
  if (/[^\w\s.,!?;:'"()/-]{2,}/.test(text)) return true;
  return false;
}

function isDebateStrategyMetaText(text = "") {
  const normalized = normalizeTranscript(text);
  return /\b(best strategy|debate strategy|in a debate|in an claim|on the offensive|defensive stance|win this debate|lose this debate|my opponent will|your side will never|progressives often|conservatives often|i explained to him|talk to people like you|audience watching|clip this|this format)\b/.test(normalized);
}

function isOffThreadDebatePoint(claim = "", quote = "", sourceText = "", state = {}, topicContinuity = "") {
  const continuity = normalizeTopicContinuity(topicContinuity);
  if (["meta", "off_topic"].includes(continuity)) return true;
  const text = `${claim} ${quote} ${sourceText}`;
  if (isDebateStrategyMetaText(text)) return true;
  const scored = (state?.points || []).filter(isScoredPoint);
  if (scored.length < 6) return false;
  if (continuity === "direct_response" || continuity === "sustained_new_topic") return false;
  const topicText = normalizeTranscript([
    state.topic || "",
    ...(state.sides || []).map(confirmedSideLabel),
    ...scored.slice(0, 24).map((point) => point.claim || "")
  ].join(" "));
  if (!topicText) return false;
  const overlap = tokenOverlapRatio(normalizeTranscript(`${claim} ${quote}`), topicText);
  return overlap < 0.08 && !hasDirectResponseCue(text);
}

function isLikelyVocativeMisattribution(claim, sourceText) {
  const normalizedClaim = normalizeTranscript(claim);
  const normalizedSource = normalizeTranscript(sourceText);
  if (!normalizedClaim || !normalizedSource) return false;
  if (/\bjoe walsh\b/.test(normalizedClaim) && /\bholocaust historian/.test(normalizedClaim)) return true;
  const roleThenName = /\b(historians?|scholars?|experts?|ministers?|officials?|doctors?|lawyers?|journalists?)\b(?:\s+\w+){0,4}\s+\b([a-z]+)\s+([a-z]+)\b/.exec(normalizedClaim);
  if (!roleThenName) return false;
  const person = `${roleThenName[2]} ${roleThenName[3]}`;
  return normalizedSource.includes(person)
    && /,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\.?$/u.test(sourceText.trim())
    && !new RegExp(`${person.replace(/\s+/g, "\\s+")}\\s+(is|was|as|a|an)\\s+`).test(normalizedSource);
}

function coercePointRole(role, claim, quote, sourceText) {
  const text = normalizeTranscript(`${claim} ${quote} ${sourceText}`);
  if (role === "dropped_point") return "claim";
  if (/\b(i would condemn|i will condemn|i respect those opinions|i can find extreme|there are extreme)\b/.test(text)) return "concession";
  if (/\b(your claim|according to .* logic|therefore according|that does not make|that is not engaging|hold on)\b/.test(text)) return "rebuttal";
  if (/\b(consists of|is a member of|are members of|current prime minister|minister of|party member|senior member)\b/.test(text)
    && !/\b(therefore|this shows|this proves|counts as|intent|genocid|kill|harm|target)\b/.test(text)) {
    return "evidence";
  }
  if (isMetaNarrationPoint(claim) || /\b(asks whether|questions whether|raises the question|big news right now)\b/.test(text)) return "framing";
  return role;
}

function expandSourceTurnIds(turnIds, turnsById) {
  return uniqueStrings((turnIds || []).flatMap((id) => turnsById.get(id)?.turnIds || [id]).filter(Boolean));
}

function debatePointCandidateScore(candidate) {
  const claim = cleanClaimText(candidate?.claim || "");
  const quote = cleanClaimText(candidate?.quote || "");
  const text = `${claim} ${quote}`;
  let score = claimTextScore(claim);
  if (isMetaNarrationPoint(claim)) score -= 80;
  if (/\b(speaker\s+\d+|the speaker|this speaker)\b/i.test(text)) score -= 30;
  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/.test(`${claim} ${quote}`)) score += 4;
  if (/\b\d{2,}(?:[.,]\d+)?%?\b/.test(text)) score += 5;
  if (/\b(government|court|parliament|congress|ministry|company|university|agency|military|police|committee|commission|report|study|poll|law|treaty|agreement|budget|tax|emissions|cost|risk|benefit|harm|intent|evidence|data)\b/i.test(text)) score += 5;
  if (/\b(causes?|caused|because|therefore|shows?|proves?|means|leads? to|results? in|compared with|more than|less than|higher than|lower than)\b/i.test(text)) score += 5;
  if (/\b(big news right now|a lot of people are asking|is the defense pact)\b/i.test(text)) score -= 60;
  if (claim.length > 220) score -= 8;
  return score;
}

function mergeDebatePoints(state, nextPoints) {
  const points = [...state.points];
  for (const point of nextPoints) {
    if (!point?.id) continue;
    const existingIndex = points.findIndex((existing) => existing.id === point.id);
    if (existingIndex !== -1) {
      points[existingIndex] = mergeDebatePointFacts(points[existingIndex], point);
      continue;
    }
    const exactDuplicate = points.some((existing) => (
      normalizeSideId(existing.sideId) === normalizeSideId(point.sideId)
      && directTextSignature(existing.claim || "") === directTextSignature(point.claim || "")
    ));
    if (exactDuplicate) continue;
    const repeatedClaim = points.some((existing) => (
      normalizeSideId(existing.sideId) === normalizeSideId(point.sideId)
      && (isRepeatedPoint(point.claim || "", [existing]) || isNearDuplicateClaim(point.claim || "", existing.claim || existing.quote || ""))
    ));
    if (repeatedClaim) continue;
    points.unshift(point);
  }
  return enforceSpeakerPointSides(syncSidesFromSpeakers({ ...state, points }));
}

function preserveDurableFactState(previousState = {}, incomingState = {}) {
  const previous = normalizeClaimState(previousState);
  const incoming = normalizeClaimState(incomingState);
  const previousPointsById = new Map(previous.points.map((point) => [point.id, point]));
  const incomingPointIds = new Set(incoming.points.map((point) => point.id));
  const points = incoming.points.map((point) => mergeDebatePointFacts(previousPointsById.get(point.id), point));
  for (const point of previous.points) {
    if (!incomingPointIds.has(point.id)) points.push(point);
  }
  const state = {
    ...incoming,
    points,
    artifacts: mergeDurableSourceArtifacts(previous.artifacts, incoming.artifacts)
  };
  return finalizeDirectLedgerState(state);
}

function mergeDebatePointFacts(current, incoming) {
  if (!current) return incoming;
  const merged = {
    ...current,
    ...incoming,
    audit: {
      ...(current.audit || {}),
      ...(incoming.audit || {})
    }
  };
  const currentStatus = normalizeFactStatus(current.factStatus || "checking");
  const incomingStatus = normalizeFactStatus(incoming.factStatus || "checking");
  const currentRank = factStatusDurabilityRank(currentStatus);
  const incomingRank = factStatusDurabilityRank(incomingStatus);
  const incomingHasSources = hasPointSourceEvidence(incoming);
  const currentHasSources = hasPointSourceEvidence(current);
  const shouldPreserveCurrentFacts =
    currentStatus !== "checking"
    && (incomingStatus === "checking" || (currentRank > incomingRank && !incomingHasSources) || (currentHasSources && !incomingHasSources && incomingRank <= currentRank));
  if (!shouldPreserveCurrentFacts) return merged;
  return copyPointFactFields(merged, current);
}

function copyPointFactFields(target, source) {
  const sourceSources = normalizeSources(source.sources || source.audit?.sources || []);
  const evidenceBasis = normalizeSourceEvidenceBasis(source.evidenceBasis || source.audit?.evidenceBasis, {
    status: source.factStatus,
    sources: sourceSources,
    explanation: source.why || source.audit?.factExplanation || "",
    point: source
  });
  const scoreEligible = isSourceScoreEligible({
    ...source,
    status: source.factStatus,
    evidenceBasis,
    sources: sourceSources
  });
  return {
    ...target,
    factStatus: normalizeFactStatus(source.factStatus),
    evidenceBasis,
    scoreEligible,
    confidence: source.confidence,
    why: source.why,
    sources: sourceSources,
    noSourceReason: source.noSourceReason || "",
    audit: {
      ...(target.audit || {}),
      ...(source.audit || {}),
      factExplanation: source.audit?.factExplanation || source.why || target.audit?.factExplanation || "",
      evidenceBasis,
      scoreEligible,
      sources: sourceSources
    }
  };
}

function hasPointSourceEvidence(point) {
  return normalizeSources(point?.sources || point?.audit?.sources || []).length > 0;
}

function factStatusDurabilityRank(status) {
  const normalized = normalizeFactStatus(status);
  if (normalized === "verified" || normalized === "contradicted") return 3;
  if (normalized === "no_clear_source" || normalized === "cannot_verify") return 2;
  return 1;
}

function mergeDurableSourceArtifacts(previousArtifacts = {}, incomingArtifacts = {}) {
  const previous = normalizeArtifacts(previousArtifacts);
  const incoming = normalizeArtifacts(incomingArtifacts);
  return {
    ...incoming,
    sourceChecks: mergeSourceCheckArtifacts(previous.sourceChecks, incoming.sourceChecks)
  };
}

function mergeSourceCheckArtifacts(previousChecks = [], incomingChecks = []) {
  const byId = new Map();
  for (const check of [...previousChecks, ...incomingChecks]) {
    if (!check?.id) continue;
    const current = byId.get(check.id);
    byId.set(check.id, preferSourceCheckArtifact(current, check));
  }
  return [...byId.values()];
}

function preferSourceCheckArtifact(current, incoming) {
  if (!current) return incoming;
  const currentStatus = normalizeFactStatus(current.status || "checking");
  const incomingStatus = normalizeFactStatus(incoming.status || "checking");
  const currentRank = factStatusDurabilityRank(currentStatus);
  const incomingRank = factStatusDurabilityRank(incomingStatus);
  const currentHasSources = normalizeSources(current.sources).length > 0;
  const incomingHasSources = normalizeSources(incoming.sources).length > 0;
  if (currentStatus !== "checking" && incomingStatus === "checking") return current;
  if (currentRank > incomingRank && !incomingHasSources) return current;
  if (currentHasSources && !incomingHasSources && incomingRank <= currentRank) return current;
  return incoming;
}

function mergeRebuttals(state, candidateLinks, newPoints = []) {
  const rebuttals = [...state.rebuttals];
  const points = [...newPoints, ...state.points];
  for (const link of Array.isArray(candidateLinks) ? candidateLinks : []) {
    const type = normalizeRebuttalType(link?.type);
    if (!["refutes", "supports", "concedes"].includes(type)) continue;
    const speakerId = link?.speakerId;
    const fromPoint = findLinkedFromPoint(points, newPoints, link, speakerId);
    const toPoint = findLinkedTargetPoint(points, link);
    if (!speakerId || !fromPoint?.id || !toPoint?.id || fromPoint.id === toPoint.id) continue;
    if (!isScoredPoint(fromPoint) || !isScoredPoint(toPoint)) continue;
    if (fromPoint.sideId === toPoint.sideId && type === "refutes") continue;
    const sourceQuote = cleanClaimText(link.sourceQuote || link.fromQuote || fromPoint.quote || fromPoint.claim);
    const targetQuote = cleanClaimText(link.targetQuote || link.toQuote || toPoint.quote || toPoint.claim);
    const id = `${type}:${fromPoint.id}:${toPoint.id}:${directConflictQuoteKey(sourceQuote)}:${directConflictQuoteKey(targetQuote)}`;
    if (rebuttals.some((existing) => existing.id === id)) continue;
    rebuttals.push({
      id,
      fromPointId: fromPoint.id,
      toPointId: toPoint.id,
      speakerId,
      type,
      summary: cleanClaimText(link.summary || `${speakerId} ${type} ${toPoint.claim}`),
      sourceQuote,
      targetQuote,
      fromQuote: sourceQuote,
      toQuote: targetQuote,
      fromClaim: fromPoint.claim,
      toClaim: toPoint.claim,
      strength: Math.max(0, Math.min(1, Number(link.strength ?? 0.5)))
    });
  }
  return { ...state, rebuttals: rebuttals.slice(-80) };
}

function findLinkedFromPoint(points, newPoints, link, speakerId) {
  if (link?.fromPointId) {
    const direct = points.find((point) => point.id === link.fromPointId);
    if (direct) return direct;
  }
  if (link?.fromTurnId) {
    const fromTurn = newPoints.find((point) => point.speakerId === speakerId && point.turnIds?.includes(link.fromTurnId));
    if (fromTurn) return fromTurn;
  }
  return findPointByClaimStrict(points, link?.fromClaim, { speakerId });
}

function findLinkedTargetPoint(points, link) {
  if (link?.toPointId) return points.find((point) => point.id === link.toPointId);
  return findPointByClaimStrict(points, link?.targetClaim);
}

function findPointByClaimStrict(points, claimText, { speakerId } = {}) {
  const claim = normalizeTranscript(claimText || "");
  if (!claim || claim.length < 28) return null;
  return (points || []).find((point) => {
    if (speakerId && point.speakerId !== speakerId) return false;
    if (!isScoredPoint(point)) return false;
    const candidate = normalizeTranscript(point.claim || point.quote || "");
    return candidate && tokenOverlapRatio(candidate, claim) >= 0.9;
  }) || null;
}

function directConflictQuoteKey(text) {
  return normalizeTranscript(text).split(/\s+/).slice(0, 12).join("-");
}

function markDroppedPoints(state) {
  const rebuttedPointIds = new Set(state.rebuttals.filter((link) => link.type === "refutes").map((link) => link.toPointId));
  const concededPointIds = new Set(state.rebuttals.filter((link) => link.type === "concedes").map((link) => link.fromPointId));
  const points = state.points.map((point) => {
    if (point.role !== "claim") return point;
    if (rebuttedPointIds.has(point.id) || concededPointIds.has(point.id)) return point;
    return point;
  });
  return { ...state, points };
}

function computeKeyMomentScorecard(artifacts = {}, sidesInput = []) {
  const sides = ensureTwoSides(sidesInput);
  const moments = (artifacts.keyMoments || [])
    .filter((item) => item?.id && normalizeSideId(item.sideId));
  const pillarDefs = SCORE_PILLARS;
  const events = moments
    .map((moment) => {
      const delta = keyMomentDelta(moment);
      if (!delta) return null;
      const sideId = normalizeSideId(moment.sideId);
      if (!sideId) return null;
      const category = keyMomentCategory(moment);
      return {
        id: `score-${category}-${moment.id}`,
        sideId,
        side: sideId === "side-b" ? "red" : "blue",
        delta,
        value: delta,
        title: keyMomentScoreTitle(moment),
        detail: cleanClaimText(moment.summary || moment.title || ""),
        category,
        pillar: category,
        artifactIds: uniqueStrings([moment.id, ...(moment.artifactIds || [])].filter(Boolean)).slice(0, 8),
        minute: scoreEventMinuteFromArtifact(moment),
        at: Number(moment.at || Date.now()),
        weight: Math.abs(delta)
      };
    })
    .filter(Boolean);
  const sideLedger = (side, color) => {
    const sideEvents = events.filter((event) => event.sideId === side.id);
    const pillars = pillarDefs.map((definition) => {
      const value = sideEvents
        .filter((event) => event.category === definition.key)
        .reduce((sum, event) => sum + Number(event.delta || 0), 0);
      return {
        key: definition.key,
        label: definition.label,
        value,
        help: definition.help,
        artifactIds: uniqueStrings(sideEvents.filter((event) => event.category === definition.key).flatMap((event) => event.artifactIds || [])).slice(0, 8)
      };
    });
    const totalContribution = sideEvents.reduce((sum, event) => sum + Number(event.delta || 0), 0);
    return {
      sideId: side.id,
      label: confirmedSideLabel(side),
      color,
      score: Math.round(totalContribution),
      metrics: {
        claimsRaised: (artifacts.claims || []).filter((claim) => claim.sideId === side.id).length,
        claimsSupported: (artifacts.claims || []).filter((claim) => claim.sideId === side.id && claim.status === "supported").length,
        claimsDefended: 0,
        clashesWon: sideEvents.filter((event) => event.category === "strong_rebuttal").length,
        claimsUnanswered: sideEvents.filter((event) => event.category === "unanswered_challenge").length,
        concessionsForced: 0,
        inconsistencies: sideEvents.filter((event) => event.category === "inconsistency").length,
        penalty: Math.abs(sideEvents.filter((event) => event.delta < 0).reduce((sum, event) => sum + Number(event.delta || 0), 0)),
        sourceReliability: 0
      },
      pillars,
      events: sideEvents.slice(-24),
      rawStrength: Math.round(totalContribution),
      totalContribution,
      reasons: []
    };
  };
  const blue = sideLedger(sides[0], "blue");
  const red = sideLedger(sides[1], "red");
  const leader = blue.score === red.score ? "even" : blue.score > red.score ? "blue" : "red";
  const edgeLabel = leader === "even" ? (moments.length ? "Even" : "Forming") : leader === "blue" ? "Blue edge" : "Red edge";
  const reason = moments.length
    ? keyMomentScoreReason(blue, red, edgeLabel)
    : "Score starts at 0 and moves only when a Key Moment is added.";
  const ledger = {
    version: 5,
    method: "key_moment_score",
    events,
    sides: {
      [sides[0].id]: {
        sideId: sides[0].id,
        keyMomentCount: moments.filter((moment) => moment.sideId === sides[0].id).length,
        pillars: blue.pillars,
        totalContribution: blue.totalContribution,
        score: blue.score,
        rawStrength: blue.rawStrength
      },
      [sides[1].id]: {
        sideId: sides[1].id,
        keyMomentCount: moments.filter((moment) => moment.sideId === sides[1].id).length,
        pillars: red.pillars,
        totalContribution: red.totalContribution,
        score: red.score,
        rawStrength: red.rawStrength
      }
    }
  };
  return {
    version: 5,
    method: "key_moment_score",
    blue: { ...blue, reasons: keyMomentReasonLines(blue, red) },
    red: { ...red, reasons: keyMomentReasonLines(red, blue) },
    leader,
    leadMargin: Math.abs(blue.score - red.score),
    edgeLabel,
    reason,
    ledger,
    updatedAt: Date.now()
  };
}

function keyMomentCategory(moment = {}) {
  const kind = cleanClaimText(moment.kind || "");
  if (kind === "source_verified") return "source_verified";
  if (kind === "source_contradicted") return "source_contradicted";
  if (kind === "strong_rebuttal") return "strong_rebuttal";
  if (kind === "unanswered_challenge") return "unanswered_challenge";
  if (kind === "weak_response") return "weak_response";
  if (kind === "inconsistency") return "inconsistency";
  const text = normalizeTranscript(`${moment.title || ""} ${moment.summary || ""}`);
  if (/\bverified\b/.test(text)) return "source_verified";
  if (/\bcontradicted\b/.test(text)) return "source_contradicted";
  if (/\binconsistency|double standard\b/.test(text)) return "inconsistency";
  if (/\bunanswered\b/.test(text)) return "unanswered_challenge";
  return "strong_rebuttal";
}

function keyMomentScoreTitle(moment = {}) {
  const category = keyMomentCategory(moment);
  const definition = SCORE_PILLARS.find((pillar) => pillar.key === category);
  return definition?.label || cleanClaimText(moment.title || "Key moment");
}

function keyMomentReasonLines(side, opponent) {
  const ownPositive = (side.events || []).filter((event) => event.delta > 0).length;
  const ownNegative = (side.events || []).filter((event) => event.delta < 0).length;
  const opponentNegative = (opponent.events || []).filter((event) => event.delta < 0).length;
  const reasons = [];
  if (ownPositive) reasons.push(`${ownPositive} positive Key Moment${ownPositive === 1 ? "" : "s"}`);
  if (ownNegative) reasons.push(`${ownNegative} costly Key Moment${ownNegative === 1 ? "" : "s"}`);
  if (!ownPositive && opponentNegative) reasons.push(`Opponent lost ${opponentNegative} Key Moment${opponentNegative === 1 ? "" : "s"}`);
  return reasons.length ? reasons : ["No Key Moments yet"];
}

function keyMomentScoreReason(blue, red, edgeLabel) {
  if (edgeLabel === "Even") return `Both sides are level at ${blue.score}.`;
  const sideLabel = edgeLabel === "Blue edge" ? "Blue side" : "Red side";
  const margin = Math.abs(Number(blue.score || 0) - Number(red.score || 0));
  return `${sideLabel} leads by ${margin} on Key Moments.`;
}

function normalizeEvidenceStatus(value = "") {
  return ["trusted", "limited", "rejected"].includes(value) ? value : "";
}

function minDefinedNumber(left, right) {
  const values = [left, right].map(Number).filter(Number.isFinite);
  return values.length ? Math.min(...values) : undefined;
}

function maxDefinedNumber(left, right) {
  const values = [left, right].map(Number).filter(Number.isFinite);
  return values.length ? Math.max(...values) : undefined;
}

function finiteOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function scoreEventMinuteFromArtifact(item = {}) {
  const seconds = Number.isFinite(Number(item.endSec)) ? Number(item.endSec) : Number(item.startSec);
  return Number.isFinite(seconds) ? Number((seconds / 60).toFixed(1)) : undefined;
}

function roundScoreContribution(value = 0) {
  if (!Number.isFinite(Number(value))) return 0;
  const rounded = Math.round(Number(value));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function emptyCoreMetrics() {
  return { points: 0, supported: 0, disputed: 0, unclear: 0, strength: 0, penalty: 0 };
}

function normalizeScores(scores = {}) {
  if (Array.isArray(scores?.dimensions) && scores.dimensions.length) return scores;
  return {
    blue: 0,
    red: 0,
    dimensions: CORE_SCORE_DIMENSIONS.map(([key, label, weight]) => ({ key, label, weight, blue: 0, red: 0 }))
  };
}

function normalizeDebatePoint(point, sides) {
  const speakerId = point?.speakerId;
  const claim = cleanAgentDisplayText(point?.claim || "");
  const quote = cleanClaimText(point?.quote || point?.claim || "");
  const sideId = normalizeAgentSideId(point) || speakerSideFromSides(sides, speakerId);
  if (!speakerId || !claim || !sideId) return null;
  const factStatus = normalizeFactStatus(point.factStatus || VERDICT_TO_FACT_STATUS[point.verdict] || "no_clear_source");
  const turnIds = uniqueStrings(Array.isArray(point.turnIds) ? point.turnIds : point.turnId ? [point.turnId] : []);
  const sources = normalizeSources(point.sources);
  const evidenceBasis = normalizeSourceEvidenceBasis(point.evidenceBasis || point.audit?.evidenceBasis, {
    status: factStatus,
    sources,
    explanation: point.why || point.audit?.factExplanation || "",
    point
  });
  const scoreEligible = isSourceScoreEligible({
    ...point,
    factStatus,
    status: factStatus,
    evidenceBasis,
    sources
  });
  return {
    id: point.id || stablePointId(speakerId, claim, turnIds),
    speakerId,
    rawSpeakerId: cleanClaimText(point.rawSpeakerId || point.audit?.rawSpeakerId || ""),
    sideId,
    sideOwnershipMode: normalizeUtteranceOwnershipMode(point.sideOwnershipMode || point.audit?.sideOwnershipMode),
    sideOwnershipConfidence: point.sideOwnershipConfidence === undefined && point.audit?.ownerSideConfidence === undefined
      ? undefined
      : clamp01(point.sideOwnershipConfidence ?? point.audit?.ownerSideConfidence, 0),
    sideOwnershipReason: cleanAgentDisplayText(point.sideOwnershipReason || point.audit?.sideOwnershipReason || ""),
    role: normalizePointRole(point.role),
    speakerRole: normalizeFloorSpeakerRole(point.speakerRole || point.audit?.speakerRole || DEBATER_SPEAKER),
    floorRoleConfidence: point.floorRoleConfidence === undefined ? undefined : clamp01(point.floorRoleConfidence, 0),
    claimMode: normalizeClaimMode(point.claimMode || inferClaimModeFromCandidate(point)),
    quoteRole: normalizeQuoteRole(point.quoteRole || inferQuoteRoleFromCandidate(point)),
    topicContinuity: normalizeTopicContinuity(point.topicContinuity || "main_thread"),
    ownershipType: normalizeOwnershipType(point.ownershipType || inferOwnershipTypeFromCandidate(point)),
    ownershipConfidence: clamp01(point.ownershipConfidence, isOwnedOwnershipType(point.ownershipType || inferOwnershipTypeFromCandidate(point)) ? 0.72 : 0.45),
    ownershipReason: cleanAgentDisplayText(point.ownershipReason || point.audit?.ownershipReason || ""),
    ownershipRisk: cleanAgentDisplayText(point.ownershipRisk || point.audit?.ownershipRisk || ""),
    ownershipRiskReason: cleanAgentDisplayText(point.ownershipRiskReason || point.audit?.ownershipRiskReason || ""),
    speechAct: normalizeSpeechAct(point.speechAct || inferSpeechActFromCandidate(point)),
    boundaryConfidence: clamp01(point.boundaryConfidence, point.audit?.boundaryConfidence ?? 0.82),
    familyHint: cleanClaimText(point.familyHint || directClaimKey(claim) || directTextSignature(claim)),
    assertionStatus: normalizeAssertionStatus(point.assertionStatus),
    assertionWhy: cleanAgentDisplayText(point.assertionWhy || "Recovered from debate state."),
    sourceSpeakerId: point.sourceSpeakerId || speakerId,
    parentPointId: cleanClaimText(point.parentPointId || ""),
    claim,
    quote: quote || claim,
    turnIds,
    at: Number(point.at || Date.now()),
    startSec: point.startSec,
    endSec: point.endSec,
    factStatus,
    evidenceBasis,
    scoreEligible,
    evidenceStatus: normalizeEvidenceStatus(point.evidenceStatus || point.audit?.evidenceStatus) || undefined,
    evidenceReason: cleanAgentDisplayText(point.evidenceReason || point.audit?.evidenceReason || ""),
    confidence: Math.max(0, Math.min(1, Number(point.confidence ?? 0.5))),
    why: cleanAgentDisplayText(point.why || (sources.length ? "Relevant source context found." : "No useful source was found for this point yet.")),
    sources,
    noSourceReason: cleanAgentDisplayText(point.noSourceReason || ""),
    burden: cleanAgentDisplayText(point.burden || ""),
    audit: {
      quote: quote || claim,
      turnIds,
      at: Number(point.at || Date.now()),
      startSec: point.startSec,
      endSec: point.endSec,
      ownershipContextText: cleanClaimText(point.audit?.ownershipContextText || ""),
      ownershipRisk: cleanAgentDisplayText(point.ownershipRisk || point.audit?.ownershipRisk || ""),
      ownershipRiskReason: cleanAgentDisplayText(point.ownershipRiskReason || point.audit?.ownershipRiskReason || ""),
      rawSpeakerId: cleanClaimText(point.rawSpeakerId || point.audit?.rawSpeakerId || ""),
      representativeSpeakerId: cleanClaimText(point.audit?.representativeSpeakerId || speakerId),
      ownerSideId: normalizeSideId(point.audit?.ownerSideId || point.ownerSideId || point.sideId) || "",
      ownerSideConfidence: point.audit?.ownerSideConfidence === undefined && point.ownerSideConfidence === undefined && point.sideOwnershipConfidence === undefined
        ? undefined
        : clamp01(point.audit?.ownerSideConfidence ?? point.ownerSideConfidence ?? point.sideOwnershipConfidence, 0),
      sideOwnershipMode: normalizeUtteranceOwnershipMode(point.audit?.sideOwnershipMode || point.sideOwnershipMode),
      sideOwnershipReason: cleanAgentDisplayText(point.audit?.sideOwnershipReason || point.sideOwnershipReason || ""),
      factExplanation: cleanAgentDisplayText(point.audit?.factExplanation || point.why || (sources.length ? "Relevant source context found." : "No useful source was found for this point yet.")),
      evidenceBasis,
      scoreEligible,
      evidenceStatus: normalizeEvidenceStatus(point.evidenceStatus || point.audit?.evidenceStatus) || undefined,
      evidenceReason: cleanAgentDisplayText(point.evidenceReason || point.audit?.evidenceReason || ""),
      sources
    }
  };
}

function normalizeRebuttal(link) {
  if (!link?.fromPointId || !link?.toPointId || !link?.speakerId) return null;
  const type = normalizeRebuttalType(link.type);
  return {
    id: link.id || `${type}:${link.fromPointId}:${link.toPointId}`,
    fromPointId: link.fromPointId,
    toPointId: link.toPointId,
    speakerId: link.speakerId,
    type,
    summary: cleanAgentDisplayText(link.summary || ""),
    sourceQuote: cleanClaimText(link.sourceQuote || link.fromQuote || ""),
    targetQuote: cleanClaimText(link.targetQuote || link.toQuote || ""),
    fromQuote: cleanClaimText(link.fromQuote || ""),
    toQuote: cleanClaimText(link.toQuote || ""),
    fromClaim: cleanAgentDisplayText(link.fromClaim || ""),
    toClaim: cleanAgentDisplayText(link.toClaim || ""),
    strength: Math.max(0, Math.min(1, Number(link.strength ?? 0.5)))
  };
}

function mergeSpeakerProfiles(inputSpeakers, sides, points) {
  const speakers = new Map();
  for (const speaker of Array.isArray(inputSpeakers) ? inputSpeakers : []) {
    if (!speaker?.speakerId) continue;
    const speakerRole = normalizeFloorSpeakerRole(speaker.speakerRole);
    const floorRoleConfidence = speaker.floorRoleConfidence === undefined ? 0 : clamp01(speaker.floorRoleConfidence, 0);
    const recoveredSideId = speakerRole === NEUTRAL_SPEAKER && floorRoleConfidence >= 0.58
      ? undefined
      : normalizeSideId(speaker.sideId) || speakerSideFromSides(sides, speaker.speakerId);
    speakers.set(speaker.speakerId, {
      speakerId: speaker.speakerId,
      sideId: recoveredSideId,
      sideConfidence: Math.max(0, Math.min(1, Number(speaker.sideConfidence ?? 0))),
      lastSpokenAt: Number(speaker.lastSpokenAt || 0),
      firstSpokenAt: Number(speaker.firstSpokenAt || 0),
      firstStartSec: finiteOrUndefined(speaker.firstStartSec),
      lastStartSec: finiteOrUndefined(speaker.lastStartSec),
      lastEndSec: finiteOrUndefined(speaker.lastEndSec),
      turnCount: Number(speaker.turnCount || 0),
      wordCount: Number(speaker.wordCount || 0),
      voicedDurationSec: Number(speaker.voicedDurationSec || 0),
      speakerSource: cleanClaimText(speaker.speakerSource || ""),
      representativeSpeakerId: cleanClaimText(speaker.representativeSpeakerId || speaker.aliasOf || speaker.speakerId),
      aliasOf: cleanClaimText(speaker.aliasOf || ""),
      identityStatus: cleanClaimText(speaker.identityStatus || ""),
      identityConfidence: Math.max(0, Math.min(1, Number(speaker.identityConfidence ?? 0))),
      aliasReason: cleanClaimText(speaker.aliasReason || ""),
      speakerRole,
      floorRoleConfidence,
      floorRoleReason: cleanAgentDisplayText(speaker.floorRoleReason || ""),
      sampleText: truncatePromptText(speaker.sampleText || "", 1200),
      turnIds: uniqueStrings(speaker.turnIds || []),
      assignmentReason: cleanClaimText(speaker.assignmentReason || "")
    });
  }
  for (const side of sides) {
    for (const speakerId of side.speakerIds || []) {
      if (!speakers.has(speakerId)) {
        speakers.set(speakerId, {
          speakerId,
        sideId: side.id,
        sideConfidence: 0.75,
        lastSpokenAt: 0,
        representativeSpeakerId: speakerId,
        identityStatus: "confirmed",
        identityConfidence: 0.75,
        speakerRole: UNKNOWN_SPEAKER,
        floorRoleConfidence: 0,
        turnIds: [],
        assignmentReason: "Recovered from side registry."
      });
    }
    }
  }
  for (const point of points) {
    if (!isScoredPoint(point)) continue;
    if (!speakers.has(point.speakerId)) {
      speakers.set(point.speakerId, {
        speakerId: point.speakerId,
        sideId: point.sideId,
        sideConfidence: 0.7,
        lastSpokenAt: point.at || 0,
        representativeSpeakerId: point.speakerId,
        identityStatus: "confirmed",
        identityConfidence: 0.7,
        speakerRole: normalizeFloorSpeakerRole(point.speakerRole) === NEUTRAL_SPEAKER ? NEUTRAL_SPEAKER : DEBATER_SPEAKER,
        floorRoleConfidence: 0.72,
        turnIds: point.turnIds || [],
        assignmentReason: "Recovered from point ownership."
      });
    }
  }
  return resolveSpeakerIdentityAliases({ sides, points, speakers: [...speakers.values()] }).speakers;
}

function speakerSideFromState(state, speakerId) {
  const speaker = state.speakers?.find((item) => item.speakerId === speakerId);
  if (speaker?.identityStatus === "side_collision") return undefined;
  if (isModeratorSideAssignment({
    speakerId,
    reason: speaker?.assignmentReason || speaker?.floorRoleReason || "",
    evidenceQuote: speaker?.sampleText || "",
    state
  })) return undefined;
  const representativeSpeakerId = speaker?.representativeSpeakerId || speaker?.aliasOf;
  const representativeSpeaker = representativeSpeakerId && representativeSpeakerId !== speakerId
    ? state.speakers?.find((item) => item.speakerId === representativeSpeakerId)
    : null;
  return normalizeSideId(speaker?.sideId)
    || normalizeSideId(representativeSpeaker?.sideId)
    || speakerSideFromSides(state.sides || [], speakerId)
    || (representativeSpeakerId ? speakerSideFromSides(state.sides || [], representativeSpeakerId) : undefined);
}

function speakerSideFromSides(sides, speakerId) {
  return normalizeSideId((sides || []).find((side) => side.speakerIds?.includes(speakerId))?.id);
}

function speakerRosterSideFromRegistry(state = {}, speakerId = "") {
  const speaker = (state.speakers || []).find((item) => item.speakerId === speakerId);
  if (!speaker?.speakerId) return undefined;
  if (isNeutralFloorSpeaker(state, speaker.speakerId)) return undefined;
  if (isModeratorSideAssignment({
    speakerId: speaker.speakerId,
    reason: speaker.assignmentReason || speaker.floorRoleReason || "",
    evidenceQuote: speaker.sampleText || "",
    state
  })) return undefined;
  if (speaker.identityStatus === "side_collision") return undefined;
  return normalizeSideId(speaker.sideId);
}

function representativeSpeakerIdForSide(state = {}, sideId = "") {
  const normalizedSideId = normalizeSideId(sideId);
  if (!normalizedSideId) return "";
  return (state.speakers || [])
    .filter((speaker) => (
      speaker?.speakerId
      && speakerRosterSideFromRegistry(state, speaker.speakerId) === normalizedSideId
      && representativeSpeakerIdForState(state, speaker.speakerId) === speaker.speakerId
    ))
    .sort((a, b) => (
      Number(b.sideConfidence || 0) - Number(a.sideConfidence || 0)
      || speakerIdentityStrength(b) - speakerIdentityStrength(a)
    ))[0]?.speakerId || "";
}

function repairUtteranceOwnedPointSpeaker(state = {}, point = {}, ownerSideId = "") {
  const normalizedOwnerSideId = normalizeSideId(ownerSideId);
  if (!normalizedOwnerSideId) return point;
  const currentSpeakerId = point.speakerId || "";
  const currentRegistrySide = speakerRosterSideFromRegistry(state, currentSpeakerId);
  if (!currentRegistrySide || currentRegistrySide === normalizedOwnerSideId) return point;
  const representativeSpeakerId = representativeSpeakerIdForSide(state, normalizedOwnerSideId);
  if (!representativeSpeakerId || representativeSpeakerId === currentSpeakerId) return point;
  return {
    ...point,
    speakerId: representativeSpeakerId,
    rawSpeakerId: point.rawSpeakerId || currentSpeakerId,
    speakerIds: uniqueStrings([
      representativeSpeakerId,
      ...(point.speakerIds || []).filter((speakerId) => speakerRosterSideFromRegistry(state, speakerId) === normalizedOwnerSideId)
    ])
  };
}

function syncSidesFromSpeakers(state) {
  const sides = ensureTwoSides(state.sides || []).map((side, index) => ({
    ...side,
    id: index === 0 ? "side-a" : "side-b",
    color: index === 0 ? "blue" : "red",
    speakerIds: []
  }));
  for (const speaker of state.speakers || []) {
    if (isNeutralFloorSpeaker(state, speaker.speakerId)) continue;
    if (isModeratorSideAssignment({
      speakerId: speaker.speakerId,
      reason: speaker.assignmentReason || speaker.floorRoleReason || "",
      evidenceQuote: speaker.sampleText || "",
      state
    })) continue;
    const sideIndex = speaker.sideId === "side-b" ? 1 : speaker.sideId === "side-a" ? 0 : -1;
    if (sideIndex === -1) continue;
    const visibleSpeakerId = representativeSpeakerIdForState(state, speaker.speakerId) || speaker.speakerId;
    sides[sideIndex].speakerIds = uniqueStrings([...sides[sideIndex].speakerIds, visibleSpeakerId]);
  }
  for (const point of state.points || []) {
    if (!isScoredPoint(point)) continue;
    if (!isSpeakerClaimEligible(state, point.speakerId, point.turnIds || [])) continue;
    if (speakerHasSideOwnershipCollision(state, point.speakerId)) continue;
    const visibleSpeakerId = representativeSpeakerIdForState(state, point.speakerId) || point.speakerId;
    const registrySideId = speakerRosterSideFromRegistry(state, visibleSpeakerId)
      || speakerRosterSideFromRegistry(state, point.speakerId);
    if (registrySideId && registrySideId !== point.sideId) continue;
    if (!registrySideId && normalizeUtteranceOwnershipMode(point.sideOwnershipMode) === "utterance_side") continue;
    const sideIndex = point.sideId === "side-b" ? 1 : 0;
    sides[sideIndex].speakerIds = uniqueStrings([...sides[sideIndex].speakerIds, visibleSpeakerId]);
  }
  return { ...state, sides };
}

function enforceSpeakerPointSides(state) {
  const speakerSideById = new Map((state.speakers || [])
    .filter((speaker) => speaker?.speakerId && normalizeSideId(speaker.sideId))
    .filter((speaker) => !isModeratorSideAssignment({
      speakerId: speaker.speakerId,
      reason: speaker.assignmentReason || speaker.floorRoleReason || "",
      evidenceQuote: speaker.sampleText || "",
      state
    }))
    .map((speaker) => [speaker.speakerId, normalizeSideId(speaker.sideId)]));
  const points = (state.points || []).map((point) => {
    const representativeSpeakerId = representativeSpeakerIdForState(state, point.speakerId) || point.speakerId;
    const speakerSide = coerceInitialSideAnchor(state, representativeSpeakerId || point.speakerId, speakerSideById.get(point.speakerId) || speakerSideById.get(representativeSpeakerId));
    const next = representativeSpeakerId && representativeSpeakerId !== point.speakerId ? { ...point, speakerId: representativeSpeakerId, rawSpeakerId: point.rawSpeakerId || point.speakerId } : point;
    if (!isSpeakerClaimEligible(state, next.speakerId, next.turnIds || [])) return next;
    const utteranceOwner = pointUtteranceOwnership(state, next);
    if (utteranceOwner.sideId && utteranceOwner.confidence >= OWNER_SIDE_CONFIDENCE_MIN) {
      const repaired = repairUtteranceOwnedPointSpeaker(state, next, utteranceOwner.sideId);
      return {
        ...repaired,
        sideId: utteranceOwner.sideId,
        sideOwnershipMode: utteranceOwner.mode,
        sideOwnershipConfidence: utteranceOwner.confidence,
        sideOwnershipReason: utteranceOwner.reason || repaired.sideOwnershipReason || ""
      };
    }
    if (speakerHasSideOwnershipCollision(state, next.speakerId)) return next;
    return speakerSide && next.sideId !== speakerSide ? { ...next, sideId: speakerSide } : next;
  });
  return syncSidesFromSpeakers({ ...state, points });
}

function conflictReceiptFromRebuttal(state, link) {
  const fromPoint = state.points.find((point) => point.id === link.fromPointId);
  const toPoint = state.points.find((point) => point.id === link.toPointId);
  return {
    speakerId: link.speakerId,
    summary: link.summary,
    severity: link.strength >= 0.75 ? "high" : "medium",
    sourceQuote: cleanClaimText(link.sourceQuote || link.fromQuote || fromPoint?.quote || fromPoint?.claim || ""),
    targetQuote: cleanClaimText(link.targetQuote || link.toQuote || toPoint?.quote || toPoint?.claim || ""),
    sourceClaim: cleanClaimText(link.fromClaim || fromPoint?.claim || ""),
    targetClaim: cleanClaimText(link.toClaim || toPoint?.claim || "")
  };
}

function buildConsistencyConflictReceipts(state) {
  const conflicts = [];
  const bySpeaker = new Map();
  for (const point of state.points || []) {
    if (!isScoredPoint(point) || !isStrongClaimText(point.claim || "")) continue;
    if (!bySpeaker.has(point.speakerId)) bySpeaker.set(point.speakerId, []);
    bySpeaker.get(point.speakerId).push(point);
  }

  for (const [speakerId, points] of bySpeaker) {
    for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
        const conflict = detectGenericPolicyConflict(points[leftIndex], points[rightIndex]);
        if (!conflict) continue;
        conflicts.push({
          speakerId,
          summary: conflict.summary,
          severity: conflict.severity,
          sourceQuote: points[leftIndex].quote || points[leftIndex].claim,
          targetQuote: points[rightIndex].quote || points[rightIndex].claim,
          sourceClaim: points[leftIndex].claim,
          targetClaim: points[rightIndex].claim
        });
      }
    }
  }
  return conflicts;
}

function uniqueConflictReceipts(conflicts) {
  const seen = new Set();
  return (conflicts || []).filter((conflict) => {
    const key = normalizeTranscript(`${conflict.speakerId} ${conflict.summary} ${conflict.sourceQuote} ${conflict.targetQuote}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactTopic(topic) {
  return cleanClaimText(topic).slice(0, 90);
}

function deriveTopicFromDurableState(state) {
  const labels = (state.sides || []).map(confirmedSideLabel).filter((label) => label && !isGenericSideLabel(label));
  if (labels.length === 2) return `${labels[0]} vs ${labels[1]}`.slice(0, 90);
  return "Listening for the debate topic";
}

function deriveFallbackSideLabel(points = [], opponentPoints = [], topic = "") {
  const claims = (points || []).filter(isThesisPoint).map((point) => ({
    speakerId: point.speakerId,
    claim: point.claim,
    stance: point.burden || point.why || ""
  }));
  if (claims.length < MIN_SIDE_THESIS_POINTS) return "";
  const side = { speakerIds: uniqueStrings(claims.map((claim) => claim.speakerId)) };
  const standardLabel = interpretiveStandardLabelFromClaims(claims, topic);
  if (standardLabel && !isGenericSideLabel(standardLabel) && !isClaimLikeLabel(standardLabel, claims)) return compactLabel(standardLabel);

  const label = labelFromSideClaims(claims, side, topic);
  if (label && !isGenericSideLabel(label) && !isClaimLikeLabel(label, claims)) return compactLabel(label);

  const topicLabel = topicObjectLabel(topic);
  if (!topicLabel) return "";
  const text = normalizeTranscript(claims.map((claim) => claim.claim).join(" "));
  const opponentText = normalizeTranscript((opponentPoints || []).map((point) => point.claim || "").join(" "));
  const negative = /\b(should not|must not|too slow|too expensive|cost too much|risk|unresolved|unsafe|ineffective|worse|oppose|reject|against)\b/.test(text);
  const positive = /\b(should|must|need|reliable|low carbon|firm power|less land|benefit|support|expand|build|produce|remain)\b/.test(text);
  const opponentNegative = /\b(should not|too slow|too expensive|risk|unresolved|oppose|reject|against)\b/.test(opponentText);
  if (negative && !positive) return compactLabel(`Against ${topicLabel}`);
  if (positive && !negative) return compactLabel(`For ${topicLabel}`);
  if (positive && opponentNegative) return compactLabel(`For ${topicLabel}`);
  if (negative) return compactLabel(`Against ${topicLabel}`);
  return "";
}

function interpretiveStandardLabelFromClaims(claims = [], topic = "") {
  const text = normalizeTranscript(`${topic} ${(claims || []).map((claim) => `${claim.claim || ""} ${claim.stance || ""}`).join(" ")}`);
  if (!text) return "";
  const topicObject = topicObjectLabel(topic);
  if (/\b(intent|motive|purpose)\b/.test(text) && /\b(determine|determines|factor|definition|criteria|standard|legal|law|genocid)\b/.test(text)) {
    if (/\b(genocid|genocide|genocidal)\b/.test(text)) return "Intent determines genocide";
    if (topicObject && meaningfulTokens(topicObject).some((token) => text.includes(token))) return compactLabel(`Intent determines ${topicObject}`);
    return "Intent-based standard";
  }
  if (/\b(same|consistent|equal|comparable)\b/.test(text) && /\b(standard|criteria|rule|test|definition|comparison)\b/.test(text)) {
    return "Same standard / criteria";
  }
  if (/\b(words?|statements?|rhetoric|quotes?)\b/.test(text) && /\b(count|matter|evidence|prove|show|indicate)\b/.test(text)) {
    return "Statements as evidence";
  }
  if (/\b(actions?|conduct|behavior)\b/.test(text) && /\b(count|matter|evidence|prove|show|indicate)\b/.test(text)) {
    return "Actions as evidence";
  }
  return "";
}

function deriveComparativeFallbackSideLabel(points = [], opponentPoints = [], topic = "") {
  return "";
}

function deriveSinglePointSideLabel(point = {}, topic = "") {
  const text = normalizeTranscript(`${topic} ${point.claim || ""} ${point.stance || ""}`);
  if (!text) return "";
  if (/\b(intent|motive)\b/.test(text) && /\b(different|separates|distinguish)\b/.test(text)) return "Intent-based distinction";
  if (/\b(same standard|same criteria|double standard|comparable)\b/.test(text)) return "Comparable cases / same standard";
  return "";
}

function deriveEarlyFallbackSideLabelFromClaim(claim = "") {
  const cleaned = cleanClaimText(claim);
  if (!cleaned || isVagueSetupPoint(cleaned, cleaned) || looksLikeBadSttClaim(cleaned, cleaned)) return "";
  const derived = derivePositionLabelFromClaim(cleaned);
  if (!derived || isGenericSideLabel(derived)) return "";
  return derived;
}

function dedupeSideThesisLabels(state = {}) {
  const sides = ensureTwoSides(state.sides || []).map((side) => ({ ...side }));
  if (sides.length < 2) return sides;
  const left = confirmedSideLabel(sides[0]);
  const right = confirmedSideLabel(sides[1]);
  if (!left || !right || normalizeTranscript(left) !== normalizeTranscript(right)) return sides;
  const pointsA = (state.points || []).filter((point) => point.sideId === sides[0].id && isThesisPoint(point));
  const pointsB = (state.points || []).filter((point) => point.sideId === sides[1].id && isThesisPoint(point));
  const fitA = tokenOverlapRatio(normalizeTranscript(left), thesisEvidenceText(pointsA, state.topic));
  const fitB = tokenOverlapRatio(normalizeTranscript(right), thesisEvidenceText(pointsB, state.topic));
  if (Math.abs(fitA - fitB) < 0.12) {
    sides[0] = clearSideThesis(sides[0], "");
    sides[1] = clearSideThesis(sides[1], "");
  } else if (fitA > fitB) {
    sides[1] = clearSideThesis(sides[1], "");
  } else {
    sides[0] = clearSideThesis(sides[0], "");
  }
  return sides;
}

function shouldPreferDerivedSideLabel(currentLabel = "", derivedLabel = "", sidePoints = [], opponentPoints = [], topic = "") {
  const current = cleanClaimText(currentLabel);
  const derived = cleanClaimText(derivedLabel);
  if (!derived) return false;
  if (!isUsableSideLabel(current, sidePoints, topic)) return true;
  if (normalizeTranscript(current) === normalizeTranscript(derived)) return false;

  const currentKind = comparativeLabelKind(current);
  const derivedKind = comparativeLabelKind(derived);
  if (currentKind || derivedKind) {
    const sideText = thesisEvidenceText(sidePoints, topic);
    const opponentText = thesisEvidenceText(opponentPoints, topic);
    const currentSide = sideLabelFitScore(current, sideText, currentKind);
    const currentOpponent = sideLabelFitScore(current, opponentText, currentKind);
    const derivedSide = sideLabelFitScore(derived, sideText, derivedKind);
    const derivedOpponent = sideLabelFitScore(derived, opponentText, derivedKind);
    if (currentKind && derivedKind && currentKind !== derivedKind) return true;
    if (derivedSide >= currentSide + 2 && derivedSide >= derivedOpponent) return true;
    if (currentOpponent >= currentSide + 2 && derivedSide > currentSide) return true;
  }

  const currentOverlap = tokenOverlapRatio(normalizeTranscript(current), thesisEvidenceText(sidePoints, topic));
  const derivedOverlap = tokenOverlapRatio(normalizeTranscript(derived), thesisEvidenceText(sidePoints, topic));
  return derivedOverlap >= currentOverlap + 0.2;
}

function thesisEvidenceText(points = [], topic = "") {
  return normalizeTranscript((points || []).map((point) => `${point.claim || ""} ${point.quote || ""} ${point.burden || ""} ${point.why || ""}`).join(" "));
}

function comparativeLabelKind(label = "") {
  const text = normalizeTranscript(label);
  if (!text) return "";
  if (/\bintent\b/.test(text) && /\bseparates?|different|distinguish|distinction\b/.test(text)) return "intent_distinction";
  if (/\bsame|comparable|standard|criteria|double standard\b/.test(text)) return "same_standard";
  return "";
}

function sideLabelFitScore(label = "", evidenceText = "", kind = "") {
  const labelText = normalizeTranscript(label);
  const text = normalizeTranscript(evidenceText);
  if (!labelText || !text) return 0;
  let score = meaningfulTokens(labelText).filter((token) => text.includes(token)).length;
  if (kind === "intent_distinction") {
    score += countMatches(text, /\b(intent|motive|purpose|distinguish|different|separates?|not the same|different standard)\b/g) * 2;
  } else if (kind === "same_standard") {
    score += countMatches(text, /\b(same standard|same criteria|double standard|comparable|counts? the same|why)\b/g) * 2;
  }
  return score;
}

function normalizeSideId(value) {
  const normalized = String(value || "")
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .trim();
  if (normalized === "side-a" || normalized === "sidea" || normalized === "a" || normalized === "blue" || normalized === "blue-side" || normalized === "side-blue") return "side-a";
  if (normalized === "side-b" || normalized === "sideb" || normalized === "b" || normalized === "red" || normalized === "red-side" || normalized === "side-red") return "side-b";
  return undefined;
}

function normalizeAgentSideId(value = {}) {
  if (typeof value === "string") return normalizeSideId(value);
  if (!value || typeof value !== "object") return undefined;
  return normalizeSideId(value.side || value.sideColor || value.sideLabel || value.sideName || value.sideId);
}

function sideColorName(sideId = "") {
  const normalized = normalizeSideId(sideId);
  if (normalized === "side-a") return "blue";
  if (normalized === "side-b") return "red";
  return "";
}

function cleanAgentDisplayText(value = "") {
  return cleanClaimText(value)
    .replace(/\bside[\s_-]*a\b/gi, "Blue side")
    .replace(/\bside[\s_-]*b\b/gi, "Red side");
}

function normalizeFactStatus(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "verified") return "verified";
  if (normalized === "contradicted") return "contradicted";
  if (normalized === "no_clear_source" || normalized === "no_clear") return "no_clear_source";
  if (normalized === "cannot_verify") return "cannot_verify";
  return ["checking", "verified", "contradicted", "no_clear_source", "cannot_verify"].includes(normalized) ? normalized : VERDICT_TO_FACT_STATUS[normalized] || "no_clear_source";
}

function normalizeSourceEvidenceBasis(value, { status = "", sources = [], explanation = "", point = null } = {}) {
  if (["external_fact", "contextual", "transcript_only"].includes(value)) return value;
  const factStatus = normalizeFactStatus(status || point?.factStatus || "");
  const hasSources = normalizeSources(sources || point?.sources || point?.audit?.sources || []).length > 0;
  const text = normalizeTranscript(`${explanation || ""} ${point?.why || ""} ${point?.claim || ""}`);
  if (!hasSources) return "contextual";
  if (factStatus === "cannot_verify") return "contextual";
  if (/\b(transcript|speaker said|said it|mentions? the topic|repeats? the claim|not enough|insufficient|unclear)\b/.test(text)) {
    return factStatus === "verified" || factStatus === "contradicted" ? "transcript_only" : "contextual";
  }
  if (factStatus === "verified" || factStatus === "contradicted") return "external_fact";
  return "contextual";
}

function isSourceScoreEligible(source = {}) {
  const status = normalizeFactStatus(source.status || source.factStatus || "");
  const basis = normalizeSourceEvidenceBasis(source.evidenceBasis || source.audit?.evidenceBasis, {
    status,
    sources: source.sources || source.audit?.sources || [],
    explanation: source.explanation || source.why || source.audit?.factExplanation || "",
    point: source
  });
  if (!["verified", "contradicted"].includes(status)) return false;
  if (basis !== "external_fact") return false;
  if (!normalizeSources(source.sources || source.audit?.sources || []).length) return false;
  return true;
}

function normalizePointRole(value) {
  return ["claim", "rebuttal", "concession", "evidence", "framing", "dropped_point"].includes(value) ? value : "claim";
}

function normalizeClaimMode(value) {
  return [
    "speaker_assertion",
    "speaker_challenge",
    "quoted_evidence",
    "reported_opponent_claim",
    "meta_commentary",
    "off_topic"
  ].includes(value) ? value : "speaker_assertion";
}

function normalizeQuoteRole(value) {
  return [
    "owned_statement",
    "owned_question",
    "external_quote",
    "opponent_quote",
    "paraphrase"
  ].includes(value) ? value : "owned_statement";
}

function normalizeTopicContinuity(value) {
  return [
    "main_thread",
    "direct_response",
    "sustained_new_topic",
    "meta",
    "off_topic"
  ].includes(value) ? value : "main_thread";
}

function normalizeOwnershipType(value) {
  return [
    "owned_assertion",
    "owned_rebuttal",
    "owned_concession",
    "owned_evidence",
    "opponent_echo",
    "challenge_question",
    "sarcastic_repetition",
    "reported_speech",
    "quoted_evidence",
    "external_quote",
    "ambiguous",
    "meta",
    "off_topic"
  ].includes(value) ? value : "owned_assertion";
}

function normalizeSpeechAct(value) {
  return [
    "assertion",
    "rebuttal",
    "concession",
    "question",
    "sarcasm",
    "opponent_paraphrase",
    "reported_speech",
    "quoted_evidence",
    "meta",
    "off_topic"
  ].includes(value) ? value : "assertion";
}

function normalizeAssertionStatus(value) {
  return ["asserted", "question_only", "reported_only", "cross_speaker", "unfaithful"].includes(value) ? value : "asserted";
}

function normalizeRebuttalType(value) {
  return ["refutes", "supports", "concedes", "drops"].includes(value) ? value : "refutes";
}

function isAssertedPoint(point) {
  if (normalizeFloorSpeakerRole(point?.speakerRole) === NEUTRAL_SPEAKER) return false;
  const mode = normalizeClaimMode(point?.claimMode || "speaker_assertion");
  const continuity = normalizeTopicContinuity(point?.topicContinuity || "main_thread");
  if (["reported_opponent_claim", "meta_commentary", "off_topic"].includes(mode)) return false;
  if (["meta", "off_topic"].includes(continuity)) return false;
  if (!isOwnedClaimPoint(point)) return false;
  return normalizeAssertionStatus(point?.assertionStatus) === "asserted";
}

function isScoredPoint(point) {
  return isAssertedPoint(point) && ["claim", "rebuttal", "concession"].includes(normalizePointRole(point?.role));
}

function isThesisPoint(point) {
  return isAssertedPoint(point) && ["claim", "rebuttal"].includes(normalizePointRole(point?.role));
}

function isEvidencePoint(point) {
  return isAssertedPoint(point) && normalizePointRole(point?.role) === "evidence";
}

function isAnalyzableTurn(turn) {
  return Boolean(turn?.isFinal && turn?.speakerId && !turn.contextOnly && !isSpeechmaticsUnassignedTurn(turn) && isDurableSpeakerTurnText(turn.text || "") && !isObviousNonPoint(turn.text || ""));
}

function isDurableSpeakerTurnText(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const normalized = normalizeTranscript(text);
  const filler = new Set(["and", "but", "so", "uh", "um", "yeah", "yes", "no", "okay", "ok", "i", "here"]);
  return words.length >= 2 && text.trim().length >= 5 && !filler.has(normalized);
}

function isCompleteDebatePoint(text) {
  const trimmed = cleanClaimText(text);
  const words = trimmed.split(/\s+/).filter(Boolean);
  const hasShortStrongSignal = /\b(intent|motive|genocide|genocidal|war crime|civilian|hamas|blame|minority|majority|official|government|minister|parliament|definition|standard|law|court|putin|ukraine|gaza|israel|russia|nuclear|nuke|destroyed|displaced|children|kill|killed|killing)\b/i.test(trimmed);
  if ((words.length < 7 || trimmed.length < 38) && !(hasShortStrongSignal && words.length >= 5 && trimmed.length >= 24)) return false;
  if (isObviousNonPoint(trimmed)) return false;
  if (isUnderspecifiedDebatePoint(trimmed)) return false;
  if (trimmed.endsWith("?") && !/\b(because|when|after|before|since|given|far more|less than|more than|\d{2,})\b/i.test(trimmed)) return false;
  if (/['’]s$/i.test(trimmed)) return false;
  const lastWord = normalizeTranscript(trimmed).split(/\s+/).at(-1) || "";
  if (new Set(["are", "is", "was", "were", "that", "the", "a", "an", "and", "but", "or", "of", "to", "with", "his", "her", "their", "our", "your"]).has(lastWord)) return false;
  return true;
}

function isUnderspecifiedDebatePoint(text) {
  const trimmed = cleanClaimText(text);
  const normalized = normalizeTranscript(trimmed);
  const words = wordCount(trimmed);
  if (/\b(valid stance|not the same|same thing|different thing|talking point)\b/.test(normalized)) return true;
  if (/\b(actions? and words?|words? and actions?)\b.*\b(distinct|different|not same|can be found)\b/.test(normalized)) return true;
  if (/^(criticizing|questioning|asking|arguing|saying|debating)\b.*\b(label|term|stance|valid)\b/.test(normalized)) return true;
  if (/\b(extreme statements?|some statements?|things can be found|can find extreme)\b/.test(normalized) && words < 16) return true;
  if (/\bthere are\b.*\b(extreme|bad|good|some|many)\b.*\b(members|people|voices|views)\b/.test(normalized) && words < 16) return true;
  if (words <= 9 && !/\b(should|must|because|therefore|intent|kill|killed|killing|kidnap|kidnapping|cost|risk|harm|more than|less than|\d{2,})\b/i.test(trimmed)) return true;
  return false;
}

function isObviousNonPoint(text) {
  const trimmed = cleanClaimText(text);
  const normalized = normalizeTranscript(trimmed);
  if (!normalized) return true;
  if (isMetaNarrationPoint(trimmed)) return true;
  if (/^(uh|um|yeah|okay|ok|so|well)\b/i.test(trimmed) && trimmed.split(/\s+/).length < 10) return true;
  if (/\b(big news right now|a lot of people are asking|let me ask|my question is|the question is|coming up next)\b/i.test(trimmed)) return true;
  if (/^(is|are|was|were|do|does|did|can|could|should|would|will)\b/i.test(trimmed) && trimmed.endsWith("?")) return true;
  if (/^(said that|according to|reports say)\b/i.test(trimmed) && !/\b(this means|this shows|this proves|because|therefore|so)\b/i.test(trimmed)) return true;
  return false;
}

function isMetaNarrationPoint(text) {
  const normalized = normalizeTranscript(text);
  if (/^(speaker\s+\d+s?|the speaker|this speaker)\b/.test(normalized)) return true;
  if (/\b(speaker\s+\d+s?|the speaker|this speaker)\s+(claim|logic|position|point|explicitly\s+)?(states|says|argues|claims|questions|asks|raises|frames|mentions|aligns|is|was|has|does)\b/.test(normalized)) return true;
  return /\b(explicitly states opposition|states opposition|questions the differential application|questions why|asks why|raises the issue|frames the debate|introduces the topic|sets up the topic|aligns with a|takes a pro\b|takes an anti\b|opposes .+ invasion|supports .+ invasion)\b/i.test(text);
}

function isReportedSetupPoint(claim, quote, sourceText) {
  const claimText = normalizeTranscript(claim);
  const source = normalizeTranscript(`${quote} ${sourceText}`);
  if (!claimText || !source) return false;
  if (/\byou have been\b/.test(source)
    && /\b(opponent|supporter|critic|advocate|outspoken|previously|known for|called it|criticized)\b/.test(source)
    && !/\b(i|we|my|our)\b.*\b(because|therefore|so|this shows|this means|i believe|i think|i argue)\b/.test(source)) {
    return true;
  }
  if (/\b(the speaker|speaker \d+s?)\b/.test(claimText)) return true;
  if (/\bquestions the differential application\b/.test(claimText)) return true;
  return false;
}

function isRepeatedPoint(claim, existingPoints) {
  const normalized = normalizeTranscript(claim);
  if (!normalized) return false;
  return (existingPoints || []).some((point) => {
    const existing = normalizeTranscript(point.claim || point.quote || "");
    if (!existing) return false;
    if (existing === normalized || existing.includes(normalized) || normalized.includes(existing)) return true;
    if (isSameCoreDebateClaim(existing, normalized)) return true;
    const overlap = tokenOverlapRatio(existing, normalized);
    if (overlap >= 0.82) return true;
    const existingKey = directClaimKey(existing);
    const normalizedKey = directClaimKey(normalized);
    return Boolean(existingKey && normalizedKey && tokenOverlapRatio(existingKey, normalizedKey) >= 0.78);
  });
}

function isNearDuplicateClaim(a = "", b = "") {
  const left = normalizeTranscript(a || "");
  const right = normalizeTranscript(b || "");
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const overlap = tokenOverlapRatio(left, right);
  if (overlap >= 0.76) return true;
  const leftTokens = new Set(meaningfulTokens(left));
  const rightTokens = new Set(meaningfulTokens(right));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token));
  const sharedSpecific = shared.filter((token) => token.length >= 4 && !GENERIC_ACTION_BUCKETS.has(token) && !GENERIC_QUALITY_BUCKETS.has(token)).length;
  const sharedAction = shared.filter((token) => GENERIC_ACTION_BUCKETS.has(token) || /^(warn|warning|strike|striking|bomb|bombing|kill|killing|destroy|destroying|target|targeting|rule|ruled|charge|charged|publish|published|write|wrote|use|uses|used)$/.test(token)).length;
  if (sharedSpecific >= 3 && overlap >= 0.54) return true;
  if (sharedSpecific >= 2 && sharedAction >= 1 && overlap >= 0.5) return true;
  const leftKey = directClaimKey(left);
  const rightKey = directClaimKey(right);
  return Boolean(leftKey && rightKey && tokenOverlapRatio(leftKey, rightKey) >= 0.72);
}

function isSameCoreDebateClaim(a, b) {
  const aTokens = new Set(meaningfulTokens(a));
  const bTokens = new Set(meaningfulTokens(b));
  const shared = [...aTokens].filter((token) => bTokens.has(token));
  const actionOverlap = shared.filter((token) => GENERIC_ACTION_BUCKETS.has(token)).length;
  const entityOverlap = shared.filter((token) => !GENERIC_ACTION_BUCKETS.has(token) && !GENERIC_QUALITY_BUCKETS.has(token)).length;
  const hasSharedNumber = /\b\d{2,}(?:[.,]\d+)?%?\b/.test(a) && (a.match(/\b\d{2,}(?:[.,]\d+)?%?\b/g) || []).some((number) => b.includes(number));
  if (actionOverlap >= 1 && entityOverlap >= 2) return true;
  if (hasSharedNumber && entityOverlap >= 2) return true;
  return tokenOverlapRatio(a, b) >= 0.76 && actionOverlap >= 1;
}

function stablePointId(speakerId, claim, turnIds = []) {
  const key = normalizeTranscript(`${speakerId} ${turnIds.join(" ")} ${claim}`).slice(0, 180);
  return `pt-${stableTextHash(key)}`;
}

function stableTextHash(text) {
  const key = normalizeTranscript(text || "").slice(0, 220);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36) || "0";
}

function findPointByClaim(points, claimText) {
  const claim = normalizeTranscript(claimText || "");
  if (!claim) return null;
  return (points || []).find((point) => tokenOverlapRatio(normalizeTranscript(point.claim), claim) >= 0.78) || null;
}

function calculateCoreMetricsForSide(state, sideId) {
  const points = (state.points || []).filter((point) => point.sideId === sideId && isScoredPoint(point));
  const evidence = (state.points || []).filter((point) => point.sideId === sideId && isEvidencePoint(point));
  const evidenceForReliability = evidence.filter((point) => point.parentPointId && points.some((parent) => parent.id === point.parentPointId));
  const opposingPoints = (state.points || []).filter((point) => point.sideId !== sideId && isScoredPoint(point));
  const rebuttals = (state.rebuttals || []).filter((link) => {
    const fromPoint = state.points.find((point) => point.id === link.fromPointId);
    return fromPoint?.sideId === sideId && isScoredPoint(fromPoint);
  });
  const concessions = points.filter((point) => point.role === "concession").length + rebuttals.filter((link) => link.type === "concedes").length;
  const refutations = rebuttals.filter((link) => link.type === "refutes").reduce((sum, link) => sum + link.strength, 0);
  const attacksAgainst = (state.rebuttals || []).filter((link) => {
    const target = state.points.find((point) => point.id === link.toPointId);
    return target?.sideId === sideId && isScoredPoint(target) && link.type === "refutes";
  }).length;
  const reliabilityPoints = [...points, ...evidenceForReliability];
  const verified = reliabilityPoints.filter((point) => point.factStatus === "verified").length;
  const contradicted = reliabilityPoints.filter((point) => normalizeFactStatus(point.factStatus) === "contradicted").length;
  const unresolved = reliabilityPoints.filter((point) => ["checking", "no_clear_source", "cannot_verify"].includes(normalizeFactStatus(point.factStatus))).length;
  const roleClaims = points.filter((point) => point.role === "claim").length;
  const burdenMet = verified + evidenceForReliability.length * 0.45 + refutations * 0.65;
  return {
    claims_burden: clampScore(45 + roleClaims * 7 + burdenMet * 5 - unresolved * 2),
    factual_reliability: clampScore(50 + verified * 10 - contradicted * 14 - unresolved * 2),
    refutation_quality: clampScore(45 + refutations * 16 - attacksAgainst * 4),
    dropped_points: clampScore(60 - Math.max(0, opposingPoints.length - attacksAgainst - rebuttals.length) * 6),
    concessions: clampScore(58 - concessions * 12),
    rhetorical_clarity: clampScore(48 + points.reduce((sum, point) => sum + rhetoricalPointScore(point), 0) / Math.max(1, points.length))
  };
}

function rhetoricalPointScore(point) {
  const words = point.claim.split(/\s+/).filter(Boolean).length;
  const hasReason = /\b(because|therefore|so|since|given|means|shows|proves)\b/i.test(point.claim);
  return Math.min(18, words * 0.35 + (hasReason ? 6 : 0));
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clamp01(value, fallback = 0) {
  const numeric = Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : fallback));
}

function sideSummaryMetrics(state, sideId) {
  const artifacts = state.artifacts?.claims ? state.artifacts : deriveArtifacts(state);
  const sideScore = sideId === "side-b" ? state.scorecard?.red : state.scorecard?.blue;
  const claims = artifacts.claims.filter((claim) => claim.sideId === sideId);
  const sourceChecks = artifacts.sourceChecks.filter((check) => claims.some((claim) => claim.pointId === check.pointId));
  return {
    points: claims.length,
    supported: claims.filter((claim) => claim.status === "verified").length,
    disputed: claims.filter((claim) => claim.status === "contradicted").length,
    unclear: claims.filter((claim) => ["checking", "no_clear_source", "cannot_verify"].includes(claim.status)).length,
    strength: sideScore?.score ?? 0,
    penalty: sideScore?.metrics?.penalty || sourceChecks.filter((check) => normalizeFactStatus(check.status) === "contradicted").length * 4
  };
}

function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  const normalized = [];
  for (const source of sources) {
    const uri = cleanClaimText(source?.uri || source?.url || source?.link || "");
    if (!/^https?:\/\//i.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    normalized.push({
      title: cleanClaimText(source?.title || source?.name || source?.description || uri),
      uri
    });
    if (normalized.length >= 3) break;
  }
  return normalized;
}

function cleanClaimText(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/^["'`]+|["'`]+$/g, "").trim();
}

function isAssertiveClaim(text) {
  const trimmed = cleanClaimText(text);
  if (!trimmed || trimmed.endsWith("?")) return false;
  return !/^(you|when it comes|why|what|how|happening in|but when)\b/i.test(trimmed);
}

async function researchWithFirecrawl(prompt, trace, meta = {}) {
  if (!config.firecrawlApiKey) {
    throw new Error("FIRECRAWL_API_KEY is not set");
  }
  const startedAt = Date.now();
  const agent = meta.agent || "Firecrawl Search";
  const query = cleanClaimText(prompt || "");
  logTraceStep(trace, `${agent}:start`, {
    queryChars: query.length,
    limit: FIRECRAWL_SEARCH_LIMIT,
    excludedDomains: FIRECRAWL_EXCLUDED_DOMAINS.length,
    ...meta
  });

  try {
    const response = await fetchWithTimeout("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.firecrawlApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        limit: Math.max(1, Math.min(8, FIRECRAWL_SEARCH_LIMIT)),
        sources: ["web"],
        country: "US",
        timeout: FIRECRAWL_SEARCH_TIMEOUT_MS,
        ...(FIRECRAWL_EXCLUDED_DOMAINS.length ? { excludeDomains: FIRECRAWL_EXCLUDED_DOMAINS } : {})
      })
    }, Math.max(3000, FIRECRAWL_SEARCH_TIMEOUT_MS + 2000));

    if (!response.ok) {
      throw new Error(`Firecrawl search failed: ${response.status}`);
    }

    const result = await response.json();
    const resultText = JSON.stringify(result || "");
    const sources = extractFirecrawlSources(result);
    logTraceStep(trace, `${agent}:done`, {
      elapsedMs: Date.now() - startedAt,
      queryChars: query.length,
      outputChars: resultText.length,
      sourceCount: sources.length,
      ...meta
    });
    return result;
  } catch (error) {
    logTraceStep(trace, `${agent}:error`, {
      elapsedMs: Date.now() - startedAt,
      queryChars: query.length,
      error: error instanceof Error ? error.message : String(error),
      ...meta
    });
    throw error;
  }
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

function directClaimKey(normalizedClaim) {
  const tokens = meaningfulTokens(normalizedClaim);
  return tokens.length >= 6 ? tokens.slice(0, 10).join(" ") : "";
}

function directTextSignature(text = "") {
  return meaningfulTokens(text).slice(0, 10).join(" ");
}

function tokenOverlapRatio(a, b) {
  const aTokens = new Set(meaningfulTokens(a));
  const bTokens = new Set(meaningfulTokens(b));
  if (!aTokens.size || !bTokens.size) return 0;
  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  return overlap / Math.min(aTokens.size, bTokens.size);
}

function isGenericTopic(topic = "") {
  return !topic
    || /listening for|distinguishing|comparing|discussing|debating|examining|live debate|debate topic/i.test(topic);
}

function isGenericSideLabel(label = "") {
  return !label
    || /forming|emerging position|speaker \d+ position|under review|comparing|distinguishing|discussing|debating|examining|conflicts$/i.test(label);
}

function isUsableSideLabel(label, claims = [], topic = "") {
  return Boolean(
    label
      && isValidSidePositionLabel(label)
      && !isGenericSideLabel(label)
      && !isFullSentenceLabel(label)
      && !isClaimLikeLabel(label, claims)
      && !isMisleadingSideLabel(label, claims, topic)
  );
}

function isFullSentenceLabel(label = "") {
  const cleaned = cleanClaimText(label);
  const normalized = normalizeTranscript(cleaned);
  if (!normalized) return true;
  if (/[.!?]$/.test(cleaned)) return true;
  if (/^(for|against|argues?|supports?|opposes?|challenges?|defends?|questions?|presses?|maintains?|comparable|intent-based)\b/i.test(cleaned)) {
    return false;
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (
    words.length <= 10
    && cleaned.length <= SIDE_POSITION_MAX_CHARS
    && /\b(is|are|was|were|should|must|can|cannot|does|do|did|has|have)\b/.test(normalized)
  ) {
    return false;
  }
  return /\b(is|are|was|were|does|do|did|has|have|had|will|would|should|could|can)\b/.test(normalized);
}

function isMisleadingSideLabel(label, claims = [], topic = "") {
  const normalizedLabel = normalizeTranscript(label);
  const evidenceText = normalizeTranscript((claims || []).map((claim) => `${claim.claim || ""} ${claim.stance || ""}`).join(" "));
  if (!normalizedLabel) return true;
  if ((claims || []).length >= MIN_SIDE_THESIS_POINTS) {
    const labelTokens = meaningfulTokens(normalizedLabel);
    const sideOverlap = tokenOverlapRatio(labelTokens.join(" "), evidenceText);
    const genericFrame = /\b(for|against|support|oppose|same|standard|intent|distinction|comparable|burden|defending|challenging)\b/.test(normalizedLabel);
    if (labelTokens.length >= 3 && sideOverlap < (genericFrame ? 0.25 : 0.34)) return true;
  }
  if (/\b(same\s+\w{0,24}\s*standard|same criteria|comparable cases?|double standard)\b/.test(normalizedLabel)
    && !/\b(same standard|same criteria|comparable|double standard|same\s+\w{0,20}\s*standard|criteria)\b/.test(evidenceText)) {
    return true;
  }
  if (/\b(intent-based|intent.*distinction|motive.*distinction|intent separates?)\b/.test(normalizedLabel)
    && !/\b(intent|motive|purpose)\b/.test(evidenceText)) {
    return true;
  }
  if (/\b(support|supports|supporting|defend|defends|defending|back|backs|backing|pro)\s+.+\b(invasion|occupation|attack|violence|harm|killing|displacement|abuse|corruption)\b/.test(normalizedLabel)
    && /\b(condemn|criticize|oppose|reject|intent|harm|kill|target|abduct|displace|illegal|wrong|unfair|abuse)\b/.test(evidenceText)) {
    return true;
  }
  if (/\b(pro|anti)\s+.+\s+stance\b/.test(normalizedLabel)) return true;
  if (/\b(supports?|opposes?)\s+.+\s+and\s+.+\s+questions?\b/.test(normalizedLabel)) return true;
  return false;
}

function labelFromSideClaims(claims, side, topic = "") {
  const comparisonLabel = comparativeLabelFromClaims(claims, topic);
  if (comparisonLabel) return comparisonLabel;

  const polarityLabel = polarityLabelFromClaims(claims, topic);
  if (polarityLabel) return polarityLabel;

  const thesisLabel = thesisLabelFromPoints(claims);
  if (thesisLabel) return thesisLabel;

  const firstStance = claims.find((claim) => claim?.stance && !/under review/i.test(claim.stance) && !isClaimLikeLabel(claim.stance, claims))?.stance;
  if (firstStance && !isGenericSideLabel(firstStance)) return compactLabel(firstStance);

  const strongest = [...claims].sort((a, b) => claimTextScore(b.claim || "") - claimTextScore(a.claim || ""))[0];
  const derived = derivePositionLabelFromClaim(strongest?.claim || "");
  return derived || (side.speakerIds[0] ? `${side.speakerIds[0]} position` : side.label);
}

function polarityLabelFromClaims(claims, topic = "") {
  const topicLabel = topicObjectLabel(topic);
  if (!topicLabel) return "";
  const text = normalizeTranscript((claims || []).map((claim) => `${claim.claim || ""} ${claim.stance || ""}`).join(" "));
  const topicTokens = meaningfulTokens(topicLabel);
  const mentionsTopic = topicTokens.some((token) => text.includes(token));
  const opposeScore = countMatches(text, /\b(oppose|opposes|opposed|against|reject|rejects|should not|must not|too slow|too expensive|cost too much|risk|risks|unresolved|harm|unsafe|ineffective|worse|alternative|alternatives|compared with|compared to)\b/g)
    + (mentionsTopic && /\b(too slow|too expensive|cost|risk|unresolved|should not|must not)\b/.test(text) ? 2 : 0);
  const supportScore = countMatches(text, /\b(support|supports|supported|should build|should expand|must build|must expand|need to build|need to expand|reliable|benefit|benefits|safer|cheaper|less land|low carbon|firm power|part of|improve|improves)\b/g)
    + (mentionsTopic && /\b(reliable|low carbon|less land|firm power|should be part|should remain|benefit)\b/.test(text) ? 2 : 0);
  if (opposeScore >= supportScore + 1) return compactLabel(`Against ${topicLabel}`);
  if (supportScore >= opposeScore + 1) return compactLabel(`For ${topicLabel}`);
  return "";
}

function topicObjectLabel(topic = "") {
  const cleaned = cleanClaimText(topic)
    .replace(/\b(debate|discussion|claims?|case|question)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isGenericTopic(cleaned)) return "";
  return cleaned.replace(/^\w/, (letter) => letter.toUpperCase()).slice(0, 42);
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function thesisLabelFromPoints(points) {
  for (const point of points || []) {
    const text = cleanClaimText(point?.claim || "");
    const explicit = text.match(/\b(?:i|we)\s+(support|oppose)\s+(.+?)\s+because\b/i);
    if (explicit) return compactLabel(`${capitalize(explicit[1])} ${trimThesisObject(explicit[2])}`);

    const shouldNot = text.match(/\bshould\s+not\s+(.+?)\s+because\b/i);
    if (shouldNot) return compactLabel(`Oppose ${toGerundPhrase(trimThesisObject(shouldNot[1]))}`);

    const should = text.match(/\bshould\s+(.+?)\s+because\b/i);
    if (should) return compactLabel(`Support ${toGerundPhrase(trimThesisObject(should[1]))}`);
  }
  return "";
}

function trimThesisObject(text) {
  return cleanClaimText(text)
    .replace(/^(the\s+)?(country|city|government|state|nation|public|we|they)\s+/i, "")
    .replace(/\s+(and|but|while|whereas)\s+.*$/i, "")
    .trim();
}

function toGerundPhrase(text) {
  return text
    .replace(/^build\b/i, "building")
    .replace(/^expand\b/i, "expanding")
    .replace(/^create\b/i, "creating")
    .replace(/^apply\b/i, "applying")
    .replace(/^allocate\b/i, "allocating")
    .replace(/^fund\b/i, "funding")
    .replace(/^use\b/i, "using");
}

function capitalize(text) {
  return cleanClaimText(text).replace(/^\w/, (letter) => letter.toUpperCase());
}

function comparativeLabelFromClaims(claims, topic = "") {
  const text = normalizeTranscript(`${topic} ${claims.map((claim) => `${claim.claim} ${claim.stance}`).join(" ")}`);
  const isTwoCaseFrame = /\b(case|conflict|policy|country|company|side|actor|group|example)s?\b/.test(text)
    && /\b(intent|motive|criteria|standard|same|different|comparable|comparison|distinction|double standard)\b/.test(text);
  const hasComparativeMagnitude = /\b(more|less|greater|fewer|higher|lower|worse|better|similar)\b(?:\s+\w+){0,4}\s+\bthan\b/.test(text)
    || /\b(clearer|less clear|more clear)\s+than\b/.test(text)
    || /\bfar\s+(more|less|greater|fewer|higher|lower)\b/.test(text);
  const isComparison = isTwoCaseFrame || hasComparativeMagnitude || /\b(vs|versus|compare|comparison|comparable|distinguish|distinction|different|same|criteria|standard|double standard)\b/.test(text);
  if (!isComparison) return "";
  if (/\b(intent|motive|intend|intends|intended)\b/.test(text)
    && /\b(different|distinguish|distinction|not comparable|clearer than|less clear|more clear|rather than|whereas|unlike|separates?)\b/.test(text)) {
    return "Intent-based distinction";
  }
  if (hasComparativeMagnitude) {
    return "Comparable cases / same standard";
  }
  if (/\b(comparable|same|same standard|double standard|criteria|more than|less than|far more|far less)\b/.test(text)) {
    return "Comparable cases / same standard";
  }
  return "";
}

function isClaimLikeLabel(label, claims) {
  const normalizedLabel = normalizeTranscript(label);
  const labelWords = label.split(/\s+/).filter(Boolean).length;
  if (!normalizedLabel) return true;
  if (labelWords > 9) return true;
  if (labelWords <= 6) return false;
  return claims.some((claim) => tokenOverlapRatio(normalizedLabel, normalizeTranscript(claim?.claim || "")) >= 0.72);
}

function compactLabel(label, maxLength = 56) {
  const cleaned = String(label || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return trimBrokenTrailingLabelWord(cleaned);
  const clipped = cleaned.slice(0, maxLength + 1);
  const boundary = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf("/"));
  const compacted = boundary >= Math.max(24, Math.floor(maxLength * 0.62))
    ? clipped.slice(0, boundary)
    : cleaned.slice(0, maxLength);
  return trimBrokenTrailingLabelWord(compacted.replace(/[\s,;:/-]+$/g, "").trim());
}

function trimBrokenTrailingLabelWord(label = "") {
  const cleaned = String(label || "").trim();
  if (cleaned.length < 44) return cleaned;
  return cleaned.replace(/\s+[A-Za-z]{1,2}$/g, "").trim();
}

function derivePositionLabelFromClaim(claimText) {
  const cleaned = cleanClaimText(claimText)
    .replace(/^(i|we)\s+(think|believe|argue|say|support|oppose)\s+(that\s+)?/i, "")
    .replace(/^(the point is|my point is|our point is)\s+(that\s+)?/i, "")
    .replace(/\s+\b(because|since|given that|as a result|therefore)\b.*$/i, "")
    .replace(/\s+\b(and|but|however)\b.*$/i, "")
    .trim();
  if (!cleaned || cleaned.split(/\s+/).length < 3) return "";
  return compactLabel(cleaned);
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function ensureTwoSides(sides) {
  const next = [...sides].slice(0, 2);
  while (next.length < 2) {
    next.push({
      id: `side-${next.length + 1}`,
      label: "",
      thesisStatus: "forming",
      workingThesis: "",
      confirmedThesis: "",
      thesisEvidencePointIds: [],
      score: 0,
      speakerIds: [],
      color: next.length === 0 ? "blue" : "red"
    });
  }
  return next.map((side, index) => ({
    ...side,
    ...normalizeSideThesisFields(side),
    color: index === 0 ? "blue" : "red"
  }));
}

function parseJson(text) {
  const cleaned = text.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) return {};
  return sanitizeParsedAgentOutput(JSON.parse(cleaned.slice(first, last + 1)));
}

const AGENT_DISPLAY_TEXT_KEYS = new Set([
  "assignmentReason",
  "bluePosition",
  "burden",
  "centralQuestion",
  "claim",
  "claimExplanation",
  "detail",
  "evidenceReason",
  "explanation",
  "factExplanation",
  "groundGained",
  "label",
  "missingStep",
  "noSourceReason",
  "ownershipReason",
  "ownershipRisk",
  "ownershipRiskReason",
  "reason",
  "redPosition",
  "repair",
  "rewrite",
  "sourceExplanation",
  "stance",
  "stanceSummary",
  "standardA",
  "standardB",
  "summary",
  "title",
  "why"
]);

function sanitizeParsedAgentOutput(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => sanitizeParsedAgentOutput(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeParsedAgentOutput(entryValue, entryKey)]));
  }
  if (typeof value === "string" && AGENT_DISPLAY_TEXT_KEYS.has(key)) return cleanAgentDisplayText(value);
  if (typeof value === "string" && key === "supportingEvidence") return cleanAgentDisplayText(value);
  return value;
}

function parseJsonWithLocalRepair(text) {
  try {
    return parseJson(text);
  } catch (error) {
    const repaired = repairJsonText(text);
    if (repaired === text) throw error;
    return parseJson(repaired);
  }
}

function repairJsonText(text = "") {
  const cleaned = String(text || "")
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) return cleaned;
  return cleaned
    .slice(first, last + 1)
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

function detectGenericPolicyConflict(leftClaim, rightClaim) {
  const principleConflict = detectPrincipleApplicationConflict(leftClaim, rightClaim)
    || detectPrincipleApplicationConflict(rightClaim, leftClaim);
  if (principleConflict) return principleConflict;

  const left = claimPolarity(leftClaim?.claim || "");
  const right = claimPolarity(rightClaim?.claim || "");
  if (!left || !right || left.polarity === right.polarity) return null;
  const overlap = tokenOverlapRatio(left.tokens.join(" "), right.tokens.join(" "));
  if (overlap < 0.35) return null;

  return {
    summary: `Possible inconsistency: this speaker appears to support and reject closely related positions (${derivePositionLabelFromClaim(leftClaim.claim)} / ${derivePositionLabelFromClaim(rightClaim.claim)}).`,
    severity: overlap >= 0.55 ? "medium" : "low"
  };
}

function detectPrincipleApplicationConflict(principleClaim, applicationClaim) {
  const principle = normalizeTranscript(`${principleClaim?.claim || ""} ${principleClaim?.quote || ""}`);
  const application = normalizeTranscript(`${applicationClaim?.claim || ""} ${applicationClaim?.quote || ""}`);
  if (!principle || !application) return null;
  const principleMovesPeople = /\b(allocate|allocated|prioritize|serve|serves|serving|widest|most people|more people|public land|scarce)\b/.test(principle)
    && /\b(most people|more people|widest group|public land|scarce space|street space)\b/.test(principle);
  const rejectsApplication = /\b(should not|must not|oppose|opposes|reject|rejects|not create|not be created|do not create)\b/.test(application);
  const concedesSamePrinciple = /\b(more people|most people|moves people|move more|move the most|serves more|widest group)\b/.test(application);
  if (!principleMovesPeople || !rejectsApplication || !concedesSamePrinciple) return null;
  return {
    summary: `Possible inconsistency: this speaker states a general allocation principle but rejects an application that appears to satisfy it (${derivePositionLabelFromClaim(principleClaim.claim)} / ${derivePositionLabelFromClaim(applicationClaim.claim)}).`,
    severity: "medium"
  };
}

function claimPolarity(text) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return null;
  const negative = /\b(should not|must not|need not|cannot|cant|oppose|opposes|opposed|against|reject|rejects|rejected|harmful|worse|bad idea|not support|do not support|does not support)\b/.test(normalized);
  const positive = /\b(should|must|need to|needs to|support|supports|supported|favor|favors|favours|expand|increase|approve|beneficial|better|necessary)\b/.test(normalized);
  if (negative === positive) return null;

  const polarityWords = new Set(["should", "must", "need", "needs", "cannot", "cant", "oppose", "opposes", "opposed", "against", "reject", "rejects", "rejected", "support", "supports", "supported", "favor", "favors", "favours", "expand", "increase", "approve", "beneficial", "better", "necessary", "harmful", "worse"]);
  const tokens = meaningfulTokens(normalized).filter((token) => !polarityWords.has(token));
  if (tokens.length < 3) return null;
  return { polarity: negative ? -1 : 1, tokens };
}

function summarizeFirecrawl(result) {
  const text = collectUsefulStrings(result?.data).find((item) => item.length >= 40 && !/^https?:\/\//i.test(item));
  if (text) return text.slice(0, 240);
  return "Additional research context is available in the linked source.";
}

function extractFirecrawlSources(result) {
  return normalizeSources(extractFirecrawlSearchResults(result));
}

function extractFirecrawlSearchResults(result) {
  const data = result?.data;
  const rawItems = Array.isArray(data)
    ? data
    : [
        ...(Array.isArray(data?.web) ? data.web : []),
        ...(Array.isArray(data?.news) ? data.news : []),
        ...(Array.isArray(data?.results) ? data.results : [])
      ];
  const sources = rawItems.map((item) => ({
    title: item?.title || item?.metadata?.title || item?.url,
    uri: item?.url || item?.metadata?.sourceURL || item?.uri,
    description: cleanClaimText(item?.description || item?.snippet || item?.markdown || "")
  })).filter((source) => /^https?:\/\//i.test(source.uri || ""));
  if (sources.length) return sources;
  const serialized = typeof data === "string" ? data : JSON.stringify(data || {});
  const urls = Array.from(serialized.matchAll(/https?:\/\/[^\s"'<>]+/g)).map((match) => match[0].replace(/[),.]+$/, ""));
  return [...new Set(urls)].map((uri) => ({ title: safeHostname(uri) || uri, uri, description: "" })).slice(0, 3);
}

function safeHostname(uri = "") {
  try {
    return new URL(uri).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function collectUsefulStrings(value, output = []) {
  if (typeof value === "string") {
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (cleaned) output.push(cleaned);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUsefulStrings(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUsefulStrings(item, output);
  }
  return output;
}

function calculatePcmRms(buffer) {
  if (buffer.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(buffer.length / 2);
  for (let offset = 0; offset < buffer.length - 1; offset += 2) {
    const sample = buffer.readInt16LE(offset) / 32768;
    sum += sample * sample;
  }
  return Number(Math.sqrt(sum / samples).toFixed(4));
}

function joinWords(words) {
  return words.join(" ").replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim();
}

function normalizeTranscript(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

function meaningfulTokens(text) {
  return uniqueStrings(normalizeTranscript(text)
    .split(/\s+/)
    .map(directToken)
    .filter((token) => token.length > 3 && !CLAIM_STOPWORDS.has(token)));
}

function directToken(token) {
  if (/^civilian/.test(token)) return "civilian";
  if (/^child/.test(token)) return "children";
  if (/^(genocid|discriminat|corrupt|illegal|unfair|unsafe|harmful)/.test(token)) return token.replace(/(?:ion|ive|al|ful|s)$/, "");
  if (/^(intend|intent|motive|motives)$/.test(token)) return "intent";
  if (/^(kill|kills|killed|killing|eliminate|eliminates|exterminate|exterminates|target|targets|targeting|wipe|wiped|destroy|destroys|destroyed|harm|harms|harmed)$/.test(token)) return "harm";
  if (/^(kidnap|kidnaps|kidnapped|kidnapping|abduct|abducts|abducted|abducting)$/.test(token)) return "abduct";
  if (/^(displace|displaces|displaced|displacing|evict|evicts|evicted)$/.test(token)) return "displace";
  if (/^(recognize|recognizes|recognized|recognition)$/.test(token)) return "recognize";
  if (/^(statement|statements)$/.test(token)) return "statement";
  if (/^(support|supports|supported|supporting)$/.test(token)) return "support";
  if (/^(oppose|opposes|opposed|opposing|reject|rejects|rejected|rejecting)$/.test(token)) return "oppose";
  if (/^(build|builds|built|building)$/.test(token)) return "build";
  if (/^(expand|expands|expanded|expanding)$/.test(token)) return "expand";
  if (/^(reduce|reduces|reduced|reducing|decrease|decreases|decreased|cut|cuts|cutting)$/.test(token)) return "reduce";
  if (/^(increase|increases|increased|increasing)$/.test(token)) return "increase";
  if (/^(cost|costs|costing|expensive)$/.test(token)) return "cost";
  if (/^(cause|causes|caused|causing|lead|leads|leading|result|results|resulting)$/.test(token)) return "cause";
  return stemToken(token);
}

function stemToken(token) {
  if (token.length > 6 && /ing$/.test(token)) return token.slice(0, -3);
  if (token.length > 5 && /ed$/.test(token)) return token.slice(0, -2);
  if (token.length > 5 && /ies$/.test(token)) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /s$/.test(token)) return token.slice(0, -1);
  return token;
}

function isStrongClaimText(text) {
  const trimmed = (text || "").replace(/\s+/g, " ").trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const normalized = trimmed.toLowerCase().replace(/[^\w\s']/g, "").trim();
  if (words.length < 5 || trimmed.length < 24) return false;
  if (/^(said that|i just (say|think)|i think it (goes|comes) (to|down to)|it (goes|comes) (to|down to)|you do|you have been|you've criticized|but when it comes|why is|what is|that is|this is|tell me|let me ask|my question is)\b/i.test(trimmed)) return false;
  if (/\b(but|whereas|while)\b/i.test(trimmed)) return false;

  const lastWord = normalized.split(/\s+/).at(-1) || "";
  const incompleteEndings = new Set(["are", "is", "was", "were", "that", "the", "a", "an", "and", "but", "or", "of", "to", "with", "his", "her", "their"]);
  if (incompleteEndings.has(lastWord)) return false;

  return hasGenericClaimSignal(trimmed);
}

function isClaimFaithfulToTurn(claimText, turnText) {
  if (/\[[^\]]+\]/.test(claimText)) return false;
  const claim = normalizeTranscript(claimText || "");
  const turn = normalizeTranscript(turnText || "");
  if (!claim) return false;
  if (!turn) return false;
  if (turn.includes(claim) || claim.includes(turn)) return true;

  const claimNumbers = claimText.match(/\b\d+(?:[.,]\d+)?%?\b/g) || [];
  const sourceNumbers = new Set(turnText.match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
  if (claimNumbers.some((number) => !sourceNumbers.has(number))) return false;

  const claimTokens = meaningfulTokens(claim);
  const sourceTokens = new Set(meaningfulTokens(turn));
  if (claimTokens.length < 3 || sourceTokens.size < 3) return false;
  const missingTokens = claimTokens.filter((token) => !sourceTokens.has(token));
  if (missingTokens.length / claimTokens.length > 0.18) return false;
  if (!hasSubjectActionOrderSupport(claim, turn)) return false;
  const overlap = claimTokens.filter((token) => sourceTokens.has(token)).length / claimTokens.length;
  return overlap >= 0.5;
}

function hasSubjectActionOrderSupport(claim, source) {
  const claimTokens = normalizeTranscript(claim).split(/\s+/).filter(Boolean);
  const sourceTokens = normalizeTranscript(source).split(/\s+/).filter(Boolean);
  const actionIndex = claimTokens.findIndex((token) => CLAIM_ACTION_TOKENS.has(token));
  if (actionIndex === -1) return true;

  const subjectIndex = claimTokens.findIndex((token, index) => index < actionIndex && token.length > 3 && !CLAIM_STOPWORDS.has(token));
  if (subjectIndex === -1) return true;
  const subject = claimTokens[subjectIndex];
  const action = claimTokens[actionIndex];

  const sourceSubjectIndexes = sourceTokens
    .map((token, index) => (token === subject ? index : -1))
    .filter((index) => index !== -1);
  const sourceActionIndexes = sourceTokens
    .map((token, index) => (token === action ? index : -1))
    .filter((index) => index !== -1);

  if (!sourceSubjectIndexes.length || !sourceActionIndexes.length) return false;
  return sourceSubjectIndexes.some((left) => sourceActionIndexes.some((right) => left <= right && right - left <= 14));
}

function strongestClaimFromTurn(text) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  const sentenceCandidates = normalized
    .split(/(?<=[.!?])\s+|\s+-\s+/)
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const candidates = sentenceCandidates.length > 1 ? sentenceCandidates : [normalized];
  return candidates
    .filter(isStrongClaimText)
    .sort((a, b) => claimTextScore(b) - claimTextScore(a))[0] || "";
}

function claimTextScore(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const signalMatches = text.match(genericClaimSignalRegex()) || [];
  const lengthPenalty = Math.max(0, words - 34) * 0.25;
  return signalMatches.length * 3 + Math.min(words, 28) * 0.2 - lengthPenalty;
}

function hasGenericClaimSignal(text) {
  return genericClaimSignalRegex().test(text) || /\b\d+(?:[.,]\d+)?%?\b/.test(text);
}

function genericClaimSignalRegex() {
  return /\b(should|must|need(?:s)? to|ought|because|therefore|causes?|caused|leads? to|results? in|evidence|study|studies|research|report|data|poll|according to|shows?|proves?|means|responsible|blame|intent|policy|law|legal|rights?|harm|risk|benefit|cost|tax|funding|budget|increase|decrease|reduce|more|less|higher|lower|majority|minority|percent|rate|people|workers|children|civilians|government|company|court|military|economy|climate|health|education|security|crime|housing|immigration|war|peace|genocide|discrimination|corruption|kill(?:ed|s|ing)?|death|violence|safe|unsafe|effective|ineffective|fair|unfair|true|false)\b/gi;
}

export {
  runDirectThesisBuilderAgent,
  applyDirectThesisBuilderUpdate,
  runDirectClashFinderAgent,
  normalizeDirectClashArtifacts,
  mergeDirectClashArtifacts,
  finalizeDirectLedgerState,
  buildArtifactContextDialogueWindows,
  normalizeClaimState
};

function isDebatePoint(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const normalized = text.trim().toLowerCase().replace(/[^\w\s]/g, "");
  const filler = new Set(["here", "yeah", "yes", "no", "okay", "ok", "hello", "hi", "um", "uh"]);
  return words.length >= 6 && text.trim().length >= 28 && !filler.has(normalized);
}

function shouldEmitTranscriptSegment(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const normalized = text.trim().toLowerCase().replace(/[^\w\s]/g, "");
  const filler = new Set(["and", "but", "so", "uh", "um", "yeah", "yes", "no", "okay", "ok", "i"]);
  return words.length >= 2 && text.trim().length >= 5 && !filler.has(normalized);
}

