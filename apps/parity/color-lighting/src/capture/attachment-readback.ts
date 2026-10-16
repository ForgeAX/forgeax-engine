import type { VertexColorReadbackMethod } from '../contracts/types';

export type ObservationKind = 'linearHdr' | 'finalDisplay';
export type ObservationStatus = 'ready' | 'failed' | 'blocked' | 'needs-context';

const LINEAR_HDR_FORMAT = 'rgba16float';
const DISPLAY_FORMATS = new Set(['rgba8unorm', 'bgra8unorm', 'rgba8unorm-srgb', 'bgra8unorm-srgb']);

export function decodeLinearHdrRgba16Float(
  bytes: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('linear HDR decode requires positive integer dimensions');
  }
  const expectedBytes = width * height * 8;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`linear HDR decode requires ${expectedBytes} bytes, got ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixels = new Float32Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    const bits = view.getUint16(i * 2, true);
    const sign = (bits & 0x8000) === 0 ? 1 : -1;
    const exponent = (bits >>> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    pixels[i] = exponent === 0
      ? sign * 2 ** -14 * (fraction / 1024)
      : exponent === 0x1f
        ? fraction === 0 ? sign * Infinity : NaN
        : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
  }
  return pixels;
}

export interface ObservationCapture {
  readonly kind: ObservationKind;
  readonly status: ObservationStatus;
  readonly bytes?: Uint8Array;
  readonly format?: string;
  readonly size?: { readonly width: number; readonly height: number };
  readonly rawHash?: string;
  readonly frameId?: number;
  readonly pipelineId?: string;
  readonly backendId?: string;
}

export interface AttachmentEvidence {
  readonly linearHdr: ObservationCapture;
  readonly finalDisplay: ObservationCapture;
}

export interface VertexColorReadbackEvidence {
  readonly backend: 'browser-webgpu' | 'dawn';
  readonly frameCount: number;
  readonly colorDomain: 'linearHdr' | 'displayEncoded';
  readonly source: 'live-producer';
  readonly readback: VertexColorReadbackMethod;
  readonly finalBytes: Uint8Array;
  readonly linearBytes: Uint8Array;
  readonly frameId: number;
  readonly rawHash: string;
}

export type VertexColorReadbackResult =
  | { readonly ok: true; readonly value: VertexColorReadbackEvidence }
  | { readonly ok: false; readonly error: ObservationEvidenceError };

function invalidVertex(field: string, reason: string): VertexColorReadbackResult {
  return { ok: false, error: { code: 'observation-evidence-invalid', field, reason } };
}

export function validateVertexColorReadback(input: VertexColorReadbackEvidence): VertexColorReadbackResult {
  if (input.source !== 'live-producer') return invalidVertex('source', 'vertex-color readback must come from a live producer');
  if (input.readback !== 'copyTextureToBuffer' && input.readback !== 'readRenderTargetPixelsAsync') {
    return invalidVertex('readback', 'vertex-color readback must identify its producer-owned operation');
  }
  if (input.frameCount !== 60 || input.frameId !== 59) return invalidVertex('frameCount', 'vertex-color readback does not cover the final 60-frame sample');
  if (input.finalBytes.byteLength === 0 || input.linearBytes.byteLength === 0) return invalidVertex('bytes', 'vertex-color readback bytes are missing');
  if (input.rawHash.length < 8) return invalidVertex('rawHash', 'vertex-color readback hash is missing');
  return { ok: true, value: input };
}

export interface ObservationEvidenceError {
  readonly code: 'observation-evidence-invalid';
  readonly field: string;
  readonly reason: string;
}

export type AttachmentEvidenceResult =
  | { readonly ok: true; readonly value: AttachmentEvidence }
  | { readonly ok: false; readonly error: ObservationEvidenceError };

const ALLOWED_FIELDS = new Set([
  'kind',
  'status',
  'bytes',
  'format',
  'size',
  'rawHash',
  'frameId',
  'pipelineId',
  'backendId',
]);

function invalid(field: string, reason: string): AttachmentEvidenceResult {
  return { ok: false, error: { code: 'observation-evidence-invalid', field, reason } };
}

function validateCapture(
  capture: ObservationCapture,
  expectedKind: ObservationKind,
): AttachmentEvidenceResult {
  if (capture.kind !== expectedKind) return invalid(expectedKind, 'capture source kind is not independent');
  if (Object.keys(capture).some((key) => !ALLOWED_FIELDS.has(key))) {
    return invalid(expectedKind, 'graph keys, RHI textures, and private handles are not evidence');
  }
  if (capture.status !== 'ready') return invalid(expectedKind, `capture status is ${capture.status}`);
  if (!(capture.bytes instanceof Uint8Array) || capture.bytes.byteLength === 0) {
    return invalid(expectedKind, 'ready capture bytes are missing');
  }
  if (typeof capture.format !== 'string' || capture.format.length === 0) {
    return invalid(expectedKind, 'native capture format is missing');
  }
  if (
    capture.size === undefined ||
    !Number.isInteger(capture.size.width) ||
    !Number.isInteger(capture.size.height) ||
    capture.size.width <= 0 ||
    capture.size.height <= 0
  ) {
    return invalid(expectedKind, 'capture size is missing or invalid');
  }
  if (expectedKind === 'linearHdr' && capture.format !== LINEAR_HDR_FORMAT) {
    return invalid(expectedKind, 'linear HDR evidence must retain the linear rgba16float producer format');
  }
  if (expectedKind === 'finalDisplay' && !DISPLAY_FORMATS.has(capture.format)) {
    return invalid(expectedKind, 'final display evidence must use an explicit 8-bit display attachment format');
  }
  if (typeof capture.rawHash !== 'string' || capture.rawHash.length === 0) {
    return invalid(expectedKind, 'raw hash is missing');
  }
  const frameId = capture.frameId;
  if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId < 0) {
    return invalid(expectedKind, 'frame provenance is missing');
  }
  if (typeof capture.pipelineId !== 'string' || capture.pipelineId.length === 0) {
    return invalid(expectedKind, 'pipeline provenance is missing');
  }
  if (typeof capture.backendId !== 'string' || capture.backendId.length === 0) {
    return invalid(expectedKind, 'backend provenance is missing');
  }
  return { ok: true, value: { linearHdr: capture, finalDisplay: capture } };
}

export function validateAttachmentEvidence(
  input: AttachmentEvidence,
  expectedPipelineId?: string,
): AttachmentEvidenceResult {
  const linearResult = validateCapture(input.linearHdr, 'linearHdr');
  if (!linearResult.ok) return linearResult;
  const finalResult = validateCapture(input.finalDisplay, 'finalDisplay');
  if (!finalResult.ok) return finalResult;
  const linear = input.linearHdr;
  const final = input.finalDisplay;
  if (linear.rawHash === final.rawHash) return invalid('rawHash', 'linear and final captures share one hash');
  if (expectedPipelineId !== undefined) {
    if (linear.pipelineId !== expectedPipelineId) return invalid('linearHdr.pipelineId', 'pipeline identity mismatch');
    if (final.pipelineId !== expectedPipelineId) return invalid('finalDisplay.pipelineId', 'pipeline identity mismatch');
  }
  return { ok: true, value: input };
}

export function projectObservation(
  kind: ObservationKind,
  input: {
    readonly status: ObservationStatus;
    readonly bytes?: Uint8Array;
    readonly format?: string;
    readonly size?: { readonly width: number; readonly height: number };
    readonly rawHash?: string;
    readonly frameId?: number;
    readonly pipelineId?: string;
    readonly backendId?: string;
  },
): ObservationCapture {
  return { kind, ...input };
}
