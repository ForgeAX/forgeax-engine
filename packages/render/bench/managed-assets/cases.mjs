/** Fixed design §10.3 workloads; do not shrink a failed case to obtain a pass. */
export const dimensions = Object.freeze({ width: 512, height: 512, seed: 0x4d414e41, warmupFrames: 60, measuredFrames: 300, groups: 3, targetHz: 60 });
export const cases = [
  ...[1_000, 10_000].map(count => ({ id: `transform-${count}`, kind: 'transform', count, unique: 1, writes: 1 })),
  { id: 'transform-fragmented-10000', kind: 'transform', count: 10_000, unique: 1, writes: 1, tables: 128 },
  { id: 'transform-dense-1000', kind: 'transform', count: 1_000, unique: 1, writes: 1_000 },
  ...[1, 10_000, 50_000].flatMap(count => [
    { id: `static-${count}`, kind: 'material', count, unique: 1, writes: 0 },
    { id: `shared-${count}`, kind: 'material', count, unique: 1, writes: 1 },
  ]),
  ...[0, 10_000, 50_000].map(unrelated => ({ id: `unrelated-${unrelated}`, kind: 'material', count: 1, unique: 1, writes: 1, unrelated })),
  ...[1, 100, 1000].flatMap(unique => [1, 8].map(writes => ({ id: `material-${unique}-writes-${writes}`, kind: 'material', count: 1000, unique, writes }))),
  ...[64_000, 1_000_000].flatMap(vertices => [64, Math.floor(vertices * .01), vertices].map(changed => ({ id: `mesh-${vertices}-changed-${changed}`, kind: 'mesh', count: 1, vertices, changed, writes: 1 }))),
  ...[16, 256, 2048].map(region => ({ id: `texture-2048-region-${region}`, kind: 'texture', count: 1, extent: 2048, region, writes: 1 })),
  { id: 'texture-resize', kind: 'texture-resize', count: 1, extent: 2048, writes: 1 },
  { id: 'mesh-topology', kind: 'mesh-topology', count: 1, vertices: 64_000, writes: 1 },
  { id: 'create-release', kind: 'lifecycle', count: 1000, unique: 100, writes: 1 },
  ...[1, 2].map(renderers => ({ id: `backpressure-${renderers}`, kind: 'backpressure', count: 1000, unique: 1, writes: 1, renderers, producerHz: 120, consumerHz: 15, pauseMs: 2000 })),
];
