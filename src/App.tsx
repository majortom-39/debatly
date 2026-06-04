import { AudioLines, BadgeCheck, BadgeHelp, BadgeMinus, BadgeX, Ban, BarChart3, BookOpen, BookOpenCheck, Check, ChevronDown, CircleDashed, CircleStop, CircleX, Clock, Clock3, Download, ExternalLink, FileText, Gavel, GitCompareArrows, Handshake, HelpCircle, Landmark, LogOut, Menu, MessageSquareQuote, Mic, Moon, MoreHorizontal, OctagonX, Pause, Pencil, Play, Plus, Repeat, RotateCcw, Scale, Search, Settings, Share2, Sparkles, Sun, Swords, Target, Trash2, TrendingDown, TrendingUp, TriangleAlert, Users, UserCircle, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import type { ComponentType, CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import Grainient from "./components/Grainient";
import PixelCard from "./components/PixelCard";
import { authHeaders, getAccessToken, isSupabaseConfigured, mapAuthUser, signInAnonymously, signInWithProvider, signOut, supabase, type AuthProvider, type AuthUser } from "./supabaseClient";
import type {
  ClashArtifact,
  CleanUtterance,
  ClaimArtifact,
  DebateArtifacts,
  DebateReport,
  DebatePoint,
  DebateSide,
  DebateState,
  DialogueWindow,
  DirectAnalysisState,
  InconsistencyArtifact,
  FactStatus,
  IssueGroup,
  Scorecard,
  ScorePillar,
  SourceCheckArtifact,
  SpeakerProfile,
  TranscriptTurn,
  KeyMomentArtifact,
  ReportSpeaker,
  ReportFactCheck,
  ReportContradiction,
  ReportKeyMoment,
  ReportScoreTimeline,
  ReportSpeakerEntry
} from "./types";

const initialDebate: DebateState = {
  topic: "",
  speakers: [],
  sides: [],
  points: [],
  rebuttals: [],
  scores: {
    blue: 0,
    red: 0,
    dimensions: []
  },
  utterances: [],
  dialogueWindows: [],
  artifacts: emptyArtifacts(),
  scorecard: emptyScorecard(),
  claims: [],
  contradictions: []
};

type LiveEvent =
  | { type: "ready"; message: string }
  | { type: "session_ready"; sessionId: string; projectId?: string; pipeline?: "current" | string; analysisSchemaVersion?: number }
  | { type: "audio_ack"; chunks: number; bytes: number; rms: number; chunkDurationMs?: number; pcmSeconds?: number; byteRate?: number }
  | { type: "transcript"; turn: TranscriptTurn }
  | { type: "analysis_status"; sessionId: string; status: "queued" | "running" | "verifying" | "idle" | "error"; message: string; pendingTurns: number; totalMs?: number; verificationMs?: number }
  | { type: "debate_state"; sessionId: string; seq: number; source: "analysis" | "verification" | "score"; analysis: LiveAnalysis | null }
  | { type: "speechmatics_stats"; reason: string; stats: { addTranscriptEvents?: number; emittedFinalTurns?: number; pendingGroupsAtClose?: number; undeliveredFinalTurns?: number } }
  | { type: "stt_stats"; provider?: string; reason: string; stats: { addTranscriptEvents?: number; emittedFinalTurns?: number; pendingGroupsAtClose?: number; undeliveredFinalTurns?: number } }
  | { type: "stt_status"; status: "connecting" | "ready" | "reconnecting" | "degraded" | "stopped"; message: string; sessionSeq: number; attempt: number; bufferedMs: number; droppedMs: number; lastCloseCode?: number | null }
  | { type: "diarization_status"; status: "disabled" | "warming" | "ready" | "degraded" | "error"; message: string }
  | { type: "error"; message: string };

// ---- NEW clean pipeline payload (from server/live-runner.mjs) ----------------
export type FactTag = "verified" | "contradicted" | "misleading" | "no_clear_source";
export type DebatePointTag = "foundation" | "evidence" | "rebuttal" | "principle" | "precedent" | "hypothetical";
export type InconsistencyType = "self-contradiction" | "double-standard" | "hypocrisy";

export interface LiveSource { title: string; uri: string; snippet?: string }
export interface LiveDebatePoint {
  id: string; speakerId: string; point: string; quote: string;
  tag: DebatePointTag; familyId: string | null; familyTitle: string;
  opposingQuote?: string; opposingSpeakerId?: string;
}
export interface LiveClaim {
  id: string; speakerId: string; claim: string; quote: string;
  status: "queued" | "checking" | "deep_checking" | "done";
  tag: FactTag | null; why: string; sources: LiveSource[];
}
export interface LiveInconsistency {
  id: string; type: InconsistencyType; level: "speaker" | "side"; why: string;
  firstSpeakerId: string; firstQuote: string; secondSpeakerId: string; secondQuote: string;
}
export interface LiveFamily { familyId: string; title: string; pointIds: string[] }
export interface LiveSide {
  position: string; thesis: string; score: number;
  breakdown: Record<string, number> | null;
  points: Record<string, number> | null;
  explanation: string;
  speakers: Record<string, { score: number } & Record<string, number>>;
  families: LiveFamily[];
  debatePoints: LiveDebatePoint[];
  claims: LiveClaim[];
  inconsistencies: LiveInconsistency[];
}
export interface LiveAnalysis {
  topic: string; gateOpen: boolean;
  sides: { blue: LiveSide; red: LiveSide };
  speakers: Record<string, { side: string }>;
  counts: { debatePoints: number; claims: number; inconsistencies: number };
}

type Diagnostics = {
  secureContext: boolean;
  mediaDevices: boolean;
  mediaRecorder: boolean;
  mimeType: string;
  wsState: string;
  chunks: number;
  bytes: number;
  level: number;
  serverRms: number;
  transcripts: number;
  analyses: number;
  diarization: string;
  sttStatus: string;
  sttReconnects: number;
  sttBufferedMs: number;
  sttDroppedMs: number;
  sttLastCloseCode: string;
  sttSessionSeq: number;
  audioContextSampleRate: number;
  micSampleRate: number;
  micChannelCount: number;
  pcmSeconds: number;
  byteRate: number;
  events: Array<{ id: string; text: string }>;
};

type SideView = DebateSide & {
  speakers: Array<{ id: string; profile?: SpeakerProfile; points: DebatePoint[]; turns: TranscriptTurn[] }>;
};

const speakerRosterTraceKeys = new Set<string>();

type TimedDebateState = DebateState & {
  _timings?: {
    selectionMs?: number;
    verificationMs?: number;
    mergeScoreMs?: number;
    totalMs?: number;
    verificationMode?: string;
  };
};

type AnalysisTab = "debatePoints" | "claims" | "inconsistencies";
type ThemeMode = "light" | "dark";
type ReportProgressState = {
  active: boolean;
  value: number;
  stage: string;
  note: string;
  tick: number;
};
type ProjectMeta = {
  id?: string;
  sessionId?: string;
  status?: string;
  title: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs?: number;
  pausedMs: number;
  pauseStartedAt: number | null;
  titleEdited: boolean;
};
type SavedDebateProject = {
  id: string;
  title: string;
  status: string;
  topic?: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  sessionId?: string | null;
  transcriptTurnCount?: number;
  createdAt?: number | null;
  updatedAt?: number | null;
};
type SavedDebateRefreshOptions = {
  showLoading?: boolean;
  autoLoadLatest?: boolean;
};
type LoadSavedDebateOptions = {
  silent?: boolean;
  force?: boolean;
  statusMessage?: string;
};
type SpeakerLabelMap = Record<string, string>;
type ProjectActionDialogState = {
  mode: "rename" | "delete";
  projectId?: string;
  title: string;
  isCurrent: boolean;
} | null;
type QuoteStripItem = {
  speakerId: string;
  sideColor?: "blue" | "red";
  text: string;
  rawText?: string;
  atSec?: number;
};

const BATCH_EXCHANGE_TURN_TRIGGER = 4;
const BATCH_EXCHANGE_TURNS_PER_SPEAKER = 2;
const BATCH_MONOLOGUE_TURN_TRIGGER = 6;
const BATCH_CHAR_TRIGGER = 1300;
const BATCH_TIME_TRIGGER_MS = 20000;
const BATCH_FAST_DEBOUNCE_MS = 500;
const BATCH_IDLE_DEBOUNCE_MS = 1200;
const DEFAULT_PROJECT_TITLE = "Untitled debate";
const LOGO_LIGHT_MODE = "/Debatly%20Logo%20Light%20Mode.png";
const LOGO_DARK_MODE = "/Debatly%20Logo%20Dark%20Mode.png";
const FAVICON_LIGHT_MODE = "/Debatly%20Favicon%20Light%20Mode%20Tight.png";
const FAVICON_DARK_MODE = "/Debatly%20Favicon%20Dark%20Mode%20Tight.png";
const REPORT_PROGRESS_STAGES = [
  { stage: "Preparing transcript", note: "Locking the last final turns." },
  { stage: "Finishing live analysis", note: "Running the remaining debate desk batches." },
  { stage: "Checking remaining points", note: "Clearing the source-check queue." },
  { stage: "Reading the score movement", note: "Marking the shifts that changed the edge." },
  { stage: "Writing highlights", note: "Drafting the post-debate read." },
  { stage: "Finalizing report", note: "Closing the copy desk." }
];
const REPORT_PROGRESS_INTERVAL_MS = 2200;

function initialReportProgress(): ReportProgressState {
  return {
    active: false,
    value: 0,
    stage: REPORT_PROGRESS_STAGES[0].stage,
    note: REPORT_PROGRESS_STAGES[0].note,
    tick: 0
  };
}

const initialDiagnostics: Diagnostics = {
  secureContext: false,
  mediaDevices: false,
  mediaRecorder: false,
  mimeType: "",
  wsState: "idle",
  chunks: 0,
  bytes: 0,
  level: 0,
  serverRms: 0,
  transcripts: 0,
  analyses: 0,
  diarization: "waiting",
  sttStatus: "idle",
  sttReconnects: 0,
  sttBufferedMs: 0,
  sttDroppedMs: 0,
  sttLastCloseCode: "",
  sttSessionSeq: 0,
  audioContextSampleRate: 0,
  micSampleRate: 0,
  micChannelCount: 0,
  pcmSeconds: 0,
  byteRate: 0,
  events: []
};

const liveAudioInputChannelMode = "average";

function sanitizeTrackSettings(settings?: MediaTrackSettings | MediaTrackConstraints | null) {
  const source = settings || {};
  const allowedKeys = [
    "sampleRate",
    "sampleSize",
    "channelCount",
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
    "latency"
  ];
  const output: Record<string, string | number | boolean> = {};
  for (const key of allowedKeys) {
    const value = source[key as keyof typeof source];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}

function sanitizeTrackCapabilities(capabilities?: MediaTrackCapabilities | MediaTrackSupportedConstraints | null) {
  const source = capabilities || {};
  const allowedKeys = [
    "sampleRate",
    "sampleSize",
    "channelCount",
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
    "latency"
  ];
  const output: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const value = source[key as keyof typeof source];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    } else if (Array.isArray(value)) {
      output[key] = value.filter((item) => ["string", "number", "boolean"].includes(typeof item)).slice(0, 12);
    } else if (value && typeof value === "object") {
      const range: Record<string, number> = {};
      for (const rangeKey of ["min", "max"]) {
        const rangeValue = (value as Record<string, unknown>)[rangeKey];
        if (typeof rangeValue === "number") range[rangeKey] = rangeValue;
      }
      if (Object.keys(range).length) output[key] = range;
    }
  }
  return output;
}

function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "dark";
    const stored = window.localStorage.getItem("debate-ui-theme");
    if (stored === "dark" || stored === "light") return stored;
    return "dark";
  });
  const [isLive, setIsLive] = useState(false);
  const [status, setStatus] = useState("Standby");
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [debate, setDebate] = useState<DebateState>(initialDebate);
  const [researching, setResearching] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [isMicTesting, setIsMicTesting] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(initialDiagnostics);
  const [liveAnalysis, setLiveAnalysis] = useState<LiveAnalysis | null>(null); // NEW clean pipeline payload
  const [activeTab, setActiveTab] = useState<AnalysisTab>("debatePoints");
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const importGuideRef = useRef<HTMLDivElement | null>(null);
  const recordGuideRef = useRef<HTMLDivElement | null>(null);
  const [toast, setToast] = useState("");
  const toastTimerRef = useRef<number | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importJob, setImportJob] = useState<{ stage: string; stageLabel: string; progress: number; error: string | null; emailConfigured?: boolean; notified?: boolean } | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [importMinimized, setImportMinimized] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const importPollRef = useRef<number | null>(null);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [isExportingReportPdf, setIsExportingReportPdf] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [liveSessionId, setLiveSessionId] = useState("");
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [debateReport, setDebateReport] = useState<DebateReport | null>(null);
  const [reportProgress, setReportProgress] = useState<ReportProgressState>(() => initialReportProgress());
  const [savedDebates, setSavedDebates] = useState<SavedDebateProject[]>([]);
  const [savedDebatesLoading, setSavedDebatesLoading] = useState(false);
  const [savedDebatesLoadError, setSavedDebatesLoadError] = useState("");
  const [savedDebatesLoadedUserId, setSavedDebatesLoadedUserId] = useState("");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured);
  const [workspaceBooting, setWorkspaceBooting] = useState(isSupabaseConfigured);
  const [authWorkingProvider, setAuthWorkingProvider] = useState<AuthProvider | "signout" | "">("");
  const [projectActionDialog, setProjectActionDialog] = useState<ProjectActionDialogState>(null);
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [project, setProject] = useState<ProjectMeta>({
    title: DEFAULT_PROJECT_TITLE,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    pausedMs: 0,
    pauseStartedAt: null,
    titleEdited: false
  });
  const [clockTick, setClockTick] = useState(Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const turnsRef = useRef<TranscriptTurn[]>([]);
  const debateRef = useRef<DebateState>(initialDebate);
  const meterContextRef = useRef<AudioContext | null>(null);
  const streamContextRef = useRef<AudioContext | null>(null);
  const preparedAudioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silenceRef = useRef<GainNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const pcmQueueRef = useRef<ArrayBuffer[]>([]);
  const pcmQueueBytesRef = useRef(0);
  const analysisQueueRef = useRef(Promise.resolve());
  const batchQueueRef = useRef<TranscriptTurn[]>([]);
  const batchCharsRef = useRef(0);
  const batchTimerRef = useRef<number | null>(null);
  const lastAnalysisAtRef = useRef(Date.now());
  const verificationInFlightRef = useRef<Set<string>>(new Set());
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingPausedRef = useRef(false);
  const pauseStartedAtRef = useRef<number | null>(null);
  const pausedDurationMsRef = useRef(0);
  const stoppedDurationMsRef = useRef(0);
  const liveSessionIdRef = useRef("");
  const latestDebateStateSeqRef = useRef(0);
  const liveFatalErrorRef = useRef("");
  const reportRequestedRef = useRef(false);
  const reportStartedRef = useRef(false);
  const reportProgressTimerRef = useRef<number | null>(null);
  const liveAnalysisRef = useRef<LiveAnalysis | null>(null);
  const debateReportRef = useRef<HTMLDivElement | null>(null);
  const shareMenuRef = useRef<HTMLDivElement | null>(null);
  const authUserIdRef = useRef("");
  const latestProjectAutoLoadedForUserRef = useRef("");
  const savedDebateRecoveryAttemptsRef = useRef(0);
  const initialWorkspaceBootFinishedRef = useRef(!isSupabaseConfigured);
  const projectRef = useRef<ProjectMeta>({
    title: DEFAULT_PROJECT_TITLE,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    pausedMs: 0,
    pauseStartedAt: null,
    titleEdited: false
  });

  const presentedDebate = debate;
  const presentedTurns = turns;
  const projectDurationMs = getActiveProjectDurationMs(project, clockTick);
  const recordingLocked = project.status === "report_ready";
  // A guest is an anonymous Supabase user (app is fully usable, debates persist,
  // but there's no email until they sign in). A permanent user has signed in.
  const isGuestUser = Boolean(authUser?.isAnonymous);
  const isPermanentUser = Boolean(authUser) && !authUser?.isAnonymous;

  // First-visit onboarding guides: shown once per browser to brand-new visitors
  // (not to anyone who has signed in or already dismissed them).
  useEffect(() => {
    if (!authReady || isPermanentUser) return;
    let seen = true;
    try { seen = Boolean(localStorage.getItem("debatly_onboarding_v1")); } catch { seen = true; }
    if (!seen) setShowOnboarding(true);
  }, [authReady, isPermanentUser]);
  function dismissOnboarding() {
    try { localStorage.setItem("debatly_onboarding_v1", "1"); } catch { /* ignore */ }
    setShowOnboarding(false);
  }
  const sideViews = useMemo(() => buildSideViews(presentedDebate, presentedTurns), [presentedDebate, presentedTurns]);
  // Manual "Generate report" gating: only for a loaded debate that has no report yet
  // AND actually has speakers placed on a side (otherwise the report would be empty).
  const reportAlreadyExists = Boolean(debateReport) || project.status === "report_ready";
  const hasAssignedSpeakers = sideViews.some((sv) => (sv.speakers?.length || 0) > 0);
  const generateReportDisabledReason = reportProgress.active
    ? "Generating report…"
    : reportAlreadyExists
      ? "Report already generated"
      : !hasAssignedSpeakers
        ? "No sides or speakers assigned yet"
        : "";
  const artifacts = useMemo(() => getArtifacts(presentedDebate), [presentedDebate]);
  const issueGroups = useMemo(() => getIssueGroups(presentedDebate), [presentedDebate]);
  const stabilizerContextWindows = useMemo(() => getStabilizerContextWindows(presentedDebate), [presentedDebate]);
  const scorecard = useMemo(() => getScorecard(presentedDebate, sideViews, artifacts), [presentedDebate, sideViews, artifacts]);
  const ledgerLead = getLedgerLead(scorecard);
  const speakerLabel = useCallback(
    (speakerId?: string) => formatSpeakerLabel(speakerId, presentedDebate.speakerDisplayNames),
    [presentedDebate.speakerDisplayNames]
  );
  const quoteMinuteBucket = Math.max(0, Math.floor(projectDurationMs / 60_000));
  const [featuredQuoteItem, setFeaturedQuoteItem] = useState<QuoteStripItem | null>(null);
  const featuredQuoteKeyRef = useRef("");
  const pipeline = useMemo(
    () => ({
      audio: diagnostics.chunks > 0,
      voice: diagnostics.serverRms >= 0.005,
      transcript: diagnostics.transcripts > 0,
      analysis: diagnostics.analyses > 0
    }),
    [diagnostics]
  );

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
    window.localStorage.setItem("debate-ui-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const updateFavicon = () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-dynamic-favicon="true"]');
      if (link) link.href = media?.matches ? FAVICON_DARK_MODE : FAVICON_LIGHT_MODE;
    };
    updateFavicon();
    media?.addEventListener?.("change", updateFavicon);
    return () => media?.removeEventListener?.("change", updateFavicon);
  }, []);

  useEffect(() => {
    if (!isSidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isSidebarOpen]);

  useEffect(() => {
    if (!shareMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && shareMenuRef.current?.contains(target)) return;
      setShareMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShareMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [shareMenuOpen]);

  useEffect(() => {
    if (!showSettings) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [showSettings]);

  useEffect(() => {
    const reportId = debateReport?.id || "";
    const backendQuote = getBackendFeaturedQuoteItem(presentedDebate);
    const key = reportId
      ? `report:${reportId}:${ledgerLead.side}`
      : backendQuote
        ? `backend:${project.id || liveSessionId || "draft"}:${backendQuote.text}:${backendQuote.atSec ?? ""}`
        : isLive
        ? `live:${project.id || liveSessionId || "draft"}:${quoteMinuteBucket}:${ledgerLead.side}`
        : "";
    if (!key) {
      featuredQuoteKeyRef.current = "";
      setFeaturedQuoteItem(null);
      return;
    }
    if (featuredQuoteKeyRef.current === key) return;
    if (backendQuote && !reportId) {
      featuredQuoteKeyRef.current = key;
      setFeaturedQuoteItem(backendQuote);
      return;
    }
    const nextQuote = buildFeaturedQuoteItem({
      artifacts,
      turns: presentedTurns,
      sideViews,
      scorecard,
      durationMs: projectDurationMs,
      report: debateReport
    });
    if (nextQuote) {
      featuredQuoteKeyRef.current = key;
      setFeaturedQuoteItem(nextQuote);
      return;
    }
    if (!isLive && !reportId) {
      featuredQuoteKeyRef.current = "";
      setFeaturedQuoteItem(null);
    }
  }, [
    artifacts,
    debateReport,
    isLive,
    ledgerLead.side,
    liveSessionId,
    presentedTurns,
    presentedDebate,
    project.id,
    projectDurationMs,
    quoteMinuteBucket,
    scorecard,
    sideViews
  ]);


  useEffect(() => {
    setDiagnostics((current) => ({
      ...current,
      secureContext: window.isSecureContext,
      mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
      mediaRecorder: "MediaRecorder" in window,
      mimeType: "LINEAR16 PCM 16k"
    }));
    void refreshAudioInputs();
  }, []);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    liveAnalysisRef.current = liveAnalysis;
  }, [liveAnalysis]);

  useEffect(() => {
    debateRef.current = debate;
  }, [debate]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      setWorkspaceBooting(false);
      return;
    }
    let mounted = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      let session = data.session;
      // No session yet → sign the visitor in as an anonymous guest so the app is
      // usable immediately. Their debates persist under this guest id and carry
      // over if they later sign in.
      if (!session) {
        try {
          session = await signInAnonymously();
        } catch (error) {
          pushEvent(error instanceof Error ? `Guest sign-in failed: ${error.message}` : "Guest sign-in failed");
        }
      }
      if (!mounted) return;
      const nextUser = mapAuthUser(session?.user);
      setAuthUser(nextUser);
      authUserIdRef.current = nextUser?.id || "";
      setAuthReady(true);
      if (nextUser) {
        const sharedId = (() => { try { return new URLSearchParams(window.location.search).get("share") || ""; } catch { return ""; } })();
        if (sharedId) {
          await openSharedFromUrl(sharedId);
        } else {
          await refreshSavedDebates({ showLoading: false, autoLoadLatest: true });
        }
      } else {
        latestProjectAutoLoadedForUserRef.current = "";
        savedDebateRecoveryAttemptsRef.current = 0;
        setSavedDebates([]);
        setSavedDebatesLoadError("");
        setSavedDebatesLoadedUserId("");
      }
    }).catch((error) => {
      if (!mounted) return;
      setAuthReady(true);
      pushEvent(error instanceof Error ? `Session restore failed: ${error.message}` : "Session restore failed");
    }).finally(() => {
      if (!mounted) return;
      initialWorkspaceBootFinishedRef.current = true;
      setWorkspaceBooting(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!initialWorkspaceBootFinishedRef.current) return;
      const nextUser = mapAuthUser(session?.user);
      const previousUserId = authUserIdRef.current;
      const nextUserId = nextUser?.id || "";
      if (event === "TOKEN_REFRESHED" && previousUserId === nextUserId) {
        setAuthUser(nextUser);
        setAuthReady(true);
        return;
      }
      setAuthUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        authUserIdRef.current = "";
        latestProjectAutoLoadedForUserRef.current = "";
        savedDebateRecoveryAttemptsRef.current = 0;
        setSavedDebates([]);
        setSavedDebatesLoadError("");
        setSavedDebatesLoadedUserId("");
        setWorkspaceBooting(false);
        return;
      }
      const identityChanged = Boolean(previousUserId && previousUserId !== nextUserId);
      const firstIdentity = !previousUserId;
      authUserIdRef.current = nextUserId;
      if (identityChanged) latestProjectAutoLoadedForUserRef.current = "";
      if (!identityChanged && !(event === "SIGNED_IN" && firstIdentity)) return;
      void refreshSavedDebates({ showLoading: false, autoLoadLatest: true });
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady || !authUser?.id || savedDebatesLoading || savedDebates.length > 0) return;
    if (savedDebatesLoadedUserId === authUser.id && !savedDebatesLoadError) return;
    const attempts = savedDebateRecoveryAttemptsRef.current;
    if (attempts >= 8 && savedDebatesLoadError) return;
    const delayMs = savedDebatesLoadError ? Math.min(5_000, 600 + attempts * 700) : 250;
    const timer = window.setTimeout(() => {
      savedDebateRecoveryAttemptsRef.current += 1;
      void refreshSavedDebates({ showLoading: true, autoLoadLatest: true });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [authReady, authUser?.id, savedDebates.length, savedDebatesLoadError, savedDebatesLoadedUserId, savedDebatesLoading]);

  useEffect(() => {
    if (!isLive || !project.startedAt || project.endedAt) return;
    const timer = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isLive, project.startedAt, project.endedAt]);

  useEffect(() => () => {
    if (reportProgressTimerRef.current) window.clearInterval(reportProgressTimerRef.current);
  }, []);

  function resetWorkspaceForProject(nextProject?: SavedDebateProject) {
    if (reportProgressTimerRef.current) window.clearInterval(reportProgressTimerRef.current);
    reportProgressTimerRef.current = null;
    setTurns([]);
    turnsRef.current = [];
    setDebate(initialDebate);
    debateRef.current = initialDebate;
    setLiveAnalysis(null);
    setResearching(false);
    setVerifying(false);
    setShowStopConfirm(false);
    setDebateReport(null);
    setReportProgress(initialReportProgress());
    setProject({
      id: nextProject?.id,
      sessionId: nextProject?.sessionId || undefined,
      status: nextProject?.status || "draft",
      title: nextProject?.title || DEFAULT_PROJECT_TITLE,
      startedAt: nextProject?.startedAt || null,
      endedAt: nextProject?.endedAt || null,
      durationMs: nextProject?.durationMs || 0,
      pausedMs: 0,
      pauseStartedAt: null,
      titleEdited: Boolean(nextProject && nextProject.title !== DEFAULT_PROJECT_TITLE)
    });
    recordingPausedRef.current = false;
    pauseStartedAtRef.current = null;
    pausedDurationMsRef.current = 0;
    stoppedDurationMsRef.current = nextProject?.durationMs || 0;
    setIsRecordingPaused(false);
    setClockTick(Date.now());
    reportRequestedRef.current = false;
    reportStartedRef.current = false;
    liveAnalysisRef.current = null;
    setLiveSessionId(nextProject?.sessionId || "");
    liveSessionIdRef.current = nextProject?.sessionId || "";
    batchQueueRef.current = [];
    batchCharsRef.current = 0;
    setStatus("Standby");
  }

  async function refreshSavedDebates(options: SavedDebateRefreshOptions = {}) {
    const { showLoading = true, autoLoadLatest = false } = options;
    if (showLoading) setSavedDebatesLoading(true);
    try {
      const response = await fetch("/api/debates", { headers: await authHeaders() });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as { debates?: SavedDebateProject[]; authenticated?: boolean };
      if (authUserIdRef.current && payload.authenticated === false) {
        throw new Error("Saved debates request reached the API without your browser session.");
      }
      const debates = orderSavedProjectsByCreation(Array.isArray(payload.debates) ? payload.debates : []);
      setSavedDebates(debates);
      setSavedDebatesLoadError("");
      setSavedDebatesLoadedUserId(authUserIdRef.current || "");
      savedDebateRecoveryAttemptsRef.current = 0;
      if (autoLoadLatest) await autoLoadLatestSavedDebate(debates);
      return debates;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Saved debates unavailable";
      setSavedDebatesLoadError(message);
      pushEvent(`Saved debates unavailable: ${message}`);
      return [];
    } finally {
      if (showLoading) setSavedDebatesLoading(false);
    }
  }

  async function autoLoadLatestSavedDebate(debates: SavedDebateProject[]) {
    const userId = authUserIdRef.current;
    if (!userId || latestProjectAutoLoadedForUserRef.current === userId) return;
    latestProjectAutoLoadedForUserRef.current = userId;
    const latest = debates[0];
    if (!latest || latest.id === projectRef.current.id) return;
    const liveSocketBusy = wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING;
    const reportBusy = Boolean(reportProgressTimerRef.current || reportRequestedRef.current || reportStartedRef.current);
    if (liveSocketBusy || projectRef.current.status === "recording" || reportBusy) return;
    await loadSavedDebate(latest.id, { silent: true });
  }

  async function loadSavedDebate(projectId: string, options: LoadSavedDebateOptions = {}) {
    if (!projectId || (!options.force && projectId === projectRef.current.id)) return;
    if (isLive) sendStopLive();
    try {
      const response = await fetch(`/api/debates/${encodeURIComponent(projectId)}`, { headers: await authHeaders() });
      if (!response.ok) throw new Error(await response.text());
      const saved = (await response.json()) as {
        project: SavedDebateProject;
        analysis?: LiveAnalysis | null;
        transcriptTurns?: TranscriptTurn[];
        report?: DebateReport | null;
      };
      const loadedTurns = Array.isArray(saved.transcriptTurns) ? saved.transcriptTurns : [];
      setTurns(loadedTurns);
      turnsRef.current = loadedTurns;
      setLiveAnalysis(saved.analysis || null);
      setDebateReport(saved.report || null);
      stoppedDurationMsRef.current = saved.project.durationMs || 0;
      setProject({
        id: saved.project.id,
        sessionId: saved.project.sessionId || undefined,
        status: saved.project.status,
        title: saved.project.title || DEFAULT_PROJECT_TITLE,
        startedAt: saved.project.startedAt,
        endedAt: saved.project.endedAt,
        durationMs: saved.project.durationMs || 0,
        pausedMs: 0,
        pauseStartedAt: null,
        titleEdited: Boolean(saved.project.title && saved.project.title !== DEFAULT_PROJECT_TITLE)
      });
      setLiveSessionId(saved.project.sessionId || "");
      liveSessionIdRef.current = saved.project.sessionId || "";
      setStatus(options.statusMessage || (saved.report ? "Saved debate loaded" : "Saved debate draft loaded"));
      if (!options.silent) pushEvent(`Loaded ${saved.project.title || DEFAULT_PROJECT_TITLE}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load saved debate");
      pushEvent(error instanceof Error ? error.message : "Could not load saved debate");
    }
  }

  // --- Import: upload a file or paste a video URL → batch pipeline → report ---
  function stopIngestPoll() {
    if (importPollRef.current) window.clearInterval(importPollRef.current);
    importPollRef.current = null;
  }

  function pollIngestJob(jobId: string) {
    stopIngestPoll();
    setImportJobId(jobId);
    importPollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/ingest/${encodeURIComponent(jobId)}`, { headers: await authHeaders() });
        if (!res.ok) throw new Error(await res.text());
        const job = (await res.json()) as { status: string; stage: string; stageLabel: string; progress: number; projectId: string | null; error: string | null; emailConfigured?: boolean };
        if (job.status === "canceled") { stopIngestPoll(); setImportJob(null); setImportJobId(null); setImportMinimized(false); return; }
        setImportJob((prev) => ({ stage: job.stage, stageLabel: job.stageLabel, progress: job.progress, error: job.error, emailConfigured: job.emailConfigured, notified: prev?.notified }));
        if (job.status === "done" && job.projectId) {
          stopIngestPoll();
          playCompletionChime();
          setStatus("Imported debate ready");
          await refreshSavedDebates({ showLoading: false });
          await loadSavedDebate(job.projectId, { force: true, statusMessage: "Imported debate ready" });
          window.setTimeout(() => { setImportJob(null); setImportJobId(null); setImportMinimized(false); }, 1600);
        } else if (job.status === "error") {
          stopIngestPoll();
          setStatus(job.error || "Import failed");
        }
      } catch (error) {
        stopIngestPoll();
        setImportJob({ stage: "error", stageLabel: "Failed", progress: 100, error: error instanceof Error ? error.message : "Import failed" });
      }
    }, 1500);
  }

  async function cancelImport() {
    const id = importJobId;
    stopIngestPoll();
    setImportJob(null);
    setImportJobId(null);
    setImportMinimized(false);
    setStatus("Import canceled");
    if (id) {
      try { await fetch(`/api/ingest/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: await authHeaders() }); } catch { /* ignore */ }
    }
  }

  async function notifyWhenImportDone() {
    setImportMinimized(true);
    const id = importJobId;
    if (!id) return;
    try {
      const res = await fetch(`/api/ingest/${encodeURIComponent(id)}/notify`, { method: "POST", headers: await authHeaders() });
      const data = res.ok ? await res.json() : { emailConfigured: false };
      setImportJob((prev) => (prev ? { ...prev, notified: true, emailConfigured: data.emailConfigured } : prev));
    } catch { /* ignore */ }
  }

  async function handleImportFile(file: File) {
    if (!file) return;
    setImportMinimized(false);
    setImportJob({ stage: "uploading", stageLabel: "Uploading file", progress: 6, error: null });
    setStatus("Uploading file");
    try {
      const res = await fetch("/api/ingest/upload", {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/octet-stream", "x-filename": encodeURIComponent(file.name) }),
        body: file
      });
      if (!res.ok) throw new Error(await res.text());
      const { jobId } = (await res.json()) as { jobId: string };
      pollIngestJob(jobId);
    } catch (error) {
      setImportJob({ stage: "error", stageLabel: "Failed", progress: 100, error: error instanceof Error ? error.message : "Upload failed" });
    }
  }

  async function handleImportUrl() {
    const url = importUrl.trim();
    if (!url) return;
    setImportMinimized(false);
    setImportJob({ stage: "fetching", stageLabel: "Fetching media", progress: 8, error: null });
    setStatus("Fetching media from URL");
    try {
      const res = await fetch("/api/ingest/url", {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ url })
      });
      if (!res.ok) throw new Error(await res.text());
      const { jobId } = (await res.json()) as { jobId: string };
      setImportUrl("");
      pollIngestJob(jobId);
    } catch (error) {
      setImportJob({ stage: "error", stageLabel: "Failed", progress: 100, error: error instanceof Error ? error.message : "Import failed" });
    }
  }

  async function saveProjectTitle(projectId: string, title: string) {
    const cleanTitle = title.trim();
    if (!projectId || !cleanTitle) return null;
    try {
      const response = await fetch(`/api/debates/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ title: cleanTitle })
      });
      if (!response.ok) throw new Error(await response.text());
      const updated = (await response.json()) as SavedDebateProject;
      setSavedDebates((current) => upsertSavedProject(current, updated));
      return updated;
    } catch (error) {
      pushEvent(error instanceof Error ? `Title save failed: ${error.message}` : "Title save failed");
      return null;
    }
  }

  async function saveSpeakerDisplayNames(projectId: string, speakerDisplayNames: SpeakerLabelMap) {
    if (!projectId) return null;
    try {
      const response = await fetch(`/api/debates/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ speakerDisplayNames })
      });
      if (!response.ok) throw new Error(await response.text());
      const updated = (await response.json()) as SavedDebateProject;
      setSavedDebates((current) => upsertSavedProject(current, updated));
      return updated;
    } catch (error) {
      pushEvent(error instanceof Error ? `Speaker label save failed: ${error.message}` : "Speaker label save failed");
      return null;
    }
  }

  function renameSpeakerLabel(speakerId: string, nextLabel: string) {
    const id = sanitizeSpeakerId(speakerId);
    if (!id) return;
    const cleaned = sanitizeSpeakerDisplayName(nextLabel);
    const currentNames = debateRef.current.speakerDisplayNames || {};
    const nextNames: SpeakerLabelMap = { ...currentNames };
    if (cleaned) nextNames[id] = cleaned;
    else delete nextNames[id];
    const applyLabels = (state: DebateState): DebateState => ({ ...state, speakerDisplayNames: nextNames });
    const nextDebate = applyLabels(debateRef.current);
    debateRef.current = nextDebate;
    setDebate(nextDebate);
    if (projectRef.current.id) {
      void saveSpeakerDisplayNames(projectRef.current.id, nextNames);
    }
  }

  async function createNewDebateProject() {
    if (isLive) {
      setStatus("Stop the current recording before creating a new debate");
      pushEvent("New debate blocked while recording");
      setShowStopConfirm(true);
      return;
    }
    if (isMicTesting) stopMicTest();
    if (isSupabaseConfigured && !authUser) {
      setStatus("Still setting up your session — try again in a moment.");
      pushEvent("Session not ready for new debate project");
      return;
    }
    setSavedDebatesLoading(true);
    try {
      const response = await fetch("/api/debates", {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ title: DEFAULT_PROJECT_TITLE })
      });
      if (!response.ok) throw new Error(await response.text());
      const created = (await response.json()) as SavedDebateProject;
      setSavedDebates((current) => upsertSavedProject(current, created));
      resetWorkspaceForProject(created);
      pushEvent("New debate project created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create debate project");
      pushEvent(error instanceof Error ? `New debate failed: ${error.message}` : "New debate failed");
    } finally {
      setSavedDebatesLoading(false);
    }
  }

  function openProjectRename(target: SavedDebateProject | ProjectMeta, isCurrent: boolean) {
    setProjectActionDialog({
      mode: "rename",
      projectId: target.id,
      title: target.title || DEFAULT_PROJECT_TITLE,
      isCurrent
    });
  }

  function openProjectDelete(target: SavedDebateProject | ProjectMeta, isCurrent: boolean) {
    setProjectActionDialog({
      mode: "delete",
      projectId: target.id,
      title: target.title || DEFAULT_PROJECT_TITLE,
      isCurrent
    });
  }

  async function renameProjectFromDialog(nextTitle: string) {
    if (!projectActionDialog || projectActionDialog.mode !== "rename") return;
    const cleanTitle = nextTitle.trim();
    if (!cleanTitle) return;
    setProjectActionBusy(true);
    try {
      if (projectActionDialog.projectId) {
        const updated = await saveProjectTitle(projectActionDialog.projectId, cleanTitle);
        if (!updated) return;
        if (projectActionDialog.isCurrent) {
          setProject((current) => ({ ...current, title: updated.title, titleEdited: true }));
        }
      } else if (projectActionDialog.isCurrent) {
        setProject((current) => ({ ...current, title: cleanTitle, titleEdited: true }));
      }
      setProjectActionDialog(null);
      pushEvent(`Renamed debate to ${cleanTitle}`);
    } finally {
      setProjectActionBusy(false);
    }
  }

  async function deleteProjectFromDialog() {
    if (!projectActionDialog || projectActionDialog.mode !== "delete") return;
    if (isLive && projectActionDialog.isCurrent) {
      setStatus("Stop the recording before deleting this debate");
      pushEvent("Delete blocked while recording");
      setProjectActionDialog(null);
      return;
    }
    setProjectActionBusy(true);
    try {
      const deletedProjectId = projectActionDialog.projectId;
      const deletedProjectIndex = deletedProjectId
        ? savedDebates.findIndex((item) => item.id === deletedProjectId)
        : -1;
      const remainingProjects = deletedProjectId
        ? savedDebates.filter((item) => item.id !== deletedProjectId)
        : savedDebates;
      if (projectActionDialog.projectId) {
        const response = await fetch(`/api/debates/${encodeURIComponent(projectActionDialog.projectId)}`, {
          method: "DELETE",
          headers: await authHeaders()
        });
        if (!response.ok) throw new Error(await response.text());
        setSavedDebates(remainingProjects);
      }
      if (projectActionDialog.isCurrent) {
        const nextProject = remainingProjects[Math.max(0, Math.min(deletedProjectIndex, remainingProjects.length - 1))] || remainingProjects[0];
        if (nextProject) {
          await loadSavedDebate(nextProject.id, { silent: true });
        } else {
          resetWorkspaceForProject();
        }
      }
      setProjectActionDialog(null);
      setStatus("Debate deleted");
      pushEvent(`Deleted debate ${projectActionDialog.title}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete debate");
      pushEvent(error instanceof Error ? `Delete failed: ${error.message}` : "Delete failed");
    } finally {
      setProjectActionBusy(false);
    }
  }

  async function handleSignIn(provider: AuthProvider) {
    setAuthWorkingProvider(provider);
    try {
      await signInWithProvider(provider);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sign-in failed");
      pushEvent(error instanceof Error ? error.message : "Sign-in failed");
      setAuthWorkingProvider("");
    }
  }

  async function handleSignOut() {
    setAuthWorkingProvider("signout");
    try {
      if (isLive) sendStopLive();
      await signOut();
      // Return to a fresh guest session so the app stays usable without re-login.
      const guestSession = await signInAnonymously().catch(() => null);
      const guestUser = mapAuthUser(guestSession?.user);
      setAuthUser(guestUser);
      authUserIdRef.current = guestUser?.id || "";
      latestProjectAutoLoadedForUserRef.current = "";
      savedDebateRecoveryAttemptsRef.current = 0;
      setSavedDebates([]);
      setSavedDebatesLoadError("");
      setSavedDebatesLoadedUserId("");
      setWorkspaceBooting(false);
      setStatus("Signed out");
      pushEvent("Signed out");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sign-out failed");
      pushEvent(error instanceof Error ? error.message : "Sign-out failed");
    } finally {
      setAuthWorkingProvider("");
    }
  }

  async function beginLive() {
    if (projectRef.current.status === "report_ready") {
      const message = "Report already generated. Create a new debate project to record again.";
      setStatus(message);
      pushEvent(message);
      return;
    }
    let stream: MediaStream | null = null;
    try {
      if (isSupabaseConfigured && !authUser) {
        throw new Error("Still setting up your session — try again in a moment.");
      }
      // iOS/Safari: an AudioContext is created SUSPENDED and only starts producing
      // audio if resume() runs inside the user gesture. Create + unlock it here on
      // the tap (before any await), then reuse it for the capture pipeline. Without
      // this the worklet never fires and no audio is captured on mobile.
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          let ctx: AudioContext;
          try { ctx = new Ctx({ sampleRate: 16000 } as AudioContextOptions); } catch { ctx = new Ctx(); }
          void ctx.resume();
          preparedAudioContextRef.current = ctx;
        }
      } catch { /* fall back to creating it later */ }
      const startedAt = Date.now();
      recordingStartedAtRef.current = startedAt;
      recordingPausedRef.current = false;
      pauseStartedAtRef.current = null;
      pausedDurationMsRef.current = 0;
      stoppedDurationMsRef.current = 0;
      setIsRecordingPaused(false);
      setClockTick(startedAt);
      setProject((current) => ({
        ...current,
        sessionId: undefined,
        status: "recording",
        title: current.title.trim() ? current.title : DEFAULT_PROJECT_TITLE,
        startedAt,
        endedAt: null,
        durationMs: 0,
        pausedMs: 0,
        pauseStartedAt: null
      }));
      pushEvent("Record button clicked");
      setStatus("Starting");
      setDebateReport(null);
      setShowStopConfirm(false);
      setReportProgress(initialReportProgress());
      reportRequestedRef.current = false;
      reportStartedRef.current = false;
      liveFatalErrorRef.current = "";
      liveAnalysisRef.current = null;
      setLiveSessionId("");
      liveSessionIdRef.current = "";
      setDiagnostics((current) => ({
        ...current,
        wsState: "starting",
        chunks: 0,
        bytes: 0,
        level: 0,
        serverRms: 0,
        transcripts: 0,
        analyses: 0,
        sttStatus: "connecting",
        sttReconnects: 0,
        sttBufferedMs: 0,
        sttDroppedMs: 0,
        sttLastCloseCode: "",
        sttSessionSeq: 0,
        audioContextSampleRate: 0,
        micSampleRate: 0,
        micChannelCount: 0,
        pcmSeconds: 0,
        byteRate: 0
      }));

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone capture is unavailable in this browser context.");
      }

      setStatus("Requesting microphone");
      pushEvent("Requesting microphone permission");
      stream = await getAudioStream();
      streamRef.current = stream;
      await refreshAudioInputs();
      pushEvent(`Microphone stream acquired: ${stream.getAudioTracks().map((track) => track.label || "audio input").join(", ")}`);
      startAudioMeter(stream);

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const accessToken = await getAccessToken();
      const liveParams = new URLSearchParams();
      if (accessToken) liveParams.set("access_token", accessToken);
      if (projectRef.current.id) liveParams.set("project_id", projectRef.current.id);
      const liveQuery = liveParams.toString() ? `?${liveParams.toString()}` : "";
      const ws = new WebSocket(`${protocol}://${window.location.host}/live${liveQuery}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      setDiagnostics((current) => ({ ...current, wsState: "connecting" }));
      pushEvent("Opening live WebSocket");

      ws.onopen = () => {
        void (async () => {
        try {
          const activeStream = streamRef.current;
          if (!activeStream) throw new Error("Microphone stream was not available.");
          await startPcmStreaming(activeStream, ws);
          setStatus("Listening live");
          setDiagnostics((current) => ({ ...current, wsState: "open", mimeType: "LINEAR16 PCM 16k" }));
          pushEvent("PCM audio stream started");
          setIsLive(true);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Audio streaming setup failed");
          pushEvent(error instanceof Error ? error.message : "Audio streaming setup failed");
          sendStopLive();
        }
        })();
      };

      ws.onerror = () => {
        setStatus("Could not connect to the live analysis server.");
        setDiagnostics((current) => ({ ...current, wsState: "error" }));
        pushEvent("WebSocket error");
        sendStopLive();
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data) as LiveEvent;
        if (data.type === "ready") setStatus(data.message);
        if (data.type === "session_ready") {
          setLiveSessionId(data.sessionId);
          liveSessionIdRef.current = data.sessionId;
          latestDebateStateSeqRef.current = 0;
          setProject((current) => ({
            ...current,
            id: data.projectId || current.id,
            sessionId: data.sessionId,
            status: "recording"
          }));
          if (data.projectId && projectRef.current.titleEdited) {
            void saveProjectTitle(data.projectId, projectRef.current.title);
          }
          if (data.projectId) window.setTimeout(() => void refreshSavedDebates({ showLoading: false }), 350);
          pushEvent(`Live session ready: ${data.sessionId.slice(0, 8)}`);
        }
        if (data.type === "audio_ack") {
          setDiagnostics((current) => ({
            ...current,
            chunks: data.chunks,
            bytes: data.bytes,
            serverRms: data.rms,
            pcmSeconds: data.pcmSeconds ?? current.pcmSeconds,
            byteRate: data.byteRate ?? current.byteRate
          }));
          if (data.chunks === 1) pushEvent("Server received first audio chunk");
          if (data.chunks === 10 && data.rms < 0.005) pushEvent("Server is receiving near-silence. Check mic input or speak louder.");
        }
        if (data.type === "error") {
          liveFatalErrorRef.current = data.message;
          setStatus(data.message);
          pushEvent(data.message);
        }
        if (data.type === "diarization_status") {
          setDiagnostics((current) => ({ ...current, diarization: data.status }));
          pushEvent(data.message);
        }
        if (data.type === "speechmatics_stats") {
          pushEvent(`Speechmatics packaged ${data.stats.emittedFinalTurns ?? 0}/${data.stats.addTranscriptEvents ?? 0} final events`);
        }
        if (data.type === "stt_stats") {
          pushEvent(`Live STT packaged ${data.stats.emittedFinalTurns ?? 0}/${data.stats.addTranscriptEvents ?? 0} final events`);
        }
        if (data.type === "stt_status") {
          setDiagnostics((current) => ({
            ...current,
            sttStatus: data.status,
            sttReconnects: Math.max(current.sttReconnects, data.status === "reconnecting" || data.status === "degraded" ? data.attempt : current.sttReconnects),
            sttBufferedMs: data.bufferedMs,
            sttDroppedMs: data.droppedMs,
            sttLastCloseCode: data.lastCloseCode ? String(data.lastCloseCode) : current.sttLastCloseCode,
            sttSessionSeq: data.sessionSeq
          }));
          setStatus(data.message);
          if (data.status === "stopped" && diagnostics.transcripts === 0) liveFatalErrorRef.current = data.message;
          pushEvent(data.message);
        }
        if (data.type === "analysis_status") {
          setResearching(data.status === "queued" || data.status === "running");
          setVerifying(data.status === "verifying");
          if (data.status !== "idle") setStatus(data.message);
          pushEvent(data.message);
        }
        if (data.type === "debate_state") {
          if (data.seq && data.seq < latestDebateStateSeqRef.current) {
            return;
          }
          latestDebateStateSeqRef.current = Math.max(latestDebateStateSeqRef.current, data.seq || 0);
          if (data.analysis) setLiveAnalysis(data.analysis);
          setDiagnostics((current) => ({ ...current, analyses: current.analyses + (data.source === "analysis" ? 1 : 0) }));
          lastAnalysisAtRef.current = Date.now();
          if (data.source === "analysis" || data.source === "score") setResearching(false);
          if (data.source === "verification") setVerifying(false);
          pushEvent(`Debate desk updated from ${data.source}`);
        }
        if (data.type === "transcript") {
          pushEvent(`${data.turn.isFinal ? "Final" : "Interim"} transcript from ${data.turn.speakerId}`);
          setDiagnostics((current) => ({ ...current, transcripts: current.transcripts + 1 }));
          setTurns((current) => {
            const next = upsertTurn(current, data.turn).slice(-120);
            turnsRef.current = next;
            return next;
          });
          if (data.turn.isFinal) {
            registerSpeakerFromTurn(data.turn);
            if (!shouldAnalyzeTurn(data.turn)) {
              pushEvent("Final transcript was too short to analyze");
            } else {
              pushEvent("Backend queued final transcript for debate analysis");
            }
          }
        }
      };

      ws.onclose = () => {
        cleanupLive();
        setStatus(liveFatalErrorRef.current || "Stopped");
        pushEvent("Live stream closed");
        if (reportRequestedRef.current && !reportStartedRef.current) {
          reportStartedRef.current = true;
          void generateDebateReport(liveSessionIdRef.current);
        }
      };
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (preparedAudioContextRef.current) { void preparedAudioContextRef.current.close().catch(() => {}); preparedAudioContextRef.current = null; }
      recordingStartedAtRef.current = null;
      setProject((current) => ({
        ...current,
        startedAt: null,
        endedAt: null,
        durationMs: 0,
        pausedMs: 0,
        pauseStartedAt: null
      }));
      setStatus(error instanceof Error ? error.message : "Microphone setup failed");
      pushEvent(error instanceof Error ? error.message : "Microphone setup failed");
      setIsLive(false);
    }
  }

  async function startFreshDebate() {
    await createNewDebateProject();
  }

  async function beginMicTest() {
    if (isLive) return;
    try {
      pushEvent("Mic test clicked");
      setStatus("Testing microphone");
      const stream = await getAudioStream();
      streamRef.current = stream;
      await refreshAudioInputs();
      startAudioMeter(stream);
      setIsMicTesting(true);
      setStatus("Mic test active");
      pushEvent(`Mic test stream acquired: ${stream.getAudioTracks().map((track) => track.label || "audio input").join(", ")}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Mic test failed");
      pushEvent(error instanceof Error ? error.message : "Mic test failed");
    }
  }

  function requestStopLive() {
    if (!isLive) return;
    setShowStopConfirm(true);
  }

  async function beginLiveFromControl() {
    if (isLive) {
      requestStopLive();
      return;
    }
    if (projectRef.current.status === "report_ready") {
      const message = "Report already generated. Create a new debate project to record again.";
      setStatus(message);
      pushEvent(message);
      return;
    }
    if (isMicTesting) {
      stopMicTest();
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    await beginLive();
  }

  function cancelStopLive() {
    setShowStopConfirm(false);
  }

  function pauseLiveRecording() {
    if (!isLive || isRecordingPaused) return;
    const pausedAt = Date.now();
    flushPcmQueue(wsRef.current);
    recordingPausedRef.current = true;
    pauseStartedAtRef.current = pausedAt;
    setIsRecordingPaused(true);
    setClockTick(pausedAt);
    setProject((current) => ({
      ...current,
      pauseStartedAt: current.pauseStartedAt ?? pausedAt
    }));
    sendLiveControl("pause", getActiveProjectDurationMs({ ...project, pauseStartedAt: pausedAt }, pausedAt));
    setStatus("Paused");
    pushEvent("Recording paused");
  }

  function resumeLiveRecording() {
    if (!isLive || !isRecordingPaused) return;
    const resumedAt = Date.now();
    const pausedAt = pauseStartedAtRef.current;
    const extraPausedMs = pausedAt ? Math.max(0, resumedAt - pausedAt) : 0;
    pausedDurationMsRef.current += extraPausedMs;
    pauseStartedAtRef.current = null;
    recordingPausedRef.current = false;
    setIsRecordingPaused(false);
    setClockTick(resumedAt);
    setProject((current) => ({
      ...current,
      pausedMs: current.pausedMs + (current.pauseStartedAt ? Math.max(0, resumedAt - current.pauseStartedAt) : extraPausedMs),
      pauseStartedAt: null
    }));
    sendLiveControl("resume", getActiveProjectDurationMs({ ...project, pausedMs: project.pausedMs + extraPausedMs, pauseStartedAt: null }, resumedAt));
    setStatus("Listening live");
    pushEvent("Recording resumed");
  }

  function togglePauseLiveRecording() {
    if (isRecordingPaused) {
      resumeLiveRecording();
    } else {
      pauseLiveRecording();
    }
  }

  function confirmStopAndGenerateReport() {
    if (!isLive) return;
    const stoppedAt = Date.now();
    const pausedAt = pauseStartedAtRef.current;
    const extraPausedMs = pausedAt ? Math.max(0, stoppedAt - pausedAt) : 0;
    if (extraPausedMs) pausedDurationMsRef.current += extraPausedMs;
    const stoppedProject = freezeProjectAtStop(projectRef.current, stoppedAt, extraPausedMs);
    stoppedDurationMsRef.current = stoppedProject.durationMs || 0;
    projectRef.current = stoppedProject;
    pauseStartedAtRef.current = null;
    recordingPausedRef.current = false;
    setIsRecordingPaused(false);
    setShowStopConfirm(false);
    setClockTick(stoppedAt);
    setProject((current) => freezeProjectAtStop(current, stoppedAt, extraPausedMs));
    reportRequestedRef.current = true;
    reportStartedRef.current = false;
    startReportProgress();
    sendStopLive(stoppedProject.durationMs || 0);
    window.setTimeout(() => {
      if (reportRequestedRef.current && !reportStartedRef.current) {
        reportStartedRef.current = true;
        void generateDebateReport(liveSessionIdRef.current);
      }
    }, 4500);
  }

  function stopRecordingWithoutReport() {
    if (!isLive) return;
    const stoppedAt = Date.now();
    const pausedAt = pauseStartedAtRef.current;
    const extraPausedMs = pausedAt ? Math.max(0, stoppedAt - pausedAt) : 0;
    if (extraPausedMs) pausedDurationMsRef.current += extraPausedMs;
    const stoppedProject = freezeProjectAtStop(projectRef.current, stoppedAt, extraPausedMs);
    stoppedDurationMsRef.current = stoppedProject.durationMs || 0;
    projectRef.current = stoppedProject;
    pauseStartedAtRef.current = null;
    recordingPausedRef.current = false;
    setIsRecordingPaused(false);
    setShowStopConfirm(false);
    setClockTick(stoppedAt);
    setProject((current) => freezeProjectAtStop(current, stoppedAt, extraPausedMs));
    reportRequestedRef.current = false;
    reportStartedRef.current = false;
    setReportProgress(initialReportProgress());
    sendStopLive(stoppedProject.durationMs || 0);
    window.setTimeout(() => void refreshSavedDebates({ showLoading: false }), 1200);
  }

  function sendStopLive(durationMs?: number) {
    stopPcmStreaming();
    recordingPausedRef.current = false;
    pauseStartedAtRef.current = null;
    setIsRecordingPaused(false);
    const elapsedMs = Math.max(0, Math.round(Number(durationMs || stoppedDurationMsRef.current || getActiveProjectDurationMs(projectRef.current, Date.now()) || 0)));
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop", elapsedMs }));
      window.setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }, 3000);
    } else {
      ws?.close();
    }
    setStatus("Stopping");
    setIsLive(false);
  }

  function sendLiveControl(type: "pause" | "resume", elapsedMs: number) {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type, elapsedMs: Math.max(0, Math.round(elapsedMs)) }));
  }

  function startReportProgress() {
    if (reportProgressTimerRef.current) window.clearInterval(reportProgressTimerRef.current);
    setReportProgress({
      active: true,
      value: 8,
      stage: REPORT_PROGRESS_STAGES[0].stage,
      note: REPORT_PROGRESS_STAGES[0].note,
      tick: 0
    });
    reportProgressTimerRef.current = window.setInterval(() => {
      setReportProgress((current) => {
        if (!current.active) return current;
        const nextValue = Math.min(90, current.value + (current.value < 55 ? 5 : current.value < 75 ? 3 : 1));
        const stageIndex = Math.min(
          REPORT_PROGRESS_STAGES.length - 1,
          Math.floor((nextValue / 100) * REPORT_PROGRESS_STAGES.length)
        );
        const nextTick = current.tick + 1;
        const stage = REPORT_PROGRESS_STAGES[stageIndex];
        return {
          active: true,
          value: nextValue,
          stage: stage.stage,
          note: stage.note,
          tick: nextTick
        };
      });
    }, REPORT_PROGRESS_INTERVAL_MS);
  }

  function finishReportProgress() {
    if (reportProgressTimerRef.current) window.clearInterval(reportProgressTimerRef.current);
    reportProgressTimerRef.current = null;
    setReportProgress(initialReportProgress());
  }

  async function generateDebateReport(sessionId: string) {
    setStatus("Generating debate highlights");
    pushEvent("Generating final report");
    try {
      const reportDurationMs = Math.max(0, Math.round(stoppedDurationMsRef.current || getActiveProjectDurationMs(projectRef.current, Date.now()) || 0));
      const response = await fetch("/api/debate-report", {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          sessionId,
          projectId: projectRef.current.id,
          analysis: liveAnalysisRef.current,
          transcriptTurns: turnsRef.current,
          durationMs: reportDurationMs
        })
      });
      if (!response.ok) throw new Error(await response.text());
      const report = (await response.json()) as DebateReport;
      setDebateReport(report);
      const currentProject = projectRef.current;
      const nextTitle = currentProject.titleEdited ? currentProject.title : deriveProjectTitleFromReport(report, debateRef.current);
      setProject((current) => ({
        ...current,
        status: "report_ready",
        title: nextTitle,
        endedAt: current.endedAt ?? Date.now(),
        durationMs: reportDurationMs || getActiveProjectDurationMs(current, Date.now())
      }));
      finishReportProgress();
      if (currentProject.id) {
        void saveProjectTitle(currentProject.id, nextTitle);
        await loadSavedDebate(currentProject.id, {
          silent: true,
          force: true,
          statusMessage: "Debate highlights ready"
        });
      }
      void refreshSavedDebates({ showLoading: false });
      setStatus("Debate highlights ready");
      pushEvent("Final report ready");
      window.setTimeout(() => {
        debateReportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 180);
    } catch (error) {
      if (reportProgressTimerRef.current) window.clearInterval(reportProgressTimerRef.current);
      reportProgressTimerRef.current = null;
      setReportProgress(initialReportProgress());
      setStatus(error instanceof Error ? error.message : "Debate highlights failed");
      pushEvent(error instanceof Error ? error.message : "Debate highlights failed");
    }
  }

  // Manual report generation for a loaded/saved debate whose report failed or was
  // skipped. Reuses the exact same progress overlay + backend report builder as the
  // stop-and-generate flow; the server rebuilds from the session's stored payload.
  async function handleGenerateReportClick() {
    if (reportProgress.active || reportProgressTimerRef.current) return;
    if (reportAlreadyExists) {
      setStatus("This debate already has a report");
      return;
    }
    if (!hasAssignedSpeakers) {
      setStatus("Assign sides and speakers before generating a report");
      return;
    }
    const sessionId = liveSessionId || liveSessionIdRef.current;
    if (!sessionId) {
      setStatus("No saved debate session to build a report from");
      pushEvent("Generate report: no session available");
      return;
    }
    setShareMenuOpen(false);
    startReportProgress();
    await generateDebateReport(sessionId);
  }

  // Brief, visible confirmation toast (auto-dismisses).
  function showToast(message: string) {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 2800);
  }

  // Create (or fetch) a public share link for the current project and copy it.
  async function copyShareLink() {
    const projectId = projectRef.current.id;
    if (!projectId) {
      setStatus("Open a saved debate before sharing it.");
      return;
    }
    setShareMenuOpen(false);
    setStatus("Creating share link…");
    try {
      const response = await fetch(`/api/debates/${projectId}/share`, { method: "POST", headers: await authHeaders() });
      if (!response.ok) throw new Error(await response.text());
      const { shareId } = (await response.json()) as { shareId: string };
      const url = `${window.location.origin}/?share=${encodeURIComponent(shareId)}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast("Share link copied to clipboard");
        setStatus("Share link copied to clipboard");
      } catch {
        showToast("Share link ready — copy it from the status bar");
        setStatus(`Share link: ${url}`);
      }
      pushEvent("Created share link");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create a share link");
      pushEvent("Share link creation failed");
    }
  }

  // Open a shared link: import a copy into the current account (guest or
  // permanent) so it lands in the project list, then load it. Idempotent server-side.
  async function openSharedFromUrl(shareId: string) {
    setStatus("Opening shared debate…");
    pushEvent("Opening shared debate");
    try {
      const response = await fetch(`/api/shared/${encodeURIComponent(shareId)}/import`, { method: "POST", headers: await authHeaders() });
      if (!response.ok) throw new Error(await response.text());
      const { projectId } = (await response.json()) as { projectId: string };
      try {
        const u = new URL(window.location.href);
        u.searchParams.delete("share");
        window.history.replaceState({}, "", u.pathname + (u.search || "") + (u.hash || ""));
      } catch { /* ignore */ }
      await refreshSavedDebates({ showLoading: false });
      await loadSavedDebate(projectId, { silent: true, force: true, statusMessage: "Shared debate loaded" });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open the shared debate");
      pushEvent("Open shared debate failed");
    }
  }

  function stopMicTest() {
    cleanupLive();
    setIsMicTesting(false);
    setStatus("Mic test stopped");
    pushEvent("Mic test stopped");
  }

  function cleanupLive() {
    stopPcmStreaming();
    if (batchTimerRef.current) window.clearTimeout(batchTimerRef.current);
    batchTimerRef.current = null;
    batchQueueRef.current = [];
    batchCharsRef.current = 0;
    wsRef.current = null;
    recordingStartedAtRef.current = null;
    recordingPausedRef.current = false;
    pauseStartedAtRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopAudioMeter();
    setDiagnostics((current) => ({ ...current, wsState: "closed", level: 0, sttStatus: "stopped", sttBufferedMs: 0 }));
    setIsLive(false);
    setIsMicTesting(false);
    setIsRecordingPaused(false);
  }

  function pushEvent(message: string) {
    setDiagnostics((current) => ({
      ...current,
      events: [{ id: crypto.randomUUID(), text: `${new Date().toLocaleTimeString()} ${message}` }, ...current.events].slice(0, 6)
    }));
  }

  async function refreshAudioInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    setAudioInputs(inputs);
    if (selectedDeviceId && !inputs.some((device) => device.deviceId === selectedDeviceId)) {
      setSelectedDeviceId("");
    }
  }

  async function getAudioStream() {
    const profiles = [
      {
        name: "raw microphone",
        constraints: createAudioConstraints()
      }
    ];

    let lastError: unknown = null;
    for (const profile of profiles) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: profile.constraints });
        pushEvent(`Microphone profile: ${profile.name}`);
        return stream;
      } catch (error) {
        lastError = error;
        pushEvent(`${profile.name} microphone profile unavailable`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Microphone capture failed.");
  }

  function createAudioConstraints(): MediaTrackConstraints {
    const constraints: MediaTrackConstraints & Record<string, unknown> = {
      sampleRate: { ideal: 16000 },
      sampleSize: { ideal: 16 },
      echoCancellation: { ideal: false },
      latency: { ideal: 0 },
      channelCount: { ideal: 1 },
      autoGainControl: { ideal: false },
      noiseSuppression: { ideal: false }
    };
    if (selectedDeviceId) {
      constraints.deviceId = { exact: selectedDeviceId };
    }
    return constraints;
  }

  function startAudioMeter(stream: MediaStream) {
    stopAudioMeter();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      pushEvent("Audio meter unavailable in this browser");
      return;
    }

    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    meterContextRef.current = context;
    const samples = new Uint8Array(analyser.frequencyBinCount);

    const update = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const centered = sample - 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / samples.length);
      setDiagnostics((current) => ({ ...current, level: Math.min(100, Math.round(rms * 4)) }));
      animationRef.current = window.requestAnimationFrame(update);
    };
    update();
  }

  async function startPcmStreaming(stream: MediaStream, ws: WebSocket) {
    stopPcmStreaming();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("AudioContext is unavailable in this browser.");

    // Prefer the context unlocked during the user gesture (see beginLive); only
    // create a fresh one if that wasn't available.
    let context = preparedAudioContextRef.current;
    preparedAudioContextRef.current = null;
    if (!context) {
      try {
        context = new AudioContextClass({ sampleRate: 16000 } as AudioContextOptions);
      } catch {
        context = new AudioContextClass();
      }
    }
    // Make sure it's actually running before wiring the worklet (iOS starts suspended).
    if (context.state !== "running") {
      await context.resume().catch(() => { /* may need a gesture; meter/worklet still attempt */ });
    }
    await context.audioWorklet.addModule("/pcm-worklet.js?v=speechmatics-4096-20260527");
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "pcm-capture-processor", {
      processorOptions: { channelMode: liveAudioInputChannelMode }
    });
    const silence = context.createGain();
    silence.gain.value = 0;

    sendAudioSettings(stream, context, ws);
    window.setTimeout(() => sendAudioSettings(stream, context, ws), 250);

    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer | Record<string, unknown>>) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!(event.data instanceof ArrayBuffer)) {
        ws.send(JSON.stringify(event.data));
        return;
      }
      if (recordingPausedRef.current) return;
      queuePcmChunk(event.data, ws);
    };

    source.connect(worklet);
    worklet.connect(silence);
    silence.connect(context.destination);
    streamContextRef.current = context;
    sourceRef.current = source;
    workletRef.current = worklet;
    silenceRef.current = silence;
  }

  function stopPcmStreaming() {
    flushPcmQueue(wsRef.current);
    workletRef.current?.disconnect();
    sourceRef.current?.disconnect();
    silenceRef.current?.disconnect();
    void streamContextRef.current?.close();
    workletRef.current = null;
    sourceRef.current = null;
    silenceRef.current = null;
    streamContextRef.current = null;
    pcmQueueRef.current = [];
    pcmQueueBytesRef.current = 0;
  }

  const liveRealtimeChunkBytes = 4096;

  function queuePcmChunk(chunk: ArrayBuffer, ws: WebSocket) {
    pcmQueueRef.current.push(chunk);
    pcmQueueBytesRef.current += chunk.byteLength;
    if (pcmQueueBytesRef.current >= liveRealtimeChunkBytes) {
      flushPcmQueue(ws);
    }
  }

  function flushPcmQueue(ws: WebSocket | null) {
    if (!ws || ws.readyState !== WebSocket.OPEN || pcmQueueBytesRef.current === 0) return;

    const output = new Uint8Array(pcmQueueBytesRef.current);
    let offset = 0;
    for (const chunk of pcmQueueRef.current) {
      output.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    pcmQueueRef.current = [];
    pcmQueueBytesRef.current = 0;
    setDiagnostics((current) => ({
      ...current,
      chunks: current.chunks + 1,
      bytes: current.bytes + output.byteLength
    }));
    ws.send(output.buffer);
  }

  function sendAudioSettings(stream: MediaStream, context: AudioContext, ws: WebSocket) {
    const track = stream.getAudioTracks()[0];
    const settings = sanitizeTrackSettings(track?.getSettings?.());
    const constraints = sanitizeTrackSettings(track?.getConstraints?.());
    const capabilities = sanitizeTrackCapabilities(track?.getCapabilities?.());
    const supportedConstraints = sanitizeTrackCapabilities(navigator.mediaDevices?.getSupportedConstraints?.());
    const payload = {
      type: "audio_settings",
      audioContextSampleRate: context.sampleRate,
      outputSampleRate: 16000,
      sampleFormat: "pcm_s16le",
      channelCount: 1,
      inputChannelMode: liveAudioInputChannelMode,
      chunkTargetBytes: liveRealtimeChunkBytes,
      expectedBytesPerSecond: 32000,
      trackLabel: track?.label || "",
      trackSettings: settings,
      trackConstraints: constraints,
      trackCapabilities: capabilities,
      supportedConstraints
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    const micSampleRate = Number(settings.sampleRate || 0);
    const micChannelCount = Number(settings.channelCount || 0);
    setDiagnostics((current) => ({
      ...current,
      audioContextSampleRate: context.sampleRate,
      micSampleRate,
      micChannelCount
    }));
    pushEvent(`Audio path ${context.sampleRate} Hz -> 16 kHz PCM`);
  }

  function stopAudioMeter() {
    if (animationRef.current) window.cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    void meterContextRef.current?.close();
    meterContextRef.current = null;
  }

  function registerSpeakerFromTurn(turn: TranscriptTurn) {
    setDebate((current) => {
      const existing = current.speakers.find((speaker) => speaker.speakerId === turn.speakerId);
      const nextSpeaker: SpeakerProfile = {
        speakerId: turn.speakerId,
        sideId: existing?.sideId,
        sideConfidence: existing?.sideConfidence ?? 0,
        lastSpokenAt: Math.max(existing?.lastSpokenAt ?? 0, turn.at),
        turnIds: Array.from(new Set([...(existing?.turnIds || []), turn.id])),
        assignmentReason: existing?.assignmentReason || "Awaiting side assignment."
      };
      const speakers = existing
        ? current.speakers.map((speaker) => (speaker.speakerId === turn.speakerId ? nextSpeaker : speaker))
        : current.speakers.concat(nextSpeaker);
      const next = { ...current, speakers };
      debateRef.current = next;
      return next;
    });
  }

  async function analyzeBatch(batch: TranscriptTurn[]) {
    if (batch.length === 0) return;
    pushEvent(`Analyzing ${batch.length} turn batch`);
    setResearching(true);
    const existingPointIds = new Set(debateRef.current.points.map((point) => point.id));
    try {
      const response = await fetch("/api/analyze-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newTurns: batch,
          transcriptWindow: turnsRef.current.slice(-24),
          currentDebate: debateRef.current,
          recordingStartedAt: recordingStartedAtRef.current,
          options: {
            skipVerification: true,
            includeTimings: true
          }
        })
      });
      if (!response.ok) throw new Error(await response.text());
      const next = (await response.json()) as TimedDebateState;
      const merged = mergeBatchDebate(debateRef.current, next);
      setDebate(merged);
      debateRef.current = merged;
      void rescoreDebate(merged);
      setDiagnostics((current) => ({ ...current, analyses: current.analyses + 1 }));
      lastAnalysisAtRef.current = Date.now();
      pushEvent(`Point selection: ${merged.points.length} point(s) in ${next._timings?.selectionMs ?? "?"} ms`);
      const verificationCandidates = merged.points
        .filter((point) => shouldRequestVerification(point, existingPointIds) && !verificationInFlightRef.current.has(point.id));
      const pointsToVerify = pickVerificationCandidates(verificationCandidates, verificationInFlightRef.current);
      if (pointsToVerify.length) {
        void verifyPoints(pointsToVerify, merged);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Analysis failed");
      pushEvent(error instanceof Error ? error.message : "Analysis failed");
    } finally {
      setResearching(false);
    }
  }

  async function verifyPoints(points: DebatePoint[], debateSnapshot: DebateState) {
    for (const point of points) verificationInFlightRef.current.add(point.id);
    pushEvent(`Fact-checking ${points.length} point(s) in background`);
    setVerifying(true);
    try {
      const response = await fetch("/api/verify-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          points,
          transcriptWindow: turnsRef.current.slice(-24),
          currentDebate: debateSnapshot,
          recordingStartedAt: recordingStartedAtRef.current,
          options: {
            includeTimings: true
          }
        })
      });
      if (!response.ok) throw new Error(await response.text());
      const verified = (await response.json()) as TimedDebateState;
      const merged = mergeVerifiedDebate(debateRef.current, verified);
      setDebate(merged);
      debateRef.current = merged;
      void rescoreDebate(merged);
      pushEvent(`Fact check updated in ${verified._timings?.verificationMs ?? "?"} ms`);
    } catch (error) {
      pushEvent(error instanceof Error ? error.message : "Fact check failed");
    } finally {
      for (const point of points) verificationInFlightRef.current.delete(point.id);
      setVerifying(verificationInFlightRef.current.size > 0);
    }
  }

  async function rescoreDebate(debateSnapshot: DebateState) {
    try {
      const response = await fetch("/api/rescore-debate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentDebate: debateSnapshot, recordingStartedAt: recordingStartedAtRef.current })
      });
      if (!response.ok) throw new Error(await response.text());
      const rescored = (await response.json()) as DebateState;
      setDebate((current) => {
        const next = mergeRescoredDebate(current, rescored);
        debateRef.current = next;
        return next;
      });
    } catch (error) {
      pushEvent(error instanceof Error ? error.message : "Score refresh failed");
    }
  }

  function queueBatchAnalysis(turn: TranscriptTurn) {
    batchQueueRef.current = batchQueueRef.current.concat(turn);
    batchCharsRef.current += turn.text.length;
    const elapsed = Date.now() - lastAnalysisAtRef.current;
    const speakerCount = new Set(batchQueueRef.current.map((item) => item.speakerId)).size;
    const speakerTurnCounts = countTurnsBySpeaker(batchQueueRef.current);
    const speakersWithExchangeDepth = [...speakerTurnCounts.values()].filter((count) => count >= BATCH_EXCHANGE_TURNS_PER_SPEAKER).length;
    const dueByExchange = speakerCount >= 2
      && batchQueueRef.current.length >= BATCH_EXCHANGE_TURN_TRIGGER
      && speakersWithExchangeDepth >= 2;
    const dueByMonologue = speakerCount === 1 && batchQueueRef.current.length >= BATCH_MONOLOGUE_TURN_TRIGGER;
    const dueByChars = batchCharsRef.current >= BATCH_CHAR_TRIGGER;
    const dueByTime = elapsed >= BATCH_TIME_TRIGGER_MS;
    scheduleBatchAnalysis(
      dueByExchange || dueByMonologue || dueByChars || dueByTime
        ? BATCH_FAST_DEBOUNCE_MS
        : Math.max(BATCH_IDLE_DEBOUNCE_MS, BATCH_TIME_TRIGGER_MS - elapsed)
    );
  }

  function scheduleBatchAnalysis(delayMs: number) {
    if (batchTimerRef.current) window.clearTimeout(batchTimerRef.current);
    batchTimerRef.current = window.setTimeout(() => {
      const batch = batchQueueRef.current;
      batchQueueRef.current = [];
      batchCharsRef.current = 0;
      batchTimerRef.current = null;
      if (batch.length === 0) return;
      analysisQueueRef.current = analysisQueueRef.current
        .catch(() => undefined)
        .then(() => analyzeBatch(batch));
    }, delayMs);
  }

  function queueAnalysis(turn: TranscriptTurn) {
    analysisQueueRef.current = analysisQueueRef.current
      .catch(() => undefined)
      .then(() => analyzeBatch([turn]));
  }

  function downloadFullTranscriptTxt() {
    setShareMenuOpen(false);
    try {
      exportTranscriptTxt({ project, debate: presentedDebate, turns: presentedTurns, speakerLabel });
      pushEvent("Downloaded full transcript TXT");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not download transcript";
      setStatus(message);
      pushEvent(message);
    }
  }

  // Generate a proper, text-based PDF document from the report data — every
  // artifact written out (debate points, claims, inconsistencies, speakers,
  // cases, turning points), with the score chart and speaker chart drawn NATIVELY
  // as vectors (same data as on screen). No screenshots, so nothing reflows or
  // gets clipped, the file stays small, and text is selectable.
  async function downloadPagePdf() {
    if (isExportingReportPdf) return;
    setShareMenuOpen(false);
    setIsExportingReportPdf(true);
    setStatus("Building PDF…");
    pushEvent("Building report PDF");
    try {
      const { jsPDF } = await import("jspdf");
      const report = debateReport;
      const analysis = liveAnalysis;

      // Brand logo (dark wordmark on the light page) for the header + faint watermark.
      const LOGO_AR = 1920 / 600; // width / height
      const logoData = await (async () => {
        try {
          const res = await fetch(encodeURI(`${import.meta.env.BASE_URL}Debatly Logo Light Mode.png`));
          if (!res.ok) return null;
          const blob = await res.blob();
          return await new Promise<string | null>((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
            fr.onerror = () => resolve(null);
            fr.readAsDataURL(blob);
          });
        } catch { return null; }
      })();

      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const M = 48;
      const W = pageW - M * 2;
      // Light, print-friendly palette.
      const ink: [number, number, number] = [28, 25, 23];
      const muted: [number, number, number] = [120, 113, 108];
      const hair: [number, number, number] = [224, 221, 217];
      const blue: [number, number, number] = [20, 127, 163];
      const red: [number, number, number] = [182, 74, 70];
      const green: [number, number, number] = [22, 131, 71];
      const danger: [number, number, number] = [180, 35, 24];
      const amber: [number, number, number] = [146, 113, 36];
      let y = M;

      const clean = (s: unknown) => String(s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
      const col = (c: [number, number, number]) => pdf.setTextColor(c[0], c[1], c[2]);
      const ensure = (h: number) => { if (y + h > pageH - M) { pdf.addPage(); y = M; } };
      const para = (textValue: string, opts: { size?: number; style?: "normal" | "bold" | "italic"; color?: [number, number, number]; indent?: number; lh?: number; gapAfter?: number } = {}) => {
        const { size = 10, style = "normal", color = ink, indent = 0, lh = 1.4, gapAfter = 0 } = opts;
        const t = clean(textValue);
        if (!t) return;
        pdf.setFont("helvetica", style); pdf.setFontSize(size); col(color);
        for (const ln of pdf.splitTextToSize(t, W - indent) as string[]) {
          ensure(size * lh);
          pdf.text(ln, M + indent, y + size * 0.92);
          y += size * lh;
        }
        if (gapAfter) y += gapAfter;
      };
      const heading = (textValue: string) => {
        y += 16; ensure(30);
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(13.5); col(ink);
        pdf.text(clean(textValue).toUpperCase(), M, y + 10); y += 17;
        pdf.setDrawColor(hair[0], hair[1], hair[2]); pdf.setLineWidth(0.6); pdf.line(M, y, pageW - M, y); y += 12;
      };
      const sideTag = (textValue: string, c: [number, number, number]) => {
        ensure(14); pdf.setFont("helvetica", "bold"); pdf.setFontSize(8.5); col(c);
        pdf.text(clean(textValue).toUpperCase(), M, y + 8); y += 15;
      };
      const gap = (h: number) => { y += h; };

      const tagMeta: Record<string, { label: string; color: [number, number, number] }> = {
        verified: { label: "Verified", color: green },
        contradicted: { label: "False", color: danger },
        misleading: { label: "Misleading", color: amber },
        no_clear_source: { label: "Unverified", color: muted },
        done: { label: "Checked", color: muted }
      };
      const claimVerdict = (c: { tag?: string | null; status?: string }) => c.tag || (["verified", "contradicted", "misleading", "no_clear_source"].includes(String(c.status)) ? String(c.status) : "no_clear_source");
      const clock = (minute: number) => { const t = Math.max(0, Math.round(minute * 60)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

      // ---- Native vector charts -------------------------------------------------
      const drawLineChart = (points: { minute: number; blue: number; red: number }[], startMin: number, maxMin: number, entries: { speakerId: string; side: string | null; minute: number }[]) => {
        if (points.length < 2) return;
        const h = 180; ensure(h + 34);
        const gx = M + 30, gxr = pageW - M, top = y + 8, bottom = y + h - 18;
        const plotW = gxr - gx, plotH = bottom - top;
        const scores = points.flatMap((p) => [p.blue, p.red]).concat([0]);
        let lo = Math.min(...scores), hi = Math.max(...scores); if (lo === hi) { lo -= 1; hi += 1; }
        const padY = (hi - lo) * 0.12; lo -= padY; hi += padY;
        const span = maxMin - startMin || 1;
        const xOf = (m: number) => gx + ((m - startMin) / span) * plotW;
        const yOf = (v: number) => bottom - ((v - lo) / (hi - lo)) * plotH;
        pdf.setFontSize(7.5); col(muted);
        pdf.setDrawColor(hair[0], hair[1], hair[2]); pdf.setLineWidth(0.4);
        for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * (i / 4); const yy = yOf(v); pdf.line(gx, yy, gxr, yy); pdf.text(String(Math.round(v)), M - 2, yy + 2.5); }
        if (lo < 0 && hi > 0) { pdf.setDrawColor(170, 165, 160); pdf.setLineWidth(0.7); pdf.line(gx, yOf(0), gxr, yOf(0)); }
        // Speaker-entry markers: numbered dotted vertical lines, keyed to the strip
        // below. Speakers who were already talking when the gate opened (minute below
        // the debate start) are clamped to the start so blue/opening speakers still
        // show up rather than being dropped off the left edge.
        const marks = (entries || [])
          .filter((e) => e.minute <= maxMin + 0.05)
          .map((e) => ({ ...e, lineMinute: Math.min(maxMin, Math.max(startMin, e.minute)) }));
        pdf.setLineDashPattern([1.4, 2.6], 0);
        marks.forEach((e, i) => {
          const c = e.side === "red" ? red : e.side === "blue" ? blue : muted;
          const mx = xOf(e.lineMinute);
          pdf.setDrawColor(c[0], c[1], c[2]); pdf.setLineWidth(0.6); pdf.line(mx, top, mx, bottom);
          pdf.setFontSize(6.5); col(c); pdf.text(String(i + 1), mx, top - 2, { align: "center" });
        });
        pdf.setLineDashPattern([], 0);
        col(muted); pdf.setFontSize(7.5);
        pdf.text(`${Math.round(startMin)}m`, gx, bottom + 11);
        pdf.text(`${Math.round(maxMin)}m`, gxr, bottom + 11, { align: "right" });
        const series = (key: "blue" | "red", c: [number, number, number]) => {
          pdf.setDrawColor(c[0], c[1], c[2]); pdf.setLineWidth(1.5);
          for (let i = 1; i < points.length; i++) pdf.line(xOf(points[i - 1].minute), yOf(points[i - 1][key]), xOf(points[i].minute), yOf(points[i][key]));
        };
        series("blue", blue); series("red", red);
        y = bottom + 22;
        pdf.setFontSize(8); col(ink);
        pdf.setFillColor(blue[0], blue[1], blue[2]); pdf.rect(M, y - 4.5, 12, 3.5, "F"); pdf.text("Blue side", M + 17, y);
        pdf.setFillColor(red[0], red[1], red[2]); pdf.rect(M + 78, y - 4.5, 12, 3.5, "F"); pdf.text("Red side", M + 95, y);
        if (marks.length) {
          pdf.setDrawColor(muted[0], muted[1], muted[2]); pdf.setLineWidth(0.8); pdf.setLineDashPattern([1.4, 2.2], 0);
          pdf.line(M + 150, y - 2.5, M + 162, y - 2.5); pdf.setLineDashPattern([], 0);
          col(muted); pdf.text("Speaker enters (numbered)", M + 167, y);
        }
        col(muted); pdf.text(`Debate starts at ${clock(startMin)}`, gxr, y, { align: "right" });
        y += 14;
        // Numbered entry strip — each number ties back to a dotted line above.
        if (marks.length) {
          gap(2);
          let cx = M; const lineH = 12;
          ensure(lineH);
          pdf.setFontSize(7.5);
          marks.forEach((e, i) => {
            const c = e.side === "red" ? red : e.side === "blue" ? blue : muted;
            const txt = `${i + 1}. ${clean(speakerLabel(e.speakerId))} ${clock(e.minute)}`;
            const w = pdf.getTextWidth(txt) + 14;
            if (cx + w > pageW - M) { cx = M; y += lineH; ensure(lineH); }
            pdf.setFillColor(c[0], c[1], c[2]); pdf.circle(cx + 2, y - 2, 1.6, "F");
            col(ink); pdf.text(txt, cx + 7, y);
            cx += w;
          });
          y += lineH;
        }
      };
      const drawBarChart = (speakers: { speakerId: string; score: number; side: string }[]) => {
        if (!speakers.length) return;
        const labelArea = 18; const chartH = 150; ensure(chartH + labelArea + 12);
        const gx = M + 28, gxr = pageW - M, top = y, bottom = y + chartH;
        const plotW = gxr - gx, plotH = bottom - top;
        const vals = speakers.map((s) => s.score).concat([0]);
        let lo = Math.min(...vals), hi = Math.max(...vals); if (lo === hi) hi = lo + 1;
        const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
        const yOf = (v: number) => bottom - ((v - lo) / (hi - lo)) * plotH;
        pdf.setFontSize(7.5); col(muted); pdf.setDrawColor(hair[0], hair[1], hair[2]); pdf.setLineWidth(0.4);
        for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * (i / 3); const yy = yOf(v); pdf.line(gx, yy, gxr, yy); pdf.text(String(Math.round(v)), M - 2, yy + 2.5); }
        const yz = yOf(0); pdf.setDrawColor(170, 165, 160); pdf.setLineWidth(0.7); pdf.line(gx, yz, gxr, yz);
        const n = speakers.length, slot = plotW / n, bw = Math.min(44, slot * 0.58);
        speakers.forEach((s, i) => {
          const cx = gx + slot * i + slot / 2, yv = yOf(s.score);
          const by = Math.min(yz, yv), bh = Math.max(1, Math.abs(yv - yz));
          const c = s.side === "red" ? red : blue;
          pdf.setFillColor(c[0], c[1], c[2]); pdf.rect(cx - bw / 2, by, bw, bh, "F");
          pdf.setFontSize(8); col(ink); pdf.text(`${s.score > 0 ? "+" : ""}${s.score}`, cx, s.score >= 0 ? by - 3 : by + bh + 9, { align: "center" });
          // Short "Sp.N" labels sit centered under each bar — no rotation, no overlap.
          pdf.setFontSize(7); col(muted);
          pdf.text(abbrevSpeakerLabel(clean(speakerLabel(s.speakerId))), cx, bottom + 11, { align: "center" });
        });
        y = bottom + labelArea + 8;
      };

      // ---- Title ---------------------------------------------------------------
      if (logoData) {
        const lw = 104, lh = lw / LOGO_AR;
        pdf.addImage(logoData, "PNG", M, y, lw, lh, undefined, "FAST");
        y += lh + 14;
      }
      const topic = clean(report?.topic || presentedDebate.topic || project.title || "Debate report");
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(20); col(ink);
      for (const ln of pdf.splitTextToSize(topic, W) as string[]) { ensure(24); pdf.text(ln, M, y + 18); y += 24; }
      const durMs = report?.durationMs || project.durationMs || 0;
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9.5); col(muted);
      y += 4; pdf.text(`Debate report · ${clock((durMs / 1000) / 60)} · ${new Date().toLocaleDateString()}`, M, y + 8); y += 14;
      pdf.setDrawColor(hair[0], hair[1], hair[2]); pdf.setLineWidth(0.8); pdf.line(M, y, pageW - M, y); y += 6;

      // ---- The reading (verdict) ----------------------------------------------
      if (report) {
        const b = report.scoreboard?.blue?.score ?? 0, r = report.scoreboard?.red?.score ?? 0;
        const lead = b === r ? null : b > r ? "blue" : "red";
        heading("The reading");
        para(lead ? `${lead === "blue" ? "Blue" : "Red"} side ended ahead on credibility` : "The sides finished level on credibility", { size: 15, style: "bold", color: lead === "red" ? red : lead === "blue" ? blue : ink, gapAfter: 6 });
        // Final score — emphasized: small caption, then large side-coloured numbers.
        ensure(40);
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(7.5); col(muted);
        pdf.text("FINAL CREDIBILITY SCORE", M, y + 6); y += 12;
        ensure(26);
        let sx = M;
        const scoreToken = (label: string, value: number, c: [number, number, number]) => {
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(10); col(c); pdf.text(label, sx, y + 18); sx += pdf.getTextWidth(label) + 6;
          pdf.setFontSize(23); pdf.text(`${value}`, sx, y + 20); sx += pdf.getTextWidth(`${value}`) + 30;
        };
        scoreToken("Blue", b, blue);
        scoreToken("Red", r, red);
        y += 30;
        for (const p of (report.verdict || "").split(/\n{2,}/)) para(p, { size: 10.5, color: ink, gapAfter: 6 });
      }

      // ---- How the score moved (line chart) -----------------------------------
      const tl = report?.scoreTimeline;
      if (tl && (tl.points?.length || 0) >= 2) {
        heading("How the score moved");
        para("Credibility score over the debate.", { size: 9.5, color: muted, gapAfter: 8 });
        const startMin = Number.isFinite(Number(tl.debateStartMinute)) ? Number(tl.debateStartMinute) : tl.points[0].minute;
        const maxMin = Number(tl.maxMinute) || tl.points[tl.points.length - 1].minute;
        drawLineChart(tl.points, startMin, maxMin, report?.speakerEntries || []);
      }

      // ---- The speakers (bar chart + write-ups) --------------------------------
      if (report && (report.speakers?.length || 0) > 0) {
        heading("The speakers");
        drawBarChart(report.speakers.map((s) => ({ speakerId: s.speakerId, score: s.score, side: s.side })));
        gap(4);
        for (const s of report.speakers) {
          const stats: string[] = [];
          if (s.stats.verified) stats.push(`${s.stats.verified} verified`);
          if (s.stats.contradicted) stats.push(`${s.stats.contradicted} false`);
          if (s.stats.misleading) stats.push(`${s.stats.misleading} misleading`);
          if (s.stats.inconsistencies) stats.push(`${s.stats.inconsistencies} self-contradiction${s.stats.inconsistencies > 1 ? "s" : ""}`);
          ensure(16);
          pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); col(s.side === "red" ? red : blue);
          pdf.text(clean(speakerLabel(s.speakerId)), M, y + 9);
          pdf.setFont("helvetica", "bold"); col(ink);
          pdf.text(`${s.score > 0 ? "+" : ""}${s.score}`, pageW - M, y + 9, { align: "right" });
          y += 15;
          if (stats.length) para(stats.join("  ·  "), { size: 9, color: muted, gapAfter: 1 });
          if (s.verdict) para(s.verdict, { size: 10, color: ink });
          if (s.standoutQuote?.text) para(`"${s.standoutQuote.text}"`, { size: 9.5, style: "italic", color: muted, indent: 12, gapAfter: 8 });
          else gap(8);
        }
      }

      // ---- The two cases ------------------------------------------------------
      if (report && (report.blueSummary || report.redSummary)) {
        heading("The two cases");
        if (report.blueSummary) { sideTag("Blue side", blue); para(report.blueSummary, { size: 10.5, color: ink, gapAfter: 10 }); }
        if (report.redSummary) { sideTag("Red side", red); para(report.redSummary, { size: 10.5, color: ink, gapAfter: 4 }); }
      }

      // ---- Turning points -----------------------------------------------------
      if (report && (report.keyMoments?.length || 0) > 0) {
        heading("Turning points");
        report.keyMoments.forEach((m, i) => {
          const impact = m.impact === "positive" ? "Gained ground" : m.impact === "negative" ? "Lost ground" : "";
          ensure(16);
          pdf.setFont("helvetica", "bold"); pdf.setFontSize(10.5); col(ink);
          pdf.text(`${i + 1}.  ${clean(m.title)}`, M, y + 9);
          if (impact) { pdf.setFont("helvetica", "bold"); pdf.setFontSize(8.5); col(m.impact === "positive" ? green : danger); pdf.text(impact.toUpperCase(), pageW - M, y + 9, { align: "right" }); }
          y += 15;
          if (m.side) para(m.side === "red" ? "Red side" : "Blue side", { size: 8.5, color: m.side === "red" ? red : blue });
          if (m.detail) para(m.detail, { size: 10, color: ink });
          if (m.quote) para(`"${m.quote}"`, { size: 9.5, style: "italic", color: muted, indent: 12 });
          gap(8);
        });
      }

      // ---- Methodology --------------------------------------------------------
      heading("How this is scored");
      para("This is a credibility score, not a measure of who talked more or whose opinion is right. Both sides start at zero. A verified claim earns +3; a claim caught out as false costs -5; a misleading claim -2; a self-contradiction -4. Strong debate points add a small, capped bonus so volume can't outweigh accuracy. \"Unverified\" means we couldn't find a clear source either way. We present the facts and our reading; you decide who came out ahead.", { size: 9, color: muted });

      // ---- Debate points (ALL, grouped by side + family) ----------------------
      const sidePoints = (sideKey: "blue" | "red") => (analysis?.sides?.[sideKey]?.debatePoints || []);
      if ((sidePoints("blue").length + sidePoints("red").length) > 0) {
        heading("Debate points");
        for (const [sideKey, c, name] of [["blue", blue, "Blue side"], ["red", red, "Red side"]] as const) {
          const pts = sidePoints(sideKey);
          if (!pts.length) continue;
          sideTag(name, c);
          const fams = new Map<string, typeof pts>();
          for (const p of pts) { const k = clean(p.familyTitle) || "Other points"; if (!fams.has(k)) fams.set(k, [] as typeof pts); fams.get(k)!.push(p); }
          for (const [famTitle, fp] of fams) {
            para(famTitle, { size: 10.5, style: "bold", color: ink, gapAfter: 2 });
            for (const p of fp) {
              para(`•  ${clean(p.point)}`, { size: 10, color: ink, indent: 8 });
              if (p.quote) para(`"${p.quote}"  — ${clean(speakerLabel(p.speakerId))}`, { size: 9, style: "italic", color: muted, indent: 16, gapAfter: 3 });
              else gap(2);
            }
            gap(3);
          }
          gap(4);
        }
      }

      // ---- Claims & fact-checks ----------------------------------------------
      const claims = report?.factChecks?.length
        ? report.factChecks.map((c) => ({ side: c.side, speakerId: c.speakerId, claim: c.claim, status: c.status, why: c.why, sources: (c.sources || []).map((s) => ({ title: s.title, url: s.url })) }))
        : ["blue", "red"].flatMap((sk) => (analysis?.sides?.[sk as "blue" | "red"]?.claims || []).filter((c) => claimVerdict(c) && claimVerdict(c) !== "checking").map((c) => ({ side: sk, speakerId: c.speakerId, claim: c.claim, status: claimVerdict(c), why: c.why, sources: (c.sources || []).map((s) => ({ title: s.title, url: s.uri })) })));
      if (claims.length) {
        heading("Claims & fact-checks");
        for (const c of claims) {
          const meta = tagMeta[c.status] || tagMeta.no_clear_source;
          ensure(16);
          pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); col(meta.color);
          pdf.text(meta.label.toUpperCase(), M, y + 8);
          pdf.setFont("helvetica", "normal"); col(muted); pdf.setFontSize(8.5);
          pdf.text(clean(speakerLabel(c.speakerId)), pageW - M, y + 8, { align: "right" });
          y += 14;
          para(clean(c.claim), { size: 10, style: "bold", color: ink });
          if (c.why) para(c.why, { size: 9.5, color: muted });
          const srcs = (c.sources || []).map((s) => clean(s.title || s.url)).filter(Boolean);
          if (srcs.length) para(`Sources: ${srcs.join("; ")}`, { size: 8.5, color: muted });
          gap(7);
        }
      }

      // ---- Self-contradictions -----------------------------------------------
      const contras = report?.contradictions?.length
        ? report.contradictions.map((x) => ({ side: x.side, type: x.type, why: x.why, first: x.first, second: x.second }))
        : ["blue", "red"].flatMap((sk) => (analysis?.sides?.[sk as "blue" | "red"]?.inconsistencies || []).map((x) => ({ side: sk, type: x.type, why: x.why, first: { speakerId: x.firstSpeakerId, quote: x.firstQuote }, second: { speakerId: x.secondSpeakerId, quote: x.secondQuote } })));
      if (contras.length) {
        heading("Self-contradictions & double standards");
        for (const x of contras) {
          para(`${clean(x.type) || "Contradiction"} — ${x.side === "red" ? "Red side" : "Blue side"}`, { size: 10.5, style: "bold", color: x.side === "red" ? red : blue });
          if (x.why) para(x.why, { size: 9.5, color: muted });
          if (x.first?.quote) para(`"${x.first.quote}"  — ${clean(speakerLabel(x.first.speakerId))}`, { size: 9.5, style: "italic", color: ink, indent: 12 });
          if (x.second?.quote) para(`"${x.second.quote}"  — ${clean(speakerLabel(x.second.speakerId))}`, { size: 9.5, style: "italic", color: ink, indent: 12 });
          gap(7);
        }
      }

      // ---- Footer on every page (no watermark) --------------------------------
      const totalPages = pdf.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        pdf.setPage(p);
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); col(muted);
        pdf.text("Generated by Debatly", M, pageH - 22);
        pdf.text(`${p} / ${totalPages}`, pageW - M, pageH - 22, { align: "right" });
      }

      const base = topic.replace(/[^\w\- ]+/g, "").replace(/\s+/g, " ").trim() || "debatly-report";
      pdf.save(`${base}.pdf`);
      setStatus("PDF downloaded");
      pushEvent("Downloaded report PDF");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not export PDF";
      setStatus(message);
      pushEvent(message);
    } finally {
      setIsExportingReportPdf(false);
    }
  }

  const appBackdrop = <AppBackdrop themeMode={themeMode} />;

  if (workspaceBooting) {
    return (
      <>
        {appBackdrop}
        <WorkspaceBootScreen themeMode={themeMode} />
      </>
    );
  }

  return (
    <>
    {appBackdrop}
    <main className={`shell productShell ${isSidebarOpen ? "sidebarOpen" : ""}`} data-theme={themeMode}>
      <button className="sidebarScrim" type="button" aria-label="Close debate sidebar" onClick={() => setIsSidebarOpen(false)} />
      <AppSidebar
        project={project}
        durationMs={projectDurationMs}
        savedDebates={savedDebates}
        savedDebatesLoading={savedDebatesLoading}
        savedDebatesLoadError={savedDebatesLoadError}
        authReady={authReady}
        signedIn={Boolean(authUser)}
        isGuest={isGuestUser}
        themeMode={themeMode}
        onProjectSelect={(projectId) => void loadSavedDebate(projectId)}
        onProjectRename={(target, isCurrent) => openProjectRename(target, isCurrent)}
        onProjectDelete={(target, isCurrent) => openProjectDelete(target, isCurrent)}
        onSettings={() => {
          setIsSidebarOpen(false);
          void refreshAudioInputs();
          setShowSettings(true);
        }}
        onNewDebate={() => {
          setIsSidebarOpen(false);
          void startFreshDebate();
        }}
        onClose={() => setIsSidebarOpen(false)}
      />
      <section className="appFrame">
        <header className="topbar">
          <button className="sidebarToggle" type="button" aria-label="Open debate sidebar" onClick={() => setIsSidebarOpen(true)}>
            <Menu size={19} />
          </button>
          <div className="topbarTitle">
            <input
              ref={importFileInputRef}
              type="file"
              accept="audio/*,video/*"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportFile(f); e.target.value = ""; }}
            />
            {importJob && importMinimized && !importJob.error ? (
              <button type="button" className="topbarImportMini" onClick={() => setImportMinimized(false)} title="Show import details">
                <span className="topbarImportMiniLabel">Importing · {importJob.stageLabel}</span>
                <span className="topbarImportMiniBar"><span style={{ width: `${importJob.progress}%` }} /></span>
                <span className="topbarImportMiniPct">{Math.round(importJob.progress)}%</span>
              </button>
            ) : featuredQuoteItem ? (
              <QuoteStrip item={featuredQuoteItem} isLive={isLive} speakerLabel={speakerLabel} />
            ) : isLive ? (
              <h1>Listening for the debate</h1>
            ) : (
              <div className="topbarImport" ref={importGuideRef}>
                <button type="button" className="topbarImportBtn" onClick={() => importFileInputRef.current?.click()}>
                  <Download size={16} style={{ transform: "rotate(180deg)" }} />
                  <span>Upload file</span>
                </button>
                <div className="topbarImportUrl">
                  <input
                    type="url"
                    className="topbarImportInput"
                    placeholder="Paste a video URL (YouTube, etc.)"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleImportUrl(); }}
                  />
                  <button type="button" className="topbarImportAnalyze" disabled={!importUrl.trim()} onClick={() => void handleImportUrl()}>Analyze</button>
                </div>
              </div>
            )}
          </div>
          <div className="topbarActions">
            {!isLive && Boolean(liveSessionId) && (
              <button
                className={`topbarReportPill${reportAlreadyExists ? " isDone" : ""}`}
                type="button"
                onClick={() => void handleGenerateReportClick()}
                disabled={Boolean(generateReportDisabledReason)}
                title={generateReportDisabledReason || "Generate report"}
              >
                <Gavel size={16} />
                <span>{reportAlreadyExists ? "Report generated" : reportProgress.active ? "Generating…" : "Generate report"}</span>
              </button>
            )}
            <div className="shareMenuWrap" ref={shareMenuRef}>
              <button
                className="iconButton"
                type="button"
                onClick={() => setShareMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={shareMenuOpen}
                title="Share and download"
              >
                <Share2 size={19} />
              </button>
              {shareMenuOpen && (
                <div className="shareMenu" role="menu" aria-label="Share and download">
                  {Boolean(liveSessionId) && (
                    <button type="button" role="menuitem" onClick={() => void copyShareLink()}>
                      <Share2 size={15} />
                      <span>Copy share link</span>
                    </button>
                  )}
                  <button type="button" role="menuitem" onClick={() => void downloadPagePdf()} disabled={isExportingReportPdf}>
                    <FileText size={15} />
                    <span>{isExportingReportPdf ? "Building PDF…" : "Download page as PDF"}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={downloadFullTranscriptTxt}>
                    <Download size={15} />
                    <span>Download full transcript TXT</span>
                  </button>
                </div>
              )}
            </div>
            <button className="iconButton" onClick={() => setThemeMode((current) => current === "light" ? "dark" : "light")} title={themeMode === "light" ? "Dark mode" : "Light mode"}>
              {themeMode === "light" ? <Moon size={19} /> : <Sun size={19} />}
            </button>
          </div>
        </header>

        <section className={`controlPanel capturePanel ${isLive ? "isRecording" : ""} ${isRecordingPaused ? "isPaused" : ""}`}>
          <PixelCard
            className="captureSignalCard"
            variant={themeMode === "dark" ? "signalDark" : "default"}
            colors={themeMode === "dark" ? "#ffffff,#e7e5e4,#d6d3d1" : "#000000,#0c0a09,#1c1917"}
            gap={5}
            speed={82}
            active={isLive || isMicTesting}
            audioLevel={isRecordingPaused ? 0 : diagnostics.level}
            noFocus
          >
            <div className="captureSignalContent">
              <div className="captureReadout">
                <span className={`captureDot ${isLive && !isRecordingPaused ? "active" : isRecordingPaused ? "paused" : ""}`} />
                <div>
                  <span>{isLive ? (isRecordingPaused ? "Paused" : "Recording") : isMicTesting ? "Mic test" : "Ready"}</span>
                  <strong>{formatRecordingClock(projectDurationMs)}</strong>
                  <p>{selectedAudioInputLabel(audioInputs, selectedDeviceId)}</p>
                </div>
              </div>

              <div className="captureActions" ref={recordGuideRef}>
                {isLive && (
                  <button className="testButton pauseButton" type="button" onClick={togglePauseLiveRecording}>
                    {isRecordingPaused ? <Play size={17} /> : <Pause size={17} />}
                    <span>{isRecordingPaused ? "Resume" : "Pause"}</span>
                  </button>
                )}
                <button
                  className={isLive ? "recordButton recording" : "recordButton"}
                  type="button"
                  disabled={!isLive && recordingLocked}
                  title={!isLive && recordingLocked ? "Report already generated. Create a new debate project to record again." : undefined}
                  onClick={() => void beginLiveFromControl()}
                >
                  {isLive ? <CircleStop size={18} /> : <Mic size={18} />}
                  <span>{isLive ? "Stop" : recordingLocked ? "Recording complete" : "Start recording"}</span>
                </button>
                {!isLive && (
                  <button className={`testButton ${isMicTesting ? "active" : ""}`} type="button" onClick={() => void (isMicTesting ? stopMicTest() : beginMicTest())}>
                    <Mic size={17} />
                    <span>{isMicTesting ? "Stop mic test" : "Test mic"}</span>
                  </button>
                )}
              </div>
            </div>
          </PixelCard>
        </section>

        <section className="sideSummaries">
          <LiveScorecard color="blue" side={liveAnalysis?.sides.blue} speakerLabel={speakerLabel} onSpeakerRename={renameSpeakerLabel} />
          <LiveScorecard color="red" side={liveAnalysis?.sides.red} speakerLabel={speakerLabel} onSpeakerRename={renameSpeakerLabel} />
        </section>

        <LiveDebateDesk
          analysis={liveAnalysis}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          speakerLabel={speakerLabel}
        />

        {debateReport && (
          <DebateReportView ref={debateReportRef} report={debateReport} speakerLabel={speakerLabel} themeMode={themeMode} />
        )}

        <section className="lowerGrid transcriptOnly">
          <details className="transcript compactTranscript" open={transcriptOpen}>
            <summary onClick={(e) => { e.preventDefault(); setTranscriptOpen((v) => !v); }}>
              <div className="transcriptTitle">
                <strong>Transcript</strong>
                <span>{isLive ? "Live capture" : presentedTurns.some((turn) => turn.isFinal) ? "Captured transcript" : "No transcript yet"}</span>
              </div>
              <div className="transcriptSummaryMeta">
                <small>{presentedTurns.filter((turn) => turn.isFinal).length} {presentedTurns.filter((turn) => turn.isFinal).length === 1 ? "turn" : "turns"}</small>
                <ChevronDown size={15} />
              </div>
            </summary>
            <StabilizerContextNotice windows={stabilizerContextWindows} />
            {(() => {
              const rawFinals = presentedTurns.filter((turn) => turn.isFinal).slice(-400);
              // ONE bubble per speaker run: merge consecutive same-speaker pieces
              // into a single growing bubble, splitting only when the SPEAKER changes
              // (a generous 15s guard prevents a huge accidental same-label silence
              // from making one giant bubble). The bubble grows by ~0.7s confirmed
              // pieces — no separate live line, no churn.
              const MERGE_GAP_SEC = 15;
              const merged: typeof rawFinals = [];
              for (const turn of rawFinals) {
                const last = merged[merged.length - 1];
                const start = Number(turn.startSec);
                const lastEnd = last ? Number(last.endSec) : NaN;
                const sameSpeaker = Boolean(last && last.speakerId === turn.speakerId);
                const closeInTime = !Number.isFinite(start) || !Number.isFinite(lastEnd) || (start - lastEnd) <= MERGE_GAP_SEC;
                if (sameSpeaker && closeInTime) {
                  last.text = `${last.text} ${turn.text}`.replace(/\s+/g, " ").trim();
                  if (Number.isFinite(Number(turn.endSec))) last.endSec = Number(turn.endSec);
                } else {
                  merged.push({ ...turn });
                }
              }
              const display = merged.slice(-120);
              // Live partial line, pinned at the BOTTOM under the newest bubble:
              // streams the current (not-yet-confirmed) words, cleared once its
              // final lands and merges into the bubble above. (Test app's separate
              // partial line, moved below for natural reading order.)
              const lastFinalAt = rawFinals.length ? Number(rawFinals[rawFinals.length - 1].at || 0) : 0;
              const interimTurn = isLive
                ? [...presentedTurns].reverse().find((turn) => !turn.isFinal && (turn.text || "").trim())
                : null;
              const interimText = interimTurn && Number(interimTurn.at || 0) >= lastFinalAt
                ? String(interimTurn.text || "").trim()
                : "";
              return (
                <TranscriptStream open={transcriptOpen} itemCount={rawFinals.length} tailKey={interimText.length}>
                  {display.length === 0 && !interimText ? (
                    <p className="empty">Live transcript will appear here.</p>
                  ) : (
                    <>
                      {display.map((turn) => (
                        <TurnBubble key={turn.id} turn={turn} sideColor={transcriptDotColor(liveAnalysis, sideViews, turn)} speakerLabel={speakerLabel(turn.speakerId)} />
                      ))}
                      {isLive && interimText && (
                        <div className="liveCaptionBottom" aria-live="polite">{interimText}<span className="liveInterimCaret">…</span></div>
                      )}
                    </>
                  )}
                </TranscriptStream>
              );
            })()}
          </details>
        </section>
      </section>
      {showStopConfirm && (
        <StopRecordingDialog
          onCancel={cancelStopLive}
          onStopWithoutReport={stopRecordingWithoutReport}
          onConfirm={confirmStopAndGenerateReport}
        />
      )}
      {showSettings && (
        <SettingsDialog
          audioInputs={audioInputs}
          selectedDeviceId={selectedDeviceId}
          disabled={isLive || isMicTesting}
          authUser={authUser}
          authReady={authReady}
          authWorkingProvider={authWorkingProvider}
          onDeviceChange={setSelectedDeviceId}
          onSignIn={(provider) => void handleSignIn(provider)}
          onSignOut={() => void handleSignOut()}
          onClose={() => setShowSettings(false)}
        />
      )}
      {projectActionDialog?.mode === "rename" && (
        <RenameProjectDialog
          title={projectActionDialog.title}
          busy={projectActionBusy}
          onCancel={() => setProjectActionDialog(null)}
          onConfirm={(nextTitle) => void renameProjectFromDialog(nextTitle)}
        />
      )}
      {projectActionDialog?.mode === "delete" && (
        <DeleteProjectDialog
          title={projectActionDialog.title}
          busy={projectActionBusy}
          onCancel={() => setProjectActionDialog(null)}
          onConfirm={() => void deleteProjectFromDialog()}
        />
      )}
      {reportProgress.active && <ReportProgress progress={reportProgress} />}
      {importJob && !importMinimized && (
        <ImportProgress
          job={importJob}
          themeMode={themeMode}
          onCancel={() => void cancelImport()}
          onNotify={() => void notifyWhenImportDone()}
          onDismiss={() => { setImportJob(null); setImportJobId(null); }}
        />
      )}
      {isExportingReportPdf && <PdfExportOverlay themeMode={themeMode} />}
      {showOnboarding && !isLive && !isMicTesting && (
        <OnboardingCoach importRef={importGuideRef} recordRef={recordGuideRef} onDismiss={dismissOnboarding} />
      )}
      {toast && <div className="appToast" role="status" aria-live="polite">{toast}</div>}
    </main>
    </>
  );
}


function countTurnsBySpeaker(turns: TranscriptTurn[]) {
  const counts = new Map<string, number>();
  for (const turn of turns) {
    counts.set(turn.speakerId, (counts.get(turn.speakerId) || 0) + 1);
  }
  return counts;
}

// The app's grainy animated background (used as the app backdrop, the boot screen,
// and the import loading overlay) — one source of truth for the Grainient params.
function AppBackdrop({ themeMode, className = "appGradientBackdrop" }: { themeMode: "light" | "dark"; className?: string }) {
  return (
    <Grainient
      className={className}
      color1={themeMode === "dark" ? "#171413" : "#fbf8ef"}
      color2={themeMode === "dark" ? "#2d2926" : "#ddd8ce"}
      color3={themeMode === "dark" ? "#3a3834" : "#c9cdc8"}
      timeSpeed={0.62}
      colorBalance={themeMode === "dark" ? 0.12 : 0.26}
      warpStrength={1.15}
      warpFrequency={4.1}
      warpSpeed={0.82}
      warpAmplitude={46}
      blendAngle={18}
      blendSoftness={0.24}
      rotationAmount={520}
      noiseScale={2.35}
      grainAmount={themeMode === "dark" ? 0.12 : 0.16}
      grainScale={2.4}
      grainAnimated={false}
      contrast={themeMode === "dark" ? 1.25 : 1.38}
      gamma={1}
      saturation={themeMode === "dark" ? 0.75 : 0.72}
      centerX={-0.12}
      centerY={0.08}
      zoom={0.74}
    />
  );
}

function WorkspaceBootScreen({ themeMode }: { themeMode: "light" | "dark" }) {
  return (
    <section className="workspaceBootScreen" aria-busy="true" aria-live="polite" aria-label="Loading workspace">
      <div className="workspaceBootPanel">
        <img
          className="workspaceBootLogo"
          src={themeMode === "dark" ? LOGO_DARK_MODE : LOGO_LIGHT_MODE}
          alt="debatly"
        />
        <div>
          <span>Loading workspace</span>
          <strong>Preparing your debates</strong>
        </div>
        <div className="workspaceBootTrack" aria-hidden="true">
          <i />
        </div>
      </div>
    </section>
  );
}

type ScrollFrameMetrics = {
  hasOverflow: boolean;
  canScrollUp: boolean;
  canScrollDown: boolean;
  thumbHeight: number;
  thumbTop: number;
};

const SCROLL_FRAME_RAIL_INSET = 8;
const SCROLL_FRAME_MIN_THUMB_HEIGHT = 28;
const SCROLL_FRAME_IDLE_MS = 900;

function ScrollFrame({
  className = "",
  viewportClassName = "",
  contentClassName = "",
  children,
  ariaLabel,
  tabIndex,
  refreshKey
}: {
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  children: ReactNode;
  ariaLabel?: string;
  tabIndex?: number;
  refreshKey?: unknown;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number; thumbHeight: number } | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const [scrollbarActive, setScrollbarActive] = useState(false);
  const [metrics, setMetrics] = useState<ScrollFrameMetrics>({
    hasOverflow: false,
    canScrollUp: false,
    canScrollDown: false,
    thumbHeight: 0,
    thumbTop: 0
  });

  const updateMetrics = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scrollHeight = viewport.scrollHeight;
    const clientHeight = viewport.clientHeight;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const hasOverflow = maxScrollTop > 1;
    const trackHeight = Math.max(0, clientHeight - SCROLL_FRAME_RAIL_INSET * 2);
    const thumbHeight = hasOverflow
      ? Math.min(trackHeight, Math.max(SCROLL_FRAME_MIN_THUMB_HEIGHT, Math.round((clientHeight / Math.max(scrollHeight, 1)) * trackHeight)))
      : 0;
    const thumbTravel = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = hasOverflow && maxScrollTop
      ? Math.round((viewport.scrollTop / maxScrollTop) * thumbTravel)
      : 0;
    const next = {
      hasOverflow,
      canScrollUp: viewport.scrollTop > 1,
      canScrollDown: viewport.scrollTop < maxScrollTop - 1,
      thumbHeight,
      thumbTop
    };
    setMetrics((current) => (
      current.hasOverflow === next.hasOverflow
      && current.canScrollUp === next.canScrollUp
      && current.canScrollDown === next.canScrollDown
      && current.thumbHeight === next.thumbHeight
      && current.thumbTop === next.thumbTop
        ? current
        : next
    ));
  }, []);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const markScrollbarActive = useCallback((hold = false) => {
    setScrollbarActive(true);
    clearIdleTimer();
    if (!hold) {
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        setScrollbarActive(false);
      }, SCROLL_FRAME_IDLE_MS);
    }
  }, [clearIdleTimer]);

  useLayoutEffect(() => {
    updateMetrics();
  });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    updateMetrics();
    const onScroll = () => {
      updateMetrics();
      if (viewport.scrollHeight - viewport.clientHeight > 1) markScrollbarActive();
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateMetrics) : null;
    resizeObserver?.observe(viewport);
    if (contentRef.current) resizeObserver?.observe(contentRef.current);
    window.addEventListener("resize", updateMetrics);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateMetrics);
    };
  }, [refreshKey, markScrollbarActive, updateMetrics]);

  useEffect(() => () => clearIdleTimer(), [clearIdleTimer]);

  const onThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !metrics.hasOverflow) return;
    event.preventDefault();
    markScrollbarActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
      thumbHeight: metrics.thumbHeight
    };
  }, [markScrollbarActive, metrics.hasOverflow, metrics.thumbHeight]);

  const onThumbPointerMove = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const viewport = viewportRef.current;
    const drag = dragRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
    markScrollbarActive(true);
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const trackHeight = Math.max(0, viewport.clientHeight - SCROLL_FRAME_RAIL_INSET * 2);
    const thumbTravel = Math.max(1, trackHeight - drag.thumbHeight);
    viewport.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) / thumbTravel) * maxScrollTop;
    updateMetrics();
  }, [markScrollbarActive, updateMetrics]);

  const finishThumbDrag = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
      dragRef.current = null;
      updateMetrics();
      markScrollbarActive();
    }
  }, [markScrollbarActive, updateMetrics]);

  const onRailPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const viewport = viewportRef.current;
    if (!viewport || !metrics.hasOverflow) return;
    markScrollbarActive();
    const rect = event.currentTarget.getBoundingClientRect();
    const trackHeight = Math.max(1, rect.height);
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const thumbTravel = Math.max(1, trackHeight - metrics.thumbHeight);
    const targetThumbTop = Math.max(0, Math.min(thumbTravel, event.clientY - rect.top - metrics.thumbHeight / 2));
    viewport.scrollTop = (targetThumbTop / thumbTravel) * maxScrollTop;
    updateMetrics();
  }, [markScrollbarActive, metrics.hasOverflow, metrics.thumbHeight, updateMetrics]);

  const frameClassName = [
    "scrollFrame",
    className,
    metrics.hasOverflow ? "hasOverflow" : "",
    scrollbarActive ? "isScrolling" : "",
    metrics.canScrollUp ? "canScrollUp" : "",
    metrics.canScrollDown ? "canScrollDown" : ""
  ].filter(Boolean).join(" ");
  const thumbStyle = {
    "--scroll-frame-thumb-height": `${metrics.thumbHeight}px`,
    "--scroll-frame-thumb-top": `${metrics.thumbTop}px`
  } as CSSProperties;

  return (
    <div className={frameClassName}>
      <div ref={viewportRef} className={`scrollFrameViewport ${viewportClassName}`.trim()} tabIndex={tabIndex} aria-label={ariaLabel}>
        <div ref={contentRef} className={`scrollFrameContent ${contentClassName}`.trim()}>
          {children}
        </div>
      </div>
      <div className="scrollFrameRail" aria-hidden="true" onPointerDown={onRailPointerDown}>
        <span
          className="scrollFrameThumb"
          style={thumbStyle}
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={finishThumbDrag}
          onPointerCancel={finishThumbDrag}
        />
      </div>
    </div>
  );
}

function AppSidebar({
  project,
  durationMs,
  savedDebates,
  savedDebatesLoading,
  savedDebatesLoadError,
  authReady,
  signedIn,
  isGuest,
  themeMode,
  onProjectSelect,
  onProjectRename,
  onProjectDelete,
  onSettings,
  onNewDebate,
  onClose
}: {
  project: ProjectMeta;
  durationMs: number;
  savedDebates: SavedDebateProject[];
  savedDebatesLoading: boolean;
  savedDebatesLoadError: string;
  authReady: boolean;
  signedIn: boolean;
  isGuest: boolean;
  themeMode: "light" | "dark";
  onProjectSelect: (projectId: string) => void;
  onProjectRename: (target: SavedDebateProject | ProjectMeta, isCurrent: boolean) => void;
  onProjectDelete: (target: SavedDebateProject | ProjectMeta, isCurrent: boolean) => void;
  onSettings: () => void;
  onNewDebate: () => void;
  onClose: () => void;
}) {
  const activeProjectId = project.id || "";
  const hasSavedActiveProject = Boolean(activeProjectId && savedDebates.some((item) => item.id === activeProjectId));

  return (
    <aside className="workspaceSidebar">
      <div className="sidebarBrand">
        <img
          className="brandLogo"
          src={themeMode === "dark" ? LOGO_DARK_MODE : LOGO_LIGHT_MODE}
          alt="debatly"
        />
        <button className="sidebarClose" type="button" aria-label="Close debate sidebar" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <button className="sidebarPrimary" onClick={onNewDebate}>
        <Plus size={16} />
        <span>New debate</span>
      </button>

      <div className="sidebarSection">
        <span>Debate threads</span>
        <ScrollFrame
          className="debateListFrame"
          viewportClassName="debateListViewport"
          contentClassName="debateList"
          ariaLabel="Debate threads"
          refreshKey={`${activeProjectId}:${savedDebates.length}:${savedDebatesLoading}:${savedDebatesLoadError}`}
        >
          {!hasSavedActiveProject && (
            <DebateProjectCard
              project={project}
              active
              durationMs={durationMs}
              onSelect={() => undefined}
              onRename={() => onProjectRename(project, true)}
              onDelete={() => onProjectDelete(project, true)}
            />
          )}
          {savedDebatesLoading && savedDebates.length === 0 && <small className="debateListStatus">Loading saved debates</small>}
          {!savedDebatesLoading && authReady && !signedIn && savedDebates.length === 0 && (
            <small className="debateListStatus">Your saved debates will appear here.</small>
          )}
          {!savedDebatesLoading && authReady && signedIn && savedDebates.length === 0 && savedDebatesLoadError && (
            <small className="debateListStatus">Saved debates unavailable. Retrying...</small>
          )}
          {!savedDebatesLoading && authReady && signedIn && savedDebates.length === 0 && !savedDebatesLoadError && (
            <small className="debateListStatus">No saved debates found.</small>
          )}
          {savedDebates.map((saved) => {
            const active = saved.id === activeProjectId;
            const cardProject = active
              ? {
                  ...saved,
                  ...project,
                  id: saved.id,
                  status: project.status || saved.status,
                  title: project.title || saved.title,
                  startedAt: project.startedAt ?? saved.startedAt,
                  endedAt: project.endedAt ?? saved.endedAt,
                  durationMs: project.durationMs ?? saved.durationMs
                }
              : saved;
            return (
              <DebateProjectCard
                key={saved.id}
                project={cardProject}
                active={active}
                durationMs={active ? durationMs : saved.durationMs || 0}
                onSelect={() => onProjectSelect(saved.id)}
                onRename={() => onProjectRename(cardProject, active)}
                onDelete={() => onProjectDelete(cardProject, active)}
              />
            );
          })}
        </ScrollFrame>
      </div>

      <div className="sidebarAccount">
        {isGuest && (
          <button className="sidebarSaveCta" type="button" onClick={onSettings}>
            <UserCircle size={18} />
            <span>
              <strong>Sign in or sign up to save your debates</strong>
            </span>
          </button>
        )}
        <button className="settingsButton" type="button" onClick={onSettings}>
          <Settings size={16} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function DebateProjectCard({
  project,
  active = false,
  durationMs,
  onSelect,
  onRename,
  onDelete
}: {
  project: SavedDebateProject | ProjectMeta;
  active?: boolean;
  durationMs: number;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const title = project.title || DEFAULT_PROJECT_TITLE;

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <article className={`debateProjectCard ${active ? "active" : "saved"}`}>
      <button
        className="debateProjectMain"
        type="button"
        onClick={active ? undefined : onSelect}
        title={title}
        aria-current={active ? "page" : undefined}
      >
        <span className="debateProjectTitle">{title}</span>
      </button>
      <span className="debateDuration">
        <Clock size={12} />
        <span className="debateDurationText">{formatDurationLabel(durationMs)}</span>
      </span>
      <button
        ref={menuButtonRef}
        className="debateProjectMenuButton"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Actions for ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((current) => !current);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {menuOpen && (
        <div ref={menuRef} className="projectMenu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onRename();
            }}
          >
            <Pencil size={14} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </button>
        </div>
      )}
    </article>
  );
}

// Transcript scroll container with standard chat-stream behaviour:
//  - sticks to the bottom as new turns arrive while you're at the bottom;
//  - releases the moment you scroll up, holding your position;
//  - shows a "jump to latest" pill (flagged "New messages" if turns arrived while
//    you were scrolled up) that re-sticks you to the bottom when clicked.
function TranscriptStream({ open, itemCount, tailKey = 0, children }: { open: boolean; itemCount: number; tailKey?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [hasNew, setHasNew] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Follow the bottom on new turns AND on streaming partial growth (tailKey). The
  // partial line lives INSIDE the scroll list, so we pin instantly ("auto") on
  // every change — no smooth animation fighting the rapid partial updates.
  useEffect(() => {
    if (!open) return;
    if (stuckRef.current) {
      scrollToBottom("auto");
      setShowJump(false);
      setHasNew(false);
    } else {
      setHasNew(true);
      setShowJump(true);
    }
  }, [itemCount, tailKey, open, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stuckRef.current = near;
    setShowJump(!near);
    if (near) setHasNew(false);
  }, []);

  const jump = useCallback(() => {
    stuckRef.current = true;
    setShowJump(false);
    setHasNew(false);
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  return (
    <div className="transcriptStream">
      <div className="turnList" ref={ref} onScroll={handleScroll}>
        {children}
      </div>
      {showJump && (
        <button type="button" className={`transcriptJump${hasNew ? " hasNew" : ""}`} onClick={jump}>
          {hasNew && <span className="transcriptJumpDot" aria-hidden="true" />}
          <span>{hasNew ? "New messages" : "Jump to latest"}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function TurnBubble({ turn, sideColor, speakerLabel }: { turn: TranscriptTurn; sideColor?: "blue" | "red"; speakerLabel: string }) {
  // Show just the clean speaker label (e.g. "Speaker 2"), no raw "(S2)" suffix.
  const displaySpeaker = speakerLabel;
  return (
    <article className={`turn ${sideColor ? `side-${sideColor}` : ""} ${turn.contextOnly ? "context-turn" : ""} ${turn.isFinal ? "" : "interim"}`}>
      <header>
        <span className="turnSpeaker">{displaySpeaker}</span>
        {turn.contextOnly && <small>{formatContextLabel(turn.contextKind)}</small>}
      </header>
      <p>{turn.text}</p>
    </article>
  );
}

function StabilizerContextNotice({ windows }: { windows: DialogueWindow[] }) {
  if (!windows.length) return null;
  const latest = windows[windows.length - 1];
  const signals = uniqueStringList(latest.contextSignals || []).slice(0, 4);
  const earlier = Math.max(0, windows.length - 1);
  return (
    <div className="stabilizerContextNotice" aria-live="polite">
      <div>
        <span>{formatContextLabel(latest.contextKind || latest.reason)}</span>
        <strong>{formatContextWindowRange(latest)}</strong>
      </div>
      <p>{latest.contextReason || "This segment was held out of debate analysis."}</p>
      {signals.length > 0 && (
        <ul>
          {signals.map((signal) => <li key={signal}>{signal}</li>)}
        </ul>
      )}
      {earlier > 0 && <small>{earlier} earlier held {earlier === 1 ? "segment" : "segments"}</small>}
    </div>
  );
}

function QuoteStrip({ item, isLive, speakerLabel }: { item: QuoteStripItem | null; isLive: boolean; speakerLabel: (speakerId?: string) => string }) {
  if (item) {
    return (
      <blockquote className={`quoteHeadline ${quoteHeadlineSizeClass(item.text)} ${item.sideColor ? `speaker-${item.sideColor}` : ""}`} aria-label="Featured debate quote" aria-live="polite">
        <span className={`quoteSpeaker speaker-${item.sideColor || "neutral"}`}>{speakerLabel(item.speakerId)}</span>
        <FittedQuoteText text={item.text} />
      </blockquote>
    );
  }
  if (!isLive) return <h1>Ready for a live debate</h1>;
  return <h1>Listening for the debate</h1>;
}

function FittedQuoteText({ text }: { text: string }) {
  const nodeRef = useRef<HTMLParagraphElement | null>(null);
  const [fontSize, setFontSize] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    let cancelled = false;

    const fit = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      if (!width || !height) return;
      const max = quoteMaxFontSize(text);
      const min = 15;
      let low = min;
      let high = max;
      let best = min;
      for (let index = 0; index < 9; index += 1) {
        const mid = (low + high) / 2;
        node.style.setProperty("--quote-fit-size", `${mid}px`);
        if (node.scrollHeight <= height + 1 && node.scrollWidth <= width + 1) {
          best = mid;
          low = mid;
        } else {
          high = mid;
        }
      }
      node.style.removeProperty("--quote-fit-size");
      if (!cancelled) setFontSize(Math.floor(best * 10) / 10);
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    window.addEventListener("resize", fit);
    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [text]);

  return (
    <p ref={nodeRef} style={fontSize ? ({ "--quote-fit-size": `${fontSize}px` } as CSSProperties) : undefined}>
      <em>{text}</em>
    </p>
  );
}

function quoteHeadlineSizeClass(text: string) {
  const chars = String(text || "").length;
  const words = wordCountText(text);
  if (chars > 210 || words > 34) return "quoteDense";
  if (chars > 160 || words > 28) return "quoteLong";
  if (chars > 105 || words > 20) return "quoteMedium";
  return "quoteShort";
}

function quoteMaxFontSize(text: string) {
  const chars = String(text || "").length;
  const words = wordCountText(text);
  if (chars > 210 || words > 34) return 23;
  if (chars > 160 || words > 28) return 26;
  if (chars > 105 || words > 20) return 29;
  return 32;
}

function displaySideThesis(side?: Pick<DebateSide, "label" | "confirmedThesis" | "thesisStatus">) {
  if (!side || side.thesisStatus !== "confirmed") return "";
  return (side.confirmedThesis || side.label || "").trim();
}

function EditableSpeakerChip({
  speakerId,
  label,
  sideColor,
  onRename,
  showEditHint = true
}: {
  speakerId: string;
  label: string;
  sideColor: "blue" | "red";
  onRename: (speakerId: string, nextLabel: string) => void;
  showEditHint?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);

  useEffect(() => {
    if (!editing) setValue(label);
  }, [editing, label]);

  if (editing) {
    return (
      <form
        className={`speakerNameEditor ${sideColor}`}
        onSubmit={(event) => {
          event.preventDefault();
          onRename(speakerId, value);
          setEditing(false);
        }}
      >
        <input
          value={value}
          autoFocus
          maxLength={48}
          aria-label={`Name for ${speakerId}`}
          placeholder={speakerId}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setValue(label);
              setEditing(false);
            }
          }}
        />
        <button type="submit" aria-label="Save speaker name" title="Save">
          <Check size={13} />
        </button>
        <button
          type="button"
          aria-label={`Reset to ${speakerId}`}
          title={`Reset to ${speakerId}`}
          onClick={() => {
            onRename(speakerId, "");
            setEditing(false);
          }}
        >
          <RotateCcw size={13} />
        </button>
      </form>
    );
  }

  return (
    <button
      type="button"
      className={`speakerChipButton ${sideColor}`}
      title={`Rename ${speakerId}`}
      aria-label={`Rename ${speakerId}`}
      onClick={() => setEditing(true)}
    >
      <span className="speakerChipName">{label}</span>
      {showEditHint && <Pencil className="speakerEditIcon" size={12} strokeWidth={2.1} aria-hidden="true" />}
    </button>
  );
}

function defaultScorePillars(): ScorePillar[] {
  return [
    { key: "source_verified", label: "Verified source", value: 0, help: "A claim from this side was verified." },
    { key: "source_contradicted", label: "Contradicted source", value: 0, help: "A claim from this side was contradicted." },
    { key: "strong_rebuttal", label: "Strong rebuttal", value: 0, help: "This side clearly landed a resolved clash." },
    { key: "weak_response", label: "Weak response", value: 0, help: "This side lost ground in a resolved response." },
    { key: "inconsistency", label: "Inconsistency", value: 0, help: "This side contradicted itself or applied a conflicting standard." },
    { key: "unanswered_challenge", label: "Unanswered challenge", value: 0, help: "This side left a direct challenge unanswered." }
  ];
}

function formatScoreComponent(value: number) {
  if (value > 0) return `+${value}`;
  if (value < 0) return String(value);
  return "0";
}

function getLedgerLead(scorecard: Scorecard): { side: "blue" | "red" | "even" } {
  const blue = Number(scorecard.blue?.score ?? 0);
  const red = Number(scorecard.red?.score ?? 0);
  if (blue === red) return { side: "even" };
  const leader = blue > red ? "blue" : "red";
  return { side: leader };
}

function ReportProgress({ progress }: { progress: ReportProgressState }) {
  return (
    <section className="reportProgress" aria-label="Generating final report">
      <div className="reportProgressCopy">
        <span>Generating final report</span>
        <strong>{progress.stage}</strong>
        <p>{progress.note}</p>
      </div>
      <div className="reportProgressPulse" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="reportProgressTrack" aria-hidden="true">
        <span style={{ width: `${progress.value}%` }} />
      </div>
      <small>{Math.round(progress.value)}%</small>
    </section>
  );
}

// Pleasant 3-note completion chime via the Web Audio API (no asset file needed).
function playCompletionChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5 · E5 · G5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.13;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.6);
    });
    window.setTimeout(() => { void ctx.close(); }, 1400);
  } catch { /* audio not available — silent */ }
}

// Import loading screen — full-screen, sits on the app's grainy animated backdrop
// (no frosted blur). A single centered card: stage icon (centered, no box, fades
// in on each stage), the stage title, a one-line note, and a progress bar.
const IMPORT_STAGE_META: Record<string, { label: string; note: string; Icon: ComponentType<{ size?: number; strokeWidth?: number }> }> = {
  uploading: { label: "Uploading file", note: "Sending your recording to the server.", Icon: Download },
  fetching: { label: "Fetching media", note: "Downloading the audio from your link.", Icon: Download },
  extracting: { label: "Extracting audio", note: "Pulling a clean 16kHz mono track.", Icon: AudioLines },
  diarizing: { label: "Diarizing & transcribing", note: "Separating speakers and transcribing every word.", Icon: Users },
  analyzing: { label: "Analyzing the debate", note: "Building sides, claims, fact-checks and scores.", Icon: BarChart3 },
  reporting: { label: "Writing the report", note: "Turning the analysis into your report.", Icon: Gavel },
  done: { label: "Report ready", note: "Opening it now…", Icon: BadgeCheck }
};

function ImportProgress({ job, onDismiss, onCancel, onNotify, themeMode }: { job: { stage: string; stageLabel: string; progress: number; error: string | null; emailConfigured?: boolean; notified?: boolean }; onDismiss: () => void; onCancel: () => void; onNotify: () => void; themeMode: "light" | "dark" }) {
  const meta = IMPORT_STAGE_META[job.stage] || { label: job.stageLabel, note: "", Icon: Sparkles };
  const Icon = job.error ? TriangleAlert : meta.Icon;
  return (
    <div className="importOverlay" aria-live="polite" aria-label="Importing debate">
      <AppBackdrop themeMode={themeMode} className="importOverlayBackdrop" />
      <div className="importCard">
        <div className={`importCardIcon ${job.error ? "error" : ""}`} key={job.error ? "error" : job.stage} aria-hidden="true">
          <Icon size={46} strokeWidth={1.6} />
        </div>
        <span className="importCardEyebrow">{job.error ? "Import failed" : "Importing debate"}</span>
        <h2 className="importCardTitle">{job.error ? "Something went wrong" : meta.label}</h2>
        <p className="importCardNote">{job.error ? job.error : meta.note}</p>
        {job.error ? (
          <button type="button" className="importCardDismiss" onClick={onDismiss}>Dismiss</button>
        ) : (
          <>
            <div className="importCardTrack" aria-hidden="true"><span style={{ width: `${job.progress}%` }} /></div>
            <span className="importCardPct">{Math.round(job.progress)}%</span>
            <div className="importCardActions">
              <button type="button" className="importCardCancel" onClick={onCancel}>Cancel</button>
              <button type="button" className="importCardNotify" onClick={onNotify}>Continue in the background</button>
            </div>
            <p className="importCardHint">
              We'll keep working in the background — a progress bar stays up top.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// First-visit coach marks: two anchored callouts (upload/link + live record) with
// a light scrim. Positions are measured from the live DOM so the arrows track the
// real elements; dismiss persists in localStorage so it never shows twice.
function OnboardingCoach({ importRef, recordRef, onDismiss }: {
  importRef: { current: HTMLDivElement | null };
  recordRef: { current: HTMLDivElement | null };
  onDismiss: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = step === 1 ? importRef.current : recordRef.current;
      setRect(el?.getBoundingClientRect() || null);
    };
    measure();
    const t1 = window.setTimeout(measure, 200);
    const t2 = window.setTimeout(measure, 600);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(t1); window.clearTimeout(t2);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [importRef, recordRef, step]);

  if (!rect) return null;
  const PAD = 6;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const ringStyle = { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
  const leftAligned = step === 1;
  const cardLeft = Math.max(16, Math.min(rect.left, vw - 320));
  const cardStyle = leftAligned
    ? { left: cardLeft, top: rect.bottom + 16 }
    : { right: Math.max(16, vw - rect.right), top: rect.bottom + 16 };

  // Portal to <body> so the overlay sits OUTSIDE the .shell `zoom: 0.75` context.
  // Otherwise the zoom re-scales these viewport-space coordinates (and Chrome's
  // zoom handling differs by version), which misaligns the highlight ring.
  return createPortal((
    <div className="coachOverlay" role="dialog" aria-label="Getting started">
      <button type="button" className="coachScrim" aria-label="Dismiss guide" onClick={onDismiss} />
      <div className="coachRing" style={ringStyle} />
      <div className={`coachCard ${leftAligned ? "" : "coachCardRight"}`} style={cardStyle}>
        <span
          className={`coachArrow ${leftAligned ? "" : "coachArrowRight"}`}
          style={leftAligned ? { left: Math.min(40, Math.max(16, rect.left - cardLeft + 24)) } : undefined}
        />
        <div className="coachCardHead">
          <span className="coachBadge">{step === 1 ? "Most accurate" : "Live"}</span>
          <span className="coachStep">{step} of 2</span>
        </div>
        {step === 1 ? (
          <p>Upload a recording or paste a video link to analyze a full debate — this gives the most accurate read.</p>
        ) : (
          <p>Or stream a live debate and let Debatly listen in the background as it happens — high quality, in real time.</p>
        )}
        <div className="coachActions">
          {step === 1 && <button type="button" className="coachSkip" onClick={onDismiss}>Skip</button>}
          {step === 1
            ? <button type="button" className="coachDone" onClick={() => setStep(2)}>Next</button>
            : <button type="button" className="coachDone" onClick={onDismiss}>Got it</button>}
        </div>
      </div>
    </div>
  ), document.body);
}

// Full-screen cover shown while the PDF is being built — hides the brief desk
// tab-cycling / un-bounding reflow that happens underneath during capture.
function PdfExportOverlay({ themeMode }: { themeMode: "light" | "dark" }) {
  return (
    <div className="importOverlay" aria-live="polite" aria-label="Building PDF">
      <AppBackdrop themeMode={themeMode} className="importOverlayBackdrop" />
      <div className="importCard">
        <div className="importCardIcon" aria-hidden="true"><FileText size={46} strokeWidth={1.6} /></div>
        <span className="importCardEyebrow">Export</span>
        <h2 className="importCardTitle">Preparing your PDF</h2>
        <p className="importCardNote">Capturing the page — this takes a few seconds.</p>
        <div className="importCardTrack" aria-hidden="true"><span className="importCardTrackIndeterminate" /></div>
      </div>
    </div>
  );
}

function StopRecordingDialog({
  onCancel,
  onStopWithoutReport,
  onConfirm
}: {
  onCancel: () => void;
  onStopWithoutReport: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="stopDialogBackdrop" role="presentation">
      <section className="stopDialog" role="dialog" aria-modal="true" aria-labelledby="stop-recording-title">
        <button type="button" className="stopDialogClose" onClick={onCancel} title="Keep recording">
          <X size={18} />
        </button>
        <span>Stop recording</span>
        <h2 id="stop-recording-title">Stop recording and generate the debate report?</h2>
        <p>Recording can end now. Generate the final report from the captured session, or stop without writing a report.</p>
        <div className="stopDialogActions">
          <button type="button" className="testButton" onClick={onStopWithoutReport}>Don't generate report</button>
          <button type="button" className="recordButton" onClick={onConfirm}>
            <CircleStop size={18} />
            <span>Generate report</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function RenameProjectDialog({
  title,
  busy,
  onCancel,
  onConfirm
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}) {
  const [value, setValue] = useState(title || DEFAULT_PROJECT_TITLE);
  const cleanValue = value.trim();
  return (
    <div className="stopDialogBackdrop" role="presentation">
      <form
        className="stopDialog projectDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-project-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (cleanValue) onConfirm(cleanValue);
        }}
      >
        <button type="button" className="stopDialogClose" onClick={onCancel} title="Close">
          <X size={18} />
        </button>
        <span>Rename debate</span>
        <h2 id="rename-project-title">Name this debate project</h2>
        <label className="projectDialogField">
          <span>Project name</span>
          <input
            autoFocus
            value={value}
            maxLength={140}
            onChange={(event) => setValue(event.target.value)}
            placeholder={DEFAULT_PROJECT_TITLE}
          />
        </label>
        <div className="stopDialogActions">
          <button type="button" className="testButton" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="recordButton" disabled={busy || !cleanValue}>
            <span>{busy ? "Saving" : "Save name"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteProjectDialog({
  title,
  busy,
  onCancel,
  onConfirm
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const cleanTitle = (title || DEFAULT_PROJECT_TITLE).trim();
  const canDelete = confirmation.trim() === cleanTitle;
  return (
    <div className="stopDialogBackdrop" role="presentation">
      <form
        className="stopDialog projectDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-project-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (canDelete) onConfirm();
        }}
      >
        <button type="button" className="stopDialogClose" onClick={onCancel} title="Close">
          <X size={18} />
        </button>
        <span>Delete debate</span>
        <h2 id="delete-project-title">Delete "{cleanTitle}"?</h2>
        <p>This removes the debate project, transcript, analysis, score history, and report from your workspace.</p>
        <label className="projectDialogField danger">
          <span>Type the project name to confirm</span>
          <input
            autoFocus
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={cleanTitle}
          />
        </label>
        <div className="stopDialogActions">
          <button type="button" className="testButton" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="recordButton dangerButton" disabled={busy || !canDelete}>
            <Trash2 size={17} />
            <span>{busy ? "Deleting" : "Delete debate"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function SettingsDialog({
  audioInputs,
  selectedDeviceId,
  disabled,
  authUser,
  authReady,
  authWorkingProvider,
  onDeviceChange,
  onSignIn,
  onSignOut,
  onClose
}: {
  audioInputs: MediaDeviceInfo[];
  selectedDeviceId: string;
  disabled: boolean;
  authUser: AuthUser | null;
  authReady: boolean;
  authWorkingProvider: AuthProvider | "signout" | "";
  onDeviceChange: (deviceId: string) => void;
  onSignIn: (provider: AuthProvider) => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [showScoringMetrics, setShowScoringMetrics] = useState(false);
  // A guest (anonymous) user counts as "not signed in" for the account UI: we still
  // show the sign-in options so they can upgrade and keep their debates.
  const isPermanentUser = Boolean(authUser) && !authUser?.isAnonymous;

  return (
    <div className="stopDialogBackdrop" role="presentation">
      <section className="stopDialog settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button type="button" className="stopDialogClose" onClick={onClose} aria-label="Close settings">
          <X size={16} />
        </button>
        <div className="settingsHeaderRow">
          <span>Settings</span>
          <h2 id="settings-title">Workspace</h2>
        </div>

        <div className="settingsAccountPanel">
          {isPermanentUser && authUser?.avatarUrl ? <img src={authUser.avatarUrl} alt="" /> : <UserCircle size={36} />}
          <div>
            <strong>{isPermanentUser ? authUser?.name : (authReady ? "Guest" : "Checking session")}</strong>
            <small>{isPermanentUser ? authUser?.email : "Sign in or sign up to save your debates"}</small>
          </div>
          {isPermanentUser && (
            <button type="button" className="accountIconButton" onClick={onSignOut} disabled={authWorkingProvider === "signout"} aria-label="Sign out">
              <LogOut size={15} />
            </button>
          )}
          {!isPermanentUser && (
            <div className="authProviderGrid settingsAuthProviderGrid" aria-label="Sign in options">
              <button type="button" onClick={() => onSignIn("google")} disabled={!authReady || Boolean(authWorkingProvider)}>
                {authWorkingProvider === "google" ? "..." : "Google"}
              </button>
              <button type="button" onClick={() => onSignIn("x")} disabled={!authReady || Boolean(authWorkingProvider)}>
                {authWorkingProvider === "x" ? "..." : "X"}
              </button>
              <button type="button" onClick={() => onSignIn("discord")} disabled={!authReady || Boolean(authWorkingProvider)}>
                {authWorkingProvider === "discord" ? "..." : "Discord"}
              </button>
            </div>
          )}
        </div>

        <div className="settingsSectionCard">
          <div className="settingsSectionTitle">
            <Mic size={16} />
            <strong>Audio input</strong>
          </div>
          <label className="deviceSelect settingsDeviceSelect">
            <span>Microphone</span>
            <select value={selectedDeviceId} onChange={(event) => onDeviceChange(event.target.value)} disabled={disabled}>
              <option value="">System default microphone</option>
              {audioInputs.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          {disabled && <p className="settingsHint">Audio input can be changed before recording or after the mic test stops.</p>}
        </div>

        <div className="settingsActionList">
          <button type="button" className="settingsMenuButton" onClick={() => setShowScoringMetrics((current) => !current)} aria-expanded={showScoringMetrics}>
            <BarChart3 size={16} />
            <span>Scoring Metrics</span>
            <ChevronDown size={15} />
          </button>
          {showScoringMetrics && (
            <div className="settingsInfoPanel scoringInfoPanel">
              <p className="scoringLede">
                A <strong>credibility score</strong> — not who talked more or whose opinion is right.
                Both sides start at <strong>0</strong> and can go negative. Every point traces to a card you can open.
              </p>
              <div className="scoreMetricGrid" aria-label="Scoring criteria">
                <section className="scoreMetricGroup scoreMetricGroupWin">
                  <h3>Earns points</h3>
                  <ul className="settingsMetricList">
                    <li><strong>+3</strong><span><b>Verified claim</b>A factual claim checks out against sources.</span></li>
                    <li><strong>+0.5</strong><span><b>Strong debate point</b>Capped, so volume can never outweigh accuracy.</span></li>
                  </ul>
                </section>
                <section className="scoreMetricGroup scoreMetricGroupLose">
                  <h3>Loses points</h3>
                  <ul className="settingsMetricList">
                    <li><strong>-5</strong><span><b>False claim</b>Caught out as factually wrong — hurts most.</span></li>
                    <li><strong>-4</strong><span><b>Self-contradiction</b>Contradicts itself, double standard, or hypocrisy.</span></li>
                    <li><strong>-2</strong><span><b>Misleading claim</b>Technically defensible but slanted or out of context.</span></li>
                  </ul>
                </section>
              </div>
              <p className="scoringFootnote">
                <b>Unverified</b> claims (no clear source either way) score <b>0</b> — neither rewarded nor punished.
                We present the facts and our reading; you decide who came out ahead.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function formatMinute(minute: number) {
  return `${Number.isInteger(minute) ? minute : minute.toFixed(1)}m`;
}

function formatReportTiming(elapsedMs?: number) {
  const ms = Number(elapsedMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s to generate`;
}

function formatDurationLabel(durationMs: number) {
  if (!durationMs) return "0m";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

function formatRecordingClock(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function getActiveProjectDurationMs(project: ProjectMeta, now: number) {
  const persistedDurationMs = Number(project.durationMs || 0);
  if (project.status !== "recording" && persistedDurationMs > 0) return persistedDurationMs;
  if (!project.startedAt) return persistedDurationMs;
  const endAt = project.endedAt ?? now;
  const activePauseMs = project.pauseStartedAt && !project.endedAt
    ? Math.max(0, endAt - project.pauseStartedAt)
    : 0;
  return Math.max(0, endAt - project.startedAt - project.pausedMs - activePauseMs);
}

function freezeProjectAtStop(project: ProjectMeta, stoppedAt: number, fallbackExtraPausedMs = 0): ProjectMeta {
  const extraPausedMs = project.pauseStartedAt
    ? Math.max(0, stoppedAt - project.pauseStartedAt)
    : Math.max(0, fallbackExtraPausedMs);
  const pausedMs = Math.max(0, project.pausedMs + extraPausedMs);
  const endedAt = project.endedAt ?? stoppedAt;
  const durationMs = getActiveProjectDurationMs({
    ...project,
    endedAt,
    pausedMs,
    pauseStartedAt: null
  }, stoppedAt);
  return {
    ...project,
    status: "stopped",
    endedAt,
    durationMs,
    pausedMs,
    pauseStartedAt: null
  };
}

function selectedAudioInputLabel(audioInputs: MediaDeviceInfo[], selectedDeviceId: string) {
  if (!selectedDeviceId) return "System default microphone";
  const selected = audioInputs.find((device) => device.deviceId === selectedDeviceId);
  return selected?.label || "Selected microphone";
}

function deriveProjectTitleFromReport(report: DebateReport, debate: DebateState) {
  const topic = debate.topic?.trim() || report.topic?.trim();
  if (topic) return compactProjectTitle(topic);
  return DEFAULT_PROJECT_TITLE;
}

function compactProjectTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (normalized.length <= 54) return normalized;
  return `${normalized.slice(0, 51).trim()}...`;
}

function formatSpeakerLabel(speakerId?: string, speakerDisplayNames: SpeakerLabelMap = {}) {
  const id = sanitizeSpeakerId(speakerId || "");
  if (!id) return speakerId || "Speaker";
  return formatSpeakerDisplayName(speakerDisplayNames[id] || "") || id;
}

function sanitizeSpeakerId(value: string) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^Speaker\s*(\d+|one|two|three|four|five|six)$/i);
  if (!match) return "";
  const wordNumbers: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const rawNumber = match[1].toLowerCase();
  const speakerNumber = wordNumbers[rawNumber] || Number(rawNumber);
  return Number.isFinite(speakerNumber) && speakerNumber > 0 ? `Speaker ${speakerNumber}` : "";
}

function sanitizeSpeakerDisplayName(value: string) {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return formatSpeakerDisplayName(cleaned);
}

function formatSpeakerDisplayName(value: string) {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  if (!cleaned) return "";
  const lower = cleaned.toLocaleLowerCase();
  return lower.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (word) => (
    word
      .replace(/^[A-Za-z]/, (letter) => letter.toLocaleUpperCase())
      .replace(/(')([A-Za-z])/g, (_match, mark: string, letter: string) => `${mark}${letter.toLocaleUpperCase()}`)
      .replace(/^Mc([a-z])/, (_match, letter: string) => `Mc${letter.toLocaleUpperCase()}`)
  ));
}

function mergeSpeakerDisplayNamesIntoDebate(debate: DebateState, localNames: SpeakerLabelMap | undefined): DebateState {
  const incomingNames = debate.speakerDisplayNames || {};
  const mergedNames = { ...incomingNames, ...(localNames || {}) };
  return { ...debate, speakerDisplayNames: mergedNames };
}

function SpeakerLinkedText({
  text,
  speakerLabel
}: {
  text?: string | null;
  speakerLabel: (speakerId?: string) => string;
}) {
  return <>{renderSpeakerLinkedText(text || "", speakerLabel)}</>;
}

function renderSpeakerLinkedText(text: string, speakerLabel: (speakerId?: string) => string) {
  const value = String(text || "");
  const displayLabelPattern = /\bSpeaker\s*(?:\d+|one|two|three|four|five|six)\b|\bside[\s_-]*[ab]\b/gi;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(displayLabelPattern)) {
    const matchText = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(value.slice(lastIndex, index));
    nodes.push(
      <span key={`speaker-${index}`} className="dynamicSpeakerName">
        {formatDynamicDebateLabel(matchText, speakerLabel)}
      </span>
    );
    lastIndex = index + matchText.length;
  }

  if (!nodes.length) return value;
  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes;
}

function plainSpeakerLinkedText(text: string, speakerLabel: (speakerId?: string) => string) {
  return String(text || "").replace(/\bSpeaker\s*(?:\d+|one|two|three|four|five|six)\b|\bside[\s_-]*[ab]\b/gi, (match) => (
    formatDynamicDebateLabel(match, speakerLabel)
  ));
}

function formatDynamicDebateLabel(rawLabel: string, speakerLabel: (speakerId?: string) => string) {
  const speakerId = sanitizeSpeakerId(rawLabel);
  if (speakerId) return speakerLabel(speakerId);
  const sideToken = rawLabel.replace(/[\s_-]+/g, "").toLowerCase();
  if (sideToken === "sidea") return "Blue side";
  if (sideToken === "sideb") return "Red side";
  return rawLabel;
}

// =============================================================================
// NEW clean-pipeline UI — reads the LiveAnalysis payload from server/live-runner.
// =============================================================================

// Proper icon components (lucide) per tag — no emoji.
const POINT_TAG_ICON: Record<DebatePointTag, BadgeIcon> = {
  foundation: BookOpen,      // defines a term / framework
  evidence: BarChart3,       // a fact, number, source
  rebuttal: Swords,          // attacks the other side
  principle: Scale,          // moral / values argument
  precedent: Landmark,       // historical / legal parallel
  hypothetical: HelpCircle   // an "if X then Y" scenario
};
const FACT_TAG_META: Record<FactTag, { icon: BadgeIcon; label: string; cls: string }> = {
  verified: { icon: BadgeCheck, label: "Verified", cls: "factVerified" },
  contradicted: { icon: CircleX, label: "Contradicted", cls: "factContradicted" },
  misleading: { icon: TriangleAlert, label: "Misleading", cls: "factMisleading" },
  no_clear_source: { icon: Search, label: "No clear source", cls: "factNoSource" }
};
const INCONSISTENCY_TYPE_ICON: Record<InconsistencyType, BadgeIcon> = {
  "self-contradiction": Repeat,
  "double-standard": Scale,
  "hypocrisy": GitCompareArrows
};

// Score breakdown pills from the deterministic engine's points object.
function liveScorePills(side: LiveSide | undefined): Array<{ label: string; value: number; tone: string }> {
  if (!side?.points) return [];
  const p = side.points;
  const pills: Array<{ label: string; value: number; tone: string }> = [
    { label: "Verified", value: Number(p.fromVerified || 0), tone: "positive" },
    { label: "Contradicted", value: Number(p.fromContradicted || 0), tone: "negative" },
    { label: "Misleading", value: Number(p.fromMisleading || 0), tone: "negative" },
    { label: "Inconsistency", value: Number(p.fromInconsistencies || 0), tone: "negative" },
    { label: "Debate points", value: Number(p.fromDebatePoints || 0), tone: "positive" }
  ];
  return pills.filter((pill) => pill.value !== 0);
}

function LiveScorecard({ color, side, speakerLabel, onSpeakerRename }: {
  color: "blue" | "red";
  side: LiveSide | undefined;
  speakerLabel: (speakerId?: string) => string;
  onSpeakerRename: (speakerId: string, nextLabel: string) => void;
}) {
  const pills = liveScorePills(side);
  const speakerEntries = side ? Object.entries(side.speakers) : [];
  // Self-contained classes (lsc*) so legacy .sideSummary grid rules can't fight it.
  return (
    <section className={`lscCard ${color}`}>
      <div className="lscIdentity">
        <span className="lscLabel">{color === "red" ? "Red side" : "Blue side"}</span>
        <strong className="lscPosition">{side?.position || "Awaiting debate…"}</strong>
      </div>
      <div className="lscSpeakers">
        {speakerEntries.length ? (
          speakerEntries.map(([sp, v]) => (
            <EditableSpeakerChip
              key={sp}
              speakerId={sp}
              label={speakerLabel(sp)}
              sideColor={color}
              onRename={onSpeakerRename}
              showEditHint
            />
          ))
        ) : (
          <span className="lscSpeakersEmpty">Awaiting assigned speakers.</span>
        )}
      </div>
      <div className="lscBottom">
        <div className="lscPills" aria-label={`${color === "red" ? "Red" : "Blue"} score breakdown`}>
          {pills.map((item) => (
            <span key={item.label} className={`lscPill ${item.tone}`}>
              <b>{item.value > 0 ? `+${item.value}` : item.value}</b>
              <span>{item.label}</span>
            </span>
          ))}
        </div>
        <div className="lscScore">
          <span className="lscScoreLabel">Score</span>
          <strong aria-label={`${color === "red" ? "Red" : "Blue"} score`}>{side ? side.score : 0}</strong>
        </div>
      </div>
    </section>
  );
}

// Header for one side (lives in the .artifactHeaderGrid row — the existing
// design splits the desk into a 2-col header row + a 2-col body row).
function LiveDeskHeader({ color, side, tab }: { color: "blue" | "red"; side: LiveSide | undefined; tab: AnalysisTab }) {
  const title = color === "blue" ? "Blue side" : "Red side";
  // Show ONLY the evolving thesis sentence (no separate redundant position line).
  // Falls back to the short position until a full thesis has formed.
  const thesis = side?.thesis || side?.position || "Thesis forming";
  const count = !side ? 0
    : tab === "debatePoints" ? side.debatePoints.length
    : tab === "claims" ? side.claims.length
    : side.inconsistencies.length;
  return (
    <header className={`artifactColumnHeader ${color}`}>
      <div className="deskHeaderText">
        <span className={`artifactSideLabel ${color}`}><i />{title}</span>
        <strong>{thesis}</strong>
      </div>
      <small>{count}</small>
    </header>
  );
}

// Body (card list) for one side (lives in the .artifactBodyGrid row).
function LiveDeskBody({ color, side, tab, speakerLabel, isFamilyOpen, toggleFamily }: {
  color: "blue" | "red"; side: LiveSide | undefined; tab: AnalysisTab; speakerLabel: (s?: string) => string;
  isFamilyOpen: (key: string) => boolean; toggleFamily: (key: string) => void;
}) {
  return (
    <section className={`artifactColumn ${color}`}>
      <div className="artifactList">
        {tab === "debatePoints" && <LiveDebatePointsList side={side} color={color} speakerLabel={speakerLabel} isFamilyOpen={isFamilyOpen} toggleFamily={toggleFamily} />}
        {tab === "claims" && <LiveClaimsList side={side} color={color} speakerLabel={speakerLabel} />}
        {tab === "inconsistencies" && <LiveInconsistencyList side={side} color={color} speakerLabel={speakerLabel} />}
      </div>
    </section>
  );
}

// Reactive viewport check so we can render a genuinely different layout on phones
// (not just restyle the desktop DOM).
function useIsMobile(query = "(max-width: 640px)") {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(query);
    const handler = () => setIsMobile(mq.matches);
    handler();
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", handler); else mq.removeListener(handler); };
  }, [query]);
  return isMobile;
}

function LiveDebateDesk({ analysis, activeTab, setActiveTab, speakerLabel }: {
  analysis: LiveAnalysis | null;
  activeTab: AnalysisTab;
  setActiveTab: (tab: AnalysisTab) => void;
  speakerLabel: (speakerId?: string) => string;
}) {
  const isMobile = useIsMobile();
  const counts = analysis?.counts || { debatePoints: 0, claims: 0, inconsistencies: 0 };
  const tabs: Array<{ id: AnalysisTab; label: string; count: number }> = [
    { id: "debatePoints", label: "Debate Points", count: counts.debatePoints },
    { id: "claims", label: "Claims", count: counts.claims },
    { id: "inconsistencies", label: "Inconsistencies", count: counts.inconsistencies }
  ];
  const activeCount = tabs.find((t) => t.id === activeTab)?.count ?? 0;

  // Per-family open/closed memory, keyed by `${side}:${familyId}`. Families default
  // to OPEN; once the user toggles one we remember it here so the choice survives
  // switching tabs (which unmounts the card list) and the global expand/collapse.
  const [familyOpen, setFamilyOpen] = useState<Record<string, boolean>>({});
  const familyKeys = useMemo(() => {
    const keys: string[] = [];
    for (const c of ["blue", "red"] as const) {
      const side = analysis?.sides?.[c];
      if (!side) continue;
      const seen = new Set<string>();
      let hasUngrouped = false;
      for (const p of side.debatePoints) {
        if (!p.familyId) { hasUngrouped = true; continue; }
        if (!seen.has(p.familyId)) { seen.add(p.familyId); keys.push(`${c}:${p.familyId}`); }
      }
      if (hasUngrouped) keys.push(`${c}:__ungrouped`);
    }
    return keys;
  }, [analysis]);
  const isFamilyOpen = useCallback((key: string) => (key in familyOpen ? familyOpen[key] : true), [familyOpen]);
  const toggleFamily = useCallback((key: string) => setFamilyOpen((m) => ({ ...m, [key]: !(key in m ? m[key] : true) })), []);
  const setAllFamilies = (open: boolean) => setFamilyOpen(Object.fromEntries(familyKeys.map((k) => [k, open])));
  const allOpen = familyKeys.length > 0 && familyKeys.every((k) => isFamilyOpen(k));
  const showFamilyControls = activeTab === "debatePoints";

  return (
    <section className="analysisDesk" aria-label="Debate desk">
      <div className="analysisDeskHeader">
        <strong>Debate Desk</strong>
        <small>{activeCount} {activeCount === 1 ? "item" : "items"}</small>
      </div>
      <nav className="analysisTabs" aria-label="Debate desk tabs">
        {tabs.map((tab) => (
          <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>
            {tab.label}<span>{tab.count}</span>
          </button>
        ))}
        {showFamilyControls && (
          <button
            type="button"
            className="familyToggleAll"
            onClick={() => setAllFamilies(!allOpen)}
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </nav>
      {/* Mirror the existing desk structure exactly: .artifactColumns is a fixed-
          height box; row 1 = sticky .artifactHeaderGrid (2 cols), row 2 = a
          ScrollFrame whose .artifactBodyGrid scrolls when cards overflow. */}
      <div className="analysisPanel">
        {isMobile ? (
          // Phone: each side is a self-contained block — its header sits directly
          // above its own cards (the page scrolls), instead of all headers then all
          // bodies, which split a side's header from its content.
          <div className="artifactStack">
            <div className="artifactSideBlock blue">
              <LiveDeskHeader color="blue" side={analysis?.sides.blue} tab={activeTab} />
              <LiveDeskBody color="blue" side={analysis?.sides.blue} tab={activeTab} speakerLabel={speakerLabel} isFamilyOpen={isFamilyOpen} toggleFamily={toggleFamily} />
            </div>
            <div className="artifactSideBlock red">
              <LiveDeskHeader color="red" side={analysis?.sides.red} tab={activeTab} />
              <LiveDeskBody color="red" side={analysis?.sides.red} tab={activeTab} speakerLabel={speakerLabel} isFamilyOpen={isFamilyOpen} toggleFamily={toggleFamily} />
            </div>
          </div>
        ) : (
          <div className="artifactColumns">
            <div className="artifactHeaderGrid">
              <LiveDeskHeader color="blue" side={analysis?.sides.blue} tab={activeTab} />
              <LiveDeskHeader color="red" side={analysis?.sides.red} tab={activeTab} />
            </div>
            <ScrollFrame
              className="artifactScrollFrame"
              viewportClassName="artifactScrollArea"
              contentClassName="artifactBodyGrid"
              tabIndex={0}
              ariaLabel="Debate desk cards"
              refreshKey={`${activeTab}:${counts.debatePoints}:${counts.claims}:${counts.inconsistencies}`}
            >
              <LiveDeskBody color="blue" side={analysis?.sides.blue} tab={activeTab} speakerLabel={speakerLabel} isFamilyOpen={isFamilyOpen} toggleFamily={toggleFamily} />
              <LiveDeskBody color="red" side={analysis?.sides.red} tab={activeTab} speakerLabel={speakerLabel} isFamilyOpen={isFamilyOpen} toggleFamily={toggleFamily} />
            </ScrollFrame>
          </div>
        )}
      </div>
    </section>
  );
}

// One collapsible family group. Fully controlled: its open/closed state lives in
// the desk's persistent map (keyed by family), so it defaults to OPEN and remembers
// the user's choice across tab switches and the global Expand/Collapse All control.
function FamilyGroup({ title, count, color, open, onToggle, children }: {
  title: string; count: number; color: "blue" | "red"; open: boolean;
  onToggle: () => void; children: ReactNode;
}) {
  return (
    <details className={`familyGroup ${color}`} open={open}>
      <summary
        className="familyGroupHeader"
        onClick={(e) => { e.preventDefault(); onToggle(); }}
      >
        <span className="familyChevron"><ChevronDown size={16} aria-hidden="true" /></span>
        <span className="familyGroupTitle"><strong>{title}</strong></span>
        <span className="familyCount">{count}</span>
      </summary>
      <div className="familyGroupBody">{children}</div>
    </details>
  );
}

// Group debate points into collapsible family cards.
function LiveDebatePointsList({ side, color, speakerLabel, isFamilyOpen, toggleFamily }: {
  side: LiveSide | undefined; color: "blue" | "red"; speakerLabel: (s?: string) => string;
  isFamilyOpen: (key: string) => boolean; toggleFamily: (key: string) => void;
}) {
  if (!side || side.debatePoints.length === 0) return <p className="empty compact">No debate points for this side yet.</p>;
  const byFamily = new Map<string, { title: string; points: LiveDebatePoint[] }>();
  const ungrouped: LiveDebatePoint[] = [];
  for (const p of side.debatePoints) {
    if (!p.familyId) { ungrouped.push(p); continue; }
    if (!byFamily.has(p.familyId)) byFamily.set(p.familyId, { title: p.familyTitle || "Theme", points: [] });
    byFamily.get(p.familyId)!.points.push(p);
  }
  return (
    <>
      {[...byFamily.entries()].map(([id, fam]) => {
        const key = `${color}:${id}`;
        return (
          <FamilyGroup key={id} title={fam.title} count={fam.points.length} color={color} open={isFamilyOpen(key)} onToggle={() => toggleFamily(key)}>
            {fam.points.map((p) => <LiveDebatePointCard key={p.id} point={p} color={color} speakerLabel={speakerLabel} />)}
          </FamilyGroup>
        );
      })}
      {ungrouped.length > 0 && (
        <FamilyGroup title="Not yet grouped" count={ungrouped.length} color={color} open={isFamilyOpen(`${color}:__ungrouped`)} onToggle={() => toggleFamily(`${color}:__ungrouped`)}>
          {ungrouped.map((p) => <LiveDebatePointCard key={p.id} point={p} color={color} speakerLabel={speakerLabel} />)}
        </FamilyGroup>
      )}
    </>
  );
}

function LiveDebatePointCard({ point, color, speakerLabel }: { point: LiveDebatePoint; color: "blue" | "red"; speakerLabel: (s?: string) => string }) {
  return (
    <details className="artifactCard debatePointArtifact">
      <summary>
        <LiveCardMeta sideColor={color}>
          <ArtifactTag className="roleBadge role-claim" icon={POINT_TAG_ICON[point.tag] || Target}>{point.tag}</ArtifactTag>
          <ArtifactTag className="statusBadge status-checking" icon={UserCircle}>{speakerLabel(point.speakerId)}</ArtifactTag>
        </LiveCardMeta>
        <p className="artifactHeadline">{point.point}</p>
        <LiveQuote speakerId={point.speakerId} sideColor={color} speakerLabel={speakerLabel}>{point.quote}</LiveQuote>
      </summary>
      {point.opposingQuote && (
        <div className="artifactDetail liveArtifactDetail">
          <LiveQuote speakerId={point.opposingSpeakerId} sideColor={color === "blue" ? "red" : "blue"} speakerLabel={speakerLabel}>{point.opposingQuote}</LiveQuote>
        </div>
      )}
    </details>
  );
}

function LiveClaimsList({ side, color, speakerLabel }: { side: LiveSide | undefined; color: "blue" | "red"; speakerLabel: (s?: string) => string }) {
  if (!side || side.claims.length === 0) return <p className="empty compact">No claims for this side yet.</p>;
  return (
    <section className="artifactIssueBlock ungrouped">
      {side.claims.map((c) => {
        const meta = c.tag ? FACT_TAG_META[c.tag] : null;
        const statusText = c.status === "deep_checking" ? "Deep checking…" : c.status === "done" ? "Checked" : "Checking…";
        return (
          <details key={c.id} className="artifactCard claimArtifact">
            <summary>
              <LiveCardMeta sideColor={color}>
                <ArtifactTag className={`statusBadge status-${meta ? c.tag : "checking"}`} icon={meta ? meta.icon : CircleDashed}>{meta ? meta.label : statusText}</ArtifactTag>
                <ArtifactTag className="roleBadge role-claim" icon={UserCircle}>{speakerLabel(c.speakerId)}</ArtifactTag>
              </LiveCardMeta>
              <p className="artifactHeadline">{c.claim}</p>
              <LiveQuote speakerId={c.speakerId} sideColor={color} speakerLabel={speakerLabel}>{c.quote}</LiveQuote>
            </summary>
            <div className="artifactDetail liveArtifactDetail">
              {c.why && <p className="artifactReadLine">{c.why}</p>}
              {c.sources.length > 0 && (
                <div className="artifactSources">
                  {c.sources.map((s, i) => (
                    <a key={i} href={s.uri} target="_blank" rel="noreferrer" className="artifactSourceLink">{s.title || s.uri}</a>
                  ))}
                </div>
              )}
            </div>
          </details>
        );
      })}
    </section>
  );
}

function LiveInconsistencyList({ side, color, speakerLabel }: { side: LiveSide | undefined; color: "blue" | "red"; speakerLabel: (s?: string) => string }) {
  if (!side || side.inconsistencies.length === 0) return <p className="empty compact">No inconsistencies for this side.</p>;
  return (
    <section className="artifactIssueBlock ungrouped">
      {side.inconsistencies.map((x) => (
        <details key={x.id} className="artifactCard inconsistencyArtifact">
          <summary>
            <LiveCardMeta sideColor={color}>
              <ArtifactTag className="roleBadge role-claim" icon={INCONSISTENCY_TYPE_ICON[x.type] || Scale}>{x.type}</ArtifactTag>
              <ArtifactTag className="statusBadge status-checking" icon={Gavel}>{x.level}</ArtifactTag>
            </LiveCardMeta>
            <p className="artifactHeadline">{x.why}</p>
          </summary>
          <div className="artifactDetail liveArtifactDetail">
            <LiveQuote speakerId={x.firstSpeakerId} sideColor={color} speakerLabel={speakerLabel}>{x.firstQuote}</LiveQuote>
            <LiveQuote speakerId={x.secondSpeakerId} sideColor={color} speakerLabel={speakerLabel}>{x.secondQuote}</LiveQuote>
          </div>
        </details>
      ))}
    </section>
  );
}

type SideId = "side-a" | "side-b";

type DebatePointLedgerCard = {
  id: string;
  pointId: string;
  speakerId: string;
  sideId: SideId;
  point: string;
  quote: string;
  pointType: string;
  issueHint: string;
  reason: string;
  confidence: number;
  turnIds: string[];
  startSec?: number;
  endSec?: number;
};

type SourceBadgeStatus = ClaimArtifact["status"] | FactStatus;
type BadgeIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

function ArtifactTag({
  className,
  icon: Icon,
  children
}: {
  className: string;
  icon?: BadgeIcon | null;
  children: ReactNode;
}) {
  return (
    <span className={`artifactTag ${className}`}>
      {Icon && <span className="tagIcon" aria-hidden="true"><Icon size={11} strokeWidth={2.35} /></span>}
      <span className="tagText">{children}</span>
    </span>
  );
}

function SourceStatusBadge({ status }: { status: SourceBadgeStatus }) {
  const Icon = sourceStatusIcon(status);
  return (
    <ArtifactTag className={`statusBadge status-${status}`} icon={Icon}>
      {formatSourceStatusLabel(status)}
    </ArtifactTag>
  );
}

function claimSourceBadgeStatus(claim: ClaimArtifact, sourceChecks: SourceCheckArtifact[]): SourceBadgeStatus {
  if (!sourceChecks.length) return effectiveSourceStatus(claim.status, claim.evidenceStatus);
  const statuses = sourceChecks.map((check) => effectiveSourceStatus(check.status, check.evidenceStatus));
  return pickStrongestSourceStatus(statuses);
}

function effectiveSourceStatus(status: SourceBadgeStatus, evidenceStatus?: "trusted" | "limited" | "rejected"): SourceBadgeStatus {
  if ((status === "verified" || status === "contradicted") && evidenceStatus === "rejected") return "no_clear_source";
  if ((status === "verified" || status === "contradicted") && evidenceStatus === "limited") return "no_clear_source";
  return status || "no_clear_source";
}

function pickStrongestSourceStatus(statuses: SourceBadgeStatus[]): SourceBadgeStatus {
  if (statuses.some((status) => status === "contradicted")) return "contradicted";
  if (statuses.some((status) => status === "verified")) return "verified";
  if (statuses.some((status) => status === "checking")) return "checking";
  if (statuses.some((status) => status === "cannot_verify")) return "cannot_verify";
  return "no_clear_source";
}

function LiveCardMeta({
  sideColor,
  children
}: {
  sideColor: "blue" | "red";
  children: ReactNode;
}) {
  return (
    <div className={`artifactBadges liveMeta side-${sideColor}`}>{children}</div>
  );
}

function LiveQuote({
  children,
  speakerId,
  sideColor,
  speakerLabel
}: {
  children?: ReactNode;
  speakerId?: string;
  sideColor?: "blue" | "red";
  speakerLabel?: (speakerId?: string) => string;
}) {
  if (!children) return null;
  return (
    <blockquote className={`liveQuote ${sideColor ? `speaker-${sideColor}` : ""}`}>
      {speakerId && <span className={`quoteSpeaker speaker-${sideColor || "neutral"}`}>{speakerLabel ? speakerLabel(speakerId) : speakerId}</span>}
      <p>{children}</p>
    </blockquote>
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function exportTranscriptTxt({
  project,
  debate,
  turns,
  speakerLabel
}: {
  project: ProjectMeta;
  debate: DebateState;
  turns: TranscriptTurn[];
  speakerLabel: (speakerId?: string) => string;
}) {
  const title = cleanExportText(project.title || DEFAULT_PROJECT_TITLE);
  const finalTurns = turns.filter((turn) => turn.isFinal);
  const cleanedUtterances = [...(debate.utterances || [])].sort((a, b) => Number(a.startSec ?? a.at ?? 0) - Number(b.startSec ?? b.at ?? 0));
  const lines: string[] = [
    "debatly transcript",
    `Project: ${title}`,
    `Generated: ${new Date().toLocaleString()}`,
    "",
    "CLEANED DIARIZED TRANSCRIPT",
    ""
  ];

  if (cleanedUtterances.length) {
    for (const utterance of cleanedUtterances) {
      lines.push(`[${formatTranscriptStamp(utterance.startSec, utterance.at)}] ${speakerLabel(utterance.speakerId)}: ${cleanExportText(utterance.text || utterance.quote)}`);
    }
  } else {
    lines.push("No cleaned utterances are available yet.");
  }

  lines.push("", "RAW DIARIZED TRANSCRIPT", "");
  if (finalTurns.length) {
    for (const turn of finalTurns) {
      lines.push(`[${formatTranscriptStamp(turn.startSec, turn.at)}] ${speakerLabel(turn.speakerId)}: ${cleanExportText(turn.text)}`);
    }
  } else {
    lines.push("No final transcript turns are available yet.");
  }

  downloadTextFile(`${safeExportFilename(title || "debate")}-transcript.txt`, lines.join("\n"));
}

function cleanExportText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeExportFilename(value: string) {
  const cleaned = cleanExportText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || "debate";
}

function formatTranscriptStamp(startSec?: number, at?: number) {
  if (Number.isFinite(Number(startSec))) {
    const seconds = Math.max(0, Math.floor(Number(startSec)));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (Number.isFinite(Number(at))) return new Date(Number(at)).toLocaleTimeString();
  return "?:??";
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  downloadBlobFile(filename, blob, "text/plain;charset=utf-8");
}

function downloadBlobFile(filename: string, blob: Blob, type?: string) {
  const normalizedBlob = type && blob.type !== type ? new Blob([blob], { type }) : blob;
  const url = URL.createObjectURL(normalizedBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// =============================================================================
// DEBATE REPORT VIEW  —  post-debate report, rendered above the transcript.
// Built from the SAME primitives as the rest of the app (cards with full hairline
// borders + side-tinted borders, ArtifactTag pills, the LiveQuote box) so it is
// visually indistinguishable from the live desk. No colored edge sleeves, no
// colored quote rules. Charts use Recharts.
// =============================================================================

function formatReportDuration(ms: number) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function minuteToClock(minute: number) {
  const total = Math.max(0, Math.round(minute * 60));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Compact axis label for crowded bar charts: "Speaker 14" -> "Sp.14".
function abbrevSpeakerLabel(label: string) {
  const m = /^\s*speaker\s+(\w+)\s*$/i.exec(label || "");
  if (m) return `Sp.${m[1]}`;
  return (label || "").length > 8 ? `${label.slice(0, 7)}…` : (label || "");
}

// Recharts sets colors as SVG ATTRIBUTES, where CSS var() does not resolve — and
// reading them via getComputedStyle lagged a frame behind the theme toggle. So we
// keep a static palette (mirrors the CSS tokens) keyed on the active theme; the
// chart re-renders the instant themeMode changes. The hover cursor uses a
// theme-neutral translucent grey so it can never flash the wrong theme.
const CHART_PALETTE = {
  light: { blue: "#147fa3", red: "#b64a46", hairline: "#e7e5e4", hairlineStrong: "#d6d3d1", muted: "#5c564f", ink: "#0c0a09" },
  dark: { blue: "#5fc6df", red: "#f07f76", hairline: "rgba(255,255,255,0.12)", hairlineStrong: "rgba(255,255,255,0.2)", muted: "#a8a29e", ink: "#ffffff" }
} as const;
const CHART_CURSOR_FILL = "rgba(128, 128, 128, 0.14)";
function getChartColors(themeMode: "light" | "dark") {
  return CHART_PALETTE[themeMode] || CHART_PALETTE.light;
}


// An old-format report (pre-rewrite) lacks the new fields. Detect it so we never
// crash the page on a shape mismatch (e.g. server not yet restarted).
function isRenderableReport(report: DebateReport | null | undefined): report is DebateReport {
  return Boolean(report && report.scoreboard && report.scoreboard.blue && report.scoreboard.red);
}

function ReportSecHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="reportSecHead">
      <h3>{title}</h3>
      {subtitle && <span>{subtitle}</span>}
    </div>
  );
}

const DebateReportView = forwardRef<HTMLDivElement, { report: DebateReport; speakerLabel: (s?: string) => string; themeMode: "light" | "dark" }>(
  function DebateReportView({ report, speakerLabel, themeMode }, ref) {
    if (!isRenderableReport(report)) {
      return (
        <section className="reportSection" ref={ref} aria-label="Debate report">
          <header className="reportTopBar">
            <span className="reportKicker"><Gavel size={15} /> Debate report</span>
          </header>
          <div className="reportCard"><p className="reportLedeBody">This report was generated in an older format. Stop and generate the report again to see the full breakdown.</p></div>
        </section>
      );
    }

    return (
      <section className="reportSection" ref={ref} aria-label="Debate report">
        <header className="reportTopBar">
          <span className="reportKicker"><Gavel size={15} /> Debate report</span>
          <span className="reportDuration"><Clock size={13} /> {formatReportDuration(report.durationMs || 0)}</span>
        </header>

        <ReportLede report={report} />

        {(report.scoreTimeline?.points?.length || 0) >= 2 && (
          <div className="reportSec">
            <ReportSecHead title="How the score moved" subtitle="Credibility score over the debate" />
            <ReportScoreJourney timeline={report.scoreTimeline} entries={report.speakerEntries || []} speakerLabel={speakerLabel} themeMode={themeMode} />
          </div>
        )}

        {(report.speakers?.length || 0) > 0 && (
          <div className="reportSec">
            <ReportSecHead title="The speakers" subtitle="Who held up, and who got caught out" />
            <ReportSpeakerSection speakers={report.speakers} speakerLabel={speakerLabel} themeMode={themeMode} />
          </div>
        )}

        {(report.blueSummary || report.redSummary) && (
          <div className="reportSec">
            <ReportSecHead title="The two cases" />
            <ReportSideSummaries report={report} />
          </div>
        )}

        {(report.keyMoments?.length || 0) > 0 && (
          <div className="reportSec">
            <ReportSecHead title="Turning points" />
            <ReportKeyMoments items={report.keyMoments} speakerLabel={speakerLabel} />
          </div>
        )}

        <ReportMethodology />
      </section>
    );
  }
);

// ---- The reading (verdict) --------------------------------------------------
function ReportLede({ report }: { report: DebateReport }) {
  const blue = report.scoreboard?.blue?.score ?? 0;
  const red = report.scoreboard?.red?.score ?? 0;
  const lead = blue === red ? "even" : blue > red ? "blue" : "red";
  const headline = lead === "even"
    ? "The sides finished level on credibility"
    : `${lead === "blue" ? "Blue" : "Red"} side ended ahead on credibility`;
  const paras = (report.verdict || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className={`reportCard reportLedeCard ${lead}`}>
      <p className={`reportLedeHeadline ${lead}`}>{headline}</p>
      <div className="reportLedeBody">
        {paras.map((p, i) => <p key={i}>{p}</p>)}
      </div>
    </div>
  );
}

// ---- The score journey (line chart) -----------------------------------------
function ReportScoreJourney({ timeline, entries, speakerLabel, themeMode }: { timeline: ReportScoreTimeline; entries: ReportSpeakerEntry[]; speakerLabel: (s?: string) => string; themeMode: "light" | "dark" }) {
  const isMobile = useIsMobile();
  const points = timeline?.points || [];
  if (points.length < 2) return null;
  const data = points.map((p) => ({
    minute: p.minute,
    blue: p.blue,
    red: p.red,
    event: p.event && p.event.kind !== "open" ? p.event.label : ""
  }));
  const c = getChartColors(themeMode);
  const startMinute = Number.isFinite(Number(timeline.debateStartMinute)) ? Number(timeline.debateStartMinute) : data[0].minute;
  const maxMinute = Number(timeline.maxMinute) || data[data.length - 1].minute || startMinute + 1;
  // Entry markers: numbered dotted lines tied to the strip below. Speakers already
  // talking when the gate opened (minute below the start) are clamped to the start
  // so blue/opening speakers still appear; their true entry time stays in the strip.
  const marks = (entries || [])
    .filter((e) => e.minute <= maxMinute + 0.05)
    .map((e) => ({ ...e, lineMinute: Math.min(maxMinute, Math.max(startMinute, e.minute)) }));
  const fmtMinute = (m: number) => `${Math.round(m)}m`;
  return (
    <div className="reportCard reportChartCard">
      <div className="reportChartTopline">
        <span className="reportChartFlag"><i />Debate starts at {minuteToClock(startMinute)}</span>
      </div>
      <div className="reportChartFrame">
        <ResponsiveContainer width="100%" height={isMobile ? 230 : 300}>
          <LineChart data={data} margin={{ top: 16, right: isMobile ? 12 : 30, bottom: 14, left: isMobile ? 0 : 10 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={c.hairline} />
            <XAxis dataKey="minute" type="number" domain={[startMinute, maxMinute]} tickFormatter={fmtMinute} tick={{ fontSize: isMobile ? 10 : 12, fill: c.muted }} tickMargin={isMobile ? 8 : 12} axisLine={{ stroke: c.hairline }} tickLine={false} />
            <YAxis tick={{ fontSize: isMobile ? 10 : 12, fill: c.muted }} axisLine={false} tickLine={false} width={isMobile ? 30 : 42} tickMargin={isMobile ? 6 : 10} allowDecimals={false} domain={["dataMin - 3", "dataMax + 4"]} />
            <ReferenceLine y={0} stroke={c.hairlineStrong} strokeWidth={1} />
            {marks.map((e, i) => (
              <ReferenceLine
                key={`${e.speakerId}-${i}`}
                x={e.lineMinute}
                stroke={e.side === "red" ? c.red : e.side === "blue" ? c.blue : c.hairlineStrong}
                strokeDasharray="2 5"
                strokeOpacity={0.5}
                label={isMobile ? undefined : { value: String(i + 1), position: "top", fontSize: 10, fontWeight: 600, fill: e.side === "red" ? c.red : e.side === "blue" ? c.blue : c.muted }}
              />
            ))}
            <Tooltip content={<JourneyTooltip />} cursor={{ stroke: c.hairlineStrong, strokeWidth: 1 }} />
            <Line type="monotone" dataKey="blue" name="Blue side" stroke={c.blue} strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} />
            <Line type="monotone" dataKey="red" name="Red side" stroke={c.red} strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="reportLegend">
        <span className="blue"><i />Blue side</span>
        <span className="red"><i />Red side</span>
        {marks.length > 0 && <span className="entry"><i />Speaker enters</span>}
      </div>
      {marks.length > 0 && (
        <ul className="reportEntryStrip">
          {marks.map((e, i) => (
            <li key={`${e.speakerId}-${i}`} className={e.side || ""}>
              <span className="reportEntryNum">{i + 1}</span>
              <span className={`reportDot speaker-${e.side || "neutral"}`} />
              {speakerLabel(e.speakerId)}
              <span className="reportEntryTime">{minuteToClock(e.minute)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JourneyTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ payload?: { blue?: number; red?: number; event?: string } }>; label?: number | string }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <div className="reportTooltip">
      <div className="reportTooltipTime">{minuteToClock(Number(label) || 0)}</div>
      <div className="reportTooltipScores">
        <span className="blue">Blue {row.blue}</span>
        <span className="red">Red {row.red}</span>
      </div>
      {row.event && <div className="reportTooltipEvent">{row.event}</div>}
    </div>
  );
}

// ---- The speakers (bar chart + judging cards) -------------------------------
function ReportSpeakerSection({ speakers, speakerLabel, themeMode }: { speakers: ReportSpeaker[]; speakerLabel: (s?: string) => string; themeMode: "light" | "dark" }) {
  const isMobile = useIsMobile();
  if (!speakers.length) return null;
  const data = speakers.map((s) => ({ name: speakerLabel(s.speakerId), score: s.score, side: s.side }));
  const c = getChartColors(themeMode);
  return (
    <div className="reportSpeakerBlock">
      <div className="reportCard reportChartCard">
        {/* On phones the bar labels can't fit (too many speakers) — hide the axis
            labels and let the per-speaker cards below act as the legend. */}
        <div className="reportChartFrame">
          <ResponsiveContainer width="100%" height={isMobile ? 210 : 260}>
            <BarChart data={data} margin={{ top: 24, right: isMobile ? 8 : 16, bottom: isMobile ? 4 : 12, left: isMobile ? 0 : 8 }} barCategoryGap="28%">
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={c.hairline} />
              <XAxis dataKey="name" tickFormatter={abbrevSpeakerLabel} tick={isMobile ? false : { fontSize: 11, fill: c.muted }} height={isMobile ? 8 : 30} tickMargin={10} axisLine={{ stroke: c.hairline }} tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: isMobile ? 10 : 12, fill: c.muted }} axisLine={false} tickLine={false} width={isMobile ? 30 : 40} tickMargin={8} allowDecimals={false} domain={["dataMin - 4", "dataMax + 4"]} />
              <ReferenceLine y={0} stroke={c.hairlineStrong} strokeWidth={1} />
              <Tooltip content={<SpeakerBarTooltip />} cursor={{ fill: CHART_CURSOR_FILL }} />
              <Bar dataKey="score" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
                {data.map((d, i) => <Cell key={i} fill={d.side === "blue" ? c.blue : c.red} />)}
                <LabelList dataKey="score" position="top" style={{ fill: c.ink, fontSize: isMobile ? 10 : 12, fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="reportSpeakerList">
        {speakers.map((s) => {
          const hasChips = (s.stats.verified || s.stats.contradicted || s.stats.misleading || s.stats.inconsistencies) > 0;
          return (
            <article key={s.speakerId} className={`reportSpeakerCard ${s.side}`}>
              <div className="reportSpeakerIdentity">
                <span className="reportSpeakerName"><i className={`reportDot speaker-${s.side}`} />{speakerLabel(s.speakerId)}</span>
                <span className="reportSpeakerScore">{s.score > 0 ? `+${s.score}` : s.score}</span>
                {hasChips && (
                  <div className="artifactBadges reportSpeakerChips">
                    {s.stats.verified > 0 && <ArtifactTag className="statusBadge status-verified" icon={BadgeCheck}>{s.stats.verified} verified</ArtifactTag>}
                    {s.stats.contradicted > 0 && <ArtifactTag className="statusBadge status-contradicted" icon={CircleX}>{s.stats.contradicted} false</ArtifactTag>}
                    {s.stats.misleading > 0 && <ArtifactTag className="statusBadge status-misleading" icon={TriangleAlert}>{s.stats.misleading} misleading</ArtifactTag>}
                    {s.stats.inconsistencies > 0 && <ArtifactTag className="statusBadge status-no_clear_source" icon={Repeat}>{s.stats.inconsistencies} self-contradiction{s.stats.inconsistencies > 1 ? "s" : ""}</ArtifactTag>}
                  </div>
                )}
              </div>
              <div className="reportSpeakerBody">
                {s.verdict && <p className="reportSpeakerVerdict">{s.verdict}</p>}
                {s.standoutQuote?.text && (
                  <LiveQuote speakerId={s.speakerId} sideColor={s.side} speakerLabel={speakerLabel}>{s.standoutQuote.text}</LiveQuote>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function SpeakerBarTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: { name?: string; score?: number; side?: string } }> }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <div className="reportTooltip">
      <div className="reportTooltipTime">{row.name}</div>
      <div className="reportTooltipScores">
        <span className={row.side === "red" ? "red" : "blue"}>Credibility {Number(row.score) > 0 ? `+${row.score}` : row.score}</span>
      </div>
    </div>
  );
}

// ---- The two cases ----------------------------------------------------------
function ReportSideSummaries({ report }: { report: DebateReport }) {
  if (!report.blueSummary && !report.redSummary) return null;
  return (
    <div className="reportSideGrid">
      <div className="reportCard reportSideCase blue">
        <span className="reportSideTag blue"><i />Blue side</span>
        <p>{report.blueSummary || "No clear case formed."}</p>
      </div>
      <div className="reportCard reportSideCase red">
        <span className="reportSideTag red"><i />Red side</span>
        <p>{report.redSummary || "No clear case formed."}</p>
      </div>
    </div>
  );
}

// ---- Turning points (key moments) -------------------------------------------
function ReportKeyMoments({ items, speakerLabel }: { items: ReportKeyMoment[]; speakerLabel: (s?: string) => string }) {
  if (!items.length) return null;
  return (
    <div className="reportMomentGrid">
      {items.map((m, i) => {
        const positive = m.impact === "positive";
        const negative = m.impact === "negative";
        const sideName = m.side === "blue" ? "Blue side" : m.side === "red" ? "Red side" : "";
        return (
          <article key={i} className="reportCard reportMomentCard">
            <header>
              {m.side && <span className={`reportSideTag ${m.side}`}><i />{sideName}</span>}
              {(positive || negative) && (
                <span className={`reportImpact ${positive ? "positive" : "negative"}`}>
                  {positive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                  {positive ? "Gained ground" : "Lost ground"}
                </span>
              )}
            </header>
            <h4>{m.title}</h4>
            {m.detail && <p>{m.detail}</p>}
            {m.quote && <LiveQuote sideColor={m.side || undefined} speakerLabel={speakerLabel}>{m.quote}</LiveQuote>}
          </article>
        );
      })}
    </div>
  );
}

// ---- Methodology footer -----------------------------------------------------
function ReportMethodology() {
  return (
    <div className="reportCard reportMethodology">
      <span className="reportMethodologyTag"><Scale size={13} /> How this is scored</span>
      <p>
        This is a <strong>credibility score</strong>, not a measure of who talked more or whose opinion is right.
        Both sides start at zero. A verified claim earns <strong>+3</strong>; a claim caught out as false costs <strong>-5</strong>;
        a misleading claim <strong>-2</strong>; a self-contradiction <strong>-4</strong>. Strong debate points add a small,
        capped bonus so volume can't outweigh accuracy. "Unverified" means we couldn't find a clear source either way —
        it neither helps nor hurts. We present the facts and our reading; you decide who came out ahead.
      </p>
    </div>
  );
}

function buildFeaturedQuoteItem({
  artifacts,
  turns,
  sideViews,
  scorecard,
  durationMs,
  report
}: {
  artifacts: DebateArtifacts;
  turns: TranscriptTurn[];
  sideViews: SideView[];
  scorecard: Scorecard;
  durationMs: number;
  report?: DebateReport | null;
}): QuoteStripItem | null {
  const lead = getLedgerLead(scorecard).side;
  const leaderSideId: SideId | undefined = lead === "blue" ? "side-a" : lead === "red" ? "side-b" : undefined;
  const reportQuote = buildReportFeaturedQuote(report, leaderSideId);
  if (reportQuote) return reportQuote;

  const candidates: Array<QuoteStripItem & { weight: number; key: string }> = [];
  const eventWeightByArtifact = scoreEventWeightByArtifact(scorecard, lead);
  const addCandidate = ({
    speakerId,
    sideId,
    text,
    atSec,
    weight,
    claimMode,
    quoteRole,
    topicContinuity
  }: {
    speakerId?: string;
    sideId?: SideId;
    text?: string;
    atSec?: number;
    weight: number;
    claimMode?: string;
    quoteRole?: string;
    topicContinuity?: string;
  }) => {
    const clean = compactQuoteText(text || "");
    if (!clean || clean.length < 18) return;
    if (wordCountText(clean) > 32 || clean.length > 230) return;
    if (looksLikeIncompleteUiQuote(clean)) return;
    if (looksLikeReportedOrMetaUiQuote(clean, { claimMode, quoteRole, topicContinuity })) return;
    if (!hasCompleteContextUiQuote(clean)) return;
    const quoteScore = featuredQuoteScore(clean);
    const resolvedSide = sideId || (speakerId ? sideForSpeaker(sideViews, speakerId) : undefined);
    if (leaderSideId && resolvedSide !== leaderSideId) return;
    const sideColor = resolvedSide === "side-a" ? "blue" : resolvedSide === "side-b" ? "red" : undefined;
    const key = normalizeUiText(clean).slice(0, 90);
    if (candidates.some((item) => item.key === key)) return;
    candidates.push({
      speakerId: speakerId || "Debate audio",
      sideColor,
      text: clean,
      atSec,
      weight: weight + quoteScore,
      key
    });
  };

  for (const claim of artifacts.claims || []) {
    addCandidate({
      speakerId: claim.speakerId,
      sideId: claim.sideId,
      text: claim.quote,
      atSec: secondsFromArtifact(claim),
      weight: 6 + Number(claim.importance || 0) + Number(eventWeightByArtifact.get(claim.id) || 0) + (claim.status === "verified" ? 2 : 0),
      claimMode: claim.claimMode,
      quoteRole: claim.quoteRole,
      topicContinuity: claim.topicContinuity
    });
  }
  for (const challenge of artifacts.clashes || []) {
    addCandidate({
      speakerId: challenge.speakerId,
      sideId: challenge.sideId,
      text: challenge.sourceQuote || challenge.challengerResponse,
      atSec: secondsFromArtifact(challenge),
      weight: 7 + Math.round(Number(challenge.strength || 0) * 3) + Number(eventWeightByArtifact.get(challenge.id) || 0)
    });
  }
  for (const item of artifacts.inconsistencies || []) {
    addCandidate({
      speakerId: item.quoteBSpeakerId || item.quoteASpeakerId || item.speakerId,
      sideId: item.accusedSideId || item.sideId,
      text: item.quoteB || item.quoteA,
      atSec: secondsFromArtifact(item),
      weight: item.severity === "high" ? 10 : item.severity === "medium" ? 7 : 5
    });
  }
  const currentSec = Math.max(
    durationMs / 1000,
    ...candidates.map((item) => Number(item.atSec || 0)),
    0
  );
  const bucketStart = Math.max(0, Math.floor(currentSec / 60) * 60);
  const recent = candidates
    .filter((item) => item.atSec === undefined || (Number(item.atSec) >= bucketStart && Number(item.atSec) <= bucketStart + 60))
    .sort((a, b) => b.weight - a.weight || Number(b.atSec || 0) - Number(a.atSec || 0));
  const [featured] = recent
    .filter((item, index, list) => list.findIndex((candidate) => candidate.key === item.key) === index)
    .slice(0, 1)
    .map(({ weight: _weight, key: _key, ...item }) => item);
  return featured || null;
}

function buildReportFeaturedQuote(report: DebateReport | null | undefined, leaderSideId?: SideId): QuoteStripItem | null {
  if (!report) return null;
  const leaderColor = leaderSideId === "side-a" ? "blue" : leaderSideId === "side-b" ? "red" : undefined;
  // Pull candidate quotes from key moments first, then speakers' standout lines.
  const candidates: QuoteStripItem[] = [];
  for (const moment of report.keyMoments || []) {
    if (moment.quote) {
      candidates.push({
        speakerId: moment.side ? `${moment.side === "blue" ? "Blue" : "Red"} side` : "Debate audio",
        sideColor: moment.side || undefined,
        text: compactQuoteText(moment.quote),
        atSec: undefined
      });
    }
  }
  for (const speaker of report.speakers || []) {
    if (speaker.standoutQuote?.text) {
      candidates.push({
        speakerId: speaker.speakerId,
        sideColor: speaker.side,
        text: compactQuoteText(speaker.standoutQuote.text),
        atSec: undefined
      });
    }
  }
  const usable = candidates
    .filter((quote) => quote.text && !looksLikeIncompleteUiQuote(quote.text) && !looksLikeReportedOrMetaUiQuote(quote.text) && hasCompleteContextUiQuote(quote.text) && wordCountText(quote.text) <= 32);
  // Prefer the leading side's quote, else the highest-scoring line.
  const leaderQuote = leaderColor ? usable.filter((q) => q.sideColor === leaderColor) : [];
  const pool = leaderQuote.length ? leaderQuote : usable;
  return pool.sort((a, b) => featuredQuoteScore(b.text) - featuredQuoteScore(a.text))[0] || null;
}

function scoreEventWeightByArtifact(scorecard: Scorecard, lead: "blue" | "red" | "even") {
  const map = new Map<string, number>();
  if (lead === "even") return map;
  const events = scorecard[lead]?.events || [];
  for (const event of events) {
    const value = Math.max(0, Number(event.delta || 0));
    for (const id of event.artifactIds || []) {
      map.set(id, Math.max(map.get(id) || 0, value));
    }
  }
  return map;
}

function secondsFromArtifact(item: { startSec?: number; endSec?: number }) {
  const end = Number(item?.endSec);
  const start = Number(item?.startSec);
  if (Number.isFinite(end)) return end;
  if (Number.isFinite(start)) return start;
  return undefined;
}

function compactQuoteText(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return pickSingleQuoteStatement(clean);
}

function pickSingleQuoteStatement(text: string) {
  const statements = splitQuoteStatements(text);
  if (!statements.length) return text;
  return [...statements].sort((a, b) => featuredQuoteScore(b) - featuredQuoteScore(a))[0] || text;
}

function splitQuoteStatements(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const pieces = clean.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [clean];
  return pieces
    .map((piece) => piece.trim())
    .filter(Boolean)
    .filter((piece) => wordCountText(piece) >= 5);
}

function featuredQuoteScore(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return -100;
  const words = wordCountText(clean);
  let score = 0;
  if (words >= 8 && words <= 24) score += 18;
  else if (words >= 6 && words <= 30) score += 12;
  else if (words >= 5 && words <= 34) score += 6;
  else score -= Math.abs(words - 22);
  if (/[.!?]["')\]]*$/.test(clean)) score += 4;
  if (/[?]$/.test(clean) && /\b(why|how|what|when|where|who|which)\b/i.test(clean)) score += 2;
  if (looksLikeIncompleteUiQuote(clean)) score -= 30;
  if (!hasCompleteContextUiQuote(clean)) score -= 45;
  if (clean.length > 220) score -= Math.ceil((clean.length - 220) / 18);
  return score;
}

function hasCompleteContextUiQuote(text: string) {
  const normalized = normalizeUiText(text);
  const words = wordCountText(text);
  if (!normalized || words < 8 || words > 30) return false;
  if (/\b(i think it goes to|it goes to|this goes to|that goes to)\b/.test(normalized)) return false;
  if (/^(that is|that s|thats|this is|it is|its)\s+(true|fair|right|wrong|bad|good|important|interesting|valid)\b/.test(normalized) && words <= 12) return false;
  if (/^(i agree|fair point|fair enough|sure|okay|right)\b/.test(normalized) && words <= 12) return false;
  const hasConcreteSubject = /\b(people|civilians|government|officials|court|law|country|state|military|minister|leader|children|families|evidence|source|numbers|policy|standard|intent|motive|claim|case)\b/.test(normalized)
    || /\b[A-Z][a-z]{2,}\b/.test(text)
    || /\b\d{2,}\b/.test(normalized)
    || normalized.split(/\s+/).filter((token) => token.length > 4 && !["because", "therefore", "should", "would", "could", "think", "believe"].includes(token)).length >= 5;
  const hasAction = /\b(should|must|because|shows|proves|means|killed|displaced|targeted|supports|rejects|distinguishes|compares|counts|requires|ordered|criticized|answered|challenged)\b/.test(normalized);
  return hasConcreteSubject && hasAction;
}

function looksLikeIncompleteUiQuote(text: string) {
  const normalized = normalizeUiText(text);
  if (!normalized) return true;
  if (wordCountText(normalized) < 5) return true;
  if (/\b(i|we|you|they|he|she)\s+(do not|don t|dont|did not|didn t|didnt|cannot|can t|cant|would not|wouldn t|wouldnt|will not|won t|wont)?\s*(think|believe|mean|know|see|say)$/.test(normalized)) return true;
  if (/\b(because|when|while|although|but|and|or|so|for example|who|who is|who s|whose|which|that|where)$/.test(normalized)) return true;
  return false;
}

function looksLikeReportedOrMetaUiQuote(
  text: string,
  meta: { claimMode?: string; quoteRole?: string; topicContinuity?: string } = {}
) {
  const normalized = normalizeUiText(text);
  if (!normalized) return true;
  if (["reported_opponent_claim", "meta_commentary", "off_topic"].includes(meta.claimMode || "")) return true;
  if (["opponent_quote", "external_quote"].includes(meta.quoteRole || "")) return true;
  if (["meta", "off_topic"].includes(meta.topicContinuity || "")) return true;
  if (/\b(you said|you called|you are saying|you re saying|they would say|he would say|she would say|he said|she said|they said|they are saying|they re saying|his words|her words|their words|i have a quote|got a quote|quote from you|best strategy|in a debate|on the offensive|defensive stance)\b/.test(normalized)) return true;
  return false;
}

function wordCountText(text: string) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function normalizeUiText(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sideForSpeaker(sideViews: SideView[], speakerId: string): SideId | undefined {
  const side = sideViews.find((candidate) => candidate.speakers.some((speaker) => speaker.id === speakerId));
  return side?.id === "side-a" || side?.id === "side-b" ? side.id : undefined;
}

function sideForTurn(sideViews: SideView[], turn: TranscriptTurn): SideId | undefined {
  if (turn.contextOnly || turn.speakerRole === "neutral_speaker") return undefined;
  const ownerSide = turn.ownerSideId === "side-a" || turn.ownerSideId === "side-b" ? turn.ownerSideId : undefined;
  const ownershipConfidence = Number(turn.ownerSideConfidence || 0);
  if (ownerSide && (turn.scoreEligible || turn.claimEligible || turn.stanceBearing || ownershipConfidence >= 0.6)) {
    return ownerSide;
  }
  return sideForSpeaker(sideViews, turn.speakerId);
}

function sideColorForTurn(sideViews: SideView[], turn: TranscriptTurn): "blue" | "red" | undefined {
  const side = sideForTurn(sideViews, turn);
  if (side === "side-a") return "blue";
  if (side === "side-b") return "red";
  return undefined;
}

// Color for the transcript speaker dot, using the live clean-pipeline speaker→side
// map as the authoritative source (it holds the Side Builder's assignments), with
// the older sideViews path as a fallback. Context-only turns stay neutral.
function transcriptDotColor(
  liveAnalysis: LiveAnalysis | null,
  sideViews: SideView[],
  turn: TranscriptTurn
): "blue" | "red" | undefined {
  if (turn.contextOnly || turn.speakerRole === "neutral_speaker") return undefined;
  const liveSide = liveAnalysis?.speakers?.[turn.speakerId]?.side;
  const normalized = String(liveSide || "").toLowerCase();
  if (normalized === "blue") return "blue";
  if (normalized === "red") return "red";
  return sideColorForTurn(sideViews, turn);
}

function getStabilizerContextWindows(debate: DebateState): DialogueWindow[] {
  return (debate.dialogueWindows || [])
    .filter((window) => window.windowStatus === "held" || window.contextOnly || window.reason === "possible_ad_or_sponsor_break")
    .slice()
    .sort((a, b) => contextWindowSortValue(a) - contextWindowSortValue(b));
}

function contextWindowSortValue(window: DialogueWindow) {
  const start = Number(window.startSec);
  if (Number.isFinite(start)) return start;
  return Number(window.at || 0);
}

function formatContextWindowRange(window: DialogueWindow) {
  const start = Number(window.startSec);
  const end = Number(window.endSec);
  if (Number.isFinite(start)) {
    const suffix = Number.isFinite(end) && end > start ? `-${formatSeconds(end)}` : "";
    return `Gate held ${formatSeconds(start)}${suffix}`;
  }
  return "Gate held a context segment";
}

function formatContextLabel(value?: string) {
  const normalized = String(value || "").toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(ad|sponsor|promotion|commercial)\b/.test(normalized)) return "Ad or sponsor segment";
  if (normalized.includes("context")) return "Context segment";
  return "Held segment";
}

function uniqueStringList(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function SourceLine({ check, speakerLabel }: { check: SourceCheckArtifact; speakerLabel: (speakerId?: string) => string }) {
  const displayStatus = effectiveSourceStatus(check.status, check.evidenceStatus);
  return (
    <div className={`sourceLine status-${displayStatus}`}>
      <span>{formatFactStatus(displayStatus)}</span>
      <p><SpeakerLinkedText text={check.explanation} speakerLabel={speakerLabel} /></p>
      {check.sources[0] && (
        <a href={check.sources[0].uri} target="_blank" rel="noreferrer">
          <ExternalLink size={13} />
          {check.sources[0].title || "source"}
        </a>
      )}
    </div>
  );
}

function SideColumn({ side }: { side: SideView }) {
  const thesisLabel = displaySideThesis(side);
  return (
    <section className={`sideColumn ${side.color || "blue"}`}>
      <header>
        <span>{side.color === "red" ? "Red side" : "Blue side"}</span>
        <strong>{thesisLabel || "Thesis forming"}</strong>
      </header>
      <div className="sideNumbers">
        <span>{side.speakers.length} speaker{side.speakers.length === 1 ? "" : "s"}</span>
        <span>{side.metrics?.points ?? 0} pts</span>
        <span>{side.metrics?.supported ?? 0} verified</span>
      </div>
      {side.metrics && (
        <div className="coreMini">
          <span>{side.metrics.disputed} disputed</span>
          <span>{side.metrics.unclear} unresolved</span>
        </div>
      )}
      <div className="speakerStack">
        {side.speakers.length === 0 ? (
          <p className="empty compact">Awaiting assigned speakers.</p>
        ) : (
          side.speakers.map((speaker) => <SpeakerCard key={speaker.id} sideColor={side.color || "blue"} speaker={speaker} />)
        )}
      </div>
    </section>
  );
}

function SpeakerCard({
  speaker,
  sideColor
}: {
  speaker: { id: string; profile?: SpeakerProfile; points: DebatePoint[]; turns: TranscriptTurn[] };
  sideColor: "blue" | "red";
}) {
  return (
    <article className={`speakerCard ${sideColor}`}>
      <div className="speakerHeader">
        <span>{speaker.id}</span>
        <small>{speaker.points.length} point{speaker.points.length === 1 ? "" : "s"}</small>
      </div>
      {speaker.profile?.assignmentReason && <p className="assignmentReason">{speaker.profile.assignmentReason}</p>}
      {speaker.points.length === 0 ? (
        <p className="empty compact">Listening for a checkable point.</p>
      ) : (
        speaker.points.slice(0, 8).map((point) => <PointCard key={point.id} point={point} />)
      )}
    </article>
  );
}

function PointCard({ point }: { point: DebatePoint }) {
  const timeLabel = new Date(point.at).toLocaleTimeString();
  return (
    <details className={`claim ${point.factStatus}`}>
      <summary>
        <div className="pointBadges">
          <span>{formatRole(point.role)}</span>
          <span>{formatFactStatus(point.factStatus)}</span>
        </div>
        <p>{point.claim}</p>
      </summary>
      <div className="claimDetail">
        <blockquote>{point.quote}</blockquote>
        <small>{point.why}</small>
        <small>{timeLabel}{point.startSec !== undefined ? ` | ${point.startSec.toFixed(1)}s` : ""}</small>
        {point.sources[0] ? (
          <a href={point.sources[0].uri} target="_blank" rel="noreferrer">
            <ExternalLink size={13} />
            {point.sources[0].title || "source"}
          </a>
        ) : (
          <small>{point.noSourceReason || "No source attached yet."}</small>
        )}
      </div>
    </details>
  );
}

function buildSideViews(debate: DebateState, turns: TranscriptTurn[]): SideView[] {
  const baseSides = ensureUiSides(debate.sides);
  const durableSpeakers = debate.speakers || [];
  const directPoints = directDebatePointsForSideViews(debate);
  const legacyPoints = (debate.points || []).filter(isVisibleDebatePoint);
  const points = uniqueDebatePointsForUi([...legacyPoints, ...directPoints]);
  return baseSides.map((side) => {
    const sideId: SideId = side.id === "side-b" ? "side-b" : "side-a";
    const ledgerSpeakerIds = points
      .filter((point) => point.sideId === sideId)
      .map((point) => point.speakerId);
    const speakerIds = uniqueUiStrings([...(side.speakerIds || []), ...ledgerSpeakerIds]);
    const speakers = speakerIds
      .filter((speakerId) =>
        durableSpeakers.some((speaker) => speaker.speakerId === speakerId && speaker.sideId === sideId)
        || points.some((point) => point.speakerId === speakerId && point.sideId === sideId)
      )
      .map((speakerId) => ({
        id: speakerId,
        profile: durableSpeakers.find((speaker) => speaker.speakerId === speakerId),
        points: points.filter((point) => point.speakerId === speakerId && point.sideId === sideId),
        turns: turns.filter((turn) => turn.speakerId === speakerId && turn.isFinal)
      }));
    traceSpeakerRosterVisibility(debate, sideId, speakers);
    return {
      ...side,
      speakerIds,
      speakers
    };
  });
}

function uniqueUiStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function uniqueDebatePointsForUi(points: DebatePoint[]): DebatePoint[] {
  const byId = new Map<string, DebatePoint>();
  for (const point of points) {
    if (!point?.id) continue;
    byId.set(point.id, byId.get(point.id) || point);
  }
  return [...byId.values()];
}

function directDebatePointsForSideViews(debate: DebateState): DebatePoint[] {
  if (!isDirectAnalysisState(debate.analysis)) return [];
  return (debate.analysis.internal?.debatePoints || [])
    .map((row) => {
      const card = debatePointCardFromDirectRow(asRecord(row));
      if (!card) return null;
      const at = Number.isFinite(Number(card.startSec)) ? Number(card.startSec) * 1000 : 0;
      return {
        id: card.pointId,
        speakerId: card.speakerId,
        sideId: card.sideId,
        role: "claim",
        assertionStatus: "asserted",
        assertionWhy: "Direct Debate Point ledger entry.",
        sourceSpeakerId: card.speakerId,
        claim: card.point,
        quote: card.quote,
        turnIds: card.turnIds,
        at,
        startSec: card.startSec,
        endSec: card.endSec,
        factStatus: "checking",
        confidence: card.confidence || 0.7,
        why: card.reason || "Direct Debate Point ledger entry.",
        sources: [],
        audit: {
          quote: card.quote,
          turnIds: card.turnIds,
          at,
          startSec: card.startSec,
          endSec: card.endSec,
          factExplanation: "",
          sources: []
        }
      } as DebatePoint;
    })
    .filter((point): point is DebatePoint => Boolean(point));
}

function traceSpeakerRosterVisibility(
  debate: DebateState,
  sideId: SideId,
  speakers: SideView["speakers"]
) {
  const hiddenByOldVisibility = speakers
    .filter((speaker) => !isVisibleSpeaker(speaker))
    .map((speaker) => speaker.id);
  if (!hiddenByOldVisibility.length) return;
  const key = `${debate.analysis?.updatedAt || 0}:${sideId}:${hiddenByOldVisibility.join(",")}`;
  if (speakerRosterTraceKeys.has(key)) return;
  speakerRosterTraceKeys.add(key);
  if (speakerRosterTraceKeys.size > 120) speakerRosterTraceKeys.clear();
  console.info("[debatly speaker roster]", {
    side: sideId === "side-a" ? "Blue side" : "Red side",
    hiddenByOldVisibility,
    speakers: speakers.map((speaker) => ({
      speakerId: speaker.id,
      directPoints: speaker.points.length,
      localFinalTurns: speaker.turns.length,
      localFinalWords: speaker.turns.reduce((sum, turn) => sum + turn.text.trim().split(/\s+/).filter(Boolean).length, 0),
      confidence: speaker.profile?.sideConfidence || 0
    }))
  });
}

function getArtifacts(debate: DebateState): DebateArtifacts {
  if (isDirectAnalysisState(debate.analysis)) return artifactsFromAnalysis(debate.analysis);
  if (debate.artifacts) return {
    ...emptyArtifacts(),
    ...debate.artifacts
  };
  return emptyArtifacts();
}

function getIssueGroups(debate: DebateState): IssueGroup[] {
  void debate;
  return [];
}

function getBackendFeaturedQuoteItem(debate: DebateState): QuoteStripItem | null {
  const quote = debate.featuredQuote;
  if (!quote?.text) return null;
  return {
    speakerId: quote.speakerId || "Debate audio",
    sideColor: quote.sideColor || (quote.sideId === "side-a" ? "blue" : quote.sideId === "side-b" ? "red" : undefined),
    text: compactQuoteText(quote.text),
    rawText: quote.rawText,
    atSec: quote.atSec
  };
}

function isDirectAnalysisState(value: DebateState["analysis"]): value is DirectAnalysisState {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Number(value.schemaVersion || 0) >= 6
    && value.architecture === "direct_debate_desk_v2"
    && value.tabs
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

function asSideId(value: unknown): "side-a" | "side-b" {
  const text = asString(value).toLowerCase();
  return text === "side-b" || text === "red" || text === "red side" ? "side-b" : "side-a";
}

function asOptionalSideId(value: unknown): SideId | undefined {
  const text = asString(value).toLowerCase();
  if (text === "side-a" || text === "blue" || text === "blue side") return "side-a";
  if (text === "side-b" || text === "red" || text === "red side") return "side-b";
  return undefined;
}

function directClaimStatus(status: unknown): ClaimArtifact["status"] {
  const normalized = asString(status).toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "verified") return "verified";
  if (normalized === "contradicted") return "contradicted";
  if (normalized === "cannot_verify") return "cannot_verify";
  if (normalized === "no_clear_source") return "no_clear_source";
  return "checking";
}

function directFactStatus(status: unknown): FactStatus {
  const normalized = asString(status).toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "verified") return "verified";
  if (normalized === "contradicted") return "contradicted";
  if (normalized === "no_clear_source") return "no_clear_source";
  if (normalized === "cannot_verify") return "cannot_verify";
  return "checking";
}

function getDebatePointLedger(debate: DebateState): DebatePointLedgerCard[] {
  const directRows = isDirectAnalysisState(debate.analysis) ? debate.analysis.internal?.debatePoints || [] : [];
  const directPoints = directRows
    .map((row) => debatePointCardFromDirectRow(asRecord(row)))
    .filter((point): point is DebatePointLedgerCard => Boolean(point));
  if (directPoints.length) return sortDebatePointCards(directPoints);

  return sortDebatePointCards((debate.points || []).map((point) => ({
    id: point.id,
    pointId: point.id,
    speakerId: point.speakerId,
    sideId: point.sideId,
    point: point.claim,
    quote: point.quote,
    pointType: point.role || "claim",
    issueHint: "",
    reason: point.why || point.assertionWhy || "",
    confidence: point.confidence || 0,
    turnIds: point.turnIds || [],
    startSec: point.startSec,
    endSec: point.endSec
  })));
}

function debatePointCardFromDirectRow(row: Record<string, unknown>): DebatePointLedgerCard | null {
  const payload = asRecord(row.payload);
  const sideId = asOptionalSideId(row.sideId || row.side || payload.sideId || payload.side);
  const point = asString(row.point || row.claim || payload.point || payload.claim).trim();
  const quote = asString(row.quote || payload.quote).trim();
  const speakerId = asString(row.speakerId || payload.speakerId).trim();
  const pointId = asString(row.pointId || row.id || payload.pointId || payload.id).trim();
  if (!sideId || !pointId || !speakerId || !point || !quote) return null;
  return {
    id: pointId,
    pointId,
    speakerId,
    sideId,
    point,
    quote,
    pointType: asString(row.pointType || payload.pointType || "point"),
    issueHint: asString(row.issueHint || payload.issueHint),
    reason: asString(row.reason || payload.reason),
    confidence: asNumber(row.confidence || payload.confidence),
    turnIds: asStringArray(row.turnIds || payload.turnIds),
    startSec: row.startSec === undefined ? payload.startSec as number | undefined : asNumber(row.startSec),
    endSec: row.endSec === undefined ? payload.endSec as number | undefined : asNumber(row.endSec)
  };
}

function artifactRecencyValue(item: unknown): number {
  const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
  for (const key of ["createdAt", "updatedAt", "at", "endSec", "startSec"]) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function sortDebatePointCards(points: DebatePointLedgerCard[]) {
  return points.slice().sort((a, b) => artifactRecencyValue(b) - artifactRecencyValue(a));
}

function formatDebatePointType(value: string) {
  const normalized = asString(value).replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!normalized || normalized === "value") return "point";
  return normalized;
}

function formatDebatePointTime(point: DebatePointLedgerCard) {
  const start = Number(point.startSec);
  const end = Number(point.endSec);
  const time = Number.isFinite(start) ? `${formatSeconds(start)}${Number.isFinite(end) && end > start ? `-${formatSeconds(end)}` : ""}` : "";
  const confidence = point.confidence ? `${Math.round(point.confidence * 100)}% confidence` : "";
  return [time, confidence].filter(Boolean).join(" | ");
}

function formatSeconds(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function artifactsFromAnalysis(analysis: DirectAnalysisState): DebateArtifacts {
  const factRows: Array<Record<string, unknown>> = (analysis.internal?.factChecks || []).map(asRecord);
  const factChecksByClaim = new Map<string, Record<string, unknown>>();
  for (const row of factRows) {
    const claimCardId = asString(row.claimCardId);
    if (claimCardId) factChecksByClaim.set(claimCardId, row);
  }
  const claims: ClaimArtifact[] = (analysis.tabs?.claims || []).map(asRecord).map((row) => {
    const payload = asRecord(row.payload);
    const cardId = asString(row.cardId || payload.id);
    const pointId = asString(payload.pointId || row.pointId || cardId.replace(/^claim-/, ""));
    const fact = factChecksByClaim.get(cardId);
    const status = directClaimStatus(fact?.status || row.factStatus || payload.status);
    return {
      id: cardId,
      pointId,
      speakerId: asString(row.speakerId || payload.speakerId),
      sideId: asSideId(row.sideId || payload.sideId),
      role: "claim",
      claim: asString(row.claim || payload.claim),
      quote: asString(row.quote || payload.quote || row.claim || payload.claim),
      status,
      importance: 3,
      burden: status === "verified" ? "met" : status === "contradicted" ? "not_met" : "open",
      burdenWhy: asString(row.sourceReason || payload.burdenWhy),
      turnIds: asStringArray(row.turnIds || payload.turnIds),
      sourceCheckIds: fact ? [asString(fact.checkId)] : [],
      clashIds: asStringArray(payload.clashIds),
      at: asNumber(row.atMs || payload.at, Date.now()),
      startSec: row.startSec === undefined ? payload.startSec as number | undefined : asNumber(row.startSec),
      endSec: row.endSec === undefined ? payload.endSec as number | undefined : asNumber(row.endSec)
    };
  });
  const sourceChecks: SourceCheckArtifact[] = factRows.map((row) => ({
    id: asString(row.checkId),
    pointId: asString(row.claimCardId).replace(/^claim-/, ""),
    sideId: asSideId(row.sideId),
    claim: asString(row.statement),
    status: directFactStatus(row.status),
    explanation: asString(row.explanation),
    sources: Array.isArray(row.sources) ? row.sources.map((source) => {
      const item = asRecord(source);
      return { title: asString(item.title), uri: asString(item.uri || item.url) };
    }).filter((source) => source.title || source.uri) : [],
    at: Date.now()
  }));
  const clashes: ClashArtifact[] = (analysis.tabs?.clashes || []).map(asRecord).map((row) => {
    const payload = asRecord(row.payload);
    const verdict = asString(row.verdict || payload.verdict);
    const normalizedVerdict = verdict.toLowerCase().replace(/[\s-]+/g, "_");
    const winningSideId = normalizedVerdict.includes("red") ? "side-b" : "side-a";
    const hasWinner = normalizedVerdict.includes("blue") || normalizedVerdict.includes("red");
    const outcome = hasWinner ? "claim_weakened" : normalizedVerdict.includes("no_clear_edge") ? "answered" : "needs_more_context";
    const blueQuote = asString(row.blueQuote || payload.blueQuote);
    const redQuote = asString(row.redQuote || payload.redQuote);
    return {
      id: asString(row.cardId || payload.id),
      fromPointId: asString(payload.fromPointId || row.blueCardId || row.redCardId),
      toPointId: asString(payload.toPointId || row.redCardId || row.blueCardId),
      speakerId: asString(payload.speakerId || (winningSideId === "side-a" ? row.blueSpeakerId : row.redSpeakerId)),
      targetSpeakerId: asString(payload.targetSpeakerId || (winningSideId === "side-a" ? row.redSpeakerId : row.blueSpeakerId)),
      sideId: hasWinner ? winningSideId : asSideId(payload.sideId || row.sideId),
      verdict,
      proposition: asString(row.proposition || payload.proposition),
      blueCardId: asString(row.blueCardId || payload.blueCardId),
      redCardId: asString(row.redCardId || payload.redCardId),
      blueSpeakerId: asString(row.blueSpeakerId || payload.blueSpeakerId),
      redSpeakerId: asString(row.redSpeakerId || payload.redSpeakerId),
      bluePosition: asString(payload.bluePosition || row.bluePosition || blueQuote || row.proposition),
      redPosition: asString(payload.redPosition || row.redPosition || redQuote || row.proposition),
      blueQuote,
      redQuote,
      originalClaim: asString(payload.originalClaim || row.proposition),
      challengerResponse: asString(payload.challengerResponse || row.reason),
      sourceQuote: asString(payload.sourceQuote || (winningSideId === "side-a" ? blueQuote : redQuote)),
      targetQuote: asString(payload.targetQuote || (winningSideId === "side-a" ? redQuote : blueQuote)),
      outcome,
      strength: hasWinner ? 0.8 : 0.5,
      summary: asString(row.reason || payload.summary || row.proposition),
      at: asNumber(row.atMs || payload.at, Date.now()),
      startSec: row.startSec === undefined ? payload.startSec as number | undefined : asNumber(row.startSec),
      endSec: row.endSec === undefined ? payload.endSec as number | undefined : asNumber(row.endSec)
    };
  });
  const inconsistencies: InconsistencyArtifact[] = (analysis.internal?.inconsistencies || []).map(asRecord).map((row) => {
    const payload = asRecord(row.payload);
    return {
      id: asString(row.cardId || payload.id),
      speakerId: asString(row.speakerId || payload.speakerId),
      sideId: asSideId(row.sideId || payload.sideId),
      accusedSideId: asSideId(row.sideId || payload.accusedSideId || payload.sideId),
      summary: asString(row.summary || payload.summary),
      severity: "high",
      standardA: asString(payload.standardA || row.title),
      standardB: asString(payload.standardB || row.summary),
      quoteA: asString(row.firstQuote || payload.quoteA),
      quoteB: asString(row.secondQuote || payload.quoteB),
      pointIds: asStringArray(payload.pointIds),
      at: asNumber(row.atMs || payload.at, Date.now()),
      startSec: row.startSec === undefined ? payload.startSec as number | undefined : asNumber(row.startSec),
      endSec: row.endSec === undefined ? payload.endSec as number | undefined : asNumber(row.endSec)
    };
  });
  const keyMoments: KeyMomentArtifact[] = (analysis.tabs?.keyMoments || []).map(asRecord).map((row) => {
    const payload = asRecord(row.payload);
    return {
      id: asString(row.cardId || payload.id),
      sideId: asSideId(row.sideId || payload.sideId),
      speakerId: asString(payload.speakerId),
      kind: asString(row.kind || payload.kind) as KeyMomentArtifact["kind"],
      title: asString(row.title || payload.title),
      summary: asString(row.summary || payload.summary),
      quote: asString(row.quote || payload.quote),
      impact: "high",
      artifactIds: asStringArray(row.artifactIds || payload.artifactIds),
      at: asNumber(row.atMs || payload.at, Date.now()),
      startSec: row.startSec === undefined ? payload.startSec as number | undefined : asNumber(row.startSec),
      endSec: row.endSec === undefined ? payload.endSec as number | undefined : asNumber(row.endSec)
    };
  });
  return { claims, clashes, inconsistencies, keyMoments, sourceChecks };
}

function getScorecard(debate: DebateState, sideViews: SideView[], artifacts: DebateArtifacts): Scorecard {
  if (isResolvedScorecard(debate.scorecard)) return debate.scorecard;
  const fallback = emptyScorecard();
  return {
    ...fallback,
    blue: { ...fallback.blue, label: displaySideThesis(sideViews[0]) },
    red: { ...fallback.red, label: displaySideThesis(sideViews[1]) },
    reason: artifacts.claims.length ? "" : fallback.reason
  };
}

function isResolvedScorecard(scorecard: DebateState["scorecard"] | null | undefined): scorecard is Scorecard {
  return Boolean(
    scorecard
    && (scorecard.version === 3 || scorecard.version === 4 || scorecard.version === 5)
    && (scorecard.method === "key_moment_score" || scorecard.method === "event_ledger")
    && Array.isArray(scorecard.blue?.pillars)
    && scorecard.blue.pillars.length > 0
    && Array.isArray(scorecard.red?.pillars)
    && scorecard.red.pillars.length > 0
  );
}

function scorecardMetricsFromArtifacts(sideId: "side-a" | "side-b", artifacts: DebateArtifacts) {
  const claims = artifacts.claims.filter((claim) => claim.sideId === sideId);
  const clashes = artifacts.clashes.filter((clash) => clash.sideId === sideId);
  const inconsistencies = artifacts.inconsistencies.filter((item) => (item.accusedSideId || item.sideId) === sideId).length;
  const penalty = inconsistencies * 5;
  const supported = claims.filter((claim) => claim.status === "verified").length;
  const resolved = claims.filter((claim) => claim.status === "verified" || claim.status === "contradicted").length;
  return {
    claimsRaised: claims.length,
    claimsSupported: supported,
    claimsDefended: claims.filter((claim) => claim.status === "verified" || claim.clashIds.length > 0).length,
    clashesWon: clashes.filter((clash) => clash.outcome === "claim_weakened" || clash.outcome === "claim_defeated").length,
    claimsUnanswered: claims.filter((claim) => claim.clashIds.length === 0 && claim.status !== "contradicted").length,
    concessionsForced: 0,
    inconsistencies,
    penalty,
    sourceReliability: resolved ? Math.round((supported / resolved) * 100) : claims.length ? 50 : 0
  };
}

function rawScoreFromMetrics(metrics: Scorecard["blue"]["metrics"]) {
  const claimsBase = Math.max(1, metrics.claimsRaised);
  return Math.max(
    1,
    (metrics.claimsSupported / claimsBase) * 20
    + (metrics.claimsDefended / claimsBase) * 20
    + Math.min(20, metrics.clashesWon * 7)
    + (metrics.claimsUnanswered / claimsBase) * 15
    + Math.min(10, metrics.concessionsForced * 5)
    + metrics.sourceReliability * 0.1
    - Math.min(20, metrics.penalty)
  );
}

function emptyArtifacts(): DebateArtifacts {
  return {
    claims: [],
    clashes: [],
    inconsistencies: [],
    keyMoments: [],
    sourceChecks: []
  };
}

function emptyScorecard(): Scorecard {
  const emptySide = (sideId: "side-a" | "side-b", color: "blue" | "red") => ({
    sideId,
    label: "",
    color,
    score: 0,
    metrics: {
      claimsRaised: 0,
      claimsSupported: 0,
      claimsDefended: 0,
      clashesWon: 0,
      claimsUnanswered: 0,
      concessionsForced: 0,
      inconsistencies: 0,
      penalty: 0,
      sourceReliability: 0,
    },
    pillars: defaultScorePillars(),
    events: [],
    rawStrength: 0,
    totalContribution: 0,
    reasons: []
  });
  return {
    version: 5,
    method: "key_moment_score",
    blue: emptySide("side-a", "blue"),
    red: emptySide("side-b", "red"),
    edgeLabel: "Forming",
    reason: "Score starts at 0 and moves only when a Key Moment is added.",
    leader: "even",
    leadMargin: 0,
    ledger: {
      version: 5,
      method: "key_moment_score",
      events: []
    },
    updatedAt: Date.now()
  };
}

function isVisibleSpeaker(speaker: { points: DebatePoint[]; turns: TranscriptTurn[]; profile?: SpeakerProfile }) {
  const durableWords = speaker.turns.reduce((sum, turn) => sum + turn.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const confidence = speaker.profile?.sideConfidence || 0;
  if (speaker.points.length >= 2 && durableWords >= 40) return true;
  if (speaker.points.length >= 1 && durableWords >= 80 && confidence >= 0.76) return true;
  return speaker.turns.length >= 4 && durableWords >= 48 && confidence >= 0.82;
}

function isVisibleDebatePoint(point: DebatePoint) {
  return point.assertionStatus === "asserted" && ["claim", "rebuttal", "concession"].includes(point.role);
}

function ensureUiSides(sides: DebateSide[]): DebateSide[] {
  const defaults: DebateSide[] = [
    { id: "side-a", label: "", thesisStatus: "forming", confirmedThesis: "", workingThesis: "", thesisEvidencePointIds: [], score: 0, speakerIds: [], color: "blue", metrics: emptyMetrics() },
    { id: "side-b", label: "", thesisStatus: "forming", confirmedThesis: "", workingThesis: "", thesisEvidencePointIds: [], score: 0, speakerIds: [], color: "red", metrics: emptyMetrics() }
  ];
  return [0, 1].map((index) => {
    const incoming = sides[index] || defaults[index];
    const thesisConfirmed = incoming.thesisStatus === "confirmed";
    const confirmedThesis = thesisConfirmed ? (incoming.confirmedThesis || incoming.label || "") : "";
    return {
      ...defaults[index],
      ...incoming,
      color: index === 0 ? "blue" : "red",
      thesisStatus: thesisConfirmed ? "confirmed" : "forming",
      label: confirmedThesis,
      confirmedThesis,
      metrics: incoming.metrics || defaults[index].metrics
    };
  });
}

function formatRole(role: DebatePoint["role"]) {
  return role.replace(/_/g, " ");
}

function formatAudienceRole(role: DebatePoint["role"]) {
  if (role === "claim") return "claim";
  if (role === "rebuttal") return "pushback";
  if (role === "concession") return "concession";
  if (role === "evidence") return "example";
  if (role === "framing") return "lens";
  if (role === "dropped_point") return "left open";
  return "point";
}

function sourceStatusIcon(status: SourceBadgeStatus) {
  if (status === "verified") return BadgeCheck;
  if (status === "contradicted") return OctagonX;
  if (status === "checking") return Clock3;
  if (status === "cannot_verify") return Ban;
  if (status === "no_clear_source") return BadgeMinus;
  return null;
}

function formatSourceStatusLabel(status: SourceBadgeStatus) {
  if (status === "verified") return "verified";
  if (status === "contradicted") return "contradicted";
  if (status === "no_clear_source") return "no clear source";
  if (status === "cannot_verify") return "cannot verify";
  if (status === "checking") return "checking";
  return "no clear source";
}

function formatClaimStatus(status: ClaimArtifact["status"]) {
  return formatSourceStatusLabel(status);
}

function formatBurden(burden: ClaimArtifact["burden"]) {
  if (burden === "met") return "supported";
  if (burden === "not_met") return "not proven";
  return "unresolved";
}

function roleIcon(role: DebatePoint["role"]) {
  if (role === "rebuttal") return Swords;
  if (role === "concession") return Handshake;
  if (role === "evidence") return BookOpenCheck;
  if (role === "dropped_point") return CircleDashed;
  if (role === "framing") return Scale;
  return MessageSquareQuote;
}

function burdenIcon(burden: ClaimArtifact["burden"]) {
  if (burden === "met") return BadgeCheck;
  if (burden === "not_met") return BadgeX;
  return BadgeHelp;
}

function oppositeSideLabel(sideColor: "blue" | "red") {
  return sideColor === "blue" ? "Red side" : "Blue side";
}

function formatClashOutcome(outcome: ClashArtifact["outcome"], winningSideId?: SideId) {
  if (outcome === "claim_weakened" || outcome === "claim_defeated" || outcome === "unanswered") {
    return winningSideId === "side-b" ? "Red side answered better" : "Blue side answered better";
  }
  if (outcome === "answered") return "No clear edge";
  return "Still developing";
}

function formatStrength(strength: number) {
  if (strength >= 0.8) return "strong";
  if (strength >= 0.65) return "solid";
  return "partial";
}

function strengthTone(strength: number) {
  if (strength >= 0.8) return "strong";
  if (strength >= 0.65) return "solid";
  return "partial";
}

function challengeOutcomeIcon(outcome: ClashArtifact["outcome"]) {
  if (outcome === "claim_defeated") return Gavel;
  if (outcome === "claim_weakened") return TriangleAlert;
  if (outcome === "answered") return BadgeCheck;
  if (outcome === "unanswered") return BadgeMinus;
  return BadgeHelp;
}

function impactIcon(impact: KeyMomentArtifact["impact"]) {
  if (impact === "high") return SignalHighIcon;
  if (impact === "medium") return SignalMediumIcon;
  return SignalLowIcon;
}

type SignalIconProps = { size?: number; strokeWidth?: number; className?: string };

function SignalBarsIcon({ level, size = 11, className }: SignalIconProps & { level: 1 | 2 | 3 }) {
  const bars = [
    { x: 2, y: 7.25, height: 4.25 },
    { x: 5.8, y: 4.75, height: 6.75 },
    { x: 9.6, y: 2, height: 9.5 }
  ];
  return (
    <svg className={`signalBarsIcon ${className || ""}`} width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      {bars.map((bar, index) => (
        <rect
          key={index}
          x={bar.x}
          y={bar.y}
          width="2.35"
          height={bar.height}
          rx="1.15"
          className={index < level ? "signalBarActive" : "signalBarInactive"}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

function SignalLowIcon(props: SignalIconProps) {
  return <SignalBarsIcon {...props} level={1} />;
}

function SignalMediumIcon(props: SignalIconProps) {
  return <SignalBarsIcon {...props} level={2} />;
}

function SignalHighIcon(props: SignalIconProps) {
  return <SignalBarsIcon {...props} level={3} />;
}

function formatImpact(impact: KeyMomentArtifact["impact"]) {
  if (impact === "high") return "major moment";
  if (impact === "medium") return "notable moment";
  return "small moment";
}

function keyMomentUiDelta(item: KeyMomentArtifact) {
  if (item.kind === "source_verified" || item.kind === "strong_rebuttal") return 10;
  if (item.kind === "source_contradicted" || item.kind === "weak_response" || item.kind === "inconsistency" || item.kind === "unanswered_challenge") return -10;
  const text = normalizeUiText(`${item.title || ""} ${item.summary || ""}`);
  if (/\b(contradicted|inconsistency|unanswered|weak)\b/.test(text)) return -10;
  return 10;
}

function formatKeyMomentKind(item: KeyMomentArtifact) {
  if (item.kind === "source_verified") return "verified";
  if (item.kind === "source_contradicted") return "contradicted";
  if (item.kind === "strong_rebuttal") return "strong rebuttal";
  if (item.kind === "weak_response") return "weak response";
  if (item.kind === "unanswered_challenge") return "unanswered";
  if (item.kind === "inconsistency") return "inconsistency";
  return "Key Moment";
}

function keyMomentIcon(item: KeyMomentArtifact): BadgeIcon {
  if (item.kind === "strong_rebuttal" || item.kind === "unanswered_challenge" || item.kind === "weak_response") return Swords;
  if (item.kind === "inconsistency") return Scale;
  if (item.kind === "source_contradicted") return OctagonX;
  return BadgeCheck;
}

function formatFactStatus(status: SourceBadgeStatus) {
  return formatSourceStatusLabel(status);
}

function mergeVerifiedDebate(current: DebateState, verified: DebateState): DebateState {
  const verifiedPointsById = new Map(verified.points.map((point) => [point.id, point]));
  const verifiedClaimsById = new Map(verified.claims.map((claim) => [claim.id, claim]));
  const points = current.points.map((point) => {
    const next = verifiedPointsById.get(point.id);
    return next ? mergeVerifiedPoint(point, next) : point;
  });
  for (const point of verified.points) {
    if (!points.some((existing) => existing.id === point.id)) points.unshift(point);
  }
  const claims = current.claims.map((claim) => {
    const next = verifiedClaimsById.get(claim.id);
    return next ? { ...claim, ...next } : claim;
  });
  const verifiedCoversCurrent = current.points.every((point) => verifiedPointsById.has(point.id));
  return {
    ...current,
    points,
    claims,
    sides: verifiedCoversCurrent ? mergeSideLabels(current.sides, verified.sides, points) : current.sides,
    scores: verifiedCoversCurrent ? verified.scores : current.scores,
    contradictions: verifiedCoversCurrent ? verified.contradictions : current.contradictions,
    utterances: mergeUtterances(current.utterances, verified.utterances),
    dialogueWindows: mergeDialogueWindows(current.dialogueWindows, verified.dialogueWindows),
    analysisSchemaVersion: verifiedCoversCurrent ? verified.analysisSchemaVersion || current.analysisSchemaVersion : current.analysisSchemaVersion,
    analysis: verifiedCoversCurrent ? verified.analysis || current.analysis : current.analysis,
    artifacts: verifiedCoversCurrent ? verified.artifacts || current.artifacts : current.artifacts,
    scorecard: verifiedCoversCurrent ? verified.scorecard || current.scorecard : current.scorecard
  };
}

function mergeVerifiedPoint(current: DebatePoint, incoming: DebatePoint): DebatePoint {
  const incomingHasSources = incoming.sources.length > 0 || (incoming.audit?.sources?.length || 0) > 0;
  const currentIsResolved = current.factStatus === "verified" || current.factStatus === "contradicted";
  const incomingIsWeaker = incoming.factStatus === "checking" || incoming.factStatus === "no_clear_source" || incoming.factStatus === "cannot_verify";
  if (currentIsResolved && incomingIsWeaker && !incomingHasSources) {
    return current;
  }
  return {
    ...current,
    ...incoming,
    audit: {
      ...current.audit,
      ...incoming.audit
    }
  };
}

function mergeBatchDebate(current: DebateState, incoming: DebateState): DebateState {
  const currentPointsById = new Map(current.points.map((point) => [point.id, point]));
  const points = incoming.points.map((point) => preserveResolvedPoint(currentPointsById.get(point.id), point));
  for (const point of current.points) {
    if (!points.some((existing) => existing.id === point.id)) points.push(point);
  }

  const speakersById = new Map(current.speakers.map((speaker) => [speaker.speakerId, speaker]));
  const speakers = incoming.speakers.map((speaker) => ({
    ...(speakersById.get(speaker.speakerId) || {}),
    ...speaker,
    sideConfidence: Math.max(speakersById.get(speaker.speakerId)?.sideConfidence || 0, speaker.sideConfidence || 0),
    turnIds: Array.from(new Set([...(speakersById.get(speaker.speakerId)?.turnIds || []), ...(speaker.turnIds || [])]))
  }));
  for (const speaker of current.speakers) {
    if (!speakers.some((existing) => existing.speakerId === speaker.speakerId)) speakers.push(speaker);
  }

  return {
    ...incoming,
    sides: mergeSideLabels(current.sides, incoming.sides, points),
    points,
    speakers,
    utterances: mergeUtterances(current.utterances, incoming.utterances),
    dialogueWindows: mergeDialogueWindows(current.dialogueWindows, incoming.dialogueWindows),
    analysisSchemaVersion: incoming.analysisSchemaVersion || current.analysisSchemaVersion,
    analysis: incoming.analysis || current.analysis,
    artifacts: incoming.artifacts || current.artifacts,
    scorecard: incoming.scorecard || current.scorecard
  };
}

function preserveResolvedPoint(current: DebatePoint | undefined, incoming: DebatePoint): DebatePoint {
  if (!current) return incoming;
  const currentResolved = current.factStatus !== "checking";
  const incomingChecking = incoming.factStatus === "checking";
  if (!currentResolved || !incomingChecking) return { ...current, ...incoming, audit: { ...current.audit, ...incoming.audit } };
  return {
    ...incoming,
    factStatus: current.factStatus,
    confidence: current.confidence,
    why: current.why,
    sources: current.sources,
    audit: {
      ...incoming.audit,
      ...current.audit
    }
  };
}

function mergeRescoredDebate(current: DebateState, rescored: DebateState): DebateState {
  const rescoredPointIds = new Set((rescored.points || []).map((point) => point.id));
  const coversCurrentPoints = current.points.every((point) => rescoredPointIds.has(point.id));
  if (!coversCurrentPoints) return current;
  return {
    ...current,
    sides: mergeSideLabels(current.sides, rescored.sides, current.points),
    scores: rescored.scores,
    claims: rescored.claims,
    contradictions: rescored.contradictions,
    analysisSchemaVersion: rescored.analysisSchemaVersion || current.analysisSchemaVersion,
    analysis: rescored.analysis || current.analysis,
    artifacts: rescored.artifacts || current.artifacts,
    scorecard: rescored.scorecard || current.scorecard,
    utterances: mergeUtterances(current.utterances, rescored.utterances),
    dialogueWindows: mergeDialogueWindows(current.dialogueWindows, rescored.dialogueWindows)
  };
}

function mergeUtterances(current: CleanUtterance[] = [], incoming: CleanUtterance[] = []) {
  const byId = new Map([...current, ...incoming].filter((item) => item?.utteranceId).map((item) => [item.utteranceId, item]));
  return [...byId.values()].slice(-160);
}

function mergeDialogueWindows(current: DebateState["dialogueWindows"] = [], incoming: DebateState["dialogueWindows"] = []) {
  const byId = new Map([...(current || []), ...(incoming || [])].filter((item) => item?.windowId).map((item) => [item.windowId, item]));
  return [...byId.values()].slice(-120);
}

function mergeSideLabels(currentSides: DebateSide[], incomingSides: DebateSide[], points: DebatePoint[]): DebateSide[] {
  void points;
  return incomingSides.map((side, index) => {
    const current = currentSides[index];
    const incomingLabel = displaySideThesis(side);
    if (incomingLabel) {
      return {
        ...side,
        label: incomingLabel,
        confirmedThesis: incomingLabel,
        thesisStatus: "confirmed"
      };
    }
    const currentLabel = displaySideThesis(current);
    if (currentLabel && side.thesisStatus !== "forming") {
      return {
        ...side,
        label: currentLabel,
        confirmedThesis: currentLabel,
        thesisStatus: "confirmed"
      };
    }
    return {
      ...side,
      label: "",
      confirmedThesis: "",
      thesisStatus: "forming"
    };
  });
}

function upsertSavedProject(projects: SavedDebateProject[], next: SavedDebateProject) {
  const existingIndex = projects.findIndex((project) => project.id === next.id);
  if (existingIndex >= 0) {
    return projects.map((project, index) => index === existingIndex ? { ...project, ...next } : project);
  }
  return [next, ...projects];
}

function orderSavedProjectsByCreation(projects: SavedDebateProject[]) {
  return [...projects].sort((a, b) => {
    const bCreated = Number(b.createdAt || b.updatedAt || 0);
    const aCreated = Number(a.createdAt || a.updatedAt || 0);
    return bCreated - aCreated;
  });
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 50)));
}

function pickVerificationCandidates(points: DebatePoint[], inFlight: Set<string>, perSpeakerLimit = 2, totalLimit = 6) {
  const grouped = new Map<string, DebatePoint[]>();
  for (const point of points) {
    if (!point.id || inFlight.has(point.id)) continue;
    const speakerId = point.speakerId || "unknown";
    const group = grouped.get(speakerId) || [];
    if (group.length < perSpeakerLimit) group.push(point);
    grouped.set(speakerId, group);
  }

  const selected: DebatePoint[] = [];
  const speakerIds = [...grouped.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  while (selected.length < totalLimit && speakerIds.some((speakerId) => (grouped.get(speakerId)?.length || 0) > 0)) {
    for (const speakerId of speakerIds) {
      const point = grouped.get(speakerId)?.shift();
      if (point) selected.push(point);
      if (selected.length >= totalLimit) break;
    }
  }
  return selected;
}

function shouldRequestVerification(point: DebatePoint, existingPointIds: Set<string>) {
  if (point.assertionStatus !== "asserted") return false;
  if (point.role === "framing" || point.role === "dropped_point") return false;
  return point.factStatus === "checking" || !existingPointIds.has(point.id);
}

function emptyMetrics() {
  return { points: 0, supported: 0, disputed: 0, unclear: 0, strength: 0, penalty: 0 };
}

function upsertTurn(turns: TranscriptTurn[], next: TranscriptTurn) {
  const existingIndex = turns.findIndex((turn) => turn.id === next.id);
  if (existingIndex === -1) return turns.concat(next);
  return turns.map((turn, index) => (index === existingIndex ? next : turn));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

function isDebatePoint(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const normalized = text.trim().toLowerCase().replace(/[^\w\s]/g, "");
  const filler = new Set(["here", "yeah", "yes", "no", "okay", "ok", "hello", "hi", "um", "uh"]);
  return words.length >= 6 && text.trim().length >= 28 && !filler.has(normalized);
}

function shouldAnalyzeTurn(turn: TranscriptTurn) {
  const source = String(turn.speakerSource || "");
  return (source === "speechmatics" || source === "deepgram" || source === "pyannote") && isDebatePoint(turn.text);
}

function isDurableSpeakerTurn(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const normalized = text.trim().toLowerCase().replace(/[^\w\s]/g, "");
  const filler = new Set(["and", "but", "so", "uh", "um", "yeah", "yes", "no", "okay", "ok", "i"]);
  return words.length >= 2 && text.trim().length >= 5 && !filler.has(normalized);
}

function getWinner(debate: DebateState) {
  if (debate.sides.length < 2) return null;
  const sorted = [...debate.sides].sort((a, b) => b.score - a.score);
  if (sorted[0].score === sorted[1].score) return null;
  return sorted[0];
}

function getEdgeLabel(debate: DebateState, winner: DebateSide | null) {
  const visiblePoints = (debate.points || []).filter(isVisibleDebatePoint);
  if (!visiblePoints.length) return "Forming";
  if (!winner) return "Even";
  return winner.id === "side-b" || winner.color === "red" ? "Red edge" : "Blue edge";
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export default App;
