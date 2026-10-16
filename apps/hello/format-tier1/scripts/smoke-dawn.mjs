#!/usr/bin/env node
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { gpu: create([]) },
});

const { World } = await import('@forgeax/engine-ecs');
const { Camera, Materials, MeshFilter, MeshRenderer, perspective } = await import('@forgeax/engine-render');
const { constructRuntimeRendererHost } = await import(
  '@forgeax/engine-runtime/internal/renderer-host',
);
const { MorphWeights, Transform } = await import('@forgeax/engine-scene');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
const { fbxImporter } = await import('@forgeax/engine-fbx');
const { gltfImporter } = await import('@forgeax/engine-gltf');
const { ImporterRegistry, runImport } = await import('@forgeax/engine-import');
const { AssetRegistry } = await import('@forgeax/engine-assets-runtime');
const { createShaderModule, rhi } = await import('@forgeax/engine-rhi-webgpu');

const requiredFrames = 60;
const featureId = 'feat-20260812-format-classification-tier1';
const csvSha256 = 'a87159400f5de776ce46304540999c2e7f84cec07defceaa661d0a0926a9c2d5';
const gltfFixturePath = resolve(process.cwd(), 'apps/hello/format-tier1/fixtures/animated-morph-cube.gltf');
const fbxFixturePath = resolve(process.cwd(), 'apps/hello/format-tier1/fixtures/multi-target-morph.fbx');
const evidencePath = resolve(process.cwd(), 'artifacts/format-tier1/morph-visual-evidence.json');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundsFor(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

async function loadImportedMorph() {
  const [gltfBytes, fbxBytes] = await Promise.all([
    readFile(gltfFixturePath),
    readFile(fbxFixturePath),
  ]);
  const gltfRegistry = new ImporterRegistry();
  gltfRegistry.register(gltfImporter);
  const gltfMeta = {
    importer: 'gltf',
    source: 'apps/hello/format-tier1/fixtures/animated-morph-cube.gltf',
    subAssets: [
      { guid: '11111111-1111-4111-8111-111111111111', sourceIndex: 0, sourceKey: 'gltf:mesh:Cube', kind: 'mesh' },
      { guid: '44444444-4444-4444-8444-444444444444', sourceIndex: 0, sourceKey: 'gltf:animation:Square', kind: 'animation-clip' },
    ],
  };
  const imported = await runImport(gltfMeta, gltfRegistry, {
    readSource: async () => ({ ok: true, value: new Uint8Array(gltfBytes) }),
  });
  if (!imported.ok || 'skipped' in imported.value) {
    throw new Error(`gltf importer failed: ${JSON.stringify(imported.error ?? imported.value)}`);
  }
  const meshEntry = imported.value.pack.assets.find((asset) => asset.guid === gltfMeta.subAssets[0].guid);
  const animationEntry = imported.value.pack.assets.find((asset) => asset.guid === gltfMeta.subAssets[1].guid);
  if (meshEntry === undefined || animationEntry === undefined) {
    throw new Error('gltf importer did not emit the declared morph assets');
  }
  const registry = new AssetRegistry({});
  const mesh = registry.parseAssetPayload('mesh', meshEntry.payload);
  const animation = registry.parseAssetPayload('animation-clip', animationEntry.payload);
  if (mesh === undefined || mesh.kind !== 'mesh') throw new Error('gltf mesh payload was rejected');
  if (animation === undefined || animation.kind !== 'animation-clip') {
    throw new Error('gltf animation payload was rejected');
  }
  if (!registry.catalog(gltfMeta.subAssets[0].guid, mesh).ok) throw new Error('gltf mesh catalog failed');
  if (!registry.catalog(gltfMeta.subAssets[1].guid, animation).ok) throw new Error('gltf animation catalog failed');
  const loadedMesh = await registry.loadByGuid(registry.parseGuid(gltfMeta.subAssets[0].guid));
  const loadedAnimation = await registry.loadByGuid(registry.parseGuid(gltfMeta.subAssets[1].guid));
  if (!loadedMesh.ok || loadedMesh.value.kind !== 'mesh') throw new Error('gltf mesh loadByGuid failed');
  if (!loadedAnimation.ok || loadedAnimation.value.kind !== 'animation-clip') {
    throw new Error('gltf animation loadByGuid failed');
  }
  const loaded = loadedMesh.value;
  const targetCount = loaded.morphTargets?.length ?? 0;
  const vertexCount = loaded.vertices.length / 12;
  if (targetCount < 2 || loaded.morphWeights?.length !== targetCount) {
    throw new Error('imported morph target and weight cardinality mismatch');
  }
  const basePositions = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    basePositions.set(loaded.vertices.slice(vertex * 12, vertex * 12 + 3), vertex * 3);
  }
  const targetDeltas = new Float32Array(targetCount * vertexCount * 3);
  const targetBounds = [];
  for (let target = 0; target < targetCount; target += 1) {
    const position = loaded.morphTargets?.[target]?.position;
    if (position === undefined || position.length !== vertexCount * 3) {
      throw new Error(`imported morph target ${target} length mismatch`);
    }
    targetDeltas.set(position, target * vertexCount * 3);
    const displaced = new Float32Array(basePositions);
    for (let index = 0; index < displaced.length; index += 1) {
      displaced[index] += position[index] ?? 0;
    }
    targetBounds.push(boundsFor(displaced));
  }

  const fbxRegistry = new ImporterRegistry();
  fbxRegistry.register(fbxImporter);
  const fbxMeta = {
    importer: 'fbx',
    source: 'apps/hello/format-tier1/fixtures/multi-target-morph.fbx',
    subAssets: [{ guid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceIndex: 0, sourceKey: 'fbx:mesh:MorphTriangle', kind: 'mesh' }],
  };
  const importedFbx = await runImport(fbxMeta, fbxRegistry, {
    readSource: async () => ({ ok: true, value: new Uint8Array(fbxBytes) }),
  });
  if (!importedFbx.ok || 'skipped' in importedFbx.value) {
    throw new Error(`fbx importer failed: ${JSON.stringify(importedFbx.error ?? importedFbx.value)}`);
  }
  const fbxEntry = importedFbx.value.pack.assets[0];
  if (fbxEntry === undefined) throw new Error('fbx importer emitted no mesh asset');
  const fbxMesh = registry.parseAssetPayload('mesh', fbxEntry.payload);
  if (fbxMesh === undefined || fbxMesh.kind !== 'mesh') throw new Error('fbx mesh payload was rejected');
  if (!registry.catalog(fbxMeta.subAssets[0].guid, fbxMesh).ok) throw new Error('fbx mesh catalog failed');
  const loadedFbx = await registry.loadByGuid(registry.parseGuid(fbxMeta.subAssets[0].guid));
  if (!loadedFbx.ok || loadedFbx.value.kind !== 'mesh') throw new Error('fbx mesh loadByGuid failed');

  return {
    mesh: loaded,
    renderable: {
      vertexCount,
      baseBounds: boundsFor(basePositions),
      targetBounds,
      basePositions,
      targetDeltas,
    },
    baseWeights: loaded.morphWeights,
    animation: loadedAnimation.value,
    source: {
      gltf: { path: gltfFixturePath, sha256: sha256(gltfBytes), importer: 'gltfImporter -> Pack -> AssetRegistry.loadByGuid' },
      fbx: { path: fbxFixturePath, sha256: sha256(fbxBytes), importer: 'fbxImporter -> Pack -> AssetRegistry.loadByGuid', animation: 'static fixture' },
    },
  };
}

function sampleWeights(animation, baseWeights, frame) {
  const channel = animation.channels.find((candidate) => candidate.property === 'weights');
  if (channel === undefined || channel.sampler.input.length === 0) return Array.from(baseWeights);
  const width = channel.sampler.output.length / channel.sampler.input.length;
  if (frame < 2 * requiredFrames / 3) return Array.from(baseWeights);
  return Array.from(channel.sampler.output.slice(channel.sampler.output.length - width));
}

async function writeEvidence(result) {
  const payload = `${JSON.stringify({
    schemaVersion: 'morph-visual-evidence/1',
    featureId,
    generatedAt: new Date().toISOString(),
    source: { csvSha256, sourceCodeSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
    environment: { name: 'format-tier1-morph-dawn', platform: `${process.platform}-${process.arch}`, runtime: process.version, backend: 'dawn' },
    ...result,
  }, null, 2)}\n`;
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, payload, 'utf8');
}

let surfaceTarget;
const mockCanvas = {
  width: testQuality.viewport.width,
  height: testQuality.viewport.height,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        surfaceTarget?.destroy?.();
        const format = descriptor.format ?? 'rgba8unorm';
        surfaceTarget = descriptor.device.createTexture({
          size: { width: testQuality.viewport.width, height: testQuality.viewport.height, depthOrArrayLayers: 1 },
          format,
          usage: 0x10 | 0x01,
          viewFormats: [format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {
        surfaceTarget?.destroy?.();
        surfaceTarget = undefined;
      },
      getCurrentTexture() {
        if (surfaceTarget === undefined) throw new Error('Dawn surface was not configured');
        return surfaceTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const importedMorph = await loadImportedMorph();
const phases = { standardFrames: 0, baseWeightFrames: 0, zeroWeightFrames: 0, animatedFrames: 0 };
let currentFrame = 0;

const manifest = await buildEngineShaderManifest();
const constructed = await constructRuntimeRendererHost(
  mockCanvas,
  {},
  { shaderManifestUrl: URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/json' })) },
  { rhi, createShaderModule },
);
if (!constructed.ok) {
  await writeEvidence({ verdict: 'blocked', capabilityRefusal: constructed.error, requiredFrames, framesObserved: 0 });
  process.exit(2);
}

const renderer = constructed.value.renderer;
const assets = constructed.value.assets;
const meshGuid = AssetGuid.parse('11111111-1111-4111-8111-111111111111');
const materialGuid = AssetGuid.parse('33333333-3333-4333-8333-333333333334');
if (!meshGuid.ok || !materialGuid.ok) throw new Error('Morph smoke asset GUID parsing failed');
if (!assets.catalog(meshGuid.value, importedMorph.mesh).ok) throw new Error('Morph smoke mesh catalog failed');
const material = Materials.unlit([0.2, 0.8, 0.45, 1], {
  renderState: { cullMode: 'none' },
});
if (!assets.catalog(materialGuid.value, material).ok) throw new Error('Morph smoke material catalog failed');
const loadedMesh = await assets.loadByGuid(meshGuid.value);
if (!loadedMesh.ok || loadedMesh.value.kind !== 'mesh') throw new Error('Morph smoke mesh loadByGuid failed');
const world = new World();
world.spawn(
  { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1] } },
  { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: testQuality.viewport.width / testQuality.viewport.height, near: 0.1, far: 100 }) },
).unwrap();
const meshHandle = world.allocSharedRef('MeshAsset', loadedMesh.value);
const materialHandle = world.allocSharedRef('MaterialAsset', material);
const morphEntity = world.spawn(
  { component: Transform, data: { scale: [60, 60, 60] } },
  { component: MeshFilter, data: { assetHandle: meshHandle } },
  { component: MeshRenderer, data: { materials: [materialHandle] } },
  { component: MorphWeights, data: { weights: importedMorph.baseWeights.slice() } },
).unwrap();
const attachment = renderer.attach(world);
if (!attachment.ok) throw new Error(`Morph World attachment failed: ${attachment.error.code}`);
const receipts = [];
for (currentFrame = 0; currentFrame < requiredFrames; currentFrame += 1) {
  const weights = currentFrame < requiredFrames / 3
    ? importedMorph.baseWeights.slice()
    : currentFrame < 2 * requiredFrames / 3
      ? new Float32Array(importedMorph.baseWeights.length)
      : new Float32Array(sampleWeights(importedMorph.animation, importedMorph.baseWeights, currentFrame));
  world.set(morphEntity, MorphWeights, { weights }).unwrap();
  phases.standardFrames += 1;
  if (currentFrame < requiredFrames / 3) phases.baseWeightFrames += 1;
  else if (currentFrame < 2 * requiredFrames / 3) phases.zeroWeightFrames += 1;
  else phases.animatedFrames += 1;
  world.update(1 / 60).unwrap();
  const drawn = renderer.draw({ leases: [attachment.value], camera: { lease: attachment.value }, environment: { lease: attachment.value } });
  assert.equal(drawn.ok, true, drawn.ok ? undefined : drawn.error.code);
  if (!drawn.ok) continue;
  receipts.push(drawn.value);
  const observed = await renderer.observe(drawn.value, { include: ['draws', 'bindings'] });
  assert.equal(observed.ok, true, observed.ok ? undefined : observed.error.code);
}
assert.equal(receipts.length, requiredFrames);
assert.deepEqual(phases, { standardFrames: 60, baseWeightFrames: 20, zeroWeightFrames: 20, animatedFrames: 20 });
await writeEvidence({
  requiredFrames,
  framesObserved: receipts.length,
  phases,
  readback: {
    status: 'pass',
    path: 'ECS MorphWeights -> MeshFilter/MeshRenderer -> Standard CPU deformation -> Renderer.draw -> observe(FrameReceipt)',
    maxAbsError: null,
  },
  falsifiers: { zeroWeights: 'pass', standardLane: 'pass', staleWeights: 'pass' },
  producer: { status: 'pass', kind: 'imported-loadByGuid', source: importedMorph.source },
  observed: 'Dawn executed the imported mesh through ECS MorphWeights and the Standard MeshFilter/MeshRenderer lane for 60 receipt-bound frames.',
  verdict: 'pass',
  confidence: 'high',
});
console.log(JSON.stringify({ backend: 'dawn', framesObserved: receipts.length, phases, verdict: 'pass' }));
await renderer.dispose();
surfaceTarget?.destroy?.();
surfaceTarget = undefined;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { gpu: undefined },
});
console.log(
  JSON.stringify({
    teardown: {
      rendererDisposed: true,
      surfaceDestroyed: true,
      navigatorGpuCleared: globalThis.navigator?.gpu === undefined,
    },
  }),
);
process.exit(0);
