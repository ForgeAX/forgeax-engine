import { WebGPURenderer } from '@forgeax/engine/three';
import { afterAll, beforeAll, it } from 'vitest';
import { commands } from 'vitest/browser';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { verifyLitNodeInputs } from './lit-node-inputs.fixture';
import { comparePrimitivePixels } from './node-family.fixture';
import {
  nodeInputPrimitives,
  verifyNodeInputPrimitive,
  verifyNodeInputs,
  verifyNodeOverride,
} from './node-inputs.fixture';
import { opticalModes, verifyOpticalNodeInputs } from './optical-node-inputs.fixture';
import { primitiveInputModes, verifyPrimitiveNodeInputs } from './primitive-node-inputs.fixture';
import { comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

let renderer: WebGPURenderer;
let canvas: HTMLCanvasElement;
beforeAll(async () => {
  const publication = await commands.prepareThreeNodeInputMaterials();
  canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  renderer = new WebGPURenderer({ canvas, forgeax: { materialPrograms: [publication] } });
});
afterAll(async () => {
  await renderer?.dispose();
  canvas?.remove();
});
it.each([
  'uniform',
  'vec4',
  'texture',
] as const)('matches independent r187 %s node inputs and source edits', {
  timeout: 120000,
}, async (mode) => {
  await verifyNodeInputs(renderer, mode, async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-node-input-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
  });
});

it('matches r187 node input precedence through scene override and async preparation', {
  timeout: 120000,
}, async () => {
  await verifyNodeOverride(renderer, async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-node-input-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
  });
});

it.each(nodeInputPrimitives)('matches r187 %s node uniforms and edits', {
  timeout: 120000,
}, async (kind) => {
  await verifyNodeInputPrimitive(renderer, kind, async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-node-input-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
    if (kind !== 'sprite') comparePrimitivePixels(displayPixels(frame), reference, 128);
  });
});

it.each([false, true])('matches r187 lit uniforms, edits and loaded=%s scenes', {
  timeout: 120000,
}, async (loaded) => {
  await verifyLitNodeInputs(renderer, loaded, async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(
      `r187-lit-node-${loaded ? 'loaded' : 'authored'}-${name}`,
      frame,
      reference,
    );
    comparePixels(displayPixels(frame), reference);
  });
});

it.each(opticalModes)('matches r187 %s optical node uniforms and edits', {
  timeout: 120000,
}, async (mode) => {
  await verifyOpticalNodeInputs(renderer, mode, async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-optical-node-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
  });
});

it.each(primitiveInputModes)('matches r187 %s primitive node inputs and edits', {
  timeout: 120000,
}, async (mode) => {
  await verifyPrimitiveNodeInputs(renderer, mode, async (name, frame, scene, camera) => {
    const reference = await renderReference(scene, camera);
    await saveBrowserEvidence(`r187-primitive-node-${name}`, frame, reference);
    comparePixels(displayPixels(frame), reference);
    if (mode.startsWith('dashed')) comparePrimitivePixels(displayPixels(frame), reference, 128);
  });
});
