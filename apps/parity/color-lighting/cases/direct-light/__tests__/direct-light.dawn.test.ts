import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry, createPrimitiveMesh } from '@forgeax/engine-geometry';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import type { TextureAsset } from '@forgeax/engine-types';
import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  SpotLight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import type { RendererLegacyHostAdapter } from '@forgeax/engine-render/internal/construct-renderer';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, describe, expect, it } from 'vitest';
import { readbackTexturePixels } from '../../../../../../packages/rhi-debug/src/readback';
import { drawReadyFrame } from '../../../../../../scripts/test/ready-render-frame.mjs';
import sceneCaseSchema from '../../../schemas/scene-case.schema.json' with { type: 'json' };
import { createForgeaxAdapter } from '../../../src/adapters/forgeax-adapter';
import { createThreeAdapter } from '../../../src/adapters/three-adapter';
import {
  decodeLinearHdrRgba16Float,
  projectObservation,
  validateAttachmentEvidence,
  type AttachmentEvidence,
} from '../../../src/capture/attachment-readback';
import { probeReadback } from '../../../src/capture/readback-probe';
import type { CaptureConfig } from '../../../src/capture/named-capture';
import { runParityMatrix } from '../../../src/cli/run-parity';
import { loadSceneCase } from '../../../src/contracts/load-scene-case';
import type { SceneCase } from '../../../src/contracts/types';
import { createPipelineEvidenceArtifact, writePipelineEvidence } from '../../../src/report/write-pipeline-evidence';
import { readbackRgba16float } from '../../../src/capture/rhi-readback';
import {
  asSceneCase,
  compareSpotShadowRoi,
  compareSpotShadowToCanonicalExpected,
  createDirectLightCanonicalExpected,
  createDirectLightPairedRecord,
  currentDirectLightExactSha,
  directLightCarrierIdentity,
  directLightUnavailableByApi,
  measureSpotShadowDelta,
  perturbDirectLightCanonicalExpected,
  SPOT_SHADOW_SCENES,
  type DirectLightProvenance,
  type SpotShadowFalsifierId,
  type SpotShadowReceiverVariant,
  type SpotShadowScene,
} from '../spot-shadow-fixture';

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;
// The direct-light matrix is a static producer contract. Its Browser parity
// adapter uses the same bounded 2-frame warmup while each artifact retains its
// producer-local frameId. The CI job opts into the bounded warmup because the
// partition runner already provides a fresh native process; local and nightly
// runs keep the longer window for debugging and full evidence collection.
const SPOT_SHADOW_CAPTURE_FRAMES = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 2 : 60;
const SPOT_SHADOW_FALSIFIER_CAPTURE_FRAMES =
  process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 2 : 60;
// The partition runner gives each scene group a fresh native process.
// On Ubuntu lavapipe, the paired and falsifier captures can legitimately exceed
// the ordinary two-minute per-test budget. The runner bounds the complete
// process lifetime; keep the shorter default for a direct Vitest invocation.
const SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS = process.env.FORGEAX_DAWN_PARTITION === undefined
  ? 120_000
  : 600_000;
const lightCaseNames = ['directional', 'point', 'spot', 'khr-spot'] as const;
const casePaths = lightCaseNames.map((name) =>
  resolve(import.meta.dirname, `../cases/${name}-urp.json`),
);
const hdrpCasePaths = lightCaseNames.map((name) =>
  resolve(import.meta.dirname, `../cases/${name}-hdrp.json`),
);
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(sceneCaseSchema);
type DawnEngineManifest = Awaited<ReturnType<typeof buildEngineShaderManifest>>;

async function dawnProvenance(backend: string): Promise<DirectLightProvenance> {
  const adapter = navigator.gpu === undefined ? null : await navigator.gpu.requestAdapter();
  const info = (adapter as unknown as { readonly info?: Record<string, unknown> } | null)?.info;
  const adapterInfo = info === undefined
    ? directLightUnavailableByApi('GPUAdapter.info is absent in the Dawn carrier')
    : { value: Object.fromEntries(Object.entries(info).map(([key, value]) => [key, String(value)])), source: 'GPUAdapter.info' };
  const versions = process.versions as unknown as Record<string, string | undefined>;
  return {
    os: { value: process.platform, source: 'node:process.platform' },
    arch: { value: process.arch, source: 'node:process.arch' },
    runtime: { value: process.version, source: 'node:process.version' },
    browser: directLightUnavailableByApi('Dawn is a Node carrier and has no browser identity'),
    backend: { value: backend, source: 'live linear-HDR observation.backendId' },
    adapter: { value: adapter === null ? 'unavailable-by-api' : 'available', source: 'navigator.gpu.requestAdapter()' },
    device: { value: 'available-by-capture', source: 'live Dawn capture created and read back linear HDR bytes' },
    adapterInfo,
    adapterCreation: { value: adapter === null ? 'unavailable-by-api' : 'available', source: 'navigator.gpu.requestAdapter()' },
    deviceCreation: { value: 'available-by-capture', source: 'live Dawn capture' },
    ...(versions.dawn === undefined ? {} : { dawnVersion: { value: versions.dawn, source: 'node:process.versions.dawn' } }),
  };
}

function mutateSpotShaderSource(source: string, falsifier: string): string {
  if (falsifier === 'tile-minus-one' || falsifier === 'wrong-tile') {
    const tile = falsifier === 'tile-minus-one' ? '-1' : '99';
    const decodedTile = source.replaceAll(
      'let tile = bitcast<i32>(light.kind_and_shadow.y);',
      `let tile = ${tile};`,
    );
    if (decodedTile !== source) return decodedTile;
    const rewritten = source.replace(
      /let (col_[A-Za-z0-9_]*) = f32\(\(shadowAtlasTile % 2i\)\);\n\s*let (row_[A-Za-z0-9_]*) = f32\(\(shadowAtlasTile \/ 2i\)\);/g,
      `let $1 = f32((${tile}i % 2i));\n    let $2 = f32((${tile}i / 2i));`,
    );
    if (rewritten !== source) return rewritten;
    return source;
  }
  if (falsifier === 'eval-spot') {
    return source.replace(
      /fn (evalSpotShadowedX_[A-Za-z0-9_]+)\(([^)]*)\) -> vec3<f32> \{[\s\S]*?\n\}\n\n(?=fn )/g,
      'fn $1($2) -> vec3<f32> {\n    return vec3(0f);\n}\n\n',
    );
  }
  return source;
}

function applySpotShaderFalsifier(manifest: DawnEngineManifest, falsifier: string): DawnEngineManifest {
  let changed = 0;
  const rewrite = (source: string): string => {
    const rewritten = mutateSpotShaderSource(source, falsifier);
    if (rewritten !== source) changed += 1;
    return rewritten;
  };
  const result = {
    ...manifest,
    entries: manifest.entries.map((entry) => ({ ...entry, wgsl: rewrite(entry.wgsl) })),
    materialShaders: manifest.materialShaders.map((shader) => ({
      ...shader,
      composedWgsl: rewrite(shader.composedWgsl),
      variants: shader.variants.map((variant) => ({ ...variant, composedWgsl: rewrite(variant.composedWgsl) })),
    })),
  };
  if (changed === 0) throw new Error(`spot-shadow falsifier ${falsifier} did not match the manifest`);
  return result;
}

const manifestPath = process.env.FORGEAX_DAWN_SHADER_MANIFEST;
const sourceManifest = manifestPath === undefined
  ? await buildEngineShaderManifest()
  : await readShaderManifestPublication(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    ) as DawnEngineManifest;
const ENGINE_MANIFEST = process.env.FORGEAX_DAWN_SPOT_SHADOW_FALSIFIER === undefined
  ? sourceManifest
  : applySpotShaderFalsifier(sourceManifest, process.env.FORGEAX_DAWN_SPOT_SHADOW_FALSIFIER);
const ENGINE_MANIFEST_URL = URL.createObjectURL(
  new Blob([JSON.stringify(ENGINE_MANIFEST)], { type: 'application/json' }),
);
afterAll(() => URL.revokeObjectURL(ENGINE_MANIFEST_URL));

interface DawnSurface {
  readonly canvas: HTMLCanvasElement;
  readonly getTexture: () => GPUTexture;
  readonly getFormat: () => string;
  readonly dispose: () => Promise<void>;
}

interface CapturedProducerEvidence {
  readonly evidence: AttachmentEvidence;
  readonly pipelineId: 'forgeax::standard';
  readonly copySrc: boolean;
  readonly lifetime: 'active' | 'retired';
  readonly errorCodes: readonly string[];
}

/**
 * A deliberately high-contrast cookie for the live surface falsifier.  The
 * texture is authored in the same TextureAsset POD shape used by a game
 * project, then resolved through the normal World shared-ref and GPU-resident
 * paths; no test-only shader or bind group is involved.
 */
function projectorTexture(): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    data: Uint8Array.from([0, 0, 0, 255]),
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
}

function createDawnSurface(width: number, height: number): DawnSurface {
  let texture: GPUTexture | undefined;
  let device: GPUDevice | undefined;
  let format = 'rgba8unorm';
  const canvas = {
    width,
    height,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          texture?.destroy();
          device = desc.device;
          format = desc.format ?? 'rgba8unorm';
          texture = desc.device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format,
            usage: 0x10 | 0x01,
            viewFormats: [format === 'rgba8unorm' ? 'rgba8unorm-srgb' : 'bgra8unorm-srgb'],
          });
        },
        unconfigure() {
          texture?.destroy();
          texture = undefined;
        },
        getCurrentTexture(): GPUTexture {
          if (texture === undefined) throw new Error('Dawn surface is not configured');
          return texture;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    getTexture: () => {
      if (texture === undefined) throw new Error('Dawn surface texture is unavailable');
      return texture;
    },
    getFormat: () => format,
    dispose: async () => {
      try {
        await device?.queue.onSubmittedWorkDone();
      } finally {
        texture?.destroy();
        texture = undefined;
        if (device !== undefined) {
          device.destroy();
          expect((await device.lost).reason).toBe('destroyed');
          device = undefined;
        }
      }
    },
  };
}

function spawnHdrpScene(
  world: World,
  assets: AssetRegistry,
  sceneCase: SceneCase,
  spotScene?: SpotShadowScene,
  falsifier?: SpotShadowFalsifierId,
  receiver: SpotShadowReceiverVariant = 'base',
  projectorEnabled = false,
): void {
  const light = sceneCase.light;
  if (light === undefined) throw new Error(`HDRP case ${sceneCase.caseId} is missing light metadata`);
  const plane = createPlaneGeometry(spotScene?.floor.size[0] ?? 2.8, spotScene?.floor.size[1] ?? 2.8);
  if (!plane.ok) throw new Error(`HDRP plane creation failed: ${plane.error.code}`);
  const meshHandle = assets.create(plane.value).unwrap();
  const materialHandle = assets.create(Materials.standard({
    baseColor: [0.55, 0.55, 0.6, 1],
    metallic: 0,
    roughness: 0.9,
    ...(receiver === 'clearcoat' ? { clearcoat: 1, clearcoatRoughness: 0.2 } : {}),
  })).unwrap();
  world.spawn(
    {
      component: Transform,
      data: {
        pos: spotScene?.camera.position ?? [0, 0, 3],
        quat: spotScene?.camera.rotation ?? [0, 0, 0, 1],
      },
    },
    {
      component: Camera,
      data: {
        fov: ((spotScene?.camera.fovDeg ?? 45) * Math.PI) / 180,
        aspect: (spotScene?.scene.width ?? sceneCase.scene.width) / (spotScene?.scene.height ?? sceneCase.scene.height),
        near: 0.1,
        far: 100,
        tonemap: TONEMAP_ACES_FILMIC,
      },
    },
  ).unwrap();
  world.spawn(
    {
      component: Transform,
      data: {
        pos: spotScene?.floor.position ?? [0, 0, 0],
        quat: spotScene?.floor.rotation ?? [0, 0, 0, 1],
      },
    },
    { component: MeshFilter, data: { assetHandle: meshHandle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  ).unwrap();

  if (spotScene !== undefined && falsifier !== 'no-caster') {
    const occluderMaterial = assets.create(Materials.standard({
      baseColor: [0.85, 0.5, 0.25, 1],
      metallic: 0,
      roughness: 0.6,
    })).unwrap();
    const occluderPosition = falsifier === 'reverse-occlusion'
      ? [
        spotScene.occluder.position[0],
        spotScene.floor.position[1] - spotScene.occluder.size[1],
        spotScene.occluder.position[2],
      ] as const
      : spotScene.occluder.position;
    world.spawn(
      { component: Transform, data: { pos: occluderPosition } },
      { component: MeshFilter, data: { assetHandle: assets.create(createPrimitiveMesh('cube').unwrap()).unwrap() } },
      { component: MeshRenderer, data: { materials: [occluderMaterial] } },
    ).unwrap();
  }

  const color = [light.color[0], light.color[1], light.color[2]] as [number, number, number];
  if (light.kind === 'directional') {
    world.spawn({ component: DirectionalLight, data: { direction: light.direction ?? [0, 0, -1], color, intensity: light.intensity, castShadow: false } }).unwrap();
    return;
  }
  if (light.kind === 'point') {
    world.spawn(
      { component: Transform, data: { pos: [0, 0, 2] } },
      { component: PointLight, data: { color, intensity: light.intensity, range: light.range ?? 10 } },
    ).unwrap();
    return;
  }
  const spot = spotScene?.light;
  const projectorHandle = projectorEnabled
    ? assets.create(projectorTexture()).unwrap()
    : undefined;
  world.spawn(
    { component: Transform, data: { pos: spot?.position ?? [0, 0, 2] } },
    { component: SpotLight, data: {
      direction: spot?.direction ?? light.direction ?? [0, 0, -1],
      color: spot?.color ?? color,
      intensity: spot?.intensity ?? light.intensity,
      range: spot?.range ?? light.range ?? 10,
      innerConeDeg: spot?.innerConeDeg ?? light.innerConeDeg ?? 0,
      outerConeDeg: spot?.outerConeDeg ?? light.outerConeDeg ?? 45,
      castShadow: falsifier === 'no-shadow-allocation' ? false : (spot?.castShadow ?? false),
      ...(projectorHandle === undefined ? {} : { projector: projectorHandle }),
    } },
  ).unwrap();

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.2, -1, -0.3], color: [1, 1, 1], intensity: 0.5, castShadow: false },
  }).unwrap();
  const pointLightPositions = [
    [0.7, 0.2, 2],
    [2.3, -3.3, -4],
    [-4, 2, -12],
    [0, 0, -3],
  ] as const;
  const pointLightColors = [
    [1, 1, 1],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const;
  for (let index = 0; index < pointLightPositions.length; index += 1) {
    const position = pointLightPositions[index];
    const color = pointLightColors[index];
    if (position === undefined || color === undefined) continue;
    world.spawn(
      { component: Transform, data: { pos: position } },
      { component: PointLight, data: { color, intensity: 100, range: 50 } },
    ).unwrap();
  }
}

async function readHdrpEvidence(
  legacyHost: RendererLegacyHostAdapter,
  device: import('@forgeax/engine-rhi').RhiDevice,
  surface: DawnSurface,
  sceneCase: SceneCase,
  expectedPipelineId: 'forgeax::standard',
): Promise<CapturedProducerEvidence> {
  const linearResult = await legacyHost.observeCurrentFrame({
    semantic: 'linear-hdr',
    readback: async (lease) => {
      const readback = await readbackRgba16float(device, lease);
      return readback;
    },
  });
  if (!linearResult.ok) throw new Error(`HDRP linear readback failed: ${linearResult.error.code}`);
  if (linearResult.value.metadata.pipelineId !== 'forgeax::standard') {
    throw new Error(`HDRP producer identity mismatch: ${linearResult.value.metadata.pipelineId}`);
  }
  const finalBytes = await readbackTexturePixels(
    device,
    surface.getTexture(),
    sceneCase.scene.width,
    sceneCase.scene.height,
    { bytesPerTexel: 4 },
  );
  const evidence = {
    linearHdr: projectObservation('linearHdr', {
      status: 'ready',
      bytes: linearResult.value.bytes,
      format: linearResult.value.metadata.format,
      size: linearResult.value.metadata.size,
      rawHash: hashBytes(linearResult.value.bytes),
      frameId: linearResult.value.metadata.frameId,
      pipelineId: expectedPipelineId,
      backendId: linearResult.value.metadata.backendId,
    }),
    finalDisplay: projectObservation('finalDisplay', {
      status: 'ready',
      bytes: finalBytes,
      format: surface.getFormat(),
      size: { width: sceneCase.scene.width, height: sceneCase.scene.height },
      rawHash: hashBytes(finalBytes),
      frameId: linearResult.value.metadata.frameId,
      pipelineId: expectedPipelineId,
      backendId: linearResult.value.metadata.backendId,
    }),
  };
  return {
    evidence,
    pipelineId: expectedPipelineId,
    copySrc: (linearResult.value.metadata.usage & 0x01) !== 0,
    lifetime: linearResult.value.metadata.lifetime.state,
  };
}

async function capturePipelineEvidence(
  sceneCase: SceneCase,
  pipelineId: 'forgeax::standard',
  falsifier?: SpotShadowFalsifierId,
  receiver: SpotShadowReceiverVariant = 'base',
  captureFrames = SPOT_SHADOW_CAPTURE_FRAMES,
  projectorEnabled = false,
): Promise<CapturedProducerEvidence> {
  const surface = createDawnSurface(sceneCase.scene.width, sceneCase.scene.height);
  const expectedRenderPath = sceneCase.pipeline?.renderPath ?? 'forward';
  const constructed = await constructRuntimeRendererHost(
    surface.canvas,
    { standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: expectedRenderPath } },
    { shaderManifestUrl: ENGINE_MANIFEST_URL },
  );
  if (!constructed.ok) {
    await surface.dispose();
    throw constructed.error;
  }
  const { renderer, debugDrawHost } = constructed.value;
  const legacyHost = debugDrawHost as unknown as RendererLegacyHostAdapter;
  const errorCodes: string[] = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errorCodes.push(event.error.code);
  });
  let lease: import('@forgeax/engine-render').RenderWorldLease | undefined;
  try {
    if (renderer.inspect().profile.renderPath !== expectedRenderPath) {
      throw new Error(`direct-light ${pipelineId} selected ${renderer.inspect().profile.renderPath} instead of ${expectedRenderPath}`);
    }
    const world = new World({ assets: constructed.value.assets });
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    lease = worldAttachment1.value;
    const spotScene = sceneCase.caseId === 'direct-spot-urp'
      ? SPOT_SHADOW_SCENES.urp
      : sceneCase.caseId === 'direct-spot-hdrp'
        ? SPOT_SHADOW_SCENES.hdrp
        : undefined;
    spawnHdrpScene(world, constructed.value.assets, sceneCase, spotScene, falsifier, receiver, projectorEnabled);
    world.update().unwrap();
    for (let frame = 0; frame < captureFrames; frame += 1) {
      await drawReadyFrame(renderer, {
        leases: [lease],
        camera: { lease },
        environment: { lease },
      });
      if (frame + 1 < captureFrames) world.update().unwrap();
    }
    return {
      ...(await readHdrpEvidence(legacyHost, debugDrawHost.device, surface, sceneCase, pipelineId)),
      errorCodes,
    };
  } finally {
    lease?.dispose();
    try {
      const disposed = await renderer.dispose();
      if (!disposed.ok) throw disposed.error;
    } finally {
      await surface.dispose();
    }
  }
}

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function producerArtifactPath(basePath: string, caseId: string): string {
  return basePath.endsWith('.json')
    ? `${basePath.slice(0, -'.json'.length)}-${caseId}.json`
    : `${basePath}-${caseId}.json`;
}

async function createHdrpArtifact(
  sceneCase: SceneCase,
  capture: CapturedProducerEvidence,
): Promise<Awaited<ReturnType<typeof createPipelineEvidenceArtifact>>> {
  const linearHdr = capture.evidence.linearHdr;
  const finalDisplay = capture.evidence.finalDisplay;
  if (
    linearHdr.bytes === undefined
    || linearHdr.format === undefined
    || linearHdr.size === undefined
    || linearHdr.frameId === undefined
    || linearHdr.backendId === undefined
    || finalDisplay.bytes === undefined
    || finalDisplay.format === undefined
    || finalDisplay.size === undefined
  ) throw new Error(`HDRP producer evidence is incomplete for ${sceneCase.caseId}`);
  return createPipelineEvidenceArtifact({
    invocationId: process.env.FORGEAX_PARITY_INVOCATION_ID ?? 'm4-dawn-artifact-contract',
    sceneCase,
    pipelineId: capture.pipelineId,
    runtimeId: 'dawn',
    backendId: linearHdr.backendId,
    frameId: linearHdr.frameId,
    copySrc: capture.copySrc,
    lifetime: capture.lifetime,
    provenance: {
      implementation: 'forgeax',
      version: 'workspace',
      renderer: 'dawn',
      adapterId: 'forgeax-dawn-hdrp',
    },
    normalization: {
      authorityId: 'threeR184SquaredWindow',
      intensityScale: 1,
      rangeModel: 'squared-finite',
      coneModel: 'radians-to-degrees',
    },
    linearHdr,
    finalDisplay,
  });
}

describe('direct-light Dawn evidence contract', () => {
  it('captures one fixed spot-shadow scene through paired URP and HDRP Dawn producers', async () => {
    if (!dawnReady) throw new Error('dawn-node navigator.gpu is required for spot-shadow paired evidence');
    const scene = SPOT_SHADOW_SCENES.hdrp;
    for (const receiver of ['base', 'clearcoat'] as const) {
      const urpCapture = await capturePipelineEvidence(
        asSceneCase(SPOT_SHADOW_SCENES.urp, 'urp'),
        'forgeax::standard',
        undefined,
        receiver,
      );
      const hdrpCapture = await capturePipelineEvidence(
        asSceneCase(scene, 'hdrp'),
        'forgeax::standard',
        undefined,
        receiver,
      );
      const urpBytes = urpCapture.evidence.linearHdr.bytes;
      const hdrpBytes = hdrpCapture.evidence.linearHdr.bytes;
      if (!(urpBytes instanceof Uint8Array) || !(hdrpBytes instanceof Uint8Array)) {
        throw new Error(`spot-shadow ${receiver} paired linear HDR bytes are unavailable`);
      }
      const urpMetrics = measureSpotShadowDelta(urpBytes, SPOT_SHADOW_SCENES.urp);
      const hdrpMetrics = measureSpotShadowDelta(hdrpBytes, scene);

      expect(urpCapture.pipelineId).toBe('forgeax::standard');
      expect(hdrpCapture.pipelineId).toBe('forgeax::standard');
      expect(urpCapture.evidence.linearHdr.status).toBe('ready');
      expect(hdrpCapture.evidence.linearHdr.status).toBe('ready');
      expect(urpMetrics.delta, `${receiver} URP metrics`).toBeGreaterThan(scene.threshold.shadowDelta);
      expect(hdrpMetrics.delta, JSON.stringify({ receiver, urpMetrics, hdrpMetrics })).toBeGreaterThan(scene.threshold.shadowDelta);
      expect(Math.abs(urpMetrics.delta - hdrpMetrics.delta), `${receiver} cross-pipeline metrics`).toBeLessThanOrEqual(scene.threshold.pipelineEpsilon);
      const record = createDirectLightPairedRecord({
        exactSha: currentDirectLightExactSha(),
        scene,
        receiver,
        legacyProjectedExpected: urpMetrics,
        dawn: {
          ...directLightCarrierIdentity('dawn', hdrpCapture.evidence.linearHdr.backendId ?? 'unavailable-by-api'),
          observed: hdrpMetrics,
          provenance: await dawnProvenance(hdrpCapture.evidence.linearHdr.backendId ?? 'unavailable-by-api'),
        },
      });
      console.log(`DIRECT_LIGHT_PAIRED_RECORD ${JSON.stringify(record)}`);
    }
  }, SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS);

  it('reports HDRP spot-shadow falsifier pixels for an external baseline comparison', async () => {
    if (process.env.FORGEAX_DAWN_SPOT_SHADOW_METRICS !== '1') return;
    const falsifier = process.env.FORGEAX_DAWN_SPOT_SHADOW_FALSIFIER;
    if (falsifier !== undefined && falsifier !== 'tile-minus-one' && falsifier !== 'wrong-tile' && falsifier !== 'eval-spot') {
      throw new Error(`unknown HDRP spot-shadow falsifier ${falsifier}`);
    }
    if (!dawnReady) throw new Error('dawn-node navigator.gpu is required for shader falsifiers');
    const metricPipeline = process.env.FORGEAX_DAWN_SPOT_SHADOW_PIPELINE === 'urp' ? 'urp' : 'hdrp';
    const scene = metricPipeline === 'urp' ? SPOT_SHADOW_SCENES.urp : SPOT_SHADOW_SCENES.hdrp;
    const sceneFalsifier = process.env.FORGEAX_DAWN_SPOT_SHADOW_SCENE_FALSIFIER as SpotShadowFalsifierId | undefined;
    const capture = await capturePipelineEvidence(
      asSceneCase(scene, metricPipeline),
      'forgeax::standard',
      sceneFalsifier,
    );
    const bytes = capture.evidence.linearHdr.bytes;
    if (!(bytes instanceof Uint8Array)) {
      throw new Error(`${falsifier ?? 'baseline'} linear HDR bytes are unavailable`);
    }
    const metrics = measureSpotShadowDelta(bytes, scene);
    const canonical = createDirectLightCanonicalExpected(scene);
    const perturbedExpected = perturbDirectLightCanonicalExpected(canonical, 'base', 0, canonical.epsilonAbs + 0.01);
    const canonicalComparison = compareSpotShadowToCanonicalExpected(perturbedExpected, 'base', metrics);
    expect(canonicalComparison.verdict).toBe('non-pass');
    const record = {
      falsifier: falsifier ?? sceneFalsifier ?? 'baseline',
      bytes: bytes.byteLength,
      metrics,
      roi: scene.roi,
      epsilonAbs: canonical.epsilonAbs,
      canonicalComparison,
      hash: capture.evidence.linearHdr.rawHash,
    };
    console.log(`SPOT_SHADOW_METRICS ${JSON.stringify(record)}`);
    const metricsPath = process.env.FORGEAX_DAWN_SPOT_SHADOW_METRICS_OUT;
    if (metricsPath !== undefined) {
      writeFileSync(metricsPath, JSON.stringify(record));
    }
    expect(capture.pipelineId).toBe('forgeax::standard');
    expect(Number.isFinite(metrics.delta)).toBe(true);
  }, 120_000);

  for (const pipelineCase of [
    { scene: SPOT_SHADOW_SCENES.urp, pipeline: 'urp' as const, pipelineId: 'forgeax::standard' as const },
    { scene: SPOT_SHADOW_SCENES.hdrp, pipeline: 'hdrp' as const, pipelineId: 'forgeax::standard' as const },
  ]) {
    for (const receiver of ['base', 'clearcoat'] as const) {
      it(`keeps no-caster and no-shadow-allocation as real-pixel falsifiers (${pipelineCase.pipeline}/${receiver})`, async () => {
        if (!dawnReady) throw new Error('dawn-node navigator.gpu is required for spot-shadow falsifiers');
        const provenance = await dawnProvenance(pipelineCase.pipelineId);
        const baseline = await capturePipelineEvidence(
          asSceneCase(pipelineCase.scene, pipelineCase.pipeline),
          pipelineCase.pipelineId,
          undefined,
          receiver,
          SPOT_SHADOW_FALSIFIER_CAPTURE_FRAMES,
        );
        const baselineBytes = baseline.evidence.linearHdr.bytes;
        if (!(baselineBytes instanceof Uint8Array)) {
          throw new Error(
            `${pipelineCase.pipelineId}/${receiver}/baseline linear HDR bytes are unavailable`,
          );
        }
        const baselineMetrics = measureSpotShadowDelta(baselineBytes, pipelineCase.scene);
        for (const falsifier of ['no-caster', 'no-shadow-allocation', 'reverse-occlusion'] as const) {
          const capture = await capturePipelineEvidence(
            asSceneCase(pipelineCase.scene, pipelineCase.pipeline),
            pipelineCase.pipelineId,
            falsifier,
            receiver,
            SPOT_SHADOW_FALSIFIER_CAPTURE_FRAMES,
          );
          const bytes = capture.evidence.linearHdr.bytes;
          if (!(bytes instanceof Uint8Array)) throw new Error(`${pipelineCase.pipelineId}/${receiver}/${falsifier} linear HDR bytes are unavailable`);
          const metrics = measureSpotShadowDelta(bytes, pipelineCase.scene);
          const collapsedDelta = baselineMetrics.delta > pipelineCase.scene.threshold.shadowDelta
            ? baselineMetrics.delta - pipelineCase.scene.threshold.shadowDelta
            : pipelineCase.scene.threshold.shadowDelta;
          if (falsifier === 'no-caster' || falsifier === 'reverse-occlusion') {
            expect(metrics.delta, `${pipelineCase.pipelineId}/${receiver}/${falsifier} must collapse the shadow/lit ROI delta`).toBeLessThan(
              collapsedDelta,
            );
          } else {
            expect(metrics.delta, `${pipelineCase.pipelineId}/${receiver}/${falsifier} must not create a shadow delta`).toBeLessThanOrEqual(
              baselineMetrics.delta,
            );
          }
          const comparison = compareSpotShadowRoi(
            baselineMetrics,
            metrics,
            pipelineCase.scene.threshold.shadowDelta,
          );
          expect(comparison.verdict, `${pipelineCase.pipelineId}/${receiver}/${falsifier} ROI falsifier`).toBe('non-pass');
          console.log(`DIRECT_LIGHT_FALSIFIER_RECORD ${JSON.stringify({
            exactSha: currentDirectLightExactSha(),
            scene: { caseId: pipelineCase.scene.caseId, receiver, roi: pipelineCase.scene.roi, colorDomain: 'linearHdr' },
            adapter: directLightCarrierIdentity('dawn', capture.evidence.linearHdr.backendId ?? 'unavailable-by-api'),
            provenance,
            falsifier,
            comparison,
          })}`);
        }
      }, SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS);
    }
  }
  it('changes a fog-disabled surface for the same SpotLight projector in shadowed and projector-only paths', async () => {
    if (!dawnReady) throw new Error('dawn-node navigator.gpu is required for projector surface falsifier');
    const adapter = await navigator.gpu.requestAdapter();
    const sampledTextureLimit = adapter?.limits.maxSampledTexturesPerShaderStage ?? 0;
    // The Standard PBR projector variant adds the 17th sampled texture. Keep
    // the test truthful on WebGPU-minimum adapters: the production capability
    // gate intentionally selects the white-projector variant there, so there
    // is no real projector path to falsify. CI heavy adapters with the raised
    // limit execute the two live on/off captures below.
    if (sampledTextureLimit < 17) {
      console.info(`PROJECTOR_SURFACE_NOT_RUN maxSampledTexturesPerShaderStage=${sampledTextureLimit} required=17`);
      return;
    }
    // Use the forward Standard surface for the pixel falsifier. HDRP's
    // deferred lighting producer intentionally consumes only the G-buffer;
    // the shared clustered SpotLight evaluator (and its projector binding)
    // is exercised by the forward lane while URP/HDRP topology parity is
    // covered by the paired evidence test above.
    const scene = asSceneCase(SPOT_SHADOW_SCENES.urp, 'urp');
    for (const [path, falsifier] of [
      ['shadowed', undefined],
      ['projector-only', 'no-shadow-allocation' as const],
    ] as const) {
      const projectorOff = await capturePipelineEvidence(
        scene,
        'forgeax::standard',
        falsifier,
        'base',
        SPOT_SHADOW_FALSIFIER_CAPTURE_FRAMES,
        false,
      );
      const projectorOn = await capturePipelineEvidence(
        scene,
        'forgeax::standard',
        falsifier,
        'base',
        SPOT_SHADOW_FALSIFIER_CAPTURE_FRAMES,
        true,
      );
      expect(projectorOff.errorCodes, `${path} projector-off renderer errors`).toEqual([]);
      expect(projectorOn.errorCodes, `${path} projector-on renderer errors`).toEqual([]);
      const offBytes = projectorOff.evidence.linearHdr.bytes;
      const onBytes = projectorOn.evidence.linearHdr.bytes;
      if (!(offBytes instanceof Uint8Array) || !(onBytes instanceof Uint8Array)) {
        throw new Error(`${path} projector surface linear HDR bytes are unavailable`);
      }
      const offPixels = decodeLinearHdrRgba16Float(offBytes, scene.scene.width, scene.scene.height);
      const onPixels = decodeLinearHdrRgba16Float(onBytes, scene.scene.width, scene.scene.height);
      let changedPixels = 0;
      let totalRgbDelta = 0;
      let offLuma = 0;
      let onLuma = 0;
      for (let index = 0; index < scene.scene.width * scene.scene.height; index += 1) {
        const offset = index * 4;
        offLuma += (offPixels[offset] ?? 0) + (offPixels[offset + 1] ?? 0) + (offPixels[offset + 2] ?? 0);
        onLuma += (onPixels[offset] ?? 0) + (onPixels[offset + 1] ?? 0) + (onPixels[offset + 2] ?? 0);
        const delta = Math.abs((onPixels[offset] ?? 0) - (offPixels[offset] ?? 0))
          + Math.abs((onPixels[offset + 1] ?? 0) - (offPixels[offset + 1] ?? 0))
          + Math.abs((onPixels[offset + 2] ?? 0) - (offPixels[offset + 2] ?? 0));
        totalRgbDelta += delta;
        if (delta > 1e-3) changedPixels += 1;
      }
      console.log(`PROJECTOR_SURFACE_METRICS ${JSON.stringify({
        path,
        projectorOffHash: projectorOff.evidence.linearHdr.rawHash,
        projectorOnHash: projectorOn.evidence.linearHdr.rawHash,
        changedPixels,
        totalRgbDelta,
        offLuma,
        onLuma,
        projectorOffErrors: projectorOff.errorCodes,
        projectorOnErrors: projectorOn.errorCodes,
      })}`);
      expect(changedPixels, `${path} projector must change real surface pixels`).toBeGreaterThan(0);
      expect(totalRgbDelta, `${path} projector RGB delta`).toBeGreaterThan(1e-2);
    }
  }, SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS);

  it('loads the required light, import, pipeline, and finite budget fields', async () => {
    const cases = await Promise.all(casePaths.map(async (path) => {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      expect(validate(value)).toBe(true);
      const result = await loadSceneCase(path);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.hint);
      return result.value;
    }));
    expect(cases.every((sceneCase) => sceneCase.pipeline?.identity === 'standard')).toBe(true);
    expect(cases.every((sceneCase) => sceneCase.pipeline?.engineId === 'forgeax::standard')).toBe(true);
    expect(cases.every((sceneCase) => sceneCase.pipeline?.renderPath === 'forward')).toBe(true);
    expect(cases.every((sceneCase) => sceneCase.light?.authorityId === 'threeR184SquaredWindow')).toBe(true);
    expect(cases.every((sceneCase) => sceneCase.import?.intensityScale === 1)).toBe(true);
    expect(cases.every((sceneCase) => Number.isFinite(sceneCase.budget.analyticMax))).toBe(true);
  });

  it('does not promote a final-only Dawn readback to paired parity evidence', () => {
    const probe = probeReadback({
      finalReadbackAvailable: true,
      linearReadbackAvailable: false,
      namedAttachmentAvailable: false,
      rawHashAvailable: true,
    });
    expect(probe.source).toBe('unavailable');
    expect(probe.linearReadback).toBe(false);
  });

  it('keeps light metadata and readback status in the case report', async () => {
    const loaded = await loadSceneCase(casePaths[0]!);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.hint);
    const sceneCase = loaded.value;
    const config: CaptureConfig = {
      width: sceneCase.scene.width,
      height: sceneCase.scene.height,
      colorDomain: sceneCase.colorDomain,
      background: sceneCase.scene.background,
      ...(sceneCase.pipeline === undefined ? {} : { pipeline: sceneCase.pipeline.identity }),
      readback: probeReadback({
        finalReadbackAvailable: true,
        linearReadbackAvailable: false,
        namedAttachmentAvailable: false,
        rawHashAvailable: true,
      }),
    };
    const capture = { linear: [], final: [0, 0, 0, 255], config };
    const result = await runParityMatrix(
      [sceneCase],
      createForgeaxAdapter(async () => capture),
      createThreeAdapter(async () => capture),
      { expectedErrors: { [sceneCase.caseId]: 'status-incomplete' } },
    );
    const report = result.cases[0]?.report;
    expect(result.ok).toBe(true);
    expect(report?.pipeline?.engineId).toBe('forgeax::standard');
    expect(report?.light?.kind).toBe('directional');
    expect(report?.import?.intensityScale).toBe(1);
    expect(report?.readback).toEqual({ forgeax: 'unavailable', three: 'unavailable' });
    expect(report?.status).toBe('partial');
  });

  it.skipIf(!dawnReady)('requires a real Dawn adapter before evidence can be recorded', async () => {
    const adapter = await navigator.gpu.requestAdapter();
    expect(adapter).not.toBeNull();
  });

  for (const [index, lightKind] of lightCaseNames.entries()) {
    it(`captures independent HDRP producer evidence (${lightKind})`, async () => {
      if (!dawnReady) throw new Error('dawn-node navigator.gpu is required for HDRP producer evidence');
      const result = await loadSceneCase(hdrpCasePaths[index]!);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.hint);
      const sceneCase = result.value;
      expect(sceneCase.pipeline?.identity).toBe('standard');
      expect(sceneCase.pipeline?.engineId).toBe('forgeax::standard');
      expect(sceneCase.pipeline?.renderPath).toBe('deferred');
      const hdrpCapture = await capturePipelineEvidence(sceneCase, 'forgeax::standard');
      const evidence = hdrpCapture.evidence;
      const evidenceValidation = validateAttachmentEvidence(evidence, 'forgeax::standard');
      expect(evidenceValidation.ok).toBe(true);
      expect(evidence.linearHdr.status).toBe('ready');
      expect(evidence.linearHdr.format).toBe('rgba16float');
      expect(evidence.linearHdr.bytes?.byteLength).toBeGreaterThan(0);
      expect(evidence.linearHdr.rawHash).toMatch(/^[0-9a-f]{8,}$/);
      expect(evidence.linearHdr.pipelineId).toBe('forgeax::standard');
      expect(evidence.finalDisplay.status).toBe('ready');
      expect(evidence.finalDisplay.format).toMatch(/^(rgba|bgra)8unorm$/);
      expect(evidence.finalDisplay.bytes?.byteLength).toBeGreaterThan(0);
      expect(evidence.finalDisplay.rawHash).toMatch(/^[0-9a-f]{8,}$/);
      expect(evidence.finalDisplay.rawHash).not.toBe(evidence.linearHdr.rawHash);
      const linearBytes = evidence.linearHdr.bytes;
      const finalBytes = evidence.finalDisplay.bytes;
      if (!(linearBytes instanceof Uint8Array) || !(finalBytes instanceof Uint8Array)) {
        throw new Error(`HDRP evidence bytes are unavailable for ${sceneCase.caseId}`);
      }
      const forgeaxConfig: CaptureConfig = {
        width: sceneCase.scene.width,
        height: sceneCase.scene.height,
        colorDomain: sceneCase.colorDomain,
        background: sceneCase.scene.background,
        pipeline: 'hdrp',
        readback: {
          source: 'rhi-debug',
          linearReadback: true,
          finalReadback: true,
          namedAttachment: true,
          rawHash: true,
          requiresRhiDebugExtension: false,
        },
      };
      const threeConfig: CaptureConfig = {
        width: sceneCase.scene.width,
        height: sceneCase.scene.height,
        colorDomain: sceneCase.colorDomain,
        background: sceneCase.scene.background,
        pipeline: 'hdrp',
        readback: probeReadback({
          finalReadbackAvailable: true,
          linearReadbackAvailable: false,
          namedAttachmentAvailable: false,
          rawHashAvailable: true,
        }),
      };
      const reportResult = await runParityMatrix(
        [sceneCase],
        createForgeaxAdapter(async () => ({
          linear: Array.from(linearBytes),
          final: Array.from(finalBytes),
          config: forgeaxConfig,
          observations: evidence,
        })),
        createThreeAdapter(async () => ({ linear: [], final: [], config: threeConfig })),
        { expectedErrors: { [sceneCase.caseId]: 'status-incomplete' } },
      );
      expect(reportResult.ok).toBe(true);
      const report = reportResult.cases[0]?.report;
      expect(report?.attachmentEvidence?.linearHdr.pipelineId).toBe('forgeax::standard');
      expect(report?.attachmentEvidence?.finalDisplay.pipelineId).toBe('forgeax::standard');
      expect(report?.status).toBe('partial');
      const sourceCaseResult = await loadSceneCase(casePaths[index]!);
      expect(sourceCaseResult.ok).toBe(true);
      if (!sourceCaseResult.ok) throw new Error(sourceCaseResult.error.hint);
      const artifact = await createHdrpArtifact(sourceCaseResult.value, hdrpCapture);
      expect(artifact.pipelineId).toBe('forgeax::standard');
      expect(artifact.runtimeId).toBe('dawn');
      expect(artifact.source).toBe('live-producer');
      expect(artifact.linearHdr.bytes).toEqual(Array.from(linearBytes));
      const outputPath = process.env.FORGEAX_PARITY_HDRP_ARTIFACT;
      if (outputPath !== undefined) {
        await writePipelineEvidence(
          producerArtifactPath(outputPath, sourceCaseResult.value.caseId),
          artifact,
        );
      }
    }, SPOT_SHADOW_HEAVY_TEST_TIMEOUT_MS);
  }
});
