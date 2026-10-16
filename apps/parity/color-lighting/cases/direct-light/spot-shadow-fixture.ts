import type { SceneCase } from '../../src/contracts/types';

import { decodeLinearHdrRgba16Float } from '../../src/capture/attachment-readback';
import canonicalOracle from './canonical-direct-light-oracle.json' with { type: 'json' };
export {
  SPOT_SHADOW_SCENES,
  type SpotShadowFalsifier,
  type SpotShadowFalsifierId,
  type SpotShadowReceiverVariant,
  type SpotShadowRoi,
  type SpotShadowScene,
} from '../../src/spot-shadow-scene';
import {
  SPOT_SHADOW_SCENES,
  type SpotShadowFalsifierId,
  type SpotShadowScene,
} from '../../src/spot-shadow-scene';

/**
 * The parity runner still consumes the existing direct-light case identity.
 * Keeping this adapter here makes the camera/ROI/light authority shared by
 * Dawn and Browser while the current runner remains the execution owner.
 */
export function asSceneCase(scene: SpotShadowScene, pipeline: 'urp' | 'hdrp'): SceneCase {
  return {
    caseId: scene.caseId,
    required: true,
    colorDomain: 'linearHdr',
    pipeline: {
      identity: 'standard',
      engineId: 'forgeax::standard',
      renderPath: pipeline === 'urp' ? 'forward' : 'deferred',
    },
    light: {
      authorityId: 'threeR184SquaredWindow',
      kind: 'spot',
      color: scene.light.color,
      intensity: scene.light.intensity,
      range: scene.light.range,
      direction: scene.light.direction,
      innerConeDeg: scene.light.innerConeDeg,
      outerConeDeg: scene.light.outerConeDeg,
    },
    import: {
      source: 'none',
      intensityScale: 1,
      rangeZero: 'no-cutoff',
      cone: 'radians-to-degrees',
    },
    scene: scene.scene,
    budget: { analyticMax: 0.05, roiMax: 0.05, byteMax: 400 * 300 * 8 },
  };
}
export type DirectLightRgb = readonly [number, number, number];

export interface SpotShadowRgbMetrics {
  readonly lit: DirectLightRgb;
  readonly shadow: DirectLightRgb;
  readonly delta: DirectLightRgb;
}

export function meanLinearHdrRgb(
  bytes: Uint8Array,
  width: number,
  roi: SpotShadowRoi,
): DirectLightRgb {
  const pixels = decodeLinearHdrRgba16Float(bytes, width, Math.ceil(bytes.byteLength / (width * 8)));
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = roi.y; y < roi.y + roi.height; y += 1) {
    for (let x = roi.x; x < roi.x + roi.width; x += 1) {
      const offset = (y * width + x) * 4;
      sum[0] += pixels[offset] ?? 0;
      sum[1] += pixels[offset + 1] ?? 0;
      sum[2] += pixels[offset + 2] ?? 0;
      count += 1;
    }
  }
  return count === 0 ? [0, 0, 0] : [sum[0] / count, sum[1] / count, sum[2] / count];
}

export function meanLinearHdrLuminance(
  bytes: Uint8Array,
  width: number,
  roi: SpotShadowRoi,
): number {
  const rgb = meanLinearHdrRgb(bytes, width, roi);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

export function measureSpotShadowDelta(
  bytes: Uint8Array,
  scene: SpotShadowScene,
): SpotShadowMetrics {
  const litRgb = meanLinearHdrRgb(bytes, scene.scene.width, scene.roi.lit);
  const shadowRgb = meanLinearHdrRgb(bytes, scene.scene.width, scene.roi.shadow);
  const lit = litRgb[0] * 0.2126 + litRgb[1] * 0.7152 + litRgb[2] * 0.0722;
  const shadow = shadowRgb[0] * 0.2126 + shadowRgb[1] * 0.7152 + shadowRgb[2] * 0.0722;
  return {
    lit,
    shadow,
    delta: lit - shadow,
    rgb: {
      lit: litRgb,
      shadow: shadowRgb,
      delta: [litRgb[0] - shadowRgb[0], litRgb[1] - shadowRgb[1], litRgb[2] - shadowRgb[2]],
    },
  };
}

export interface SpotShadowMetrics {
  readonly lit: number;
  readonly shadow: number;
  readonly delta: number;
  readonly rgb?: SpotShadowRgbMetrics;
}

export interface DirectLightProvenanceValue {
  readonly value: string | Record<string, string>;
  readonly source: string;
}

export interface DirectLightProvenance {
  readonly os: DirectLightProvenanceValue;
  readonly arch: DirectLightProvenanceValue;
  readonly runtime: DirectLightProvenanceValue;
  readonly browser: DirectLightProvenanceValue;
  readonly backend: DirectLightProvenanceValue;
  readonly adapter: DirectLightProvenanceValue;
  readonly device: DirectLightProvenanceValue;
  readonly adapterInfo: DirectLightProvenanceValue;
  readonly adapterCreation: DirectLightProvenanceValue;
  readonly deviceCreation: DirectLightProvenanceValue;
  readonly dawnVersion?: DirectLightProvenanceValue;
}

export function directLightUnavailableByApi(source: string): DirectLightProvenanceValue {
  return { value: 'unavailable-by-api', source };
}

export interface SpotShadowRoiComparison {
  readonly expected: SpotShadowMetrics;
  readonly observed: SpotShadowMetrics;
  readonly absoluteError: number;
  readonly maxAbsoluteError: number;
  readonly maxChannelAbs: number;
  readonly channelErrors: SpotShadowRgbMetrics;
  readonly epsilon: number;
  readonly ulp: null;
  readonly verdict: 'pass' | 'non-pass';
}

export interface DirectLightCanonicalExpectedOracle {
  readonly schema: 'forgeax.direct-light.canonical-oracle/1';
  readonly authorityId: 'SPOT_SHADOW_SCENES';
  readonly sceneId: 'direct-spot-shadow-v1';
  readonly sceneDigest: string;
  readonly roiDigest: string;
  readonly aggregation: {
    readonly method: 'linear-HDR channel-wise mean over every pixel in each named ROI';
    readonly colorDomain: 'linearHdr';
    readonly rois: SpotShadowScene['roi'];
  };
  readonly expected: {
    readonly base: { readonly rgb: DirectLightRgb; readonly shadowRgb: DirectLightRgb; readonly deltaRgb: DirectLightRgb };
    readonly clearcoat: { readonly rgb: DirectLightRgb; readonly shadowRgb: DirectLightRgb; readonly deltaRgb: DirectLightRgb };
    readonly clearcoatDelta: { readonly rgb: DirectLightRgb };
  };
  readonly epsilonAbs: number;
  readonly pairwiseEpsilonAbs: number;
  readonly provenance: {
    readonly generatorPath: string;
    readonly generatorSha256: string;
    readonly inputDigest: string;
    readonly formula: string;
    readonly frozenSource: string;
    readonly sceneSourceSha256: string;
    readonly materialSourceSha256: string;
    readonly command: string;
    readonly payloadEncoding: string;
    readonly payloadBytesSha256: string;
  };
}

export interface DirectLightCanonicalComparison {
  readonly expected: DirectLightCanonicalExpectedOracle;
  readonly receiver: SpotShadowReceiverVariant;
  readonly observed: SpotShadowMetrics;
  readonly channelErrors: SpotShadowRgbMetrics;
  readonly maxChannelAbs: number;
  readonly epsilonAbs: number;
  readonly ulp: null;
  readonly verdict: 'pass' | 'non-pass';
}

export const DIRECT_LIGHT_CANONICAL_ORACLE = canonicalOracle as DirectLightCanonicalExpectedOracle;

export function compareSpotShadowRoi(
  expected: SpotShadowMetrics,
  observed: SpotShadowMetrics,
  epsilon: number,
): SpotShadowRoiComparison {
  const expectedRgb = expected.rgb ?? scalarRgb(expected);
  const observedRgb = observed.rgb ?? scalarRgb(observed);
  const channelErrors = subtractRgbMetrics(expectedRgb, observedRgb);
  const maxChannelAbs = maxRgb(channelErrors);
  const errors = [
    Math.abs(expected.lit - observed.lit),
    Math.abs(expected.shadow - observed.shadow),
    Math.abs(expected.delta - observed.delta),
  ];
  const maxAbsoluteError = Math.max(...errors);
  return {
    expected,
    observed,
    absoluteError: Math.abs(expected.delta - observed.delta),
    maxAbsoluteError,
    maxChannelAbs,
    channelErrors,
    epsilon,
    ulp: null,
    verdict: Number.isFinite(maxChannelAbs) && maxChannelAbs <= epsilon ? 'pass' : 'non-pass',
  };
}

function scalarRgb(metrics: SpotShadowMetrics): SpotShadowRgbMetrics {
  return { lit: [metrics.lit, metrics.lit, metrics.lit], shadow: [metrics.shadow, metrics.shadow, metrics.shadow], delta: [metrics.delta, metrics.delta, metrics.delta] };
}

function subtractRgb(left: DirectLightRgb, right: DirectLightRgb): DirectLightRgb {
  return [Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2])];
}

function subtractRgbMetrics(left: SpotShadowRgbMetrics, right: SpotShadowRgbMetrics): SpotShadowRgbMetrics {
  return { lit: subtractRgb(left.lit, right.lit), shadow: subtractRgb(left.shadow, right.shadow), delta: subtractRgb(left.delta, right.delta) };
}

function maxRgb(metrics: SpotShadowRgbMetrics): number {
  return Math.max(...metrics.lit, ...metrics.shadow, ...metrics.delta);
}

export interface DirectLightCarrierObservation {
  readonly runtime: 'browser' | 'dawn';
  readonly adapter: string;
  readonly browser: string;
  readonly device: string;
  readonly observed: SpotShadowMetrics;
  readonly provenance: DirectLightProvenance;
}

export interface DirectLightPairedRecord {
  readonly schema: 'forgeax.direct-light.paired/1';
  readonly exactSha: string;
  readonly scene: {
    readonly caseId: SpotShadowScene['caseId'];
    readonly receiver: SpotShadowReceiverVariant;
    readonly roi: SpotShadowScene['roi'];
    readonly threshold: SpotShadowScene['threshold'];
    readonly colorDomain: 'linearHdr';
  };
  readonly sceneDigest: string;
  readonly roiDigest: string;
  readonly oracleDigest: string;
  readonly expectedDigest: string;
  readonly expected: DirectLightCanonicalExpectedOracle;
  readonly browserObserved: SpotShadowMetrics | null;
  readonly dawnObserved: SpotShadowMetrics | null;
  readonly browserCanonical: DirectLightCanonicalComparison | null;
  readonly dawnCanonical: DirectLightCanonicalComparison | null;
  readonly pairwise: SpotShadowRoiComparison | null;
  readonly legacyProjectedExpected: SpotShadowMetrics | null;
  readonly exactShaSource: string;
  readonly browser: DirectLightCarrierObservation | null;
  readonly dawn: DirectLightCarrierObservation | null;
  readonly pairing: 'complete' | 'partial';
  readonly verdict: 'pass' | 'non-pass';
}

export function createDirectLightPairedRecord(input: {
  readonly exactSha: string;
  readonly scene: SpotShadowScene;
  readonly receiver: SpotShadowReceiverVariant;
  readonly legacyProjectedExpected?: SpotShadowMetrics;
  readonly browser?: DirectLightCarrierObservation;
  readonly dawn?: DirectLightCarrierObservation;
}): DirectLightPairedRecord {
  const expected = createDirectLightCanonicalExpected(input.scene);
  const pairwise = input.browser === undefined || input.dawn === undefined
    ? null
    : compareSpotShadowRoi(input.browser.observed, input.dawn.observed, expected.pairwiseEpsilonAbs);
  const browserCanonical = input.browser === undefined ? null : compareSpotShadowToCanonicalExpected(expected, input.receiver, input.browser.observed);
  const dawnCanonical = input.dawn === undefined ? null : compareSpotShadowToCanonicalExpected(expected, input.receiver, input.dawn.observed);
  return {
    schema: 'forgeax.direct-light.paired/1',
    exactSha: input.exactSha,
    scene: {
      caseId: input.scene.caseId,
      receiver: input.receiver,
      roi: input.scene.roi,
      threshold: input.scene.threshold,
      colorDomain: 'linearHdr',
    },
    sceneDigest: expected.sceneDigest,
    roiDigest: expected.roiDigest,
    oracleDigest: directLightExpectedDigest(expected),
    expectedDigest: directLightExpectedDigest(expected),
    expected,
    browserObserved: input.browser?.observed ?? null,
    dawnObserved: input.dawn?.observed ?? null,
    browserCanonical,
    dawnCanonical,
    pairwise,
    legacyProjectedExpected: input.legacyProjectedExpected ?? null,
    exactShaSource: input.exactSha === 'unavailable-by-api' ? 'unavailable-by-api' : currentDirectLightExactShaSource(),
    browser: input.browser ?? null,
    dawn: input.dawn ?? null,
    pairing: pairwise === null ? 'partial' : 'complete',
    verdict: pairwise?.verdict === 'pass'
      && (browserCanonical === null || browserCanonical.verdict === 'pass')
      && (dawnCanonical === null || dawnCanonical.verdict === 'pass')
      ? 'pass'
      : 'non-pass',
  };
}

export function createDirectLightCanonicalExpected(
  scene: SpotShadowScene,
): DirectLightCanonicalExpectedOracle {
  if (JSON.stringify(scene.roi) !== JSON.stringify(DIRECT_LIGHT_CANONICAL_ORACLE.aggregation.rois)) {
    throw new Error('canonical direct-light oracle ROI does not match SPOT_SHADOW_SCENES');
  }
  return DIRECT_LIGHT_CANONICAL_ORACLE;
}

export function perturbDirectLightCanonicalExpected(
  expected: DirectLightCanonicalExpectedOracle,
  receiver: SpotShadowReceiverVariant,
  channel: 0 | 1 | 2,
  amount: number,
): DirectLightCanonicalExpectedOracle {
  const target = receiver === 'base' ? expected.expected.base : expected.expected.clearcoat;
  const rgb = [...target.rgb] as [number, number, number];
  rgb[channel] = (rgb[channel] ?? 0) + amount;
  const nextTarget = { ...target, rgb };
  return {
    ...expected,
    expected: receiver === 'base'
      ? { ...expected.expected, base: nextTarget }
      : { ...expected.expected, clearcoat: nextTarget },
  };
}

export function compareSpotShadowToCanonicalExpected(
  expected: DirectLightCanonicalExpectedOracle,
  receiver: SpotShadowReceiverVariant,
  observed: SpotShadowMetrics,
): DirectLightCanonicalComparison {
  const target = receiver === 'base' ? expected.expected.base : expected.expected.clearcoat;
  const observedRgb = observed.rgb ?? scalarRgb(observed);
  const channelErrors = subtractRgbMetrics(
    { lit: target.rgb, shadow: target.shadowRgb, delta: target.deltaRgb },
    observedRgb,
  );
  const maxChannelAbs = maxRgb(channelErrors);
  return {
    expected,
    receiver,
    observed,
    channelErrors,
    maxChannelAbs,
    epsilonAbs: expected.epsilonAbs,
    ulp: null,
    verdict: Number.isFinite(maxChannelAbs)
      && Number.isFinite(expected.epsilonAbs)
      && expected.epsilonAbs <= 0.05
      && maxChannelAbs <= expected.epsilonAbs
      ? 'pass'
      : 'non-pass',
  };
}

export function currentDirectLightExactSha(): string {
  const env = typeof process === 'undefined' ? undefined : process.env;
  const browserEnv = typeof import.meta === 'undefined'
    ? undefined
    : (import.meta.env as Record<string, string | undefined> | undefined)?.FORGEAX_EXACT_SHA;
  return env?.GITHUB_SHA ?? env?.FORGEAX_EXACT_SHA ?? browserEnv ?? 'unavailable-by-api';
}

export function currentDirectLightExactShaSource(): string {
  const env = typeof process === 'undefined' ? undefined : process.env;
  if (env?.GITHUB_SHA !== undefined) return 'process.env.GITHUB_SHA';
  if (env?.FORGEAX_EXACT_SHA !== undefined) return 'process.env.FORGEAX_EXACT_SHA';
  const browserEnv = typeof import.meta === 'undefined'
    ? undefined
    : (import.meta.env as Record<string, string | undefined> | undefined)?.FORGEAX_EXACT_SHA;
  return browserEnv === undefined
    ? 'unavailable-by-api'
    : 'import.meta.env.FORGEAX_EXACT_SHA (config/vitest-browser-project.ts define from process.env.GITHUB_SHA/FORGEAX_EXACT_SHA)';
}

export function directLightExpectedDigest(input: DirectLightCanonicalExpectedOracle): string {
  const canonical = JSON.stringify({
    schema: input.schema,
    authorityId: input.authorityId,
    sceneId: input.sceneId,
    sceneDigest: input.sceneDigest,
    roiDigest: input.roiDigest,
    aggregation: input.aggregation,
    expected: input.expected,
    epsilonAbs: input.epsilonAbs,
    pairwiseEpsilonAbs: input.pairwiseEpsilonAbs,
    provenance: input.provenance,
  });
  return directLightDigest(canonical);
}

function directLightDigest(value: unknown): string {
  const canonical = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function directLightCarrierIdentity(
  runtime: DirectLightCarrierObservation['runtime'],
  adapter: string,
): Pick<DirectLightCarrierObservation, 'runtime' | 'adapter' | 'browser' | 'device'> {
  return {
    runtime,
    adapter,
    browser: runtime === 'browser' ? 'chromium' : 'not-applicable',
    device: typeof process === 'undefined' ? 'unavailable-by-api' : process.env.FORGEAX_DIRECT_LIGHT_DEVICE ?? 'unavailable-by-api',
  };
}
