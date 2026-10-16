#!/usr/bin/env node
// Static shadow-layer audit of one PERF_RHI_CAPTURE tape. Diagnostic only.
//   with-lavapipe node scripts/inspect-shadow-tape.mjs <frame.rhitape>
// A static layer redrawn with loadOp 'load' is a partial redraw: every texel
// outside its scissor rects must keep the retained depth.
// Static layers are the copy sources of the static-to-final layer copies. For
// every static and final array layer it lists the depth raster passes that
// write the layer, then replays the tape on a fresh Dawn device and compares
// the layer after the last work item with its captured initial content: a
// retained (hit) layer must have no raster pass and identical depth bytes.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildFrameModel, decodeTape, openReplay } from '../../../../packages/rhi-debug/dist/index.mjs';
import { bootstrapDawn } from '../../../shared/scripts/rhi-debug-verify.mjs';

const tapePath = process.argv[2];
if (tapePath === undefined) {
  console.error('usage: inspect-shadow-tape.mjs <frame.rhitape>');
  process.exit(2);
}
const decoded = decodeTape(new Uint8Array(readFileSync(tapePath)));
if (!decoded.ok) throw decoded.error;
const tape = decoded.value;
const model = buildFrameModel(tape);
const resources = new Map(model.resources.map((entry) => [entry.resourceId, entry]));

const copies = model.commands.filter((command) => command.kind === 'copyTextureToTexture');
const staticTextures = new Set(copies.map((command) => command.params.source.textureHandleId));
const finalTextures = new Set(copies.map((command) => command.params.destination.textureHandleId));

// Depth raster passes keyed by `${texture}:${layer}`.
const rasters = new Map();
for (const pass of model.passes) {
  if (pass.kind !== 'render') continue;
  const begin = model.commands.find((command) => command.eventIndex === pass.beginEventIndex);
  const viewId = begin?.params?.depthStencilViewHandleId;
  const view = viewId === undefined ? undefined : resources.get(viewId)?.descriptor;
  if (view === undefined || view === null) continue;
  const key = `${view.sourceHandleId}:${view.desc?.baseArrayLayer ?? 0}`;
  const list = rasters.get(key) ?? [];
  const scissors = pass.commandIndices
    .map((index) => model.commands[index])
    .filter((command) => command?.kind === 'setScissorRect')
    .map((command) => command.params);
  list.push({ passIndex: pass.passIndex, load: begin.params.desc.depthStencilAttachment.depthLoadOp, works: pass.workIndices.length, scissors });
  rasters.set(key, list);
}

const lastWork = model.works.at(-1)?.workIndex;
if (lastWork === undefined) throw new Error('tape has no work items');
const backend = await bootstrapDawn('shadow-tape', tape);
const opened = await openReplay(tape, { device: backend.freshDevice, createShaderModule: backend.rhiWebgpu.createShaderModule });
if (!opened.ok) throw opened.error;
const replay = opened.value;
// Texels outside every scissor rect that differ; a partial static redraw
// (loadOp 'load') must leave them exactly as retained.
function changedOutside(before, after, width, rects) {
  const rowBytes = width * 4;
  const rows = rowBytes === 0 ? 0 : Math.floor(before.length / rowBytes);
  let changed = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rects.some((rect) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h)) continue;
      const offset = y * rowBytes + x * 4;
      for (let i = 0; i < 4; i += 1) {
        if (before[offset + i] !== after[offset + i]) {
          changed += 1;
          break;
        }
      }
    }
  }
  return changed;
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const layers = [];
try {
  for (const texture of [...staticTextures, ...finalTextures]) {
    const layerCount = resources.get(texture)?.descriptor?.desc?.size?.depthOrArrayLayers ?? 1;
    for (let arrayLayer = 0; arrayLayer < layerCount; arrayLayer += 1) {
      const subresource = { arrayLayer, aspect: 'depth-only' };
      const initial = await replay.readResource(texture, subresource);
      if (!initial.ok) throw initial.error;
      const after = await replay.readResourceAtWork(texture, lastWork, subresource);
      if (!after.ok) throw after.error;
      const passes = rasters.get(`${texture}:${arrayLayer}`) ?? [];
      const partial =
        staticTextures.has(texture) && passes.length > 0 && passes.every((pass) => pass.load === 'load');
      const outsideChanged = partial
        ? changedOutside(
            initial.value.bytes,
            after.value.bytes,
            resources.get(texture)?.descriptor?.desc?.size?.width ?? 0,
            passes.flatMap((pass) => pass.scissors),
          )
        : undefined;
      layers.push({
        texture,
        layer: staticTextures.has(texture) ? 'static' : 'final',
        arrayLayer,
        rasterPasses: passes.length,
        loadOps: passes.map((pass) => pass.load),
        initialDigest: digest(initial.value.bytes),
        afterDigest: digest(after.value.bytes),
        partial,
        dirtyRects: partial ? passes.reduce((sum, pass) => sum + pass.scissors.length, 0) : undefined,
        outsideChanged,
        unchanged: Buffer.compare(Buffer.from(initial.value.bytes), Buffer.from(after.value.bytes)) === 0,
      });
    }
  }
} finally {
  await replay.dispose();
}
console.table(layers);
const retainedStatic = layers.filter((entry) => entry.layer === 'static' && entry.rasterPasses === 0);
const broken = retainedStatic.filter((entry) => !entry.unchanged);
const partials = layers.filter((entry) => entry.layer === 'static' && entry.partial);
const partialBroken = partials.filter((entry) => entry.outsideChanged !== 0);
console.log(
  JSON.stringify({
    tape: tapePath,
    works: model.works.length,
    staticLayers: layers.filter((entry) => entry.layer === 'static').length,
    staticRastered: layers.filter((entry) => entry.layer === 'static' && entry.rasterPasses > 0).length,
    staticRetainedUnchanged: retainedStatic.length - broken.length,
    staticRetainedChanged: broken.length,
    staticPartial: partials.length,
    staticPartialOutsideChanged: partialBroken.length,
  }),
);
process.exit(broken.length === 0 && partialBroken.length === 0 ? 0 : 1);
