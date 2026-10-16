import type { ForgeaxSurfaceEvidence } from './adapters/forgeax-adapter';

export type FallbackSurfaceBackend = 'webkit-webgl2' | 'chromium-webgl2';

export interface FallbackSurfaceCaseInput {
  readonly caseId: string;
  readonly passed: boolean;
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly surfaceEvidence?: ForgeaxSurfaceEvidence;
}

export interface FallbackSurfaceCaseContract {
  readonly caseId: string;
  readonly status: 'pass' | 'failed';
  readonly missing: readonly string[];
  readonly captureIdentity?: string;
  readonly actualBackendKind?: ForgeaxSurfaceEvidence['actualBackendKind'];
  readonly surface?: ForgeaxSurfaceEvidence['surface'];
  readonly presentationProof?: ForgeaxSurfaceEvidence['presentationProof'];
  readonly pixelReadbackEvidence?: ForgeaxSurfaceEvidence['pixelReadbackEvidence'];
}

export interface FallbackSurfaceContract {
  readonly status: 'pass' | 'failed';
  readonly backendId: FallbackSurfaceBackend;
  readonly endpoint: 'surface.storage.raw';
  readonly cases: readonly FallbackSurfaceCaseContract[];
  readonly error?: {
    readonly code: 'surface-raw-endpoint-failed';
    readonly expected: 'raw-storage presentation proof and final-display compositor pixels for every fallback case';
    readonly hint: string;
    readonly detail: {
      readonly lane: FallbackSurfaceBackend;
      readonly stage: 'surface-probe';
      readonly target: 'surface.storage.raw';
      readonly endpoint: 'surface.storage.raw';
      readonly missingCases: readonly string[];
    };
  };
}

const RENDER_ATTACHMENT_USAGE = 16;

/**
 * The wgpu-wasm proof carries Rust Debug enum names while the render surface
 * contract uses WebGPU's lower-case format vocabulary. Keep this conversion
 * explicit at the contract boundary rather than allowing arbitrary casing to
 * satisfy a storage-format check.
 */
function proofFormatMatchesStorage(proofFormat: string, storageFormat: string): boolean {
  const canonical = new Map<string, string>([
    ['Rgba8Unorm', 'rgba8unorm'],
    ['Bgra8Unorm', 'bgra8unorm'],
    ['Rgba16Float', 'rgba16float'],
  ]);
  return (canonical.get(proofFormat) ?? proofFormat) === storageFormat;
}

function validPresentationProof(
  proof: ForgeaxSurfaceEvidence['presentationProof'],
  evidence: ForgeaxSurfaceEvidence,
  expectedWidth: number,
  expectedHeight: number,
): boolean {
  const requested = proof?.requested;
  const validated = proof?.validated;
  const storageFormat = evidence.surface.storageFormat;
  const storageFormatSupported = storageFormat === 'rgba8unorm' || storageFormat === 'bgra8unorm';
  return proof !== undefined
    && proof.descriptor === true
    && proof.acquisition === true
    && proof.validation === true
    && typeof proof.surfaceIdentity === 'string'
    && proof.surfaceIdentity.length > 0
    && requested !== undefined
    && validated !== undefined
    && JSON.stringify(requested) === JSON.stringify(validated)
    && storageFormatSupported
    && evidence.surface.endpoint === 'surface.storage.raw'
    && evidence.surface.displayEncoded === true
    && evidence.surface.capability !== 'unavailable'
    && proofFormatMatchesStorage(requested.format, storageFormat)
    && requested.usage === RENDER_ATTACHMENT_USAGE
    && requested.width === expectedWidth
    && requested.height === expectedHeight
    && proofFormatMatchesStorage(validated.format, storageFormat)
    && validated.usage === RENDER_ATTACHMENT_USAGE
    && validated.width === expectedWidth
    && validated.height === expectedHeight;
}

function expectedCaptureIdentity(
  backendId: FallbackSurfaceBackend,
  caseId: string,
  evidence: ForgeaxSurfaceEvidence,
): string {
  return [
    backendId,
    caseId,
    evidence.presentationProof?.surfaceIdentity ?? 'missing',
    evidence.pixelReadbackEvidence.observationId,
    evidence.pixelReadbackEvidence.frameId,
    evidence.pixelReadbackEvidence.rawHash,
  ].join(':');
}

function expectedPixelMethod(backendId: FallbackSurfaceBackend): ForgeaxSurfaceEvidence['pixelReadbackEvidence']['source']['method'] {
  return backendId === 'webkit-webgl2' ? 'webkit-compositor-rgba8' : 'chromium-compositor-rgba8';
}

function validateCase(
  backendId: FallbackSurfaceBackend,
  input: FallbackSurfaceCaseInput,
): FallbackSurfaceCaseContract {
  const evidence = input.surfaceEvidence;
  const missing: string[] = [];
  if (evidence === undefined) {
    missing.push('surfaceEvidence');
  } else {
    if (evidence.captureIdentity.length === 0) missing.push('captureIdentity');
    if (evidence.actualBackendKind !== 'wgpu-webgl2') missing.push('actualBackendKind');
    if (evidence.surface.endpoint !== 'surface.storage.raw') missing.push('surface.endpoint');
    if (!validPresentationProof(evidence.presentationProof, evidence, input.expectedWidth, input.expectedHeight)) {
      missing.push('presentationProof');
    }
    const pixels = evidence.pixelReadbackEvidence;
    const expectedByteLength = input.expectedWidth * input.expectedHeight * 4;
    if (pixels.status !== 'present') missing.push('pixelReadbackEvidence.status');
    if (pixels.byteLength !== expectedByteLength) missing.push('pixelReadbackEvidence.byteLength');
    if (pixels.rawHash.length === 0) missing.push('pixelReadbackEvidence.rawHash');
    if (pixels.width !== input.expectedWidth || pixels.height !== input.expectedHeight) {
      missing.push('pixelReadbackEvidence.size');
    }
    if (!Number.isInteger(pixels.frameId) || pixels.frameId <= 0 || pixels.observationId.length === 0) {
      missing.push('pixelReadbackEvidence.identity');
    }
    if (
      pixels.source.endpoint !== 'surface.display.final'
      || pixels.source.method !== expectedPixelMethod(backendId)
    ) {
      missing.push('pixelReadbackEvidence.source');
    }
    const expectedIdentity = expectedCaptureIdentity(backendId, input.caseId, evidence);
    if (
      !validPresentationProof(evidence.presentationProof, evidence, input.expectedWidth, input.expectedHeight)
      || evidence.captureIdentity !== expectedIdentity
      || pixels.surfaceIdentity !== expectedIdentity
    ) {
      missing.push('pixelReadbackEvidence.surfaceIdentity');
    }
  }
  if (!input.passed) missing.push('case');
  return {
    caseId: input.caseId,
    status: missing.length === 0 ? 'pass' : 'failed',
    missing,
    ...(evidence === undefined ? {} : {
      actualBackendKind: evidence.actualBackendKind,
      captureIdentity: evidence.captureIdentity,
      surface: evidence.surface,
      ...(evidence.presentationProof === undefined ? {} : { presentationProof: evidence.presentationProof }),
      pixelReadbackEvidence: evidence.pixelReadbackEvidence,
    }),
  };
}

export function buildFallbackSurfaceContract(
  backendId: FallbackSurfaceBackend,
  cases: readonly FallbackSurfaceCaseInput[],
): FallbackSurfaceContract {
  const initialCaseContracts = cases.map((input) => validateCase(backendId, input));
  const duplicateCaptureIdentities = initialCaseContracts
    .map((entry) => entry.captureIdentity)
    .filter((identity): identity is string => identity !== undefined)
    .filter((identity, index, all) => all.indexOf(identity) !== index);
  const caseContracts = initialCaseContracts.map((entry) =>
    entry.captureIdentity !== undefined && duplicateCaptureIdentities.includes(entry.captureIdentity)
      ? { ...entry, status: 'failed' as const, missing: [...entry.missing, 'captureIdentity.unique'] }
      : entry,
  );
  const missingCases = caseContracts.filter((entry) => entry.status !== 'pass' || entry.missing.length > 0).map((entry) => entry.caseId);
  if (caseContracts.length > 0 && missingCases.length === 0) {
    return {
      status: 'pass',
      backendId,
      endpoint: 'surface.storage.raw',
      cases: caseContracts,
    };
  }
  return {
    status: 'failed',
    backendId,
    endpoint: 'surface.storage.raw',
    cases: caseContracts,
    error: {
      code: 'surface-raw-endpoint-failed',
      expected: 'raw-storage presentation proof and final-display compositor pixels for every fallback case',
      hint: 'run the concrete endpoint probe and post-frame compositor readback; keep the last-known-good surface when proof is absent',
      detail: {
        lane: backendId,
        stage: 'surface-probe',
        target: 'surface.storage.raw',
        endpoint: 'surface.storage.raw',
        missingCases,
      },
    },
  };
}
