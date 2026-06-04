const optionalNumber = (value) => {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const config = {
  project: process.env.GOOGLE_CLOUD_PROJECT || "project-edf64ffe-6f3d-4e13-979",
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
  model: process.env.VERTEX_MODEL || "gemini-2.5-pro",
  fastModel: process.env.VERTEX_FAST_MODEL || "gemini-3.1-flash-lite",
  groundingModel: process.env.VERTEX_GROUNDING_MODEL || "gemini-2.5-flash",
  liveSttProvider: "speechmatics",
  resendApiKey: process.env.RESEND_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || "",
  appUrl: process.env.APP_URL || "http://127.0.0.1:5173",
  pyannoteApiKey: process.env.PYANNOTE_API_KEY || "",
  pyannoteBatchModel: process.env.PYANNOTE_MODEL_BATCH || "precision-2",
  pyannoteBatchTranscriptionModel: process.env.PYANNOTE_BATCH_STT_MODEL || "faster-whisper-large-v3-turbo",
  pyannoteLiveEnabled: String(process.env.PYANNOTE_LIVE_ENABLED || "true").toLowerCase() !== "false",
  // Live speaker diarization source: "speechmatics" (default, raw STT labels) or
  // "pyannote" (local Utterr online-clustering worker; Speechmatics still does words).
  liveDiarizationProvider: String(process.env.LIVE_DIARIZATION_PROVIDER || "speechmatics").trim().toLowerCase(),
  pyannotePythonPath: process.env.PYANNOTE_PYTHON_PATH || "python",
  pyannoteModel: process.env.PYANNOTE_MODEL || "pyannote/speaker-diarization-community-1",
  pyannoteSampleRate: Number(process.env.PYANNOTE_SAMPLE_RATE || 16000),
  pyannoteDevice: process.env.PYANNOTE_DEVICE || "auto",
  // Default false: when pyannote can't place a word, fall back to the Speechmatics
  // label instead of dropping it. Set PYANNOTE_ONLY_DIARIZATION=true for pure mode.
  pyannoteOnlyDiarization: String(process.env.PYANNOTE_ONLY_DIARIZATION || "false").toLowerCase() === "true",
  pyannoteNumSpeakers: optionalNumber(process.env.PYANNOTE_NUM_SPEAKERS),
  pyannoteMinSpeakers: optionalNumber(process.env.PYANNOTE_MIN_SPEAKERS),
  pyannoteMaxSpeakers: optionalNumber(process.env.PYANNOTE_MAX_SPEAKERS),
  pyannoteLiveWindowMs: Number(process.env.PYANNOTE_LIVE_WINDOW_MS || 30000),
  pyannoteLiveIntervalMs: Number(process.env.PYANNOTE_LIVE_INTERVAL_MS || 5000),
  pyannoteLiveBootstrapWindowMs: Number(process.env.PYANNOTE_LIVE_BOOTSTRAP_WINDOW_MS || 30000),
  pyannoteLiveBootstrapIntervalMs: Number(process.env.PYANNOTE_LIVE_BOOTSTRAP_INTERVAL_MS || 5000),
  pyannoteLiveBootstrapUntilMs: Number(process.env.PYANNOTE_LIVE_BOOTSTRAP_UNTIL_MS || 30000),
  pyannoteLiveRollingWindowMs: Number(process.env.PYANNOTE_LIVE_ROLLING_WINDOW_MS || process.env.PYANNOTE_LIVE_WINDOW_MS || 30000),
  pyannoteLiveRollingIntervalMs: Number(process.env.PYANNOTE_LIVE_ROLLING_INTERVAL_MS || process.env.PYANNOTE_LIVE_INTERVAL_MS || 5000),
  pyannoteLiveMinAudioMs: Number(process.env.PYANNOTE_LIVE_MIN_AUDIO_MS || 8000),
  pyannoteLiveMaxBufferMs: Number(process.env.PYANNOTE_LIVE_MAX_BUFFER_MS || 120000),
  pyannoteLiveTurnWaitMs: Number(process.env.PYANNOTE_LIVE_TURN_WAIT_MS || 10000),
  pyannoteLiveColdStartWindowMs: Number(process.env.PYANNOTE_LIVE_COLD_START_WINDOW_MS || 60000),
  pyannoteLiveColdStartTurnWaitMs: Number(process.env.PYANNOTE_LIVE_COLD_START_TURN_WAIT_MS || 30000),
  pyannoteLiveReadyTimeoutMs: Number(process.env.PYANNOTE_LIVE_READY_TIMEOUT_MS || 120000),
  pyannoteLiveRequestTimeoutMs: Number(process.env.PYANNOTE_LIVE_REQUEST_TIMEOUT_MS || 180000),
  pyannoteStableOverlapSec: Number(process.env.PYANNOTE_STABLE_OVERLAP_SEC || 0.75),
  speechmaticsApiKey: process.env.SPEECHMATICS_API_KEY || "",
  speechmaticsRealtimeUrl: process.env.SPEECHMATICS_REALTIME_URL || "wss://us.rt.speechmatics.com/v2",
  speechmaticsLanguage: process.env.SPEECHMATICS_LANGUAGE || "en",
  speechmaticsOperatingPoint: process.env.SPEECHMATICS_OPERATING_POINT || "enhanced",
  speechmaticsSampleRate: Number(process.env.SPEECHMATICS_SAMPLE_RATE || 16000),
  // Diarization tuning (see speechmatics-live-stt-node.mjs).
  speechmaticsMaxSpeakers: Number(process.env.SPEECHMATICS_MAX_SPEAKERS || 10),
  speechmaticsPreferCurrentSpeaker: String(process.env.SPEECHMATICS_PREFER_CURRENT_SPEAKER || "true").toLowerCase() !== "false",
  speechmaticsSpeakerSensitivity: optionalNumber(process.env.SPEECHMATICS_SPEAKER_SENSITIVITY) ?? 0.35,
  speechmaticsVolumeThreshold: optionalNumber(process.env.SPEECHMATICS_VOLUME_THRESHOLD) ?? 3,
  speechmaticsMaxDelay: Number(process.env.SPEECHMATICS_MAX_DELAY || 2),
  speechmaticsRecoveryBufferMs: Number(process.env.SPEECHMATICS_RECOVERY_BUFFER_MS || 60000),
  speechmaticsReconnectInitialMs: Number(process.env.SPEECHMATICS_RECONNECT_INITIAL_MS || 500),
  speechmaticsReconnectMaxMs: Number(process.env.SPEECHMATICS_RECONNECT_MAX_MS || 15000),
  speechmaticsHeartbeatMs: Number(process.env.SPEECHMATICS_HEARTBEAT_MS || 30000),
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || "",
  firecrawlSearchTimeoutMs: Number(process.env.FIRECRAWL_SEARCH_TIMEOUT_MS || 12000),
  firecrawlSearchLimit: Number(process.env.FIRECRAWL_SEARCH_LIMIT || 4),
  firecrawlExcludedDomains: (process.env.FIRECRAWL_EXCLUDED_DOMAINS || "facebook.com,x.com,twitter.com,reddit.com,tiktok.com,instagram.com,quora.com")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean),
  port: Number(process.env.PORT || 8787)
};
