import { readFileSync } from 'node:fs';

function readCapture(path) {
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const projection = file.evidence?.shadowProjection;
  const samples = projection?.timings ?? file.samples;
  if (!Array.isArray(samples)) throw new Error(`Missing GPU timestamp samples in ${path}`);
  const frames = new Map();
  for (const [index, sample] of samples.entries()) {
    const progress = sample.progress ?? index + 1;
    if (frames.has(progress)) throw new Error(`Duplicate sample ${progress} in ${path}`);
    frames.set(progress, sample.timing ?? sample);
  }
  return {
    path,
    frames,
    adapter: file.gpuAdapterInfo ?? file.deviceInfo?.adapterInfo ?? null,
    receiver: projection?.observed ?? file.receiver ?? null,
    workload: file.evidence?.workloadFingerprint ?? null,
    extent: file.readback === undefined ? null : [file.readback.width, file.readback.height],
  };
}

function isReceiverWork(name) {
  return (
    name.startsWith('standard-scene-surface-data') ||
    name === 'forward-directional-shadow' ||
    name === 'main' ||
    name === 'skybox + main'
  );
}

function unionMs(frame, include) {
  const intervals = frame.passes
    .flatMap((pass) =>
      pass.status === 'measured' && include(pass.passName)
        ? [[BigInt(pass.beginningTick), BigInt(pass.endTick)]]
        : [],
    )
    .sort(([left], [right]) => (left < right ? -1 : Number(left > right)));
  let end = 0n;
  let ticks = 0n;
  for (const [begin, nextEnd] of intervals) {
    if (nextEnd <= end) continue;
    ticks += nextEnd - (begin < end ? end : begin);
    end = nextEnd;
  }
  return (Number(ticks) * frame.timestampPeriodNanoseconds) / 1e6;
}

function distribution(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95: sorted[Math.ceil(0.95 * sorted.length) - 1],
  };
}

function summarize({ frames, ...capture }, paired) {
  return {
    ...capture,
    sampled: frames.size,
    excluded: [...frames].flatMap(([progress, sample]) =>
      paired.includes(progress)
        ? []
        : [
            {
              progress,
              status: sample.status,
              ...(sample.error ? { error: sample.error.code } : {}),
            },
          ],
    ),
    receiverPassUnionMs: distribution(
      paired.map((progress) => unionMs(frames.get(progress).frame, isReceiverWork)),
    ),
    gpuFrameUnionMs: distribution(
      paired.map((progress) => unionMs(frames.get(progress).frame, () => true)),
    ),
  };
}

const [rawPath, screenPath, ...extra] = process.argv.slice(2);
if (rawPath === undefined || screenPath === undefined || extra.length !== 0) {
  throw new Error(
    'Usage: node scripts/test/compare-forward-shadow-timings.mjs RAW.json SCREEN.json',
  );
}
const raw = readCapture(rawPath);
const screen = readCapture(screenPath);
if (
  raw.workload !== screen.workload ||
  JSON.stringify(raw.extent) !== JSON.stringify(screen.extent)
) {
  throw new Error('Capture workload or drawing-buffer extent differs between arms');
}
if (
  raw.adapter !== null &&
  screen.adapter !== null &&
  JSON.stringify(raw.adapter) !== JSON.stringify(screen.adapter)
) {
  throw new Error('GPU adapters differ between arms');
}
if (screen.receiver?.mode !== 'screen')
  throw new Error('Projected arm did not admit screen shadows');
const paired = [...raw.frames.keys()].filter(
  (progress) =>
    raw.frames.get(progress)?.status === 'complete' &&
    screen.frames.get(progress)?.status === 'complete',
);
console.log(
  JSON.stringify(
    {
      matchedFrames: paired.length,
      raw: summarize(raw, paired),
      screen: summarize(screen, paired),
    },
    null,
    2,
  ),
);
if (paired.length === 0) process.exitCode = 1;
