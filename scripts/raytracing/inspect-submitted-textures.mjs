import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import UPNG from 'upng-js';
import { buildFrameModel, decodeTape } from '../../packages/rhi-debug/dist/index.mjs';
import { rasterInitialization } from './gltf/raster-tape.mjs';

const [dir] = process.argv.slice(2);
assert(dir, 'usage: node scripts/raytracing/inspect-submitted-textures.mjs <evidence-directory>');
const bytes = await readFile(join(dir, 'submitted-textures.rhitape'));
const tape = decodeTape(bytes).unwrap(),
  model = buildFrameModel(tape);
const accum = model.works.filter((w) =>
  w.pipeline.shaders.some((s) => s.entryPoint === 'accumulate'),
);
assert.equal(accum.length, 3);
const rows = [];
let previous = -1;
for (const [stage, work] of accum.entries()) {
  const surface = model.works.filter(
    (w) =>
      w.workIndex > previous &&
      w.workIndex < work.workIndex &&
      w.pipeline.shaders.some((s) => s.entryPoint === 'cs_surface'),
  );
  const views = [
    ...new Set(
      surface.flatMap((w) =>
        w.bindings.filter((b) => b.resourceKind === 'textureView').map((b) => b.resourceId),
      ),
    ),
  ];
  assert.equal(views.length, 1);
  const view = tape.bootstrap.find((b) => b.handleId === views[0])?.create;
  assert.equal(view.kind, 'createTextureView');
  const textureId = view.sourceHandleId;
  const destroy = model.resources.find((r) => r.resourceId === textureId)?.destroyEventIndex ?? -1;
  const submit = tape.events.findIndex((e, i) => i > work.eventIndex && e.kind === 'submit');
  assert(submit > work.eventIndex && destroy > submit);
  const output = await readFile(join(dir, `submitted-textures-${stage}.bin`));
  const data = new DataView(output.buffer, output.byteOffset, output.byteLength);
  rows.push({
    stage,
    textureId,
    viewId: views[0],
    surfaceWorks: surface.map((w) => w.workIndex),
    accumulateWork: work.workIndex,
    submitEvent: submit,
    destroyEvent: destroy,
    radiance: [0, 80].map((i) => [0, 4, 8].map((c) => data.getFloat32(i + c, true))),
  });
  previous = work.workIndex;
}
const initialization = rasterInitialization({
  ...model,
  unseededResources: model.unseededResources.filter((r) => r.kind !== 'texture'),
});
for (const { resourceId, kind } of model.unseededResources.filter((r) => r.kind === 'texture')) {
  const desc = tape.bootstrap.find((b) => b.handleId === resourceId).create.desc;
  assert.equal(desc.format, 'rgba8unorm');
  assert.equal(desc.mipLevelCount, 1);
  assert.equal(desc.size.depthOrArrayLayers, 1);
  const aliases = new Set(
    tape.bootstrap
      .filter(
        (b) => b.create.kind === 'createTextureView' && b.create.sourceHandleId === resourceId,
      )
      .map((b) => b.handleId),
  );
  const first = model.works.find((w) => w.bindings.some((b) => aliases.has(b.resourceId)));
  const write = tape.events.findIndex(
    (e) => e.kind === 'writeTexture' && e.destination.textureHandleId === resourceId,
  );
  assert(write >= 0 && write < (first?.eventIndex ?? Infinity));
  const event = tape.events[write];
  assert.equal(event.size.width, desc.size.width);
  assert.equal(event.size.height, desc.size.height);
  assert.equal(event.dataLayout.bytesPerRow, desc.size.width * 4);
  assert.deepEqual(event.destination.origin, { x: 0, y: 0, z: 0 });
  initialization.push({
    resourceId,
    kind,
    operation: 'full-writeTexture',
    eventIndex: write,
    firstConsumerWork: first?.workIndex ?? null,
  });
}
const facts = {
  scope:
    'captured resource binding and destroy events; no driver allocation or GPU performance claim',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  works: model.works.length,
  rows,
  initialization,
  resourceLifecycleAvailability: model.resourceLifecycle.availability,
};
await writeFile(join(dir, 'lifetime.json'), `${JSON.stringify(facts, null, 2)}\n`);
const w = 256,
  h = 96,
  rgba = new Uint8Array(w * h * 4);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const rgb = rows[Math.floor(y / 32)].radiance[Math.floor(x / 128)];
    rgba.set(
      [...rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), 255],
      (y * w + x) * 4,
    );
  }
await writeFile(
  join(dir, 'mask-readback.png'),
  new Uint8Array(UPNG.encode([rgba.buffer], w, h, 0)),
);
process.stdout.write(
  `${JSON.stringify({
    works: facts.works,
    rows: rows.map(({ surfaceWorks, ...r }) => ({ ...r, surfaceWorkCount: surfaceWorks.length })),
    initialization: initialization.length,
    sha256: facts.sha256,
  })}\n`,
);
