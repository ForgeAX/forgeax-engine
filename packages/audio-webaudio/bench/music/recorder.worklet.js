class MusicRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.captureStart = -1;
    this.frames = Math.round(sampleRate * (options.processorOptions.seconds ?? 10));
    this.pending = new Float32Array(sampleRate);
    this.used = 0;
    this.chunkStart = 0;
    this.flushRequested = false;
    this.port.onmessage = event => {
      if (event.data?.flush === true) this.flushRequested = true;
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0], output = outputs[0]?.[0];
    if (input && output) output.set(input);
    if (this.flushRequested) {
      this.flushRequested = false;
      if (this.used > 0) {
        const pcm = this.pending.slice(0, this.used);
        this.port.postMessage({ captureStart: this.captureStart, sample: this.chunkStart, pcm, flushComplete: true }, [pcm.buffer]);
        this.chunkStart += this.used;
        this.used = 0;
      } else this.port.postMessage({ flushComplete: true });
    }
    if (!input || !output) return true;
    const onsets = [];
    for (let i = 0; i < input.length; i++)
      if (Math.abs(input[i]) > 0.001) onsets.push({ sample: currentFrame + i, amplitude: input[i] });
    if (this.captureStart < 0 && onsets.length) this.captureStart = currentFrame;
    const remaining = this.frames - (currentFrame - this.captureStart);
    const capture = this.captureStart >= 0 && remaining > 0;
    if (capture) {
      const count = Math.min(input.length, remaining);
      let offset = 0;
      while (offset < count) {
        const copy = Math.min(count-offset, this.pending.length-this.used);
        this.pending.set(input.subarray(offset,offset+copy),this.used);
        this.used += copy;offset += copy;
        if (this.used === this.pending.length || remaining === offset) {
          const pcm = this.pending.slice(0,this.used);
          this.port.postMessage({onsets:[],captureStart:this.captureStart,sample:this.chunkStart,pcm},[pcm.buffer]);
          this.chunkStart += this.used;this.used = 0;
        }
      }
    }
    if (onsets.length) this.port.postMessage({onsets,captureStart:this.captureStart});
    return true;
  }
}
registerProcessor('musical-output-recorder', MusicRecorder);
