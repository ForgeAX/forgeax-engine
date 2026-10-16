/* global AudioWorkletProcessor, registerProcessor, currentFrame, sampleRate */
// Copies the actual input frames; no synthetic silence or DSP processing.
class AcousticRecorder extends AudioWorkletProcessor {
  channels = [new Float32Array(1024), new Float32Array(1024)];
  offset = 0;
  firstFrame = 0;
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const frames = output[0]?.length ?? 128;
    if (this.offset === 0) this.firstFrame = currentFrame;
    for (let channel = 0; channel < 2; channel++) {
      const samples = input[channel];
      if (samples) {
        output[channel]?.set(samples);
        this.channels[channel].set(samples, this.offset);
      } else this.channels[channel].fill(0, this.offset, this.offset + frames);
    }
    this.offset += frames;
    if (this.offset === 1024) {
      this.port.postMessage({ channels: this.channels, firstFrame: this.firstFrame,
        frameCount: this.offset, sampleRate }, this.channels.map(channel => channel.buffer));
      this.channels = [new Float32Array(1024), new Float32Array(1024)];
      this.offset = 0;
    }
    return true;
  }
}
registerProcessor('acoustic-recorder', AcousticRecorder);
