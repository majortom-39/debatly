export function createSpeechmaticsLiveSttNodeConfig(config = {}) {
  // --- Diarization tuning (all from the Speechmatics realtime docs) ----------
  // prefer_current_speaker: don't flip to a similar-sounding speaker on noise.
  // max_speakers: cap over-splitting (jubilee has ~8; allow a little headroom).
  // speaker_sensitivity: lower = fewer phantom speakers from background noise.
  const speakerDiarizationConfig = {
    max_speakers: Number(config.speechmaticsMaxSpeakers || 10),
    prefer_current_speaker: config.speechmaticsPreferCurrentSpeaker !== false,
    speaker_sensitivity: Number(
      config.speechmaticsSpeakerSensitivity != null ? config.speechmaticsSpeakerSensitivity : 0.35
    )
  };

  const transcriptionConfig = {
    language: config.speechmaticsLanguage || "en",
    operating_point: config.speechmaticsOperatingPoint || "enhanced",
    diarization: "speaker",
    enable_partials: true,
    speaker_diarization_config: speakerDiarizationConfig,
    // max_delay: shorter holds segments less long → more stable for long debates
    // and avoids single-utterance duration limits on long monologues.
    max_delay: Number(config.speechmaticsMaxDelay || 2)
  };

  // Audio filtering: drop low-volume background speech before it's transcribed
  // (the direct fix for external noise corrupting diarization). 0 disables.
  const volumeThreshold = Number(
    config.speechmaticsVolumeThreshold != null ? config.speechmaticsVolumeThreshold : 3
  );
  if (volumeThreshold > 0) {
    transcriptionConfig.audio_filtering_config = { volume_threshold: volumeThreshold };
  }

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
      operating_point: transcriptionConfig.operating_point,
      diarization: transcriptionConfig.diarization,
      enable_partials: transcriptionConfig.enable_partials,
      sample_rate: startMessage.audio_format.sample_rate,
      encoding: startMessage.audio_format.encoding,
      max_speakers: speakerDiarizationConfig.max_speakers,
      prefer_current_speaker: speakerDiarizationConfig.prefer_current_speaker,
      speaker_sensitivity: speakerDiarizationConfig.speaker_sensitivity,
      max_delay: transcriptionConfig.max_delay,
      volume_threshold: volumeThreshold
    }
  };
}
