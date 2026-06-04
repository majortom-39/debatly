export function createSpeechmaticsLiveSttNodeConfig(config = {}) {
  // Speechmatics does WORDS ONLY — speaker identity is handled by the local
  // pyannote engine. This mirrors the test backend exactly:
  //   TranscriptionConfig(language="en", max_delay=0.7, enable_partials=True)
  // No Speechmatics diarization, no operating_point override (Speechmatics
  // default), no audio filtering. Lower max_delay = finals settle ~3x faster.
  const transcriptionConfig = {
    language: config.speechmaticsLanguage || "en",
    max_delay: Number(config.speechmaticsMaxDelay || 0.7),
    enable_partials: true
  };

  const startMessage = {
    message: "StartRecognition",
    audio_format: {
      type: "raw",
      encoding: "pcm_s16le",
      sample_rate: Number(config.speechmaticsSampleRate || 16000)
    },
    transcription_config: transcriptionConfig
  };

  return {
    url: config.speechmaticsRealtimeUrl || "wss://us.rt.speechmatics.com/v2",
    startMessage,
    summary: {
      url: config.speechmaticsRealtimeUrl || "wss://us.rt.speechmatics.com/v2",
      language: transcriptionConfig.language,
      diarization: "none (local pyannote owns speakers)",
      enable_partials: transcriptionConfig.enable_partials,
      sample_rate: startMessage.audio_format.sample_rate,
      encoding: startMessage.audio_format.encoding,
      max_delay: transcriptionConfig.max_delay
    }
  };
}
