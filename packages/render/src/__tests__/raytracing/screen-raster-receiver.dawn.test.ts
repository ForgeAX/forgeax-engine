import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { contactCoverageWork } from './screen-probe-contact-coverage.fixture';
import {
  rasterReceiverCases,
  rasterReceiverPipelines,
  rasterReceiverPrograms,
} from './screen-raster-receiver.fixture';

it('qualifies local MASK receivers from real alpha-tested raster pixels without creating World hits', {
  timeout: 60_000,
}, async () => {
  const programs = await rasterReceiverPrograms(),
    cases = await rasterReceiverCases();
  const directory = process.env.FORGEAX_SCREEN_RASTER_RECEIVER_OUTPUT;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'raster.wgsl'), programs.raster.wgsl);
    writeFileSync(join(directory, 'compute.wgsl'), programs.compute.wgsl);
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('Actual GPU adapter required');
  const device = await adapter.requestDevice(),
    errors: string[] = [],
    raw: { name: string; probeAndRays: Uint8Array; visible: Uint8Array }[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  try {
    const pipelines = await rasterReceiverPipelines(device, programs);
    for (const row of cases) {
      const work = contactCoverageWork(device, row.row, {
        pipeline: pipelines.raster,
        positions: row.positions,
        viewProjection: row.viewProjection,
        rasterMatrix: row.rasterMatrix,
        opacity: row.opacity,
        direction: row.direction,
      });
      try {
        const bytes = await work.run(pipelines.prepare, pipelines.world),
          visible = work.rasterVisible();
        if (!visible) throw Error('Actual raster readback required');
        raw.push({ name: row.name, probeAndRays: bytes, visible });
        const directory = process.env.FORGEAX_SCREEN_RASTER_RECEIVER_OUTPUT;
        if (directory) {
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, `${row.name}.raw`), bytes);
          writeFileSync(join(directory, `${row.name}.visible`), visible);
        }
        const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
          surface = new Uint32Array(visible.buffer, visible.byteOffset, visible.byteLength / 4);
        expect(surface[20], row.name).toBe(row.opacity > 0.5 ? 1 : 0);
        expect(words[20], row.name).toBe(row.token);
        for (let ray = 0; ray < 64; ray++)
          expect(((words[24 + ray * 8 + 3] ?? 0) >>> 12) & 7, row.name).toBe(row.status);
      } finally {
        work.dispose();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    const directory = process.env.FORGEAX_SCREEN_RASTER_RECEIVER_OUTPUT;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'result.json'),
        JSON.stringify(
          {
            adapter: adapter.info,
            errors,
            rows: raw.map((x) => ({
              name: x.name,
              bytes: x.probeAndRays.byteLength,
              visibleBytes: x.visible.byteLength,
            })),
            scope:
              'Actual alpha-tested raster, canonical construction and production World-contact prefix only; WORLD1 never means resolved, nearest miss or physical GI',
          },
          null,
          2,
        ),
      );
    }
    device.destroy();
  }
});
