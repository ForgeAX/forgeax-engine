// Synthetic large-capture page driven by ../measure-large-capture.mjs.
// Query: ?mb=<total seeded MiB>&mode=live-dev|upload
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { attachRecorder } from '../../src/index';
import { uploadTape } from '../../src/browser';

const BUFFER_BYTES = 64 * 1024 * 1024;
const params = new URLSearchParams(location.search);
const totalMiB = Number(params.get('mb') ?? '832');
const mode = params.get('mode') ?? 'upload';
const marks: Record<string, number> = {};
const t0 = performance.now();
const mark = (name: string) => {
  marks[name] = Math.round(performance.now() - t0);
  console.log(`[large-capture] ${name} ${marks[name]}ms`);
};
const fail = (stage: string, cause: unknown): never => {
  throw new Error(`${stage}: ${typeof cause === 'string' ? cause : JSON.stringify(cause)}`);
};

async function run() {
  const recorder = attachRecorder(webgpu);
  if (!recorder.ok) fail('attach', recorder.error);
  const attachment = recorder.unwrap();
  const adapter = (await attachment.backend.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice()
  ).unwrap();
  const count = Math.ceil((totalMiB * 1024 * 1024) / BUFFER_BYTES);
  const scratch = new Uint32Array(BUFFER_BYTES / 4);
  const buffers = [];
  for (let i = 0; i < count; i++) {
    let x = (i + 1) * 0x9e3779b1;
    for (let j = 0; j < scratch.length; j++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      scratch[j] = x >>> 0;
    }
    const buffer = device.createBuffer({ size: BUFFER_BYTES, usage: 128 | 4 | 8, label: `seed-${i}` }).unwrap();
    device.queue.writeBuffer(buffer, 0, scratch).unwrap();
    buffers.push(buffer);
  }
  const sink = device.createBuffer({ size: 256 * count, usage: 4 | 8, label: 'sink' }).unwrap();
  mark('resources');

  const pending = attachment.captureFrame({ snapshotTimeoutMs: 600_000 });
  await attachment.frameBoundary();
  mark('snapshot');
  const encoder = device.createCommandEncoder().unwrap();
  buffers.forEach((buffer, i) => encoder.copyBufferToBuffer(buffer, 0, sink, i * 256, 256));
  device.queue.submit([encoder.finish().unwrap()]);
  attachment.frameBoundary();
  const captured = await pending;
  if (!captured.ok) fail('capture', captured.error);
  const tape = captured.unwrap();
  mark('captured');
  const tapeBytes = 'byteLength' in tape ? (tape as { byteLength: number }).byteLength : tape.bytes.byteLength;
  const spent = { fetchMs: 0, digestMs: 0 };
  const timed = <A extends unknown[], R>(key: keyof typeof spent, fn: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      const start = performance.now();
      try {
        return await fn(...args);
      } finally {
        spent[key] += performance.now() - start;
      }
    };
  globalThis.fetch = timed('fetchMs', globalThis.fetch.bind(globalThis));
  crypto.subtle.digest = timed('digestMs', crypto.subtle.digest.bind(crypto.subtle));

  let artifact: unknown;
  if (mode === 'live-dev') {
    const response = await fetch('/__forgeax-debug/tape?runId=large-live-dev', {
      method: 'POST',
      headers: { 'content-type': 'application/x-forgeax-rhitape' },
      body: new Blob([tape.bytes as Uint8Array<ArrayBuffer>]),
    });
    artifact = await response.json();
    if (!response.ok) fail('upload', artifact);
  } else {
    const result = await uploadTape(tape, { runId: 'large-upload' });
    if (!result.ok) fail('upload', result.error);
    artifact = result.unwrap();
  }
  mark('uploaded');
  // The whole-container digest is computed only for this cross-check.
  const digest = tape.digest;
  mark('digest');
  return { ok: true, count, tapeBytes, digest, artifact, marks, spent };
}

(globalThis as { __largeCapture?: Promise<unknown> }).__largeCapture = run().catch((cause) => ({
  ok: false,
  cause: String(cause),
  marks,
}));
