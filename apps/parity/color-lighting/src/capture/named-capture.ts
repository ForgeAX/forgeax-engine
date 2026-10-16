import { parityError, type ColorLightingParityError } from '../errors';
import type {
  NamedCaptures,
  ParityProvenance,
  PipelineIdentity,
  VertexColorBackend,
  VertexColorCaptureOutput,
  VertexColorDomain,
  VertexColorReadbackMethod,
  VertexColorProducerIdentity,
  VertexColorSemanticFixture,
} from '../contracts/types';
import type { AttachmentEvidence } from './attachment-readback';
import type { ReadbackProbe } from './readback-probe';
import type { ForgeaxSurfaceEvidence } from '../adapters/forgeax-adapter';

export interface CaptureConfig {
  readonly width: number;
  readonly height: number;
  readonly colorDomain: 'linearHdr' | 'linearLdr' | 'displayEncoded';
  readonly background: readonly number[];
  readonly pipeline?: PipelineIdentity;
  readonly readback?: ReadbackProbe;
}

export interface CaptureEnvelope {
  readonly side: 'forgeax' | 'three';
  readonly role: 'primary' | 'fallback';
  readonly adapterId: string;
  readonly provenance: ParityProvenance;
  readonly config: CaptureConfig;
  readonly captures: NamedCaptures;
  readonly readback?: ReadbackProbe;
  readonly observations?: AttachmentEvidence;
  readonly surfaceEvidence?: ForgeaxSurfaceEvidence;
}

export interface VertexColorNamedCapture {
  readonly backend: VertexColorBackend;
  readonly frameCount: 60;
  readonly colorDomain: VertexColorDomain;
  readonly sourceSha: string;
  readonly sourceFixtureHash: string;
  readonly producer: VertexColorProducerIdentity;
  readonly captures: NamedCaptures;
  readonly samples: VertexColorCaptureOutput['samples'];
  readonly readback: VertexColorReadbackMethod;
}

export function createVertexColorNamedCapture(
  fixture: VertexColorSemanticFixture,
  producer: VertexColorProducerIdentity,
  output: VertexColorCaptureOutput,
): Promise<VertexColorNamedCapture> {
  if (output.backend !== 'browser-webgpu' && output.backend !== 'dawn') {
    return Promise.reject(new Error('vertex-color capture backend is not a required backend'));
  }
  if (output.frameCount !== 60) return Promise.reject(new Error('vertex-color capture must cover 60 frames'));
  if (output.colorDomain !== fixture.colorDomain) return Promise.reject(new Error('vertex-color capture domain does not match fixture'));
  if (output.sourceFixtureHash.length !== 64) return Promise.reject(new Error('vertex-color fixture hash is missing'));
  if (output.linear.length === 0 || output.final.length === 0) return Promise.reject(new Error('vertex-color capture bytes are missing'));
  const expectedReadback = producer.implementation === 'three'
    ? 'readRenderTargetPixelsAsync'
    : 'copyTextureToBuffer';
  if (output.readback !== expectedReadback) {
    return Promise.reject(new Error(`vertex-color capture readback must be ${expectedReadback}`));
  }
  return createNamedCaptures(output.linear, output.final).then((captures) => ({
    backend: output.backend,
    frameCount: 60,
    colorDomain: output.colorDomain,
    sourceSha: output.sourceSha,
    sourceFixtureHash: output.sourceFixtureHash,
    producer,
    captures,
    samples: output.samples,
    readback: output.readback,
  }));
}

export interface ProvenancePair {
  readonly forgeax: ParityProvenance;
  readonly three: ParityProvenance;
}

export type CaptureValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ColorLightingParityError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateProvenance(input: ProvenancePair): CaptureValidationResult<ProvenancePair> {
  if (
    input.forgeax.implementation === input.three.implementation
    && input.forgeax.version === input.three.version
  ) {
    return {
      ok: false,
      error: parityError('provenance-conflict', {
        code: 'provenance-conflict',
        forgeaxImplementation: input.forgeax.implementation,
        threeImplementation: input.three.implementation,
      }),
    };
  }
  if (input.three.renderer !== 'webgpu') {
    return {
      ok: false,
      error: parityError('primary-capture-missing', {
        code: 'primary-capture-missing',
        missing: ['threeWebGpu'],
      }),
    };
  }
  return { ok: true, value: input };
}

export function validateCaptureEnvelope(input: unknown): CaptureValidationResult<CaptureEnvelope> {
  if (!isRecord(input)) {
    return { ok: false, error: invalidEnvelope('envelope') };
  }
  const capture = input.capture;
  const hash = input.hash;
  const config = input.config;
  const renderer = input.renderer;
  const role = input.role;
  const adapterId = input.adapterId;
  if (!Array.isArray(capture) || capture.length === 0) {
    return { ok: false, error: invalidEnvelope('capture') };
  }
  if (typeof hash !== 'string' || hash.length === 0) {
    return { ok: false, error: invalidEnvelope('hash') };
  }
  if (!isRecord(config)) {
    return { ok: false, error: invalidEnvelope('config') };
  }
  if (role === 'primary' && renderer === 'webgl') {
    return {
      ok: false,
      error: parityError('primary-capture-missing', {
        code: 'primary-capture-missing',
        missing: ['threeWebGpu'],
      }),
    };
  }
  if (adapterId === 'same') {
    return {
      ok: false,
      error: parityError('provenance-conflict', {
        code: 'provenance-conflict',
        forgeaxImplementation: 'shared-adapter',
        threeImplementation: 'shared-adapter',
      }),
    };
  }
  return { ok: true, value: input as unknown as CaptureEnvelope };
}

function invalidEnvelope(field: string): ColorLightingParityError {
  return parityError('capture-envelope-invalid', { code: 'capture-envelope-invalid', field, role: 'primary' });
}

export async function hashCapture(linear: readonly number[], final: readonly number[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ linear, final }));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export async function createNamedCaptures(
  linear: readonly number[],
  final: readonly number[],
): Promise<NamedCaptures> {
  return { linear, final, hash: await hashCapture(linear, final) };
}
