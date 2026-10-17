import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { resolve } from 'node:path';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { CloudLayer } from '../src/components/cloud-layer';
import { DirectionalLight } from '../src/components/directional-light';
import { PointLight } from '../src/components/point-light';
import { extractWorldEnvironment } from '../src/extract/world-environment';
import { createWorldInternalView, prepareExtractContext } from '../src/render-system-extract';

// CPU extraction only. This measures cumulative allocations, including collected
// objects, rather than retained heap, browser FPS or native GC pause duration.
const world = new World();
for (let index = 0; index < 128; index++) {
  const tag = defineComponent(`EnvironmentBench${index}`, {});
  world.spawn({ component: tag, data: {} }).unwrap();
}
for (let index = 0; index < 16; index++) {
  world.spawn({ component: PointLight, data: { intensity: index + 1 } }).unwrap();
}
world.spawn({
  component: DirectionalLight,
  data: { intensity: 2, direction: [0, -1, 0], castShadow: false },
}).unwrap();
world.spawn({ component: CloudLayer, data: {} }).unwrap();
const context = prepareExtractContext(world);
const internal = createWorldInternalView(world);
const extract = () => extractWorldEnvironment(world, context, internal, undefined);
for (let frame = 0; frame < 120; frame++) extract();

const inspector = new Session();
inspector.connect();
try {
  await inspector.post('HeapProfiler.startSampling', {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  let checksum = 0;
  const iterations = 10_000;
  const started = performance.now();
  for (let frame = 0; frame < iterations; frame++) {
    const extracted = extract();
    checksum += extracted.lights.point.length;
    for (const light of extracted.lights.point) checksum += light.color[0] ?? 0;
    checksum += extracted.cloudLayer?.sunRadiance?.[0] ?? 0;
  }
  const elapsedMs = performance.now() - started;
  const { profile } = await inspector.post('HeapProfiler.stopSampling');
  const totals = { allocatedBytes: 0, queryBytes: 0, refreshMatchesBytes: 0 };
  function visit(node: typeof profile.head, query = false, refresh = false): void {
    const ownsQuery = query || /^(createQuery\d*|query)$/.test(node.callFrame.functionName);
    const ownsRefresh = refresh || node.callFrame.functionName === 'refreshMatches';
    totals.allocatedBytes += node.selfSize;
    if (ownsQuery) totals.queryBytes += node.selfSize;
    if (ownsRefresh) totals.refreshMatchesBytes += node.selfSize;
    for (const child of node.children) visit(child, ownsQuery, ownsRefresh);
  }
  visit(profile.head);
  const output = resolve(process.argv[2] ?? '.forgeax-harness/environment-extract');
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'allocation.heapprofile'), JSON.stringify(profile));
  const result = {
    iterations,
    unrelatedArchetypes: 128,
    pointLights: 16,
    samplingInterval: 32768,
    checksum,
    elapsedMs,
    ...totals,
    allocatedBytesPerExtraction: totals.allocatedBytes / iterations,
  };
  writeFileSync(resolve(output, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  inspector.disconnect();
}
