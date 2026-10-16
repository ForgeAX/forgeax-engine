import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { PerformanceObserver } from 'node:perf_hooks';
import { Session } from 'node:inspector';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { curve3, vec3 } from '@forgeax/engine-math';
import { createProfileSweepGeometry } from '@forgeax/engine-geometry';
import { MeshFilter } from '@forgeax/engine-render';
import { pickTriangle } from '../src/pick-triangle';
import { pickVertexOnEntity } from '../src/pick-vertex';
import { skinScene } from '../src/__tests__/skin-scene.fixture';

// Build with bun --target node --packages external; run node --expose-gc.
// Optional prebundled baseline modules compare identical supported Skin and static queries.
const directory = process.argv[2] ?? 'artifacts/picking-curves';
const baselineTriangle = process.argv[3]
  ? (await import(pathToFileURL(resolve(process.argv[3])).href)).pickTriangle
  : undefined;
const baselineVertex = process.argv[4]
  ? (await import(pathToFileURL(resolve(process.argv[4])).href)).pickVertexOnEntity
  : undefined;
const gc: { durationMs: number; kind: number }[] = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries())
    gc.push({ durationMs: e.duration, kind: (e as any).detail.kind });
}).observe({ entryTypes: ['gc'] });
const session = new Session();
session.connect();
const post = (method: string, params = {}) =>
  new Promise<any>((resolve, reject) =>
    session.post(method as any, params, (err, value) => (err ? reject(err) : resolve(value))),
  );
const pct = (values: number[], q: number) =>
  values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * q)];
const records: any[] = [];
async function compare(name: string, callA: () => unknown, callB: () => unknown, spec: object) {
  const raw: any[] = [];
  for (let i = 0; i < 100; i++) {
    callA();
    callB();
  }
  for (const mode of ['A', 'B', 'B', 'A']) {
    globalThis.gc?.();
    await new Promise((r) => setImmediate(r));
    const gcStart = gc.length,
      before = process.memoryUsage();
    let peak = { ...before };
    for (let frame = 0; frame < 300; frame++) {
      const start = performance.now();
      const result = (mode === 'A' ? callA : callB)();
      const elapsedMs = performance.now() - start;
      if (result === undefined) throw new Error('benchmark query must have a result');
      raw.push({ mode, frame, elapsedMs });
      if (frame % 25 === 0) {
        const now = process.memoryUsage();
        for (const key of ['rss', 'heapUsed', 'arrayBuffers'] as const)
          peak[key] = Math.max(peak[key], now[key]);
      }
    }
    await post('HeapProfiler.startSampling', {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let i = 0; i < 300; i++) (mode === 'A' ? callA : callB)();
    const profile = await post('HeapProfiler.stopSampling');
    await new Promise((r) => setImmediate(r));
    const sampledBytes = (profile.profile?.samples ?? []).reduce(
      (s: number, v: any) => s + v.size,
      0,
    );
    records.push({
      name,
      mode,
      ...spec,
      windowSamples: 300,
      warmup: 100,
      p50Ms: pct(
        raw.filter((v) => v.mode === mode).map((v) => v.elapsedMs),
        0.5,
      ),
      p95Ms: pct(
        raw.filter((v) => v.mode === mode).map((v) => v.elapsedMs),
        0.95,
      ),
      sampledJsAllocBytes: sampledBytes,
      bytesPerQuery: sampledBytes / 300,
      before,
      peak,
      gc: gc.slice(gcStart),
    });
  }
  return raw;
}
const raw: any[] = [];
for (const segments of [16, 512, 4096, 16384]) {
  const s = skinScene(segments);
  const query = () => pickTriangle(s.world, s.camera, 64, 64, 128, 128);
  const base = baselineTriangle
    ? () => baselineTriangle(s.world, s.camera, 64, 64, 128, 128)
    : query;
  raw.push({
    name: 'skin-static-' + segments,
    rows: await compare('skin-static-' + segments, base, query, {
      vertices: (segments + 1) * 2,
      triangles: segments * 2,
      joints: 2,
      scratchBytes: 12 * (segments + 1) * 2 + 64 * 2,
    }),
  });
  let tick = 0;
  const dynamic = (pick: any) => () => {
    s.pose(Math.sin(++tick * 0.1) * 0.05, 0.15 * Math.sin(tick * 0.07));
    return pick(s.world, s.camera, 64, 64, 128, 128);
  };
  raw.push({
    name: 'skin-updating-' + segments,
    rows: await compare(
      'skin-updating-' + segments,
      dynamic(baselineTriangle ?? pickTriangle),
      dynamic(pickTriangle),
      {
        vertices: (segments + 1) * 2,
        triangles: segments * 2,
        joints: 2,
        includesPropagation: true,
      },
    ),
  });
  // Static vertex query isolates the former per-triangle temporary vector allocations.
  s.world.removeComponent(s.entity, (await import('@forgeax/engine-skinning')).Skin).unwrap();
  const mesh = { ...s.mesh, attributes: { position: s.mesh.attributes.position } };
  s.world
    .set(s.entity, MeshFilter, { assetHandle: s.world.allocSharedRef('MeshAsset', mesh) })
    .unwrap();
  const vertex = () => pickVertexOnEntity(s.world, s.camera, 74, 64, 128, 128, s.entity);
  const bv = baselineVertex
    ? () => baselineVertex(s.world, s.camera, 74, 64, 128, 128, s.entity)
    : vertex;
  raw.push({
    name: 'vertex-static-' + segments,
    rows: await compare('vertex-static-' + segments, bv, vertex, {
      vertices: (segments + 1) * 2,
      triangles: segments * 2,
      joints: 0,
    }),
  });
}
const controls = [
  [0, 0, 0],
  [0.05, 0.01, 0],
  [1, 2, 0],
  [5, 2, 1],
  [5.1, 2.1, 1],
];
const sample = (out: vec3.Vec3, t: number) => curve3.catmullRom(out, controls, t);
const lengths = curve3.arcLengths(new Float32Array(4097), sample);
const out = vec3.create();
let n = 0;
raw.push({
  name: 'curve-distance',
  rows: await compare(
    'curve-distance',
    () => sample(out, (++n % 1000) / 1000),
    () =>
      sample(
        out,
        curve3.parameterAtDistance(lengths, ((lengths.at(-1) ?? 0) * (++n % 1000)) / 1000),
      ),
    { controls: 5, tableBytes: lengths.byteLength },
  ),
});
const sweep: any[] = [];
const shape = {
  contour: [
    { x: -0.04, y: -0.08 },
    { x: 0.04, y: -0.08 },
    { x: 0.04, y: 0.08 },
    { x: -0.04, y: 0.08 },
  ],
};
for (const count of [2, 64, 1024, 4096]) {
  const path = Array.from({ length: count }, (_, i) => [0, 0, i * 0.1] as const),
    times = [];
  for (let i = 0; i < 5; i++) createProfileSweepGeometry(shape, path, { capped: false }).unwrap();
  let peakBytes = 0;
  for (let i = 0; i < 30; i++) {
    const start = performance.now(),
      mesh = createProfileSweepGeometry(shape, path, { capped: false }).unwrap();
    times.push(performance.now() - start);
    peakBytes = Math.max(peakBytes, mesh.vertices.byteLength + (mesh.indices?.byteLength ?? 0));
  }
  sweep.push({
    points: count,
    vertices: (count - 1) * 24,
    meshBytes: peakBytes,
    rawMs: times,
    p50Ms: pct(times, 0.5),
    p95Ms: pct(times, 0.95),
  });
}
session.disconnect();
mkdirSync(directory, { recursive: true });
writeFileSync(
  `${directory}/performance.json`,
  JSON.stringify(
    {
      cpu: cpus()[0]?.model,
      platform: platform(),
      runtime: process.versions,
      resolution: [128, 128],
      scope:
        'Uninstrumented CPU query timing; separate 300-query V8 allocation sample; GC covers both windows. CPU query benchmark; GPU not used; A=baseline B=current for supported skin/static vertices; curve A=parameter B=distance; sampler approximation and scratch reported separately; V8 sampling excludes external backing buffers; no retained pose',
      order: 'ABBA',
      records,
      raw,
      sweep,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      records: records.map(({ gc, before, peak, ...v }) => v),
      sweep: sweep.map(({ rawMs, ...v }) => v),
    },
    null,
    2,
  ),
);
