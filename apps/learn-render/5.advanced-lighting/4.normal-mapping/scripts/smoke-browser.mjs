// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x normal-mapping. Delegates to the shared harness; this file only
// supplies the demo identity + its live-pixel hook (window.__captureNormalMapping, installed by
// src/index.ts).
//
// pixel mode: capture a frame -> replay on a fresh dawn-node device -> compare
// the replayed RT against the live canvas readback (mean/maxChannel/coveredMean).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// The two visible bricks must reach separate real draws with the same albedo,
// distinct seeded normal inputs, and their authored strengths in GPU uniforms.
function assertNormalAndBumpDraws({ tape }) {
  const bootstrap = new Map(tape.bootstrap.map((resource) => [resource.handleId, resource]));
  const materialDraws = [];
  let materialBinding;
  for (const event of tape.events) {
    if (event.kind === 'setBindGroup' && event.index === 1) materialBinding = event;
    if (event.kind === 'drawIndexedIndirect') materialDraws.push(materialBinding);
  }
  if (materialDraws.length !== 2 || materialDraws.some((binding) => binding === undefined)) {
    throw new Error(`expected two material draws, got ${materialDraws.length}`);
  }
  const inputs = materialDraws.map((binding) => {
    const group = bootstrap.get(binding.bindGroupHandleId)?.create;
    if (group?.kind !== 'createBindGroup') throw new Error('material bind group missing');
    const resource = (slot) => {
      const index = group.entries.findIndex((entry) => entry.binding === slot);
      return group.resourceHandleIds[index];
    };
    const inputView = bootstrap.get(resource(6))?.create;
    const inputTexture = bootstrap.get(inputView?.sourceHandleId);
    if (inputTexture?.kind !== 'texture' || inputTexture.initialData.length === 0) {
      throw new Error('normal/bump texture has no captured source bytes');
    }
    return { albedo: resource(2), input: resource(6), buffer: resource(0), offset: binding.dynamicOffsets?.[0] ?? 0 };
  });
  if (inputs[0].albedo !== inputs[1].albedo || inputs[0].input === inputs[1].input) {
    throw new Error('material draws must share albedo and bind different normal inputs');
  }
  if (inputs[0].buffer !== inputs[1].buffer) throw new Error('material uniform buffer changed');
  const uniform = bootstrap.get(inputs[0].buffer)?.initialData?.[0];
  const bytes = tape.blobPool.get(uniform?.hash);
  if (bytes === undefined) throw new Error('material uniform bytes were not captured');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const near = (actual, expected) => Math.abs(actual - expected) < 0.0001;
  const strengthTuple = (base, offset) => [0, 4, 8].map((delta) => view.getFloat32(base + offset + delta, true));
  const hasAuthoredStrengths = Array.from({ length: 64 }, (_, index) => index * 4).some((offset) => {
    const normal = strengthTuple(inputs[0].offset, offset);
    const bump = strengthTuple(inputs[1].offset, offset);
    return near(normal[0], 2) && near(normal[1], 0.35) && near(normal[2], 1)
      && near(bump[0], 1) && near(bump[1], 1) && near(bump[2], -6);
  });
  if (!hasAuthoredStrengths) throw new Error('authored normalScale/bumpScale missing from GPU uniforms');
}

function assertBothPanelsVisible({ pixels, width, height }) {
  for (const [name, minX, maxX] of [['normal', 0.29, 0.44], ['bump', 0.56, 0.71]]) {
    let samples = 0;
    let lit = 0;
    for (let y = Math.floor(height * 0.34); y < Math.floor(height * 0.62); y++) {
      for (let x = Math.floor(width * minX); x < Math.floor(width * maxX); x++) {
        const i = (y * width + x) * 4;
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 24) lit++;
        samples++;
      }
    }
    if (samples === 0 || lit / samples < 0.5) {
      throw new Error(`${name} panel is not visible in the live WebGPU frame (${lit}/${samples} lit)`);
    }
  }

  // The source depth texture is nearly flat inside each brick. Its relief
  // should still make the mortar/brick boundary cast a visible dark edge.
  // This catches a correctly bound but imperceptibly weak bump material.
  const brightness = [];
  for (let y = Math.floor(height * 220 / 720); y < Math.floor(height * 470 / 720); y++) {
    for (let x = Math.floor(width * 670 / 1280); x < Math.floor(width * 950 / 1280); x++) {
      const i = (y * width + x) * 4;
      brightness.push((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
    }
  }
  brightness.sort((a, b) => a - b);
  const median = brightness[Math.floor(brightness.length / 2)];
  const darkEdgeFraction = brightness.filter((value) => value < median - 35).length / brightness.length;
  if (darkEdgeFraction < 0.05) {
    throw new Error(`bump relief is too faint: dark edge fraction ${darkEdgeFraction.toFixed(3)} < 0.05`);
  }
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-4-normal-mapping',
  label: 'learn-render 5.4 normal-mapping',
  mode: 'pixel',
  liveHook: '__captureNormalMapping',
  rtIdx: 0,
  assertTape: assertNormalAndBumpDraws,
  assertPixels: assertBothPanelsVisible,
  appDir: dirname(here),
});
