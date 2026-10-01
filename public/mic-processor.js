/**
 * AudioWorklet microphone processor.
 *
 * Runs on the audio rendering thread: downsamples the microphone from the
 * AudioContext sample rate (e.g. 48 kHz) to 16 kHz mono PCM-16 and posts the
 * samples to the main thread for streaming to the Gemini Live API.
 *
 * Using an AudioWorklet (instead of the deprecated ScriptProcessorNode) keeps
 * latency low, avoids main-thread jank, and prevents the browser deprecation
 * warning from appearing in the console.
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global provided by the AudioWorkletGlobalScope.
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.leftover = new Float32Array(0);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    // Merge any leftover samples from the previous quantum with the new ones.
    const merged = new Float32Array(this.leftover.length + channel.length);
    merged.set(this.leftover, 0);
    merged.set(channel, this.leftover.length);

    const outCount = Math.floor(merged.length / this.ratio);
    if (outCount <= 0) {
      this.leftover = merged;
      return true;
    }

    const out = new Int16Array(outCount);
    for (let i = 0; i < outCount; i++) {
      const start = Math.floor(i * this.ratio);
      const end = Math.min(merged.length, Math.floor((i + 1) * this.ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += merged[j];
      const count = end - start;
      let sample = count > 0 ? sum / count : 0;
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    const consumed = Math.floor(outCount * this.ratio);
    this.leftover = merged.slice(consumed);

    // Transfer the buffer (zero-copy) to the main thread.
    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
