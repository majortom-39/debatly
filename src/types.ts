export type SpeakerId = string;
export type SideId = "side-a" | "side-b";
export type SpeakerFloorRole = "debater" | "neutral_speaker" | "unknown_speaker" | "possible_alias";
export type DebatePhase = "prelude" | "openings" | "active_debate" | "cross_exam" | "closing" | "unknown";
export type SpeechFunction = "topic_setup" | "opening_statement" | "claim" | "challenge_question" | "procedural" | "clarification" | "off_topic";
export type UtteranceOwnershipMode = "speaker_side" | "utterance_side" | "neutral_context" | "unknown";
export type FactStatus = "checking" | "verified" | "contradicted" | "no_clear_source" | "cannot_verify";
export type SourceEvidenceBasis = "external_fact" | "contextual" | "transcript_only";
export type AssertionStatus = "asserted" | "question_only" | "reported_only" | "cross_speaker" | "unfaithful";
export type PointRole = "claim" | "rebuttal" | "concession" | "evidence" | "framing" | "dropped_point";
export type RebuttalType = "refutes" | "supports" | "concedes" | "drops";
export type ClaimOwnershipType =
  | "owned_assertion"
  | "owned_rebuttal"
  | "owned_concession"
  | "owned_evidence"
  | "opponent_echo"
  | "challenge_question"
  | "sarcastic_repetition"
  | "reported_speech"
  | "quoted_evidence"
  | "external_quote"
  | "ambiguous"
  | "meta"
  | "off_topic";
export type SpeechAct =
  | "assertion"
  | "rebuttal"
  | "concession"
  | "question"
  | "sarcasm"
  | "opponent_paraphrase"
  | "reported_speech"
  | "quoted_evidence"
  | "meta"
  | "off_topic";

export type CleanUtterance = {
  utteranceId: string;
  speakerId: SpeakerId;
  text: string;
  quote: string;
  rawTurnIds: string[];
  startSec?: number;
  endSec?: number;
  at: number;
  speakerOwnershipConfidence?: number;
  isComplete?: boolean;
  cleanupNotes?: string;
  speakerRole?: SpeakerFloorRole;
  floorRoleConfidence?: number;
  speechFunction?: SpeechFunction;
  debatePhase?: DebatePhase;
  stanceBearing?: boolean;
  sideMapEligible?: boolean;
  claimEligible?: boolean;
  challengeEligible?: boolean;
  scoreEligible?: boolean;
  contextOnly?: boolean;
  contextKind?: string;
  contextSignals?: string[];
  floorReason?: string;
  ownerSideId?: SideId | "";
  ownerSideConfidence?: number;
  ownerSideReason?: string;
  ownershipMode?: UtteranceOwnershipMode;
};

export type DialogueWindowStatus = "open" | "ready" | "processed" | "held";
export type DialogueWindowReason = "exchange" | "same_speaker_claim" | "max_delay" | "forced" | "possible_ad_or_sponsor_break";

export type DialogueWindow = {
  windowId: string;
  windowStatus: DialogueWindowStatus;
  reason: DialogueWindowReason;
  turns: TranscriptTurn[];
  speakerBlocks: Array<{ speakerId: SpeakerId; text: string; turnIds: string[] }>;
  speakerColumns?: Array<{ speakerId: SpeakerId; text: string; turnIds: string[] }>;
  sideColumns?: Array<{ sideId: SideId; speakerIds: SpeakerId[]; text: string; turnIds: string[] }>;
  turnIds: string[];
  speakerIds: SpeakerId[];
  priorContext?: TranscriptTurn[];
  nextContext?: TranscriptTurn[];
  startSec?: number;
  endSec?: number;
  contextOnly?: boolean;
  contextKind?: string;
  contextSignals?: string[];
  contextReason?: string;
  contextScore?: {
    adScore?: number;
    debateScore?: number;
  };
  at: number;
};

export type TranscriptTurn = {
  id: string;
  speakerId: SpeakerId;
  text: string;
  isFinal: boolean;
  at: number;
  startSec?: number;
  endSec?: number;
  words?: Array<{ word: string; startSec?: number; endSec?: number }>;
  rawSpeakers?: string[];
  speakerSource?: "speechmatics" | "deepgram" | "pyannote" | "speechmatics_unassigned" | "deepgram_unassigned" | "pyannote_unassigned" | string;
  speakerRole?: SpeakerFloorRole;
  floorRoleConfidence?: number;
  speechFunction?: SpeechFunction;
  debatePhase?: DebatePhase;
  stanceBearing?: boolean;
  sideMapEligible?: boolean;
  claimEligible?: boolean;
  challengeEligible?: boolean;
  scoreEligible?: boolean;
  contextOnly?: boolean;
  contextKind?: string;
  contextSignals?: string[];
  floorReason?: string;
  ownerSideId?: SideId | "";
  ownerSideConfidence?: number;
  ownerSideReason?: string;
  ownershipMode?: UtteranceOwnershipMode;
};

export type SpeakerProfile = {
  speakerId: SpeakerId;
  sideId?: SideId;
  sideConfidence: number;
  lastSpokenAt: number;
  firstSpokenAt?: number;
  firstStartSec?: number;
  lastStartSec?: number;
  lastEndSec?: number;
  turnCount?: number;
  wordCount?: number;
  voicedDurationSec?: number;
  speakerSource?: string;
  speakerRole?: SpeakerFloorRole;
  floorRoleConfidence?: number;
  floorRoleReason?: string;
  aliasOf?: SpeakerId | "";
  identityStatus?: "confirmed" | "provisional_alias" | string;
  identityConfidence?: number;
  aliasReason?: string;
  sampleText?: string;
  turnIds: string[];
  assignmentReason?: string;
};

export type SpeakerPositionMemory = {
  speakerId: SpeakerId;
  likelySide?: SideId | "";
  confidence: number;
  stanceSummary: string;
  supportingEvidence: string[];
  recentShiftRisk: "low" | "medium" | "high";
  updatedAt: number;
};

export type FloorUtteranceAnnotation = {
  utteranceId: string;
  speakerId: SpeakerId;
  speakerRole: SpeakerFloorRole;
  roleConfidence: number;
  speechFunction: SpeechFunction;
  debatePhase: DebatePhase;
  stanceBearing: boolean;
  sideMapEligible: boolean;
  claimEligible: boolean;
  challengeEligible: boolean;
  scoreEligible: boolean;
  contextOnly: boolean;
  contextKind?: string;
  contextSignals?: string[];
  reason: string;
  ownerSideId?: SideId | "";
  ownerSideConfidence?: number;
  ownerSideReason?: string;
  ownershipMode?: UtteranceOwnershipMode;
};

export type FloorSpeakerState = {
  speakerId: SpeakerId;
  role: SpeakerFloorRole;
  confidence: number;
  sideHint?: "blue" | "red" | "";
  sideHintConfidence?: number;
  roleReason?: string;
};

export type FloorState = {
  version: 1;
  phase: DebatePhase;
  phaseConfidence: number;
  updatedAt: number;
  speakers: FloorSpeakerState[];
  utterances: FloorUtteranceAnnotation[];
};

export type AuditReceipt = {
  quote: string;
  turnIds: string[];
  at: number;
  startSec?: number;
  endSec?: number;
  factExplanation: string;
  sources: Array<{ title: string; uri: string }>;
  ownershipContextText?: string;
  rawSpeakerId?: SpeakerId;
  ownerSideId?: SideId | "";
  ownerSideConfidence?: number;
  sideOwnershipMode?: UtteranceOwnershipMode;
  sideOwnershipReason?: string;
};

export type DebatePoint = {
  id: string;
  speakerId: SpeakerId;
  rawSpeakerId?: SpeakerId;
  sideId: SideId;
  speakerRole?: SpeakerFloorRole;
  floorRoleConfidence?: number;
  sideOwnershipMode?: UtteranceOwnershipMode;
  sideOwnershipConfidence?: number;
  sideOwnershipReason?: string;
  role: PointRole;
  ownershipType?: ClaimOwnershipType;
  ownershipConfidence?: number;
  ownershipReason?: string;
  speechAct?: SpeechAct;
  boundaryConfidence?: number;
  assertionStatus: AssertionStatus;
  assertionWhy: string;
  sourceSpeakerId: SpeakerId;
  parentPointId?: string;
  claim: string;
  quote: string;
  turnIds: string[];
  at: number;
  startSec?: number;
  endSec?: number;
  factStatus: FactStatus;
  evidenceBasis?: SourceEvidenceBasis;
  scoreEligible?: boolean;
  confidence: number;
  why: string;
  sources: Array<{ title: string; uri: string }>;
  noSourceReason?: string;
  burden?: string;
  audit: AuditReceipt;
};

export type RebuttalLink = {
  id: string;
  fromPointId: string;
  toPointId: string;
  speakerId: SpeakerId;
  type: RebuttalType;
  summary: string;
  sourceQuote?: string;
  targetQuote?: string;
  fromQuote?: string;
  toQuote?: string;
  fromClaim?: string;
  toClaim?: string;
  strength: number;
};

export type CoreScoreDimension = {
  key: string;
  label: string;
  weight: number;
  blue: number;
  red: number;
};

export type CoreScores = {
  blue: number;
  red: number;
  dimensions: CoreScoreDimension[];
};

export type ClaimSignal = {
  id: string;
  turnId?: string;
  speakerId: SpeakerId;
  sideId?: SideId;
  role?: PointRole;
  assertionStatus?: AssertionStatus;
  assertionWhy?: string;
  sourceSpeakerId?: SpeakerId;
  quote?: string;
  turnIds?: string[];
  at?: number;
  claim: string;
  stance: string;
  verdict: FactStatus;
  factStatus?: FactStatus;
  evidenceBasis?: SourceEvidenceBasis;
  scoreEligible?: boolean;
  confidence: number;
  why: string;
  sources: Array<{ title: string; uri: string }>;
  noSourceReason?: string;
};

export type DebateSide = {
  id: string;
  label: string;
  thesisStatus?: "forming" | "confirmed";
  workingThesis?: string;
  confirmedThesis?: string;
  thesisEvidencePointIds?: string[];
  thesisUpdatedAt?: number;
  score: number;
  speakerIds: string[];
  color?: "blue" | "red";
  metrics?: {
    points: number;
    supported: number;
    disputed: number;
    unclear: number;
    strength: number;
    penalty: number;
  };
};

export type ClaimArtifactStatus = "checking" | "verified" | "contradicted" | "no_clear_source" | "cannot_verify";
export type ClashOutcome = "answered" | "unanswered" | "claim_weakened" | "claim_defeated" | "needs_more_context";

export type ClaimArtifact = {
  id: string;
  pointId: string;
  speakerId: SpeakerId;
  sideId: SideId;
  issueGroupId?: string;
  issueGroupTitle?: string;
  evidenceStatus?: "trusted" | "limited" | "rejected";
  evidenceReason?: string;
  role?: PointRole;
  claimMode?: "speaker_assertion" | "speaker_challenge" | "quoted_evidence" | "reported_opponent_claim" | "meta_commentary" | "off_topic";
  quoteRole?: "owned_statement" | "owned_question" | "external_quote" | "opponent_quote" | "paraphrase";
  topicContinuity?: "main_thread" | "direct_response" | "sustained_new_topic" | "meta" | "off_topic";
  ownershipType?: ClaimOwnershipType;
  ownershipConfidence?: number;
  ownershipReason?: string;
  speechAct?: SpeechAct;
  boundaryConfidence?: number;
  familyHint?: string;
  quoteId?: string;
  claim: string;
  quote: string;
  status: ClaimArtifactStatus;
  importance: number;
  burden: "met" | "not_met" | "open";
  burdenWhy: string;
  turnIds: string[];
  sourceCheckIds: string[];
  clashIds: string[];
  at: number;
  startSec?: number;
  endSec?: number;
};

export type ClashArtifact = {
  id: string;
  fromPointId: string;
  toPointId: string;
  speakerId: SpeakerId;
  targetSpeakerId?: SpeakerId;
  sideId: SideId;
  verdict?: "blue_stronger" | "red_stronger" | "no_clear_edge" | "developing" | "blue_answered_better" | "red_answered_better" | "still_developing" | string;
  proposition?: string;
  blueCardId?: string;
  redCardId?: string;
  blueSpeakerId?: SpeakerId;
  redSpeakerId?: SpeakerId;
  bluePosition?: string;
  redPosition?: string;
  blueQuote?: string;
  redQuote?: string;
  turnIds?: string[];
  originalClaim: string;
  challengerResponse: string;
  sourceQuote: string;
  targetQuote: string;
  outcome: ClashOutcome;
  strength: number;
  summary: string;
  issueGroupId?: string;
  issueGroupTitle?: string;
  evidenceStatus?: "trusted" | "limited" | "rejected";
  evidenceReason?: string;
  issueId?: string;
  issueKey?: string;
  issueFamilyKey?: string;
  at?: number;
  startSec?: number;
  endSec?: number;
};

export type InconsistencyArtifact = {
  id: string;
  speakerId: SpeakerId;
  speakerIds?: SpeakerId[];
  quoteASpeakerId?: SpeakerId;
  quoteBSpeakerId?: SpeakerId;
  sideId?: SideId;
  accusedSideId?: SideId;
  accusedSpeakerIds?: SpeakerId[];
  accuserSideId?: SideId;
  accuserSpeakerId?: SpeakerId;
  challengeQuote?: string;
  summary: string;
  severity: "low" | "medium" | "high";
  standardA: string;
  standardB: string;
  quoteA: string;
  quoteB: string;
  pointIds: string[];
  issueGroupId?: string;
  issueGroupTitle?: string;
  evidenceStatus?: "trusted" | "limited" | "rejected";
  evidenceReason?: string;
  issueId?: string;
  issueKey?: string;
  issueFamilyKey?: string;
  at?: number;
  startSec?: number;
  endSec?: number;
};

export type KeyMomentArtifact = {
  id: string;
  sideId?: SideId;
  speakerId?: SpeakerId;
  kind?: "source_verified" | "source_contradicted" | "strong_rebuttal" | "weak_response" | "unanswered_challenge" | "inconsistency";
  title: string;
  summary: string;
  quote?: string;
  impact: "low" | "medium" | "high";
  artifactIds: string[];
  issueGroupId?: string;
  issueGroupTitle?: string;
  evidenceStatus?: "trusted" | "limited" | "rejected";
  evidenceReason?: string;
  issueId?: string;
  issueKey?: string;
  issueFamilyKey?: string;
  at?: number;
  startSec?: number;
  endSec?: number;
};

export type SourceCheckArtifact = {
  id: string;
  pointId: string;
  sideId?: SideId;
  issueGroupId?: string;
  issueGroupTitle?: string;
  evidenceStatus?: "trusted" | "limited" | "rejected";
  evidenceReason?: string;
  claim: string;
  status: FactStatus;
  evidenceBasis?: SourceEvidenceBasis;
  scoreEligible?: boolean;
  explanation: string;
  sources: Array<{ title: string; uri: string }>;
  noSourceReason?: string;
  at?: number;
  startSec?: number;
  endSec?: number;
};

export type DebateArtifacts = {
  claims: ClaimArtifact[];
  clashes: ClashArtifact[];
  inconsistencies: InconsistencyArtifact[];
  keyMoments: KeyMomentArtifact[];
  sourceChecks: SourceCheckArtifact[];
};

export type DirectAnalysisState = {
  schemaVersion: number;
  architecture?: "direct_debate_desk_v2" | string;
  updatedAt?: number;
  sideState?: {
    sides?: Array<{ sideId: SideId; label?: string; speakerIds?: SpeakerId[] }>;
    speakerSideMap?: Array<{ speakerId: SpeakerId; sideId: SideId; confidence?: number }>;
  };
  tabs?: {
    claims?: Array<Record<string, unknown>>;
    clashes?: Array<Record<string, unknown>>;
    keyMoments?: Array<Record<string, unknown>>;
  };
  internal?: {
    factChecks?: Array<Record<string, unknown>>;
    inconsistencies?: Array<Record<string, unknown>>;
    sideAssignments?: Array<Record<string, unknown>>;
    debatePoints?: Array<Record<string, unknown>>;
    thesisUpdates?: Array<Record<string, unknown>>;
    claimReviewedDebatePointIds?: string[];
    clashReviewedDebatePointIds?: string[];
    inconsistencyReviewedDebatePointIds?: string[];
  };
  score?: Record<string, unknown>;
};

export type ScorecardMetrics = {
  claimsRaised: number;
  claimsSupported: number;
  claimsDefended: number;
  clashesWon: number;
  claimsUnanswered: number;
  concessionsForced: number;
  inconsistencies: number;
  penalty: number;
  sourceReliability: number;
};

export type ScorePillarKey =
  | "source_verified"
  | "source_contradicted"
  | "strong_rebuttal"
  | "weak_response"
  | "inconsistency"
  | "unanswered_challenge";

export type ScorePillar = {
  key: ScorePillarKey;
  label: string;
  value: number;
  help?: string;
  artifactIds?: string[];
};

export type ScoreLedger = {
  version: number;
  method: "key_moment_score";
  events?: Array<{
    side: "blue" | "red";
    sideId?: SideId | string;
    delta: number;
    title: string;
    detail: string;
    category?: ScorePillarKey | string;
    artifactIds?: string[];
    minute?: number;
  }>;
};

export type FeaturedQuoteState = {
  id: string;
  speakerId: SpeakerId | "Debate audio";
  sideId?: SideId;
  sideColor?: "blue" | "red";
  text: string;
  rawText?: string;
  atSec?: number;
  updatedAt: number;
  source: "cleaned_transcript" | string;
  utteranceIds: string[];
  rawTurnIds: string[];
};

export type SpeakerSideMapEntry = {
  speakerId: SpeakerId;
  sideId?: SideId | "";
  confidence: number;
  speakerRole?: SpeakerFloorRole;
  roleConfidence?: number;
  reason: string;
  updatedAt: number;
};

export type IssueGroup = {
  id: string;
  title: string;
  summary: string;
  sideIds: SideId[];
  cardIds: string[];
  artifactIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type ScorecardSide = {
  sideId: SideId;
  label: string;
  color: "blue" | "red";
  score: number;
  metrics: ScorecardMetrics;
  pillars?: ScorePillar[];
  events?: ScoreLedger["events"];
  rawStrength?: number;
  totalContribution?: number;
  reasons: string[];
};

export type Scorecard = {
  version?: number;
  method?: "key_moment_score" | "event_ledger" | string;
  blue: ScorecardSide;
  red: ScorecardSide;
  edgeLabel: "Forming" | "Even" | "Blue edge" | "Red edge";
  reason: string;
  leader?: "blue" | "red" | "even";
  leadMargin?: number;
  ledger?: ScoreLedger;
  updatedAt: number;
};

export type ScoreTimelineEvent = {
  id?: string;
  side: "blue" | "red";
  delta: number;
  title: string;
  detail: string;
  kind: "score" | "loss";
  category?: ScorePillarKey | string;
  artifactIds?: string[];
};

export type ScoreTimelinePoint = {
  minute: number;
  blue: number;
  red: number;
  event?: ScoreTimelineEvent;
};

export type DebateReportTiming = {
  elapsedMs: number;
  measuredAt?: string;
  source?: "api" | "benchmark" | string;
};

// ---- Post-debate report (clean architecture) --------------------------------
export type ReportSideColor = "blue" | "red";

export type ReportScoreEvent = {
  kind: "open" | "final" | "lead" | "verified" | "contradicted" | "misleading" | "inconsistencies" | string;
  label: string;
  side: ReportSideColor | null;
  delta: number;
  count?: number;
};

export type ReportScorePoint = {
  minute: number;
  blue: number;
  red: number;
  pivotal: boolean;
  event?: ReportScoreEvent | null;
};

export type ReportScoreTimeline = {
  points: ReportScorePoint[];
  maxMinute: number;
  debateStartMinute?: number;
  capMinute: number;
};

export type ReportSpeakerEntry = {
  speakerId: string;
  side: ReportSideColor | null;
  minute: number;
};

export type ReportSpeakerStats = {
  verified: number;
  contradicted: number;
  misleading: number;
  inconsistencies: number;
  debatePoints: number;
};

export type ReportSpeaker = {
  speakerId: string;
  side: ReportSideColor;
  score: number;
  stats: ReportSpeakerStats;
  verdict: string;
  standoutQuote?: { text: string; kind: "strength" | "stumble" | "neutral" } | null;
};

export type ReportFactCheck = {
  side: ReportSideColor;
  speakerId: string;
  claim: string;
  quote: string;
  status: "verified" | "contradicted" | "misleading" | "no_clear_source" | string;
  why: string;
  sources: { title: string; url: string }[];
};

export type ReportContradiction = {
  side: ReportSideColor;
  type: string;
  level: string;
  why: string;
  first: { speakerId: string; quote: string };
  second: { speakerId: string; quote: string };
};

export type ReportKeyMoment = {
  title: string;
  detail: string;
  side: ReportSideColor | null;
  impact: "positive" | "negative" | "neutral";
  quote: string;
};

export type ReportScoreboard = {
  blue: { score: number; breakdown: Record<string, number> | null };
  red: { score: number; breakdown: Record<string, number> | null };
};

export type DebateReport = {
  id: string;
  sessionId: string;
  generatedAt: string;
  generationTiming?: DebateReportTiming;
  topic: string;
  durationMs: number;
  verdict: string;
  blueSummary: string;
  redSummary: string;
  scoreboard: ReportScoreboard;
  scoreTimeline: ReportScoreTimeline;
  speakerEntries: ReportSpeakerEntry[];
  speakers: ReportSpeaker[];
  factChecks: ReportFactCheck[];
  contradictions: ReportContradiction[];
  keyMoments: ReportKeyMoment[];
};

export type DebateState = {
  topic: string;
  speakerDisplayNames?: Record<string, string>;
  speakers: SpeakerProfile[];
  sides: DebateSide[];
  points: DebatePoint[];
  rebuttals: RebuttalLink[];
  scores: CoreScores;
  floorState?: FloorState;
  utterances?: CleanUtterance[];
  dialogueWindows?: DialogueWindow[];
  speakerPositionMemory?: SpeakerPositionMemory[];
  featuredQuote?: FeaturedQuoteState | null;
  featuredQuoteAttemptedAt?: number;
  analysisSchemaVersion?: number;
  analysis?: DirectAnalysisState | null;
  artifacts?: DebateArtifacts;
  scorecard?: Scorecard;
  claims: ClaimSignal[];
  contradictions: Array<{
    turnId?: string;
    speakerId: string;
    summary: string;
    severity: "low" | "medium" | "high";
    sourceQuote?: string;
    targetQuote?: string;
    sourceClaim?: string;
    targetClaim?: string;
  }>;
};
