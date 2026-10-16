import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { buildFrameModel } from '@forgeax/engine-rhi-debug';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { materialTerrainGuid } from '../src/identity.ts';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';
const execution = process.argv[2] ?? 'host';
assert(['host', '1', 'engine'].includes(execution));
const reports = [];
for (const encoding of ['weights', 'ids']) {
  const report = await verifyDemoCapture({
    pkg: '@forgeax/hello-terrain',
    label: `hello-terrain-${encoding}-${execution}`,
    appDir: resolve(import.meta.dirname, '..'),
    mode: execution === 'host' ? 'pixel' : 'structural',
    urlSuffix: `?material=${encoding}${execution === 'host' ? '' : `&workers=${execution}`}`,
    ...(execution === 'host'
      ? {
          liveHook: '__readTerrainCapture',
          capturePrepareHook: '__prepareTerrainCapture',
          browserReplayHook: '__replayTerrainCapture',
          pixelVerdictOwner: 'browser-fresh',
          epsilon: 0.05,
          coveredEpsilon: 0.05,
          maxChannelEpsilon: 0.05,
        }
      : { capturePrepareHook: '__prepareTerrainWorkerCapture' }),
    reportHook: '__terrainReport',
    navigationWaitUntil: 'domcontentloaded',
    hookReadyTimeoutMs: 300000,
    assertTape({ tape }) {
      const model = buildFrameModel(tape);
      assert(
        model.works.some((w) =>
          w.pipeline.shaders.some((s) => s.source?.includes('terrainVertex')),
        ),
        'actual Terrain raster work must execute',
      );
      if (encoding === 'ids')
        assert(
          model.works.some((w) =>
            w.pipeline.shaders.some(
              (s) => s.stage === 'fragment' && s.source?.includes('pairWeights'),
            ),
          ),
          'actual ID fragment work must execute in the selected realm',
        );
    },
    assertPixels({ pixels, width, height }) {
      let covered = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) covered++;
      assert(covered > width * height * 0.15, 'black or absent terrain fails browser readback');
    },
  });
  const producer = report.producerReport;
  const root = execution === 'host' ? producer.source.rootGuid : producer.rootGuid;
  const policy = execution === 'host' ? producer.source.encoding : producer.materialEncoding;
  assert.equal(root, AssetGuid.format(materialTerrainGuid(encoding)));
  assert.equal(policy.kind, encoding, 'the actual loaded root must use the selected Cook policy');
  reports.push(report);
  writeFileSync(
    resolve(import.meta.dirname, '../.forgeax-debug', report.runId, 'material-id-report.json'),
    JSON.stringify(report, null, 2),
  );
}
if (execution === 'host')
  assert.equal(
    reports[0].producerReport.source.sourceSha256,
    reports[1].producerReport.source.sourceSha256,
    'real Browser JSON transport must retain the same complete author source for both roots',
  );
console.log(
  JSON.stringify(
    {
      status: 'PASS',
      execution,
      reports: reports.map((r) => ({ runId: r.runId, producerReport: r.producerReport })),
    },
    null,
    2,
  ),
);
