import { expect, it } from 'vitest';
import { retain, retainNativePcm } from '../retain-native-pcm';

it('retains every native float WAV byte with one bounded publication in flight', async () => {
  const frames = 1024 * 1024 / 4 + 3;
  const pcm = Float32Array.from({ length: frames }, (_, index) => (index % 127 - 63) / 64);
  const output: Uint8Array[] = [];
  let offset = 0;
  let pending = 0;
  await retainNativePcm('complete', {
    context: { sampleRate: 48000 },
    pcm: [{ sample: 0, pcm: pcm.subarray(0, 37) }, { sample: 37, pcm: pcm.subarray(37) }],
  }, frames / 48000, async (name, row) => {
    expect(name).toBe('complete');
    expect(++pending).toBe(1);
    const binary = atob(row.wavBase64);
    const bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
    expect(bytes.length).toBeLessThanOrEqual(1024 * 1024);
    expect(row.wavOffset).toBe(offset);
    output.push(bytes);
    offset += bytes.length;
    await new Promise(resolve => setTimeout(resolve, 1));
    pending--;
  });
  expect(output.map(row => row.length)).toEqual([44, 1024 * 1024, 12]);
  const bytes = new Uint8Array(offset);
  let start = 0;
  for (const chunk of output) { bytes.set(chunk, start); start += chunk.length; }
  const view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
  expect(view.getUint32(4, true)).toBe(bytes.length - 8);
  expect(view.getUint16(20, true)).toBe(3);
  expect(view.getUint32(24, true)).toBe(48000);
  expect(view.getUint32(40, true)).toBe(pcm.length * 4);
  for (let index = 0; index < pcm.length; index++) {
    if (view.getFloat32(44 + index * 4, true) !== pcm[index]) throw new Error(`PCM mismatch at ${index}`);
  }
}, 30000);

it('rejects missing or overlapping native frames before publishing a WAV header', async () => {
  let publications = 0;
  for (const rows of [
    [{ sample: 1, pcm: new Float32Array(2) }],
    [{ sample: 0, pcm: new Float32Array(2) }, { sample: 1, pcm: new Float32Array(1) }],
    [{ sample: 0, pcm: new Float32Array(1) }],
  ]) {
    await expect(retainNativePcm('invalid', { context: { sampleRate: 1 }, pcm: rows }, 2,
      async () => { publications++; })).rejects.toThrow(/native PCM/);
  }
  expect(publications).toBe(0);
});


it('keeps WAV bytes until native sink acknowledgement, then retires the returned duplicate', async () => {
  const host = globalThis as unknown as { __musicRetain?: (name: string, row: unknown) => Promise<void> };
  const previous = host.__musicRetain;
  const row = { wav: [82, 73, 70, 70], waveform: [0.25], pass: true };
  let release!: () => void;
  let received: unknown;
  host.__musicRetain = async (name, value) => {
    expect(name).toBe('acknowledged');
    received = structuredClone(value);
    await new Promise<void>(resolve => { release = resolve; });
  };
  try {
    const pending = retain('acknowledged', row);
    expect(row.wav).toEqual([82, 73, 70, 70]);
    expect(received).toEqual(row);
    release();
    await pending;
    expect(row.wav).toEqual([]);
    expect(row.waveform).toEqual([0.25]);
    expect(row.pass).toBe(true);
    expect(received).toEqual({ wav: [82, 73, 70, 70], waveform: [0.25], pass: true });
  } finally { host.__musicRetain = previous; }
});

it('preserves unacknowledged WAV evidence on sink failure or when no native sink exists', async () => {
  const host = globalThis as unknown as { __musicRetain?: (name: string, row: unknown) => Promise<void> };
  const previous = host.__musicRetain;
  const row = { wav: [82, 73, 70, 70] };
  try {
    host.__musicRetain = async () => { throw new Error('native evidence write rejected'); };
    await expect(retain('rejected', row)).rejects.toThrow('native evidence write rejected');
    expect(row.wav).toEqual([82, 73, 70, 70]);
    host.__musicRetain = undefined;
    await retain('browser-only', row);
    expect(row.wav).toEqual([82, 73, 70, 70]);
  } finally { host.__musicRetain = previous; }
});
