const DEEPGRAM_UNASSIGNED_RAW_SPEAKER = "__unassigned__";

export function createDeepgramLiveSttNodeConfig(config = {}) {
  const baseUrl = config.deepgramRealtimeUrl || "wss://api.deepgram.com/v1/listen";
  const url = new URL(baseUrl);
  const set = (key, value) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, String(value));
  };
  const setBool = (key, value) => set(key, value ? "true" : "false");

  set("model", config.deepgramModel || "nova-3");
  set("language", config.deepgramLanguage || "en");
  set("encoding", config.deepgramEncoding || "linear16");
  set("sample_rate", Number(config.deepgramSampleRate || 16000));
  set("channels", Number(config.deepgramChannels || 1));
  setBool("diarize", config.deepgramDiarize !== false);
  setBool("interim_results", config.deepgramInterimResults !== false);
  setBool("punctuate", config.deepgramPunctuate !== false);
  setBool("smart_format", config.deepgramSmartFormat !== false);
  set("endpointing", Number(config.deepgramEndpointingMs || 500));
  set("utterance_end_ms", Number(config.deepgramUtteranceEndMs || 1000));
  setBool("vad_events", config.deepgramVadEvents !== false);

  return {
    url: url.toString(),
    summary: {
      model: url.searchParams.get("model"),
      language: url.searchParams.get("language"),
      encoding: url.searchParams.get("encoding"),
      sample_rate: Number(url.searchParams.get("sample_rate")),
      channels: Number(url.searchParams.get("channels")),
      diarize: url.searchParams.get("diarize") === "true",
      interim_results: url.searchParams.get("interim_results") === "true",
      punctuate: url.searchParams.get("punctuate") === "true",
      smart_format: url.searchParams.get("smart_format") === "true",
      endpointing: Number(url.searchParams.get("endpointing")),
      utterance_end_ms: Number(url.searchParams.get("utterance_end_ms")),
      vad_events: url.searchParams.get("vad_events") === "true"
    }
  };
}

export function deepgramResultsTranscript(event = {}) {
  return String(deepgramAlternative(event)?.transcript || "").trim();
}

export function deepgramEventStats(event = {}) {
  const alternative = deepgramAlternative(event);
  const words = Array.isArray(alternative?.words) ? alternative.words : [];
  const transcriptChars = deepgramResultsTranscript(event).length;
  return {
    resultItems: words.length,
    wordItems: words.filter((word) => String(word?.word || word?.punctuated_word || "").trim()).length,
    punctuationItems: 0,
    transcriptChars,
    speechFinal: Boolean(event.speech_final),
    fromFinalize: Boolean(event.from_finalize)
  };
}

export function splitDeepgramResultsBySpeaker(event = {}, mapRawSpeaker, options = {}) {
  const alternative = deepgramAlternative(event);
  const words = Array.isArray(alternative?.words) ? alternative.words : [];
  const transcript = deepgramResultsTranscript(event);
  const groups = [];
  const timestampOffsetSec = Number(options.timestampOffsetSec || 0);
  const unassignedSpeakerId = options.unassignedSpeakerId || "Unassigned speaker";

  for (const word of words) {
    const text = String(word?.punctuated_word || word?.word || "").trim();
    if (!text) continue;
    const rawSpeaker = normalizeDeepgramRawSpeaker(word?.speaker);
    const speakerId = typeof mapRawSpeaker === "function"
      ? mapRawSpeaker(rawSpeaker)
      : unassignedSpeakerId;
    const wordInfo = {
      word: text,
      rawSpeaker,
      startSec: offsetTimestamp(word?.start, timestampOffsetSec),
      endSec: offsetTimestamp(word?.end, timestampOffsetSec)
    };
    const last = groups.at(-1);
    if (last?.speakerId === speakerId) {
      last.words.push(wordInfo);
      last.rawSpeakers = uniqueStrings([...(last.rawSpeakers || []), rawSpeaker]);
      if (rawSpeaker === DEEPGRAM_UNASSIGNED_RAW_SPEAKER) last.unassignedWords = Number(last.unassignedWords || 0) + 1;
    } else {
      groups.push({
        speakerId,
        words: [wordInfo],
        rawSpeakers: [rawSpeaker],
        unassignedWords: rawSpeaker === DEEPGRAM_UNASSIGNED_RAW_SPEAKER ? 1 : 0
      });
    }
  }

  if (!groups.length && transcript) {
    return [{
      speakerId: unassignedSpeakerId,
      text: transcript,
      words: [{ word: transcript, rawSpeaker: DEEPGRAM_UNASSIGNED_RAW_SPEAKER }],
      rawSpeakers: [DEEPGRAM_UNASSIGNED_RAW_SPEAKER],
      unassignedWords: wordCount(transcript)
    }];
  }

  return groups.map((group) => ({
    speakerId: group.speakerId,
    text: joinWords(group.words.map((word) => word.word)),
    words: group.words,
    rawSpeakers: group.rawSpeakers,
    unassignedWords: Number(group.unassignedWords || 0)
  }));
}

function deepgramAlternative(event = {}) {
  return event?.channel?.alternatives?.[0] || null;
}

function normalizeDeepgramRawSpeaker(rawSpeaker) {
  if (rawSpeaker == null || rawSpeaker === "") return DEEPGRAM_UNASSIGNED_RAW_SPEAKER;
  return String(rawSpeaker);
}

function offsetTimestamp(value, offsetSec) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed + offsetSec : undefined;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function joinWords(words = []) {
  return words.join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

function wordCount(text = "") {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

