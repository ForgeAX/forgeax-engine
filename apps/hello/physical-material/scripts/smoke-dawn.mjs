#!/usr/bin/env node
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { createAdditiveCoatMutantPublication } from '../evidence/additive-coat-mutant.mjs';
// Physical-material Dawn witness. This drives the Engine-owned renderer path:
// dawn-node -> constructRuntimeRendererHost -> ECS -> Renderer -> readback.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCaseRecords, evaluatePairedSentinels, referencePlan } from '../evidence/evaluator.mjs';
import { createLinearHdrRoiEvidence, fnv1a, objectCoverage, resolveCaseRoi } from '../evidence/evaluator-core.mjs';
import { captureGpuErrors, captureWorldErrors, requireFrameMaterials, disposeRenderResources, runPairedStages, runRenderPhase } from '../evidence/phase-executor.mjs';
import { describeMaterialCase } from '../evidence/material-case-builder.mjs';
import { buildFrameModel, decodeTape, halfToFloat, readbackTexturePixels } from '@forgeax/engine-rhi-debug';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import { physicalMaterialChild, physicalMaterialRoots, withPhysicalMaterialModule } from '../src/material-contract.ts';

const here = dirname(fileURLToPath(import.meta.url));
const caseInputPath = resolve(here, '..', 'evidence', 'case-input.json');
const caseInput = JSON.parse(readFileSync(caseInputPath, 'utf8'));
const WIDTH = caseInput.render.width;
const HEIGHT = caseInput.render.height;
const FRAME_COUNT = smokeFrameBudget();
const manifestPath = resolve(here, '..', 'dist', 'shaders', 'manifest.json');
const caseManifestPath = resolve(here, '..', 'evidence', 'case-manifest.json');
const referenceArtifactPath = resolve(here, '..', 'evidence', 'reference-linear-hdr.json');
const caseManifest = JSON.parse(readFileSync(caseManifestPath, 'utf8'));
const referenceArtifact = JSON.parse(readFileSync(referenceArtifactPath, 'utf8'));
if (
  referenceArtifact.artifactId !== caseManifest.referenceArtifact?.artifactId ||
  referenceArtifact.source !== caseManifest.referenceArtifact?.source ||
  referenceArtifact.revision !== caseManifest.referenceArtifact?.revision ||
  referenceArtifact.configHash !== caseManifest.referenceArtifact?.configHash ||
  referenceArtifact.cases?.length !== caseManifest.caseCount
) {
  throw new Error('reference artifact identity or coverage mismatch');
}
const referenceCases = new Map(referenceArtifact.cases.map((item) => [item.caseId, item]));
const casePlans = new Map(
  caseManifest.cases.map((item, index) => {
    const reference = referenceCases.get(item.caseId);
    return [item.caseId, referencePlan({
      ...item,
      reference: reference === undefined ? undefined : {
        expectedLinearHdrMean: reference.expectedLinearHdrMean,
        source: referenceArtifact.source,
        revision: referenceArtifact.revision,
        configHash: referenceArtifact.configHash,
        camera: referenceArtifact.camera,
        roi: reference.roi,
        metric: referenceArtifact.metric,
        epsilon: referenceArtifact.epsilon,
        hash: reference.referenceHash,
      },
    }, index)];
  }),
);
const exactHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: resolve(here, '..', '..', '..', '..'),
  encoding: 'utf8',
}).trim();

let create;
let globals;
try {
  ({ create, globals } = await import('@forgeax/engine-dawn-node'));
} catch (cause) {
  console.error(`[physical-material] dawn-node import failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
Object.assign(globalThis, globals);
if (globalThis.navigator === undefined) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
}
const gpu = create([]);
Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

const errors = [];
let sharedDevice;
const requestAdapter = globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter = async (options) => {
  const adapter = await requestAdapter(options);
  if (adapter === null) return null;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async (descriptor) => {
    const device = await requestDevice(descriptor);
    sharedDevice ??= device;
    return device;
  };
  return adapter;
};

let renderTarget;
const canvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        renderTarget ??= descriptor.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: descriptor.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (renderTarget === undefined) {
          if (sharedDevice === undefined) throw new Error('Dawn render target requested before device');
          renderTarget = sharedDevice.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['rgba8unorm-srgb'],
          });
        }
        return renderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};
let mutantRenderTarget;
const mutantCanvas = {
  width: WIDTH,
  height: HEIGHT,
  getContext(kind) {
    if (kind !== 'webgpu') return null;
    return {
      configure(descriptor) {
        mutantRenderTarget ??= descriptor.device.createTexture({
          size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
          format: descriptor.format ?? 'rgba8unorm',
          usage: 0x10 | 0x01,
          viewFormats: ['rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture() {
        if (mutantRenderTarget === undefined) throw new Error('mutant render target requested before configure');
        return mutantRenderTarget;
      },
    };
  },
  addEventListener() {},
  removeEventListener() {},
};

const { constructRuntimeRendererHost } = await import('@forgeax/engine-runtime/internal/renderer-host');
const { createWorldContext, World } = await import('@forgeax/engine-ecs');
const { createBoxGeometry } = await import('@forgeax/engine-geometry');
const { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective, TONEMAP_REINHARD_EXTENDED } =
  await import('@forgeax/engine-render');
const { Transform } = await import('@forgeax/engine-scene');
const { resolveMaterialAsset } = await import('@forgeax/engine-types');
const { Skin } = await import('@forgeax/engine-skinning');
const { readShaderManifestPublication } = await import('@forgeax/engine-shader');
const productManifestBytes = readFileSync(manifestPath, 'utf8');
const productManifest = await readShaderManifestPublication(JSON.parse(productManifestBytes));
const shaderManifest = structuredClone(productManifest);
const PHYSICAL_MATERIAL_MODULES = {
  scalar: 'physical-material::standard-clearcoat',
  factor: 'physical-material::standard-clearcoat-factor-r',
  roughness: 'physical-material::standard-clearcoat-roughness-g',
  normal: 'physical-material::standard-clearcoat-normal-rg',
  skinFactor: 'physical-material::pbr-skin-clearcoat-factor-r',
  skinRoughness: 'physical-material::pbr-skin-clearcoat-roughness-g',
  skinNormal: 'physical-material::pbr-skin-clearcoat-normal-rg',
};
function physicalMaterialModule(item) {
  const skin = item.geometry === 'skinned';
  if (item.semantic === 'factor-r') return skin ? PHYSICAL_MATERIAL_MODULES.skinFactor : PHYSICAL_MATERIAL_MODULES.factor;
  if (item.semantic === 'roughness-g') return skin ? PHYSICAL_MATERIAL_MODULES.skinRoughness : PHYSICAL_MATERIAL_MODULES.roughness;
  return skin ? PHYSICAL_MATERIAL_MODULES.skinNormal : PHYSICAL_MATERIAL_MODULES.normal;
}
const productShader = shaderManifest.materialShaders?.find(
  (shader) => shader.identifier === PHYSICAL_MATERIAL_MODULES.scalar,
);
if (productShader === undefined) throw new Error('product clearcoat shader is missing');
const mutateAdditiveCoat = (wgsl) => {
  const needle = 'let attenuatedBase = (baseRadiance * (1f - _e2));';
  if (!wgsl.includes('evaluateClearcoatLayer') || !wgsl.includes(needle)) {
    throw new Error('additive mutant attenuation needle missing');
  }
  return wgsl.replace(needle, 'let attenuatedBase = baseRadiance;');
};
const additiveMutantShader = {
  ...productShader,
  identifier: productShader.identifier,
  sourcePath: resolve(here, '..', 'evidence', 'additive-coat-mutant.wgsl'),
  composedWgsl: mutateAdditiveCoat(productShader.composedWgsl),
  variants: productShader.variants?.map((variant) => ({
    ...variant,
    composedWgsl: mutateAdditiveCoat(variant.composedWgsl),
  })),
};
// The expanded manifest repeats every Standard variant's full WGSL and exceeds
// V8's string limit once URI-encoded, so the mutant stays in the deduplicated
// publication form and only the clearcoat rows point at new mutated sources.
const productManifestUrl = `data:application/json,${encodeURIComponent(productManifestBytes)}`;
const mutantPublication = await createAdditiveCoatMutantPublication(
  JSON.parse(productManifestBytes), productShader.identifier, productShader.identifier,
);
const mutantManifestBytes = JSON.stringify(mutantPublication);
const mutantManifestUrl = `data:application/json,${encodeURIComponent(mutantManifestBytes)}`;
const shaderManifestHash = fnv1a(new TextEncoder().encode(productManifestBytes));
const mutantSourceClosureDigest = createHash('sha256').update(mutantManifestBytes).digest('hex');
function scalarVariantReceipts(shader) {
  const variants = shader.variants?.length > 0 ? shader.variants : [{ defines: {}, definesKey: '', composedWgsl: shader.composedWgsl }];
  return variants
    .filter((variant) => variant.defines?.STORAGE_BUFFER_AVAILABLE !== false)
    .map((variant) => ({
      definesKey: variant.definesKey,
      defines: variant.defines,
      sourceHash: createHash('sha256').update(variant.composedWgsl).digest('hex'),
      attenuationNeedleCount: (variant.composedWgsl.match(/let attenuatedBase = \(baseRadiance \* \(1f - _e2\)\);/gu) ?? []).length,
      additiveNeedleCount: (variant.composedWgsl.match(/let attenuatedBase = baseRadiance;/gu) ?? []).length,
      factorSentinelNeedleCount: (variant.composedWgsl.match(/clearcoatFactor = 1f;/gu) ?? []).length,
    }));
}
const productScalarVariantReceipts = scalarVariantReceipts(productShader);
const mutantScalarVariantReceipts = scalarVariantReceipts(additiveMutantShader);
const materialDiagnosticsByCaseId = new Map();
const standardParamSchema = JSON.parse(productShader.paramSchema);
const standardParamSchemaDigest = createHash('sha256').update(productShader.paramSchema).digest('hex');

function describeMaterial(item, material) {
  const values = material.values ?? {};
  const projection = assets.getMaterialProjectionForPayload(material);
  const authoredTextures = Object.keys(values).filter((name) => name.endsWith('Texture'));
  const shader = productManifest.materialShaders?.find(
    (candidate) => candidate.identifier === physicalMaterialModule(item),
  ) ?? productShader;
  const fixtureVariant = shader.variants?.find((variant) =>
    variant.defines?.STORAGE_BUFFER_AVAILABLE === true,
  );
  const source = fixtureVariant?.composedWgsl ?? shader.composedWgsl;
  const group1Bindings = [...source.matchAll(/@group\(1\)\s*@binding\((\d+)\)/gu)].map((match) => Number(match[1]));
  materialDiagnosticsByCaseId.set(item.caseId, {
    effectiveRoot: { kind: material.kind, shader: projection?.passes[0]?.module ?? physicalMaterialModule(item) },
    cookedPublication: projection === undefined ? undefined : {
      materialGuid: projection.materialGuid,
      specializationKey: projection.specializationKey,
      artifactHash: projection.artifactHash,
      staticSelection: projection.staticSelection,
    },
    authoredTextures,
    ubo: { values },
    fixtureVariant: fixtureVariant === undefined ? { verdict: 'missing' } : {
      definesKey: fixtureVariant.definesKey,
      defines: fixtureVariant.defines,
    },
    bindingCensus: { source: 'authored-shader-fixture', group1Bindings, sampledTextureCount: group1Bindings.length / 2 },
    layoutIdentity: `${shader.identifier}:paramSchemaSha256:${createHash('sha256').update(shader.paramSchema).digest('hex')}`,
    paramSchemaFields: JSON.parse(shader.paramSchema).map((field) => field.name),
  });
}

const captureDirectory = process.env.FORGEAX_PHYSICAL_CAPTURE_DIR;
const recorder = captureDirectory === undefined ? undefined :
  (await import('@forgeax/engine-rhi-debug')).attachRecorder(await import('@forgeax/engine-rhi-webgpu')).unwrap();
const constructed = await constructRuntimeRendererHost(canvas, recorder === undefined ? {} : { rhi: recorder.backend.rhi }, { shaderManifestUrl: productManifestUrl });
if (!constructed.ok) {
  console.error(`[physical-material] renderer construction failed: ${JSON.stringify(constructed.error)}`);
  process.exit(1);
}
const { renderer, assets, debugDrawHost } = constructed.value;
captureGpuErrors(renderer.nativeDevice().unwrap(), errors);
const { Skylight } = await import('@forgeax/engine-render');
const { AssetGuid } = await import('@forgeax/engine-pack/guid');
const packIndexPath = resolve(here, '..', 'dist', 'pack-index.json');
const packIndexWire = JSON.parse(readFileSync(packIndexPath, 'utf8'));
const packIndex = decodeCatalogWire(packIndexWire).unwrap();
const hdrGuid = '019e4a26-3c29-7420-af5d-20f2724a16b0';
const fullPhysicalMaterialGuid = '8a5a0001-0000-4000-8000-000000000008';
const hdrEntry = packIndex.find((entry) => entry.guid === hdrGuid);
const fullPhysicalMaterialEntry = packIndex.find((entry) => entry.guid === fullPhysicalMaterialGuid);
let hdrPod;
let hdrReceipt;
let fullPhysicalMaterial;
let fullPhysicalMaterialLoad;
const publishedPackages = [];
for (const entry of [hdrEntry, ...physicalMaterialRoots.map((root) => packIndex.find((entry) => entry.guid === root.guid))]) {
  if (entry === undefined) continue;
  const packagePath = resolve(here, '..', 'dist', entry.packageUrl.replace(/^\//, ''));
  const pack = JSON.parse(readFileSync(packagePath, 'utf8'));
  publishedPackages.push({ entry, packagePath, pack });
}
const originalFetch = globalThis.fetch;
const responseFromBytes = (bytes) => {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return {
    ok: true,
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(arrayBuffer),
  };
};
const responseFromJson = (value) => ({
  ok: true,
  json: () => Promise.resolve(value),
  arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(value)).buffer),
});
const publishedArtifacts = publishedPackages.flatMap(({ entry, packagePath, pack }) => {
  const asset = pack.assets?.find((candidate) => candidate.guid === entry.guid);
  return Object.values(asset?.artifacts ?? {}).flatMap((artifact) => {
    if (artifact?.path === undefined) return [];
    return [{
      url: `${entry.packageUrl.slice(0, entry.packageUrl.lastIndexOf('/') + 1)}${artifact.path}`,
      path: resolve(dirname(packagePath), artifact.path),
    }];
  });
});
const fetchPublished = async (url) => {
  const request = typeof url === 'string' ? url : String(url);
  if (request === '/pack-index.json') return responseFromJson(packIndexWire);
  for (const { entry, pack } of publishedPackages) {
    if (request === entry.packageUrl) return responseFromJson(pack);
  }
  const artifact = publishedArtifacts.find((candidate) => request === candidate.url || request.endsWith(candidate.url));
  if (artifact !== undefined) return responseFromBytes(readFileSync(artifact.path));
  if (typeof originalFetch === 'function') return originalFetch(url);
  return { ok: false, status: 404, json: () => Promise.resolve({}), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
};
globalThis.fetch = fetchPublished;
assets.configurePackIndex('/pack-index.json');
try {
  const fullMaterialGuid = AssetGuid.parse(fullPhysicalMaterialGuid);
  if (!fullMaterialGuid.ok) throw new Error(`invalid physical material GUID: ${fullPhysicalMaterialGuid}`);
  const loadedMaterial = await assets.loadByGuid(fullMaterialGuid.value);
  if (!loadedMaterial.ok) {
    throw new Error(`full physical material load failed: ${loadedMaterial.error.code} expected=${loadedMaterial.error.expected} hint=${loadedMaterial.error.hint}`);
  }
  fullPhysicalMaterial = loadedMaterial.value;
  for (const root of physicalMaterialRoots) {
    if (root.guid === fullPhysicalMaterialGuid) continue;
    const loaded = await assets.loadByGuid(root.parent);
    if (!loaded.ok) throw new Error(`physical root ${root.guid} load failed: ${loaded.error.code}`);
  }
  fullPhysicalMaterialLoad = {
    status: 'ok',
    guid: fullPhysicalMaterialGuid,
    route: 'assets.loadByGuid',
    shader: fullPhysicalMaterial.passes?.[0]?.program.module,
    parameterNames: fullPhysicalMaterial.parameters?.map((parameter) => parameter.name),
  };
  if (process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1') {
    console.error(`[physical-material] full physical material receipt: ${JSON.stringify(fullPhysicalMaterialLoad)}`);
  }
  if (hdrEntry !== undefined) {
    const hdrPublished = publishedPackages.find(({ entry }) => entry.guid === hdrGuid);
    const packagePath = hdrPublished?.packagePath;
    const pack = hdrPublished?.pack;
    const asset = pack?.assets?.find((candidate) => candidate.guid === hdrGuid);
    const body = asset?.artifacts?.body;
    if (packagePath !== undefined && pack !== undefined && body?.path !== undefined) {
      const bodyPath = resolve(dirname(packagePath), body.path);
      const parsedGuid = AssetGuid.parse(hdrGuid);
      if (parsedGuid.ok) {
        const loaded = await assets.loadByGuid(parsedGuid.value);
        if (loaded.ok) {
          hdrPod = loaded.value;
          const bodyBytes = new Uint8Array(readFileSync(bodyPath));
          hdrReceipt = {
            sourceGuid: hdrGuid,
            packageUrl: hdrEntry.packageUrl,
            packageHash: fnv1a(new TextEncoder().encode(JSON.stringify(pack))),
            bodyPath: body.path,
            bodyHash: fnv1a(bodyBytes),
            publication: {
              sourceRevision: hdrEntry.publication?.sourceRevision,
              digest: hdrEntry.publication?.digest,
            },
            payload: {
              kind: hdrPod.kind,
              width: hdrPod.width,
              height: hdrPod.height,
              format: hdrPod.format,
              colorSpace: hdrPod.colorSpace,
              dataByteLength: hdrPod.data.byteLength,
            },
            bodyIntegrity: {
              algorithm: body.integrity?.algorithm,
              expectedDigest: body.integrity?.digest,
              actualDigest: `sha256:${createHash('sha256').update(bodyBytes).digest('hex')}`,
            },
            load: 'assets.loadByGuid',
          };
          if (process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1') {
            console.error(`[physical-material] IBL source receipt: ${JSON.stringify(hdrReceipt)}`);
          }
        }
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}
const restoreConsole = captureWorldErrors(errors);
const world = new World();
const { renderComponentsPlugin } = await import('@forgeax/engine-render');
const { scenePlugin } = await import('@forgeax/engine-scene');
await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
const meshResult = createBoxGeometry(1.2, 1.2, 1.2);
if (!meshResult.ok) {
  console.error(`[physical-material] geometry failed: ${meshResult.error.code}`);
  process.exit(1);
}
const rigidMeshHandle = world.allocSharedRef('MeshAsset', meshResult.value);
const skinnedVertices = new Float32Array(3 * 18);
const skinnedFixture = caseInput.geometry.skinned;
const skinnedIndices = skinnedFixture.jointIndices.map((indices) => [...indices, 0, 0]);
const skinnedWeights = skinnedFixture.weights.map((weights) => [...weights, 0, 0]);
const skinnedBaseVertices = skinnedFixture.positions.map((position, vertex) => [
  ...position,
  0, 0, 1,
  ...skinnedFixture.uv[vertex],
  ...skinnedIndices[vertex],
  ...skinnedWeights[vertex],
]);
const skinnedVertexU16 = new Uint16Array(skinnedVertices.buffer);
for (let vertex = 0; vertex < skinnedBaseVertices.length; vertex += 1) {
  const floatOffset = vertex * 18;
  skinnedVertices.set(skinnedBaseVertices[vertex], floatOffset);
  const uint16Offset = floatOffset * 2 + 24;
  skinnedVertexU16.set(skinnedIndices[vertex], uint16Offset);
  skinnedVertices.set(skinnedWeights[vertex], floatOffset + 14);
}
const skinnedMesh = {
  kind: 'mesh',
  vertices: skinnedVertices,
  indices: new Uint16Array([0, 1, 2]),
  attributes: {
    position: new Float32Array([-0.55, -0.55, 0, 0.55, -0.55, 0, 0, 0.55, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    skinIndex: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    skinWeight: new Float32Array([0.75, 0.25, 0, 0, 0.35, 0.65, 0, 0, 0.6, 0.4, 0, 0]),
  },
  aabb: new Float32Array([-0.55, -0.55, 0, 0.55, 0.55, 0]),
  materialSlots: [{ slotName: 'Default' }],
  submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, materialSlot: 0, topology: 'triangle-list' }],
};
const skinnedMeshHandle = world.allocSharedRef('MeshAsset', skinnedMesh);
const skeletonMatrix = new Float32Array(16);
skeletonMatrix[0] = 1;
skeletonMatrix[5] = 1;
skeletonMatrix[10] = 1;
skeletonMatrix[15] = 1;
const secondInverseBind = new Float32Array(16);
secondInverseBind[0] = 1;
secondInverseBind[5] = 1;
secondInverseBind[10] = 1;
secondInverseBind[15] = 1;
const skeletonHandle = world.allocSharedRef('SkeletonAsset', {
  kind: 'skeleton',
  inverseBindMatrices: new Float32Array([...skeletonMatrix, ...secondInverseBind]),
  jointCount: 2,
});

function makeTexture(channel) {
  const data = new Uint8Array(4 * 4 * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = channel === 'R' ? 255 : channel === 'RG' ? 128 : 0;
    data[index + 1] = channel === 'G' ? 255 : channel === 'RG' ? 128 : 0;
    data[index + 2] = channel === 'RG' ? 255 : 0;
    data[index + 3] = 255;
  }
  return world.allocSharedRef('TextureAsset', {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    data,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  });
}

function makeMaterial(item) {
  const facts = describeMaterialCase(item, caseInput);
  const texture = makeTexture(facts.channel);
  const standardMaterial = Materials.standard({
    baseColor: Materials.srgb(facts.baseColor),
    metallic: facts.metallic,
    roughness: facts.roughness,
    clearcoat: facts.clearcoat,
    clearcoatRoughness: facts.clearcoatRoughness,
    clearcoatNormalScale: facts.clearcoatNormalScale,
    [facts.textureField]: texture,
  });
  const module = physicalMaterialModule(item);
  const material = physicalMaterialChild(standardMaterial, module);
  describeMaterial(item, material);
  return world.allocSharedRef('MaterialAsset', material);
}

const directCases = caseManifest.cases.filter((item) => item.lighting === 'direct');
const skinEvidence = new Map();
const directEntityByCaseId = new Map();
let anchorTextureMaterial;
const materialHandleByCaseId = new Map();
for (const item of directCases) {
  const [x, y] = caseInput.geometry.casePositions[item.caseId];
  const materialHandle = makeMaterial(item);
  const skinJoints = item.geometry === 'skinned'
    ? [
        world.spawn({ component: Transform, data: { pos: [x + caseInput.geometry.skinned.pose[0].pos[0], y + caseInput.geometry.skinned.pose[0].pos[1], 0], quat: caseInput.geometry.skinned.pose[0].quat, scale: caseInput.geometry.skinned.pose[0].scale } }).unwrap(),
        world.spawn({ component: Transform, data: { pos: [x + caseInput.geometry.skinned.pose[1].pos[0], y + caseInput.geometry.skinned.pose[1].pos[1], 0], quat: caseInput.geometry.skinned.pose[1].quat, scale: caseInput.geometry.skinned.pose[1].scale } }).unwrap(),
      ]
    : undefined;
  const meshArgs = skinJoints === undefined
    ? []
    : [{ component: Skin, data: { skeleton: skeletonHandle, joints: new Uint32Array(skinJoints) } }];
  if (skinJoints !== undefined) {
    skinEvidence.set(item.caseId, {
      jointCount: 2,
      joints: skinJoints,
      weights: caseInput.geometry.skinned.weights,
      pose: [
        { pos: [x + caseInput.geometry.skinned.pose[0].pos[0], y + caseInput.geometry.skinned.pose[0].pos[1], 0], quat: caseInput.geometry.skinned.pose[0].quat, scale: caseInput.geometry.skinned.pose[0].scale },
        { pos: [x + caseInput.geometry.skinned.pose[1].pos[0], y + caseInput.geometry.skinned.pose[1].pos[1], 0], quat: caseInput.geometry.skinned.pose[1].quat, scale: caseInput.geometry.skinned.pose[1].scale },
      ],
    });
  }
  const entity = world.spawn(
    { component: Transform, data: { pos: [x, y, 0] } },
    { component: MeshFilter, data: { assetHandle: item.geometry === 'skinned' ? skinnedMeshHandle : rigidMeshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
    ...meshArgs,
  ).unwrap();
  directEntityByCaseId.set(item.caseId, entity);
  materialHandleByCaseId.set(item.caseId, materialHandle);
  if (item.caseId === 'direct-rigid-factor-r') anchorTextureMaterial = materialHandle;
}
world.spawn(
  { component: Transform, data: { pos: [0, 0, 7] } },
  { component: Camera, data: {
    ...perspective({ fov: Math.PI / 4, aspect: WIDTH / HEIGHT, near: 0.1, far: 100 }),
    clearColor: caseInput.render.clearColor,
    tonemap: TONEMAP_REINHARD_EXTENDED,
    exposure: caseInput.render.exposure,
    whitePoint: caseInput.render.whitePoint,
  } },
).unwrap();
const directionalLight = world.spawn({ component: DirectionalLight, data: caseInput.directLight }).unwrap();

const attachment = renderer.attach(world);
if (!attachment.ok) {
  console.error(`[physical-material] world attach failed: ${attachment.error.code}`);
  process.exit(1);
}
renderer.subscribe((event) => {
  if (event.kind === 'error') {
    errors.push(event.error.code);
    if (process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1') {
      console.error(`[physical-material] renderer error: ${JSON.stringify(describeRuntimeError(event.error))}`);
    }
  }
});
const frameRequest = {
  leases: [attachment.value],
  camera: { lease: attachment.value },
  environment: { lease: attachment.value },
};
const observationHost = debugDrawHost;
const expectedMaterials = () => [...directEntityByCaseId.values()].map((entityKey) => ({
  entityKey,
  handle: world.get(entityKey, MeshRenderer).unwrap().materials[0],
}));
function requireCurrentMaterials(receipt, activeRenderer = renderer) {
  if (errors.length !== 0) throw new Error(`Runtime errors: ${errors.join(', ')}`);
  return requireFrameMaterials(receipt, activeRenderer.inspect(), world.identity, expectedMaterials());
}
function yieldToFrameLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function describeRuntimeError(error) {
  const seen = new Set();
  const serialize = (value, depth = 0) => {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (depth > 5) return '[max-depth]';
    if (seen.has(value)) return '[cycle]';
    seen.add(value);
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: typeof value.stack === 'string' ? value.stack.split('\n').slice(0, 8) : undefined,
        code: value.code,
        expected: value.expected,
        hint: value.hint,
        detail: serialize(value.detail, depth + 1),
      };
    }
    if (Array.isArray(value)) return value.map((item) => serialize(item, depth + 1));
    const result = {};
    for (const key of Object.getOwnPropertyNames(value)) result[key] = serialize(value[key], depth + 1);
    return result;
  };
  return serialize(error);
}

async function captureObservation(receipt, host = observationHost) {
  const observed = await host.observeCurrentFrame({
    semantic: 'linear-hdr',
    readback: (lease) => readbackTexturePixels(
      host.device,
      lease.descriptor.texture,
      lease.descriptor.size.width,
      lease.descriptor.size.height,
      { bytesPerTexel: 8 },
    ).then((bytes) => ({ ok: true, value: bytes })).catch((error) => ({ ok: false, error })),
  });
  if (!observed.ok) throw new Error(`linear HDR observation failed: ${JSON.stringify({ code: observed.error.code, reason: observed.error.detail?.reason, hint: observed.error.hint })}`);
  // The public Renderer receipt is one-based (the first submitted receipt is
  // frame 1), while the internal graph/observation host retains the
  // zero-based RenderFrameState frame number.  Compare the two explicit
  // identities instead of treating their presentation counters as one
  // namespace; the underlying texture must still come from the receipt's
  // immediately submitted frame.
  const expectedObservationFrameId = receipt.frameId - 1;
  if (observed.value.metadata.frameId !== expectedObservationFrameId) {
    throw new Error(`observation frame mismatch: receipt=${receipt.frameId} expected=${expectedObservationFrameId} observed=${observed.value.metadata.frameId}`);
  }
  if (observed.value.metadata.format !== 'rgba16float') {
    throw new Error(`linear HDR observation format mismatch: ${observed.value.metadata.format}`);
  }
  if (observed.value.metadata.pipelineId !== 'forgeax::standard' || observed.value.metadata.backendId.length === 0) {
    throw new Error('linear HDR observation identity is incomplete');
  }
  return observed.value;
}

function prepareGraphTargetCapture(host) {
  const target = host.getCurrentGraphTarget('scene-color');
  if (target === undefined) {
    const graph = host.perFrameGraphInfo;
    const inspection = renderer.inspect();
    const alternateTargets = ['standard-output-color', 'hdrColor', 'surface', 'output-transform'].map((name) => ({
      name,
      available: host.getCurrentGraphTarget(name) !== undefined,
    }));
    console.error(`[physical-material] IBL scene-color target unavailable before draw: ${JSON.stringify({
      graphGeneration: graph?.generation,
      resources: graph?.resources?.map((resource) => ({ label: resource.label, kind: resource.kind, format: resource.format, extent: resource.extent })),
      passes: graph?.passes?.map((pass) => pass.name),
      inspection: Object.keys(inspection).filter((key) => key.toLowerCase().includes('graph') || key.toLowerCase().includes('output')),
      inspectionOutput: inspection.output,
      alternateTargets,
    })}`);
    return undefined;
  }
  const bytesPerRow = Math.ceil((WIDTH * 8) / 256) * 256;
  const bufferResult = host.device.createBuffer({
    label: 'physical-material-ibl-graph-capture',
    size: bytesPerRow * HEIGHT,
    usage: 0x0001 | 0x0008,
  });
  if (!bufferResult.ok) {
    console.error(`[physical-material] IBL graph capture buffer failed: ${JSON.stringify(describeRuntimeError(bufferResult.error))}`);
    return undefined;
  }
  const sentinel = new Uint8Array(16).fill(0xa5);
  const initialized = host.device.queue.writeBuffer(bufferResult.value, 0, sentinel);
  if (!initialized.ok) {
    console.error(`[physical-material] IBL graph capture sentinel failed: ${JSON.stringify(describeRuntimeError(initialized.error))}`);
    host.device.destroyBuffer(bufferResult.value);
    return undefined;
  }
  host.requestGraphTargetCapture({
    name: 'scene-color',
    buffer: bufferResult.value,
    bytesPerRow,
    width: WIDTH,
    height: HEIGHT,
    expected: {
      format: 'rgba16float',
      width: WIDTH,
      height: HEIGHT,
      usage: 0x01,
      identity: {
        graphGeneration: target.graphGeneration,
        frameId: target.frameId + 1,
        textureIdentity: target.textureIdentity,
      },
    },
  });
  return { target, buffer: bufferResult.value, bytesPerRow };
}

async function readGraphTargetCapture(host, capture) {
  if (capture === undefined) return undefined;
  await host.device.queue.onSubmittedWorkDone();
  const mapped = await capture.buffer.mapAsync(0x0001);
  if (!mapped.ok) {
    host.device.destroyBuffer(capture.buffer);
    return undefined;
  }
  const range = mapped.value.getMappedRange();
  if (!range.ok) {
    mapped.value.unmap();
    host.device.destroyBuffer(capture.buffer);
    return undefined;
  }
  const padded = new Uint8Array(range.value.slice(0));
  mapped.value.unmap();
  host.device.destroyBuffer(capture.buffer);
  const bytes = new Uint8Array(WIDTH * HEIGHT * 8);
  for (let row = 0; row < HEIGHT; row += 1) {
    bytes.set(
      padded.subarray(row * capture.bytesPerRow, row * capture.bytesPerRow + WIDTH * 8),
      row * WIDTH * 8,
    );
  }
  const record = {
    graphFrameId: capture.target.frameId + 1,
    graphGeneration: capture.target.graphGeneration,
    textureIdentity: capture.target.textureIdentity,
    descriptor: capture.target.descriptor,
    bytes,
    rawHash: fnv1a(bytes),
  };
  return record;
}

const anchorEntity = directEntityByCaseId.get('direct-rigid-factor-r');
let frameCapture;
const directReceipt = await runRenderPhase({
  phase: 'direct',
  frameCount: FRAME_COUNT,
  world,
  renderer,
  frameRequest,
  yieldFrame: yieldToFrameLoop,
  beforeDraw: async (frame) => {
    if (recorder !== undefined && (frame === 0 || frame === 4)) {
      frameCapture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
    }
  },
  afterDraw: async (frame, receipt) => {
    requireCurrentMaterials(receipt);
    if (recorder !== undefined && frameCapture !== undefined) {
      (await recorder.frameBoundary()).unwrap();
      mkdirSync(captureDirectory, { recursive: true });
      const captured = (await frameCapture).unwrap();
      writeFileSync(resolve(captureDirectory, `direct-${frame}.rhitape`), captured.bytes);
      const tape = decodeTape(captured.bytes).unwrap();
      const model = buildFrameModel(tape);
      const creates = new Map([...tape.bootstrap.map((row) => row.create), ...tape.events]
        .filter((row) => row?.handleId !== undefined).map((row) => [row.handleId, row]));
      let checked = 0;
      for (const work of model.works) {
        const pipeline = creates.get(work.pipeline?.pipelineHandleId);
        const layout = creates.get(pipeline?.layoutHandleId);
        if (layout?.bglHandleIds === undefined) continue;
        for (const binding of work.bindings) {
          const group = creates.get(binding.bindGroupId);
          const expected = creates.get(layout.bglHandleIds[binding.groupIndex]);
          const actual = creates.get(group?.layoutHandleId);
          if (expected === undefined || actual === undefined) continue;
          checked++;
          if (JSON.stringify(expected.desc.entries) !== JSON.stringify(actual.desc.entries))
            throw new Error(`Physical work ${work.workIndex} group ${binding.groupIndex}: recorded layout differs from its pipeline`);
          const expectedEntry = expected.desc.entries.find((entry) => entry.binding === binding.binding);
          const resource = group.entries.find((entry) => entry.binding === binding.binding);
          const resourceKind = expectedEntry?.texture !== undefined || expectedEntry?.storageTexture !== undefined
            ? 'textureView'
            : expectedEntry?.sampler !== undefined ? 'sampler'
            : expectedEntry?.externalTexture !== undefined ? 'externalTexture' : 'buffer';
          if (resource?.resourceKind !== resourceKind)
            throw new Error(`Physical work ${work.workIndex} group ${binding.groupIndex} binding ${binding.binding}: resource type differs from its layout`);
        }
      }
      writeFileSync(resolve(captureDirectory, `direct-${frame}-bindings.json`), JSON.stringify({ works: model.works.length, checked, differences: 0 }));
      frameCapture = undefined;
    }
  },
  onDrawError: (phase, frame, error) => console.error(`[physical-material] ${phase} frame=${frame} failed: ${JSON.stringify(describeRuntimeError(error))}`),
});
const directObservation = await captureObservation(directReceipt);
if (process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1') {
  const directInspection = renderer.inspect();
  console.error(`[physical-material] direct graph inspection: ${JSON.stringify({
    frame: directInspection.frame,
    outputTransform: directInspection.output.outputTransform,
    graphPassNames: directInspection.output.graphPassNames,
    standardOutputColor: directInspection.output.standardOutputColor,
    iblBinding: directInspection.iblBinding,
    graphResources: observationHost.perFrameGraphInfo?.resources?.map((resource) => ({ label: resource.label, kind: resource.kind, format: resource.format, extent: resource.extent })),
  })}`);
}
const directPixels = directObservation.bytes;
if (captureDirectory !== undefined) {
  const view = new DataView(directPixels.buffer, directPixels.byteOffset, directPixels.byteLength);
  const preview = Uint8Array.from({ length: WIDTH * HEIGHT * 4 }, (_, index) => {
    if (index % 4 === 3) return 255;
    const linear = Math.max(0, Math.min(1, halfToFloat(view.getUint16(index * 2, true))));
    return Math.round((linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055) * 255);
  });
  writeFileSync(resolve(captureDirectory, 'direct-linear-hdr-preview.png'), writeReferencePng(preview, WIDTH, HEIGHT));
  writeFileSync(resolve(captureDirectory, 'direct-linear-hdr.bin'), directPixels);
}
const directMaterialBindingReceipt = renderer.inspect().meshMaterialBindings.map((entry) => ({
  worldId: entry.worldId,
  entityKey: entry.entityKey,
  bindings: entry.bindings,
  diagnostics: entry.diagnostics,
}));
let directAnchorScalarCoverage;
if (process.env.PHYSICAL_MATERIAL_RUN_ANCHOR_PROBE === '1' && anchorEntity !== undefined) {
  const directProbeMaterial = world.allocSharedRef('MaterialAsset', Materials.standard({
    baseColor: [0.62, 0.14, 0.04, 1], metallic: 0, roughness: 0.42,
  }));
  world.set(anchorEntity, MeshRenderer, { materials: [directProbeMaterial] }).unwrap();
  world.update().unwrap();
  const directProbeReceipt = renderer.draw(frameRequest);
  if (directProbeReceipt.ok) {
    const directProbeObservation = await captureObservation(directProbeReceipt.value);
    directAnchorScalarCoverage = objectCoverage(
      directProbeObservation.bytes,
      WIDTH,
      { x: 0, y: 0, width: Math.floor(WIDTH / 4), height: Math.floor(HEIGHT / 2) },
      caseInput.render.clearColor,
    );
  }
  if (anchorTextureMaterial !== undefined) {
    world.set(anchorEntity, MeshRenderer, { materials: [anchorTextureMaterial] }).unwrap();
  }
  world.update().unwrap();
  renderer.draw(frameRequest);
}
const directNonZeroBytes = directPixels.reduce((total, byte) => total + (byte !== 0 ? 1 : 0), 0);
const centerOffset = (Math.floor(HEIGHT / 2) * WIDTH + Math.floor(WIDTH / 2)) * 8;
const center = [...directPixels.slice(centerOffset, centerOffset + 8)];
const roiWidth = caseInput.projection.roiWidth;
const roiHeight = caseInput.projection.roiHeight;
function readRoi(item, index, observation, phase) {
  const pixels = observation.bytes;
  const plan = casePlans.get(item.caseId);
  const roi = resolveCaseRoi(item, index, plan, { roiWidth, roiHeight });
  const projected = createLinearHdrRoiEvidence(pixels, WIDTH, roi, item.caseId, caseInput.render.clearColor);
  const skin = skinEvidence.get(item.caseId) ?? skinEvidence.get(item.caseId.replace('ibl-', 'direct-'));
  const observed = {
    nonZeroBytes: projected.observed.nonZeroBytes,
    nonZeroAlphaPixels: projected.observed.nonZeroAlphaPixels,
    linearHdrMean: projected.observed.linearHdrMean,
  };
  const record = {
    caseId: item.caseId,
    backend: renderer.inspect().capabilities.backendKind,
    device: 'dawn-node',
    exactHead,
    lighting: item.lighting,
    geometry: item.geometry,
    authoredSlot: item.authoredSlot,
    channel: item.channel,
    material: {
      kind: 'MaterialAsset',
      shader: physicalMaterialModule(item),
      handle: materialHandleByCaseId.get(item.caseId),
    },
    bindingReceipt: directMaterialBindingReceipt.find((entry) =>
      entry.entityKey === directEntityByCaseId.get(item.caseId),
    ),
    iblBinding: renderer.inspect().iblBinding,
    materialDiagnostic: materialDiagnosticsByCaseId.get(item.caseId),
    artifact: {
      shaderManifest: manifestPath,
      shaderManifestHash,
      reference: {
        path: referenceArtifactPath,
        artifactId: referenceArtifact.artifactId,
        source: referenceArtifact.source,
        revision: referenceArtifact.revision,
        configHash: referenceArtifact.configHash,
      },
    },
    ...(item.sourceRoute !== undefined || hdrReceipt !== undefined
      ? { sourceClosure: { route: item.sourceRoute, ...(hdrReceipt === undefined ? {} : { hdrReceipt }) } }
      : {}),
    ...(skin !== undefined ? { skin } : {}),
    submittedFrame: { start: 0, end: FRAME_COUNT - 1, count: FRAME_COUNT },
    readback: {
      status: 'ok',
      format: observation.metadata.format,
      colorSpace: 'linear-hdr',
      byteLength: projected.rawBytes.byteLength,
      nonZeroBytes: projected.observed.nonZeroBytes,
      frameId: observation.metadata.frameId,
      pipelineId: observation.metadata.pipelineId,
      backendId: observation.metadata.backendId,
    },
    roi,
    reference: plan ?? { referenceId: 'missing', metric: 'linear-hdr-rgb-mean', epsilon: 0.05 },
    observed,
    residual: plan?.expectedLinearHdrMean?.map((expected, channel) => expected - observed.linearHdrMean[channel]),
    objectMask: projected.objectMask,
    verdict: 'pending',
    confidence: phase === 'direct' ? 'linear-hdr-observation' : 'linear-hdr-ibl-observation',
    rawHash: projected.rawHash,
  };
  if (
    process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1' &&
    phase === 'ibl' &&
    item.caseId === 'ibl-rigid-factor-r'
  ) {
    console.error(`[physical-material] IBL binding receipt: ${JSON.stringify(record.iblBinding)}`);
  }
  return record;
}
const directRecords = directCases.map((item, index) => readRoi(item, index, directObservation, 'direct'));
// Paired sentinels are direct-light captures. Run them before the lighting
// owner transitions to Skylight so the same direct frame contract remains
// active for both material variants.
const pairSentinelRoi = { x: 75, y: 37, width: 50, height: 75 };
const pairedBaseColor = [1, 1, 1, 1];
if (anchorEntity !== undefined) {
  world.set(anchorEntity, Transform, {
    pos: [0, 0, 0],
    // Put the paired witness at a controlled 85-degree grazing angle. A
    // head-on box makes the fixed-IOR clearcoat Fresnel only ~4%, so the
    // additive mutant can be numerically hidden by a linear-HDR ROI mean even
    // when the shader is genuinely different. This rotation keeps the same
    // geometry and light while making the energy-layer falsifier observable.
    quat: [0, 0.6755902, 0, 0.7372773],
    scale: [1, 1, 1],
  }).unwrap();
}
world.set(directionalLight, DirectionalLight, {
  direction: [-0.4, -0.8, -0.3],
  color: [1, 1, 1],
  intensity: 128,
  castShadow: false,
}).unwrap();
async function capturePairMaterial(
  material,
  roi = pairSentinelRoi,
  pairRenderer = renderer,
  pairObservationHost = observationHost,
  pairFrameRequest = frameRequest,
) {
  const handle = world.allocSharedRef('MaterialAsset', material);
  const entity = directEntityByCaseId.get('direct-rigid-factor-r');
  if (entity === undefined) return { ok: false, error: new Error('paired entity is missing') };
  const resolvedMaterial = resolveMaterialAsset('pair', { pair: material, [fullPhysicalMaterialGuid]: fullPhysicalMaterial }).unwrap().asset;
  const assigned = world.set(entity, MeshRenderer, { materials: [handle] });
  if (!assigned.ok) return { ok: false, error: assigned.error };
  // Keep transition submissions separate from the final paired HDR witness.
  const warmupFrames = pairRenderer === renderer ? 1 : 2;
  const receipt = await runRenderPhase({
    phase: 'paired', frameCount: warmupFrames + 1, world, renderer: pairRenderer,
    frameRequest: pairFrameRequest, yieldFrame: yieldToFrameLoop,
    afterDraw: (_frame, current) => requireCurrentMaterials(current, pairRenderer),
  });
  const frameMaterials = requireCurrentMaterials(receipt, pairRenderer);
  let observation;
  try {
    observation = await captureObservation(receipt, pairObservationHost);
  } catch (error) {
    if (process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1') {
      console.error(`[physical-material] paired observation failed: ${JSON.stringify(describeRuntimeError(error))}`);
    }
    return { ok: false, error };
  }
  let projected;
  try {
    projected = createLinearHdrRoiEvidence(observation.bytes, WIDTH, roi, 'paired', caseInput.render.clearColor);
  } catch (error) {
    if (process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1') {
      console.error(`[physical-material] paired ROI failed: ${JSON.stringify(describeRuntimeError(error))}`);
    }
    return { ok: false, error };
  }
  const result = {
    ok: true,
    observed: projected.observed.linearHdrMean,
    objectMask: projected.objectMask,
    frameId: observation.metadata.frameId,
    pipelineId: observation.metadata.pipelineId,
    backendId: observation.metadata.backendId,
    bindingReceipt: pairRenderer.inspect().meshMaterialBindings,
    drawReceipt: {
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      frameMaterials,
    },
    observationReceipt: {
      frameId: observation.metadata.frameId,
      pipelineId: observation.metadata.pipelineId,
      backendId: observation.metadata.backendId,
      format: observation.metadata.format,
      colorSpace: observation.metadata.colorSpace,
      byteLength: projected.rawBytes.byteLength,
      roi,
      roiRawHash: projected.rawHash,
    },
    materialReceipt: {
      parameterNames: (resolvedMaterial.parameters ?? []).map((parameter) => parameter.name),
      authoredTextureFields: Object.keys(material.values ?? {}).filter((name) => name.endsWith('Texture')),
      paramDigest: createHash('sha256').update(JSON.stringify({
        parameters: resolvedMaterial.parameters,
        values: resolvedMaterial.values,
        modules: resolvedMaterial.passes.map((pass) => pass.program.module),
      })).digest('hex'),
    },
  };
  if (process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1') {
    console.error(`[physical-material] paired observation receipt: ${JSON.stringify({
      materialHandle: handle,
      observed: result.observed,
      objectMask: result.objectMask,
      drawReceipt: result.drawReceipt,
      observationReceipt: result.observationReceipt,
      materialReceipt: result.materialReceipt,
    })}`);
  }
  return result;
}
function makePairMaterial(clearcoat = 0, useLoadedRoot = true) {
  const material = Materials.standard({
    baseColor: pairedBaseColor,
    metallic: 0,
    roughness: 0.42,
    ior: 1.5,
    transmission: 0,
    thickness: 0,
    clearcoat,
    clearcoatRoughness: 0.18,
  });
  return useLoadedRoot
    ? physicalMaterialChild(material, 'physical-material::standard-full-physical')
    : withPhysicalMaterialModule(material, PHYSICAL_MATERIAL_MODULES.scalar);
}
const pairBaseMaterial = makePairMaterial();
const customSurfaceMaterial = {
  ...pairBaseMaterial,
  values: { ...pairBaseMaterial.values },
};
const additiveBaselineMaterial = makePairMaterial(1, false);
const additiveMutationMaterial = makePairMaterial(1, false);
const additivePairIdentity = (material) => JSON.stringify({
  parameters: material.parameters ?? [],
  values: material.values ?? {},
  modules: (material.passes ?? []).map((pass) => ({ name: pass.name, module: pass.program.module })),
});
if (additivePairIdentity(additiveBaselineMaterial) !== additivePairIdentity(additiveMutationMaterial)) {
  throw new Error('additive coat paired materials do not share authored identity');
}
const pairResults = await runPairedStages({
  stages: ['base', 'factorZero', 'defaultSurface', 'customSurface', 'additiveBaseline'],
  captureStage: (stage) => {
    if (stage === 'base') return capturePairMaterial(pairBaseMaterial);
    if (stage === 'factorZero') return capturePairMaterial(makePairMaterial(0));
    if (stage === 'defaultSurface') return capturePairMaterial(pairBaseMaterial);
    if (stage === 'customSurface') return capturePairMaterial(customSurfaceMaterial);
    return capturePairMaterial(additiveBaselineMaterial);
  },
});
const pairBase = pairResults.base;
const pairFactorZero = pairResults.factorZero;
const defaultSurface = pairResults.defaultSurface;
const customSurface = pairResults.customSurface;
const additiveBaseline = pairResults.additiveBaseline;
if (defaultSurface.ok && customSurface.ok && (
  defaultSurface.materialReceipt.parameterNames.length === 0 ||
  defaultSurface.materialReceipt.paramDigest !== customSurface.materialReceipt.paramDigest
)) throw new Error('default/custom resolved material parameter contract differs');
let mutantRenderer;
let mutantObservationHost;
let mutantFrameRequest;
const mutantConstructed = await constructRuntimeRendererHost(mutantCanvas, {}, { shaderManifestUrl: mutantManifestUrl });
if (!mutantConstructed.ok) {
  errors.push('additive-mutant-host-construction-failed');
} else {
  const mutantAssets = mutantConstructed.value.assets;
  mutantAssets.configurePackIndex('/pack-index.json');
  globalThis.fetch = fetchPublished;
  try {
    for (const root of physicalMaterialRoots) {
      const loaded = await mutantAssets.loadByGuid(root.parent);
      if (!loaded.ok) throw new Error(`mutant root ${root.guid} load failed: ${loaded.error.code}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  mutantRenderer = mutantConstructed.value.renderer;
  captureGpuErrors(mutantRenderer.nativeDevice().unwrap(), errors);
  mutantObservationHost = mutantConstructed.value.debugDrawHost;
  mutantRenderer.subscribe((event) => {
    if (event.kind === 'error') {
      errors.push(event.error.code);
      if (process.env.PHYSICAL_MATERIAL_DIAGNOSTICS === '1') {
        console.error(`[physical-material] mutant renderer error: ${JSON.stringify(describeRuntimeError(event.error))}`);
      }
    }
  });
  const mutantAttachment = mutantRenderer.attach(world);
  if (!mutantAttachment.ok) {
    errors.push('additive-mutant-attach-failed');
    mutantRenderer = undefined;
  } else {
    mutantFrameRequest = {
      leases: [mutantAttachment.value],
      camera: { lease: mutantAttachment.value },
      environment: { lease: mutantAttachment.value },
    };
  }
}
const additiveMutation = await capturePairMaterial(
  additiveMutationMaterial,
  pairSentinelRoi,
  mutantRenderer,
  mutantObservationHost,
  mutantFrameRequest,
);
if (anchorEntity !== undefined) {
  world.set(anchorEntity, Transform, {
    pos: [-2.7, 0.9, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  }).unwrap();
}
const iblCases = caseManifest.cases.filter((item) => item.lighting === 'ibl');
let iblObservation;
let iblGraphCapture;
let iblGraphCaptureError;
if (hdrPod === undefined) {
  errors.push('ibl-guid-load-failed');
} else {
  world.despawn(directionalLight).unwrap();
  const equirect = world.allocSharedRef('EquirectAsset', hdrPod);
  world.spawn({ component: Skylight, data: { equirect, intensity: 1 } }).unwrap();
  // Paired sentinel capture temporarily rebinds the shared anchor entity to
  // the additive-mutant material. Re-project every IBL case onto its own
  // authored/cooked module before the phase starts, just like the Browser
  // carrier does; otherwise the first ROI would observe the sentinel
  // material instead of `standard-clearcoat-factor-r`.
  for (const item of iblCases) {
    const entity = directEntityByCaseId.get(item.caseId.replace('ibl-', 'direct-'));
    if (entity !== undefined) {
      world.set(entity, MeshRenderer, { materials: [makeMaterial(item)] }).unwrap();
    }
  }
  const iblReceipt = await runRenderPhase({
    phase: 'ibl',
    frameCount: FRAME_COUNT,
    maxPendingFrames: 120,
    world,
    renderer,
    frameRequest,
    yieldFrame: yieldToFrameLoop,
    beforeDraw: async (frame) => {
      if (errors.length !== 0) throw new Error(`Runtime errors: ${errors.join(', ')}`);
      if (frame === FRAME_COUNT - 1) {
        iblGraphCapture = prepareGraphTargetCapture(observationHost);
        if (iblGraphCapture === undefined) iblGraphCaptureError = 'graph-capture-prepare-failed';
      }
    },
    afterDraw: async (frame, receipt) => {
      requireCurrentMaterials(receipt);
      if (frame === FRAME_COUNT - 1) {
        iblObservation = await captureObservation(receipt);
        try {
          iblGraphCapture = await readGraphTargetCapture(observationHost, iblGraphCapture);
        } catch (cause) {
          iblGraphCaptureError = cause instanceof Error ? cause.message : String(cause);
        }
      }
    },
    onDrawError: (phase, frame, error) => console.error(`[physical-material] ${phase} frame=${frame} failed: ${JSON.stringify(describeRuntimeError(error))}`),
  });
  if (iblObservation === undefined) iblObservation = await captureObservation(iblReceipt);
  if (hdrReceipt !== undefined) {
    hdrReceipt = {
      ...hdrReceipt,
      residency: {
        backend: renderer.inspect().capabilities.backendKind,
        device: 'dawn-node',
        sourceView: {
          dimension: '2d',
          format: hdrPod.format,
          width: hdrPod.width,
          height: hdrPod.height,
        },
        projectedCubemap: {
          dimension: 'cube',
          format: hdrPod.format,
          faceSize: hdrPod.height,
          mipLevelCount: 1,
        },
        output: {
          observationFormat: iblObservation.metadata.format,
          observationColorSpace: iblObservation.metadata.colorSpace,
          frameId: iblObservation.metadata.frameId,
          pipelineId: iblObservation.metadata.pipelineId,
          byteLength: iblObservation.bytes.byteLength,
        },
      },
    };
  }
}
const iblGraphComparison = (() => {
  if (iblGraphCapture === undefined || iblObservation === undefined) {
    return { verdict: 'blocked', reason: iblGraphCaptureError ?? 'graph-capture-missing' };
  }
  let equal = iblGraphCapture.bytes.byteLength === iblObservation.bytes.byteLength;
  if (equal) {
    for (let index = 0; index < iblGraphCapture.bytes.length; index += 1) {
      if (iblGraphCapture.bytes[index] !== iblObservation.bytes[index]) {
        equal = false;
        break;
      }
    }
  }
  return {
    verdict: equal ? 'pass' : 'fail',
    graph: {
      frameId: iblGraphCapture.graphFrameId,
      graphGeneration: iblGraphCapture.graphGeneration,
      textureIdentity: iblGraphCapture.textureIdentity,
      descriptor: iblGraphCapture.descriptor,
      rawHash: iblGraphCapture.rawHash,
    },
    observation: {
      frameId: iblObservation.metadata.frameId,
      pipelineId: iblObservation.metadata.pipelineId,
      backendId: iblObservation.metadata.backendId,
      rawHash: fnv1a(iblObservation.bytes),
    },
    frameMatch: iblGraphCapture.graphFrameId === iblObservation.metadata.frameId,
    sameBytes: equal,
  };
})();
if (iblGraphComparison.frameMatch === false) errors.push('ibl-graph-observation-frame-mismatch');
if (iblGraphComparison.verdict !== 'pass') errors.push('ibl-graph-observation-mismatch');
console.error(`[physical-material] IBL graph/observation comparison: ${JSON.stringify(iblGraphComparison)}`);
const iblRecords = iblObservation === undefined
  ? []
  : iblCases.map((item, index) => readRoi(item, index, iblObservation, 'ibl'));
const caseRecords = [...directRecords, ...iblRecords];
const semanticEvaluation = evaluateCaseRecords(caseRecords, caseManifest, casePlans);
const pairedSentinels = {
  'factor-zero-base-parity': pairBase.ok && pairFactorZero.ok ? {
    base: pairBase.observed,
    factorZero: pairFactorZero.observed,
    epsilon: referenceArtifact.paired['factor-zero-base-parity'].epsilon,
    observations: {
      base: { frameId: pairBase.frameId, pipelineId: pairBase.pipelineId, backendId: pairBase.backendId },
      factorZero: { frameId: pairFactorZero.frameId, pipelineId: pairFactorZero.pipelineId, backendId: pairFactorZero.backendId },
      baseObjectMask: pairBase.objectMask,
      factorZeroObjectMask: pairFactorZero.objectMask,
    },
  } : { verdict: 'blocked', reason: 'paired-capture-frame-input-invalid' },
  'default-custom-surface-physical-parity': defaultSurface.ok && customSurface.ok ? {
    defaultSurface: defaultSurface.observed,
    customSurface: customSurface.observed,
    epsilon: referenceArtifact.paired['default-custom-surface-physical-parity'].epsilon,
    rootIdentity: { parent: fullPhysicalMaterialGuid, custom: 'independent-child-values' },
    materials: { default: defaultSurface.materialReceipt, custom: customSurface.materialReceipt },
  } : { verdict: 'blocked', reason: 'paired-capture-frame-input-invalid' },
  'additive-coat-falsifier': additiveBaseline.ok && additiveMutation.ok ? {
    metric: referenceArtifact.paired['additive-coat-falsifier'].metric,
    baselineNoise: referenceArtifact.paired['additive-coat-falsifier'].baselineNoise,
    baselineEnergy: additiveBaseline.observed.reduce((sum, value) => sum + Math.abs(value), 0),
    mutatedEnergy: additiveMutation.observed.reduce((sum, value) => sum + Math.abs(value), 0),
    energyTolerance: referenceArtifact.paired['additive-coat-falsifier'].energyTolerance,
    baselineArtifact: {
      frameId: additiveBaseline.frameId,
      rawObservation: additiveBaseline.observed,
      objectMask: additiveBaseline.objectMask,
      bindingReceipt: additiveBaseline.bindingReceipt,
      drawReceipt: additiveBaseline.drawReceipt,
      observationReceipt: additiveBaseline.observationReceipt,
      materialReceipt: additiveBaseline.materialReceipt,
    },
    mutatedArtifact: {
      frameId: additiveMutation.frameId,
      rawObservation: additiveMutation.observed,
      objectMask: additiveMutation.objectMask,
      bindingReceipt: additiveMutation.bindingReceipt,
      drawReceipt: additiveMutation.drawReceipt,
      observationReceipt: additiveMutation.observationReceipt,
      materialReceipt: additiveMutation.materialReceipt,
      source: resolve(here, '..', 'evidence', 'additive-coat-mutant.wgsl'),
      artifact: 'physical-material-additive-mutant-v1',
      program: PHYSICAL_MATERIAL_MODULES.scalar,
      sourceClosureDigest: mutantSourceClosureDigest,
      productClosure: false,
      programSelection: {
        product: productScalarVariantReceipts,
        mutant: mutantScalarVariantReceipts,
        manifestHash: shaderManifestHash,
      },
    },
  } : { verdict: 'blocked', reason: 'falsifier-capture-frame-input-invalid' },
};
const pairedSentinelEvaluation = evaluatePairedSentinels(pairedSentinels);
const nonZeroBytes = Math.max(directNonZeroBytes, iblObservation?.bytes.reduce((total, byte) => total + (byte !== 0 ? 1 : 0), 0) ?? 0);
if (caseRecords.length !== caseManifest.caseCount) {
  errors.push('case-coverage-incomplete');
}
if (directRecords.length !== directCases.length) errors.push('direct-case-executor-incomplete');
if (iblRecords.length !== iblCases.length) errors.push('ibl-case-executor-incomplete');
if (semanticEvaluation.verdict !== 'pass') errors.push('semantic-evaluator-failed');
if (pairedSentinelEvaluation.verdict !== 'pass') errors.push('paired-sentinel-evaluator-failed');
const evidence = {
  status: errors.length === 0 && nonZeroBytes > 0 && caseRecords.length === caseManifest.caseCount ? 'pass' : 'fail',
  backend: renderer.inspect().capabilities.backendKind,
  frames: FRAME_COUNT,
  nonZeroBytes,
  center,
  targets: caseManifest.cases.map((item) => item.caseId),
  caseRecords,
  semanticEvaluation,
  pairedSentinelEvaluation,
  pairedSentinels,
  iblGraphComparison,
  materialLoad: fullPhysicalMaterialLoad,
  ...(directAnchorScalarCoverage === undefined ? {} : { directAnchorScalarCoverage }),
  provenance: {
    manifest: manifestPath,
    caseManifest: caseManifestPath,
    referenceArtifact: referenceArtifactPath,
    renderer: 'constructRuntimeRendererHost',
    readback: 'copyTextureToBuffer',
  },
  errors,
};
const disposeErrors = await disposeRenderResources({ renderer, mutantRenderer, renderTarget, mutantRenderTarget, device: sharedDevice });
errors.push(...disposeErrors);
if (disposeErrors.length !== 0) evidence.status = 'fail';
if (evidence.status === 'pass') emitSmokeReceipt('hello-physical-material/smoke', FRAME_COUNT);
// Flush the complete receipt before terminating the native Dawn worker host.
// A successful verdict otherwise leaves Dawn's event loop alive indefinitely.
await new Promise((resolve, reject) =>
  process.stdout.write(`${JSON.stringify(evidence)}\n`, (error) => (error ? reject(error) : resolve())),
);
restoreConsole();
delete globalThis.navigator.gpu;
// All owned resources and readbacks are settled above. Dawn's native instance
// can retain the Node event loop even after GPUDevice.destroy(); the smoke CLI
// terminates only after publishing its final cleanup-aware verdict.
process.exit(evidence.status === 'pass' ? 0 : 1);
