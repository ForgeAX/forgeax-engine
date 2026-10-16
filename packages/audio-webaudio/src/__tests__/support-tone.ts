export function toneBuffer(
  context: BaseAudioContext,
  frequencies: readonly number[],
  seconds = 2,
): AudioBuffer {
  const buffer = context.createBuffer(
    1,
    Math.round(context.sampleRate * seconds),
    context.sampleRate,
  );
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    let value = 0;
    for (const frequency of frequencies)
      value += Math.sin((2 * Math.PI * frequency * i) / context.sampleRate);
    samples[i] = (value / frequencies.length) * 0.5;
  }
  return buffer;
}

export function pcmWav(input: Float32Array, sampleRate = 48000): Uint8Array {
  const samples = input.length;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++)
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, input[i] ?? 0)) * 32767), true);
  return bytes;
}

export function toneWav(frequency = 440): Uint8Array {
  const samples = new Float32Array(96000);
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.sin((2 * Math.PI * frequency * i) / 48000) * 0.5;
  return pcmWav(samples);
}

export function rms(samples: Float32Array, from: number, to: number): number {
  let total = 0;
  for (let i = from; i < to; i++) total += (samples[i] ?? 0) ** 2;
  return Math.sqrt(total / (to - from));
}

export function magnitude(samples: Float32Array, sampleRate: number, frequency: number): number {
  let real = 0,
    imaginary = 0;
  const start = Math.round(sampleRate * 0.2),
    end = Math.round(sampleRate * 0.8);
  for (let i = start; i < end; i++) {
    real += (samples[i] ?? 0) * Math.cos((2 * Math.PI * frequency * i) / sampleRate);
    imaginary += (samples[i] ?? 0) * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return (Math.hypot(real, imaginary) * 2) / (end - start);
}
