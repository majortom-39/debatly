class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.outputSampleRate = 16000;
    this.pending = new Float32Array(0);
    this.cursor = 0;
    this.channelMode = options?.processorOptions?.channelMode || "left";
    this.statsIntervalFrames = sampleRate;
    this.framesSinceStats = 0;
  }

  process(inputs) {
    const channels = inputs[0] || [];
    const firstChannel = channels[0];
    if (!firstChannel || firstChannel.length === 0) return true;

    const input = this.captureInput(channels, firstChannel.length);
    this.maybePostChannelStats(channels, firstChannel.length);

    const ratio = sampleRate / this.outputSampleRate;
    if (!Number.isFinite(ratio) || ratio <= 0) return true;

    const pending = new Float32Array(this.pending.length + input.length);
    pending.set(this.pending, 0);
    pending.set(input, this.pending.length);

    const samples = [];
    let cursor = this.cursor;
    while (cursor + ratio <= pending.length) {
      const start = cursor;
      const end = cursor + ratio;
      let sum = 0;
      let weightSum = 0;
      for (let sourceIndex = Math.floor(start); sourceIndex < Math.ceil(end); sourceIndex += 1) {
        const left = Math.max(start, sourceIndex);
        const right = Math.min(end, sourceIndex + 1);
        const weight = Math.max(0, right - left);
        sum += pending[sourceIndex] * weight;
        weightSum += weight;
      }
      samples.push(Math.max(-1, Math.min(1, sum / Math.max(weightSum, 1e-9))));
      cursor += ratio;
    }

    const drop = Math.floor(cursor);
    this.pending = pending.slice(drop);
    this.cursor = cursor - drop;

    if (!samples.length) return true;

    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    this.port.postMessage(buffer, [buffer]);
    return true;
  }

  captureInput(channels, frameCount) {
    const input = new Float32Array(frameCount);
    if (this.channelMode === "phase_mix" && channels.length >= 2) {
      const left = channels[0];
      const right = channels[1];
      let cross = 0;
      let leftSum = 0;
      let rightSum = 0;
      for (let frame = 0; frame < frameCount; frame += 1) {
        const leftSample = left?.[frame] || 0;
        const rightSample = right?.[frame] || 0;
        cross += leftSample * rightSample;
        leftSum += leftSample * leftSample;
        rightSum += rightSample * rightSample;
      }
      const correlation = Math.sqrt(leftSum * rightSum) > 1e-9
        ? cross / Math.sqrt(leftSum * rightSum)
        : 1;
      const rightPolarity = correlation < -0.2 ? -1 : 1;
      for (let frame = 0; frame < frameCount; frame += 1) {
        const leftSample = left?.[frame] || 0;
        const rightSample = right?.[frame] || 0;
        input[frame] = Math.max(-1, Math.min(1, (leftSample + rightPolarity * rightSample) * 0.5));
      }
      return input;
    }

    if (this.channelMode === "average") {
      for (let frame = 0; frame < frameCount; frame += 1) {
        let sum = 0;
        let channelCount = 0;
        for (const channel of channels) {
          if (!channel || frame >= channel.length) continue;
          sum += channel[frame];
          channelCount += 1;
        }
        input[frame] = channelCount ? sum / channelCount : 0;
      }
      return input;
    }

    const requestedIndex = this.channelMode === "right" ? 1 : 0;
    const selected = channels[requestedIndex] || channels[0];
    for (let frame = 0; frame < frameCount; frame += 1) {
      input[frame] = selected?.[frame] || 0;
    }
    return input;
  }

  maybePostChannelStats(channels, frameCount) {
    this.framesSinceStats += frameCount;
    if (this.framesSinceStats < this.statsIntervalFrames) return;
    this.framesSinceStats = 0;

    const rms = channels.slice(0, 2).map((channel) => {
      if (!channel || !channel.length) return 0;
      let sum = 0;
      for (let index = 0; index < channel.length; index += 1) {
        sum += channel[index] * channel[index];
      }
      return Math.sqrt(sum / channel.length);
    });

    let correlation = null;
    const left = channels[0];
    const right = channels[1];
    if (left && right) {
      let cross = 0;
      let leftSum = 0;
      let rightSum = 0;
      const count = Math.min(left.length, right.length);
      for (let index = 0; index < count; index += 1) {
        cross += left[index] * right[index];
        leftSum += left[index] * left[index];
        rightSum += right[index] * right[index];
      }
      const denominator = Math.sqrt(leftSum * rightSum);
      correlation = denominator > 1e-9 ? cross / denominator : null;
    }

    this.port.postMessage({
      type: "audio_channel_stats",
      inputChannels: channels.length,
      channelMode: this.channelMode,
      rms,
      correlation
    });
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
