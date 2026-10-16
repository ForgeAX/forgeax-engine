#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { teardownDawnInstance } from '../../../../scripts/lib/dawn-teardown.mjs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';
import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { create, globals } from '@forgeax/engine-dawn-node';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = resolve(APP_ROOT, 'assets', 'pulse-material.pack.json');
const FRAME_COUNT = Math.max(60, Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

async function assertRuntimeReadiness(fixture) {
  const cookedByGuid = new Map(
    fixture.assets.map((entry) => [entry.guid.toLowerCase(), entry.payload?.cooked]),
  );
  const loader = createMaterialLoader({
    loadPublication: async (guid) => {
      const record = cookedByGuid.get(guid.toLowerCase());
      if (record === undefined) return undefined;
      return {
        guid,
        record,
        artifacts: Object.fromEntries(
          record.programs.map(({ artifact }) => [
            artifact.path,
            { bytes: new Uint8Array(artifact.bytes), digest: artifact.digest },
          ]),
        ),
      };
    },
    loadReference: async () => true,
  });
  const loadPublication = async (guid) => {
    const record = cookedByGuid.get(guid.toLowerCase());
    assert(record !== undefined, `missing cooked publication for ${guid}`);
    assert(
      typeof record.specializationKey === 'string',
      `cooked publication ${guid} has no specializationKey`,
    );
    return loader.load({ guid, specializationKey: record.specializationKey });
  };
  const root = await loadPublication('01935b00-7d8c-7c4e-9f12-345678abcd02');
  const derived = await loadPublication('01935b00-7d8c-7c4e-9f12-345678abcd03');
  assert(root.status === 'Ready' && derived.status === 'Ready', 'runtime cooked records are not ready');
  assert(root.record.artifactDigest === derived.record.artifactDigest, 'root and derived cooked program sets differ');
  assert(root.record.receipt.identity.cookIdentity === derived.record.receipt.identity.cookIdentity, 'specialization inputs differ');
  assert(root.record.receipt.identity.layoutIdentity === derived.record.receipt.identity.layoutIdentity, 'material layouts differ');
  assert(root.record.receipt.identity.programIdentity === derived.record.receipt.identity.programIdentity, 'material programs differ');
  assert(root.record.receipt.identity.pipelineIdentity === derived.record.receipt.identity.pipelineIdentity, 'material pipelines differ');
  assert(root.record.receipt.identity.materialPublicationIdentity !== derived.record.receipt.identity.materialPublicationIdentity, 'material publication identities did not capture the child override');
  assert(JSON.stringify(derived.record.resolved.values.baseColor) === JSON.stringify([0.2, 0.55, 0.95, 1]), 'derived material value override is missing');
  assert(JSON.stringify(root.record.resolved.values.baseColor) !== JSON.stringify(derived.record.resolved.values.baseColor), 'derived material value override did not diverge from root');
  return { root, derived };
}

const fixture = readFixture();
const parity = await assertRuntimeReadiness(fixture);
Object.assign(globalThis, globals);
let gpu = create([]);
const adapter = await gpu.requestAdapter();
assert(adapter !== null, 'Dawn did not provide a WebGPU adapter');
const device = await adapter.requestDevice();
const texture = device.createTexture({
  size: { width: 1, height: 1 },
  format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
const readback = device.createBuffer({
  size: 256,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0.95, g: 0.45, b: 0.2, a: 1 },
      },
    ],
  });
  pass.end();
  if (frame === FRAME_COUNT - 1) {
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: readback, bytesPerRow: 256 },
      { width: 1, height: 1 },
    );
  }
  device.queue.submit([encoder.finish()]);
}
await device.queue.onSubmittedWorkDone();
await readback.mapAsync(GPUMapMode.READ);
const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
readback.unmap();
assert(
  pixel[0] >= 240 && pixel[1] >= 110 && pixel[2] >= 45 && pixel[3] === 255,
  `Dawn readback did not preserve the expected material color: ${pixel.join(',')}`,
);
readback.destroy();
texture.destroy();
// Join the public destruction notification before releasing the native instance.
const destroyed = device.lost;
await teardownDawnInstance([device], async () => {
  const lost = await destroyed;
  assert(lost.reason === 'destroyed', `unexpected Dawn device loss: ${lost.reason}: ${lost.message}`);
  gpu = undefined;
});
console.log(
  JSON.stringify({
    status: 'pass',
    frames: FRAME_COUNT,
    backend: 'dawn-webgpu',
    pixel,
    rootArtifactDigest: parity.root.record.artifactDigest,
    derivedArtifactDigest: parity.derived.record.artifactDigest,
    materialIdentity: {
      materialGuid: parity.root.record.materialGuid,
      layoutIdentity: parity.root.record.receipt.identity.layoutIdentity,
      programIdentity: parity.root.record.receipt.identity.programIdentity,
      pipelineIdentity: parity.root.record.receipt.identity.pipelineIdentity,
      cookIdentity: parity.root.record.receipt.identity.cookIdentity,
      compilerFingerprint: parity.root.record.receipt.identity.compilerFingerprint,
      artifactDigest: parity.root.record.receipt.identity.artifactDigest,
      publicationGeneration: parity.root.record.receipt.identity.cookGeneration,
    },
    values: parity.root.record.resolved.values,
  }),
);
emitSmokeReceipt('hello-custom-shader/direct-dawn', FRAME_COUNT);
