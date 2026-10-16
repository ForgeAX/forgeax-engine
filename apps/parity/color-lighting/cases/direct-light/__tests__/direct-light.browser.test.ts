import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DIRECT_LIGHT_SLOT_KIND_MASK,
  DIRECT_LIGHT_SLOT_PCF_SHIFT,
  DirectLightSlotKind,
  packDirectLightSlot,
  type SpotLightSnapshot,
} from '../../../../../../packages/render/src/light-buffer-layout';
import directionalCase from '../cases/directional-urp.json' with { type: 'json' };
import pointCase from '../cases/point-urp.json' with { type: 'json' };
import khrSpotCase from '../cases/khr-spot-urp.json' with { type: 'json' };
import { captureThree, createForgeaxCaptureSession } from '../../../src/main';
import type { SceneCase } from '../../../src/contracts/types';
import {
  asSceneCase,
  createDirectLightPairedRecord,
  currentDirectLightExactSha,
  directLightCarrierIdentity,
  directLightUnavailableByApi,
  measureSpotShadowDelta,
  createDirectLightCanonicalExpected,
  compareSpotShadowToCanonicalExpected,
  perturbDirectLightCanonicalExpected,
  SPOT_SHADOW_SCENES,
  type DirectLightProvenance,
  type SpotShadowReceiverVariant,
} from '../spot-shadow-fixture';

const sceneCase = directionalCase as unknown as SceneCase;
// Browser parity uses a bounded warmup; CI shortens only the redundant warmup
// window because the required 60-frame stability budget remains in Dawn.
const SPOT_SHADOW_BROWSER_CAPTURE_FRAMES =
  import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 24 : 60;
const browserSpotSnapshot = {
  kind: 'spot',
  entity: 7,
  position: [-1.2, 1.1, 2.4],
  direction: [0.35, -0.35, -1],
  color: [12, 9.6, 7.2],
  intensity: 12,
  invRangeSquared: 1 / 64,
  cosInner: Math.cos((18 * Math.PI) / 180),
  cosOuter: Math.cos((32 * Math.PI) / 180),
  castShadow: true,
  lightViewProj: undefined,
  mapSize: 1024,
  nearPlane: 0.1,
  farPlane: 8,
  shadowAtlasTile: 3,
} as unknown as SpotLightSnapshot;

async function browserProvenance(backend: string): Promise<DirectLightProvenance> {
  const browserNavigator = navigator as Navigator & {
    readonly userAgentData?: {
      readonly platform?: string;
      readonly brands?: readonly { readonly brand: string; readonly version: string }[];
      getHighEntropyValues?: (hints: readonly string[]) => Promise<{ readonly architecture?: string }>;
    };
  };
  const userAgentData = browserNavigator.userAgentData;
  const highEntropy = userAgentData?.getHighEntropyValues === undefined
    ? undefined
    : await userAgentData.getHighEntropyValues(['architecture']);
  const userAgent = navigator.userAgent;
  const browserMatch = userAgent.match(/(Chrome|Chromium)\/([0-9.]+)/);
  const adapter = navigator.gpu === undefined ? null : await navigator.gpu.requestAdapter();
  const info = (adapter as unknown as { readonly info?: Record<string, unknown> } | null)?.info;
  const adapterInfo = info === undefined
    ? directLightUnavailableByApi('GPUAdapter.info is absent in the browser carrier')
    : { value: Object.fromEntries(Object.entries(info).map(([key, value]) => [key, String(value)])), source: 'GPUAdapter.info' };
  return {
    os: userAgentData?.platform === undefined
      ? directLightUnavailableByApi('Browser User-Agent Client Hints platform is absent')
      : { value: userAgentData.platform, source: 'navigator.userAgentData.platform' },
    arch: highEntropy?.architecture === undefined
      ? directLightUnavailableByApi('Browser User-Agent Client Hints architecture is absent')
      : { value: highEntropy.architecture, source: 'navigator.userAgentData.getHighEntropyValues' },
    runtime: { value: 'chromium-browser', source: 'navigator.userAgent' },
    browser: browserMatch === null
      ? directLightUnavailableByApi('browser name/version is absent from navigator.userAgent')
      : { value: { name: browserMatch[1] ?? 'unavailable-by-api', version: browserMatch[2] ?? 'unavailable-by-api', channel: 'unavailable-by-api' }, source: 'navigator.userAgent; release channel is not exposed' },
    backend: { value: backend, source: 'live linear-HDR observation.backendId' },
    adapter: { value: adapter === null ? 'unavailable-by-api' : 'available', source: 'navigator.gpu.requestAdapter()' },
    device: { value: 'available-by-capture', source: 'live capture session created and read back linear HDR bytes' },
    adapterInfo,
    adapterCreation: { value: adapter === null ? 'unavailable-by-api' : 'available', source: 'navigator.gpu.requestAdapter()' },
    deviceCreation: { value: 'available-by-capture', source: 'live capture session' },
  };
}

describe('direct-light URP browser producer evidence', () => {
  let captureSession: Awaited<ReturnType<typeof createForgeaxCaptureSession>>;

  async function captureBrowser(scene: SceneCase, receiver: SpotShadowReceiverVariant = 'base') {
    return captureSession.capture(scene, undefined, receiver, SPOT_SHADOW_BROWSER_CAPTURE_FRAMES);
  }

  async function assertSpotShadowReceiverParity(receiver: SpotShadowReceiverVariant) {
    const urpScene = SPOT_SHADOW_SCENES.urp;
    const hdrpScene = SPOT_SHADOW_SCENES.hdrp;
    const urpCapture = await captureBrowser(asSceneCase(urpScene, 'urp'), receiver);
    const hdrpCapture = await captureBrowser(asSceneCase(hdrpScene, 'hdrp'), receiver);
    const urpObservation = urpCapture.observations?.linearHdr;
    const hdrpObservation = hdrpCapture.observations?.linearHdr;
    expect(urpObservation?.pipelineId).toBe('forgeax::standard');
    expect(hdrpObservation?.pipelineId).toBe('forgeax::standard');
    if (!(urpObservation?.bytes instanceof Uint8Array) || !(hdrpObservation?.bytes instanceof Uint8Array)) {
      throw new Error(`spot-shadow ${receiver} browser linear HDR bytes are unavailable`);
    }
    const urpMetrics = measureSpotShadowDelta(urpObservation.bytes, urpScene);
    const hdrpMetrics = measureSpotShadowDelta(hdrpObservation.bytes, hdrpScene);
    expect(urpMetrics.delta, `${receiver} URP metrics`).toBeGreaterThan(hdrpScene.threshold.shadowDelta);
    expect(hdrpMetrics.delta, `${receiver} HDRP metrics`).toBeGreaterThan(hdrpScene.threshold.shadowDelta);
    expect(Math.abs(urpMetrics.delta - hdrpMetrics.delta), `${receiver} cross-pipeline metrics`).toBeLessThanOrEqual(
      hdrpScene.threshold.pipelineEpsilon,
    );
    const record = createDirectLightPairedRecord({
      exactSha: currentDirectLightExactSha(),
      scene: hdrpScene,
      receiver,
      legacyProjectedExpected: urpMetrics,
      browser: {
        ...directLightCarrierIdentity('browser', urpObservation.backendId ?? 'unavailable-by-api'),
        observed: hdrpMetrics,
        provenance: await browserProvenance(urpObservation.backendId ?? 'unavailable-by-api'),
      },
    });
    console.log(`DIRECT_LIGHT_PAIRED_RECORD ${JSON.stringify(record)}`);
  }

  beforeAll(async () => {
    document.body.innerHTML = '<canvas id="forgeax"></canvas><canvas id="three"></canvas>';
    captureSession = await createForgeaxCaptureSession(sceneCase);
  });

  afterAll(async () => {
    await captureSession.dispose();
  });

  it('captures linear HDR from the current producer attachment', async () => {
    const capture = await captureBrowser(sceneCase);
    const observation = capture.observations?.linearHdr;

    expect(observation?.status).toBe('ready');
    expect(observation?.format).toBe('rgba16float');
    expect(observation?.bytes?.byteLength).toBeGreaterThan(0);
    expect(observation?.rawHash).toMatch(/^[0-9a-f]{8,}$/);
    expect(observation?.frameId).toBeTypeOf('number');
    expect(observation?.pipelineId).toBe('forgeax::standard');
    expect(observation?.backendId).toBeTypeOf('string');
    expect(capture.config.readback?.linearReadback).toBe(true);
    expect(capture.config.readback?.namedAttachment).toBe(true);
  });

  it('matches Three r184 at the center of deterministic point and spot receivers', async () => {
    for (const input of [pointCase, khrSpotCase] as unknown as readonly SceneCase[]) {
      const forgeax = await captureBrowser(input);
      const three = await captureThree(input);
      const center =
        (Math.floor(input.scene.height / 2) * input.scene.width + Math.floor(input.scene.width / 2)) * 4;
      const forgeaxRgb = forgeax.final.slice(center, center + 3);
      const threeRgb = three.final.slice(center, center + 3);
      const maxDelta = Math.max(
        ...forgeaxRgb.map((value, index) => Math.abs(value - (threeRgb[index] ?? 0)) / 255),
      );
      expect(maxDelta, `${input.caseId}: ForgeaX=${forgeaxRgb.join(',')} Three=${threeRgb.join(',')}`).toBeLessThanOrEqual(
        input.budget.roiMax,
      );
    }
  }, 120_000);

  it('keeps the 96B DirectLightSlot raw channel/kind/tile bits through the browser pack transport', () => {
    const packed = packDirectLightSlot(browserSpotSnapshot);
    const transported = structuredClone(packed);
    const storageBytes = new Uint8Array(packDirectLightSlot(browserSpotSnapshot).buffer);
    const uniformBytes = new Uint8Array(packDirectLightSlot(browserSpotSnapshot).buffer);
    const rawU32 = new Uint32Array(transported.buffer);

    expect(transported).toBeInstanceOf(Float32Array);
    expect(transported.byteLength).toBe(96);
    expect(storageBytes).toEqual(uniformBytes);
    const kindWord = rawU32[16] ?? 0;
    expect(kindWord & DIRECT_LIGHT_SLOT_KIND_MASK).toBe(DirectLightSlotKind.SPOT);
    expect(kindWord >>> DIRECT_LIGHT_SLOT_PCF_SHIFT).toBe(3);
    expect(rawU32[17]).toBe(3);
    expect(rawU32[20]).toBe(0xffffffff);
    expect(transported[12]).toBeCloseTo(0.005, 6);
    expect(transported[13]).toBeCloseTo(0.05, 6);
    expect(transported[14]).toBe(1);
    expect(transported[15]).toBe(0);
  });

  it('uses the same fixed spot-shadow scene authority and exposes the baseline RED', async () => {
    const scene = SPOT_SHADOW_SCENES.urp;
    const capture = await captureBrowser(asSceneCase(scene, 'urp'));
    const observation = capture.observations?.linearHdr;
    expect(observation?.status).toBe('ready');
    if (!(observation?.bytes instanceof Uint8Array)) {
      throw new Error('spot-shadow browser linear HDR bytes are unavailable');
    }
    const metrics = measureSpotShadowDelta(observation.bytes, scene);
    expect(observation.pipelineId).toBe('forgeax::standard');
    expect(metrics.lit).toBeGreaterThan(0);
    expect(metrics.delta).toBeGreaterThan(scene.threshold.shadowDelta);
  }, 120_000);

  it('captures the fixed HDRP spot-shadow scene through the browser producer', async () => {
    const scene = SPOT_SHADOW_SCENES.hdrp;
    const capture = await captureBrowser(asSceneCase(scene, 'hdrp'));
    const observation = capture.observations?.linearHdr;
    expect(observation?.status).toBe('ready');
    if (!(observation?.bytes instanceof Uint8Array)) {
      throw new Error('spot-shadow HDRP browser linear HDR bytes are unavailable');
    }
    const metrics = measureSpotShadowDelta(observation.bytes, scene);
    expect(observation.pipelineId).toBe('forgeax::standard');
    expect(metrics.lit).toBeGreaterThan(0);
    expect(metrics.delta).toBeGreaterThan(scene.threshold.shadowDelta);
  }, 120_000);

  it.each(['base', 'clearcoat'] as const satisfies readonly SpotShadowReceiverVariant[])(
    'compares %s spot-shadow ROIs across live URP and HDRP producers',
    assertSpotShadowReceiverParity,
    120_000,
  );

  it('rejects a perturbed expected spot-shadow ROI oracle', async () => {
    const scene = SPOT_SHADOW_SCENES.urp;
    const capture = await captureBrowser(asSceneCase(scene, 'urp'));
    const observation = capture.observations?.linearHdr;
    expect(observation?.status).toBe('ready');
    if (!(observation?.bytes instanceof Uint8Array)) {
      throw new Error('spot-shadow browser falsifier linear HDR bytes are unavailable');
    }
    const observed = measureSpotShadowDelta(observation.bytes, scene);
    const canonical = createDirectLightCanonicalExpected(scene);
    const perturbedExpected = perturbDirectLightCanonicalExpected(canonical, 'base', 0, canonical.epsilonAbs + 0.01);
    const comparison = compareSpotShadowToCanonicalExpected(perturbedExpected, 'base', observed);
    expect(comparison.verdict).toBe('non-pass');
    console.log(`DIRECT_LIGHT_FALSIFIER_RECORD ${JSON.stringify({
      exactSha: currentDirectLightExactSha(),
      scene: { caseId: scene.caseId, roi: scene.roi, colorDomain: 'linearHdr' },
      oracle: canonical,
      comparison,
    })}`);
  }, 120_000);
});
