import {
  type AtlasTile,
  type BatchReadRequest,
  type BufferRecordLayout,
  type BufferRecords,
  bindingReadRequest,
  buildFrameModel,
  type DepthProjection,
  type DisplayOptions,
  decodeBufferRecords,
  decodeTape,
  depthImage,
  encodePng,
  extractTile,
  type FrameSummary,
  type FrameTiming,
  type ImageLayout,
  type ImageStats,
  type InspectField,
  imageStats,
  inspectBufferRecords,
  openReplay,
  type ReadbackSubresource,
  type ReplayBackend,
  type ReplayReadbackResult,
  type RhiDebugError,
  readbackImage,
  summarizeFrame,
  tapeDigest,
  toRgba8,
  type V7Tape,
  type WorkInspection,
  type WorkOutput,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import { ok, type Result } from '@forgeax/engine-types';
import type { CommandError, CommandResult } from '../types.js';

export const RHI_TAPE_ARTIFACT_KIND = 'rhi-tape' as const;

export interface ArtifactRef {
  readonly kind: typeof RHI_TAPE_ARTIFACT_KIND;
  readonly digest: string;
  readonly source: string;
  readonly path?: string;
}

export interface CapturedRhiTape extends ArtifactRef {
  readonly bytes: Uint8Array;
}

export interface RhiCaptureFrameValue {
  readonly kind: typeof RHI_TAPE_ARTIFACT_KIND;
  readonly digest: string;
  readonly bytes: Uint8Array;
  readonly source?: string;
  readonly path?: string;
}

export interface RhiCaptureInput {
  readonly signal?: AbortSignal;
}

export interface RhiSummaryInput {
  readonly artifact: ArtifactRef;
}

export interface RhiInspectInput {
  readonly artifact: ArtifactRef;
  readonly workIndex: number;
  readonly fields?: readonly InspectField[];
  readonly buffer?: {
    readonly resourceId: string;
    readonly layout: BufferRecordLayout;
    readonly first: number;
    readonly count: number;
  };
}

/**
 * One read of `rhi.read`: a resource by id, what `workIndex` bound at a
 * binding slot, or a named output that work wrote (`color0`, `depth`,
 * `@group(G)@binding(B)` from `rhi.inspect` outputs). `records` decodes typed
 * struct rows; `image` decodes texels (a buffer names its format and extent),
 * optionally linearizes depth, crops one atlas tile and writes a
 * display-mapped PNG to `image.png`.
 */
export interface RhiReadRequest {
  readonly resourceId?: string;
  readonly binding?: { readonly group: number; readonly binding: number };
  readonly output?: string;
  /** Omit to read the pre-frame (bootstrap) contents. */
  readonly workIndex?: number;
  readonly subresource?: ReadbackSubresource;
  readonly records?: {
    readonly layout: BufferRecordLayout;
    readonly first: number;
    readonly count: number;
  };
  readonly image?: Partial<ImageLayout> &
    DisplayOptions & {
      readonly tile?: AtlasTile;
      readonly png?: string;
      /** Depth texels: grey without fields, view distance with a projection. */
      readonly depth?: true | DepthProjection;
    };
}

export interface RhiReadInput {
  readonly artifact: ArtifactRef;
  readonly reads: readonly RhiReadRequest[];
}

export interface RhiReadValue {
  readonly resourceId: string;
  readonly provenance: ReplayReadbackResult['provenance'];
  readonly byteLength: number;
  readonly digest: string;
  readonly records?: BufferRecords['records'];
  readonly image?: {
    readonly width: number;
    readonly height: number;
    readonly stats: ImageStats;
    readonly png?: string;
  };
}

export interface RhiReadOutput {
  readonly artifact: ArtifactRef;
  /** One result per request, in request order; a failed read never fails the batch. */
  readonly reads: readonly CommandResult<RhiReadValue>[];
}

export const RHI_READ_LIMIT = 64;

export interface RhiTimingOutput {
  readonly artifact: ArtifactRef;
  readonly timing: FrameTiming;
}

export type RhiDebugOperationName =
  | 'rhi.capture'
  | 'rhi.summary'
  | 'rhi.inspect'
  | 'rhi.read'
  | 'rhi.timing';

export type RhiDebugOperationInput =
  | RhiCaptureInput
  | RhiSummaryInput
  | RhiInspectInput
  | RhiReadInput;

export interface RhiSummaryOutput {
  readonly artifact: ArtifactRef;
  readonly summary: FrameSummary;
}

/** One `outputs` entry of `rhi.inspect`: what the work wrote, summarized by digest. */
export interface RhiInspectOutputRead extends Omit<WorkOutput, 'request'> {
  readonly read: CommandResult<RhiReadValue>;
}

export interface RhiInspectOutput {
  readonly artifact: ArtifactRef;
  readonly inspection: Omit<WorkInspection, 'outputs'> & {
    readonly outputs?: readonly RhiInspectOutputRead[];
  };
  readonly bufferRecords?: BufferRecords;
}

export type RhiDebugOperationOutput =
  | ArtifactRef
  | RhiSummaryOutput
  | RhiInspectOutput
  | RhiReadOutput
  | RhiTimingOutput;

/** A replay backend the operation owns; `release` ends the fresh device after replay. */
export interface ReplayBackendLease extends ReplayBackend {
  readonly release: () => void;
}

export interface RhiDebugOperationContext {
  readonly captureFrame: (
    input?: RhiCaptureInput,
  ) => Promise<Result<CapturedRhiTape, RhiDebugError>>;
  readonly readArtifact: (artifact: ArtifactRef) => Promise<CommandResult<Uint8Array>>;
  readonly createReplayBackend?: (tape: V7Tape) => Promise<CommandResult<ReplayBackendLease>>;
  /** Writes `rhi.read` PNG previews; hosts without a filesystem omit it. */
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<CommandResult<string>>;
}

export interface RhiDebugOperationHost {
  readonly captureFrame: (
    input?: RhiCaptureInput,
  ) => Promise<Result<RhiCaptureFrameValue, RhiDebugError>>;
  readonly readArtifact: (artifact: ArtifactRef) => Promise<CommandResult<Uint8Array>>;
  readonly createReplayBackend?: (tape: V7Tape) => Promise<CommandResult<ReplayBackendLease>>;
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<CommandResult<string>>;
}

export function createRhiDebugOperationContext(
  host: RhiDebugOperationHost,
): RhiDebugOperationContext {
  return {
    async captureFrame(input) {
      const captured = await host.captureFrame(input);
      if (!captured.ok) return captured;
      return ok({
        kind: RHI_TAPE_ARTIFACT_KIND,
        digest: captured.value.digest,
        source: captured.value.source ?? 'rhi.capture',
        ...(captured.value.path === undefined ? {} : { path: captured.value.path }),
        bytes: captured.value.bytes,
      });
    },
    readArtifact: host.readArtifact,
    ...(host.createReplayBackend === undefined
      ? {}
      : { createReplayBackend: host.createReplayBackend }),
    ...(host.writeFile === undefined ? {} : { writeFile: host.writeFile }),
  };
}

type JsonSchemaType = 'object' | 'string' | 'integer' | 'number' | 'array' | 'boolean';

export interface JsonSchema {
  readonly type: JsonSchemaType | readonly JsonSchemaType[];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly additionalProperties?: boolean;
}

export interface RhiDebugOperationDescriptor {
  readonly name: RhiDebugOperationName;
  readonly summary: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly recoveryCodes: readonly string[];
}

export interface RhiDebugOperationManifest {
  readonly schemaVersion: '1.0.0';
  readonly artifactRefSchema: JsonSchema;
  readonly operations: readonly RhiDebugOperationDescriptor[];
}

const artifactRefSchema: JsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [RHI_TAPE_ARTIFACT_KIND] },
    digest: { type: 'string' },
    source: { type: 'string' },
    path: { type: 'string' },
  },
  required: ['kind', 'digest', 'source'],
  additionalProperties: false,
};

const summaryOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    artifact: artifactRefSchema,
    summary: { type: 'object', additionalProperties: true },
  },
  required: ['artifact', 'summary'],
  additionalProperties: false,
};

const inspectOutputSchema: JsonSchema = {
  type: 'object',
  properties: {
    artifact: artifactRefSchema,
    inspection: { type: 'object', additionalProperties: true },
    bufferRecords: { type: 'object', additionalProperties: true },
  },
  required: ['artifact', 'inspection'],
  additionalProperties: false,
};

const recordLayoutSchema: JsonSchema = {
  type: 'object',
  properties: {
    stride: { type: 'integer', minimum: 4, maximum: 65536 },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          type: { type: 'string', enum: ['f32', 'u32', 'i32', 'f16'] },
          components: { type: 'integer', minimum: 1, maximum: 4 },
        },
        required: ['name', 'offset', 'type', 'components'],
        additionalProperties: false,
      },
    },
  },
  required: ['stride', 'fields'],
  additionalProperties: false,
};

const recordsSchema: JsonSchema = {
  type: 'object',
  properties: {
    layout: recordLayoutSchema,
    first: { type: 'integer', minimum: 0 },
    count: { type: 'integer', minimum: 1, maximum: 4096 },
  },
  required: ['layout', 'first', 'count'],
  additionalProperties: false,
};

export const RHI_INSPECT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    artifact: artifactRefSchema,
    workIndex: { type: 'integer', minimum: 0 },
    buffer: {
      type: 'object',
      properties: {
        resourceId: { type: 'string' },
        first: { type: 'integer', minimum: 0 },
        count: { type: 'integer', minimum: 1, maximum: 4096 },
        layout: recordLayoutSchema,
      },
      required: ['resourceId', 'layout', 'first', 'count'],
      additionalProperties: false,
    },
    fields: {
      type: 'array',
      items: { type: 'string', enum: ['bindings', 'pipeline', 'pixels', 'outputs'] },
    },
  },
  required: ['artifact', 'workIndex'],
  additionalProperties: false,
} as const;

const readImageSchema: JsonSchema = {
  type: 'object',
  properties: {
    format: { type: 'string' },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
    offset: { type: 'integer', minimum: 0 },
    bytesPerRow: { type: 'integer', minimum: 1 },
    tile: {
      type: 'object',
      properties: {
        tileWidth: { type: 'integer', minimum: 1 },
        tileHeight: { type: 'integer', minimum: 1 },
        index: { type: 'integer', minimum: 0 },
        border: { type: 'integer', minimum: 0 },
        columns: { type: 'integer', minimum: 1 },
      },
      required: ['tileWidth', 'tileHeight', 'index'],
      additionalProperties: false,
    },
    exposure: { type: 'number' },
    range: {
      type: ['array', 'string'],
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: "[min, max] or 'auto' for the finite RGB range",
    },
    depth: {
      type: ['boolean', 'object'],
      properties: {
        near: { type: 'number' },
        far: { type: 'number' },
        reverseZ: { type: 'boolean' },
        orthographic: { type: 'boolean' },
      },
      additionalProperties: false,
      description:
        'true for raw grey depth, or {near,far,reverseZ?,orthographic?} for view distance',
    },
    tonemap: { type: 'string', enum: ['clamp', 'reinhard'] },
    png: { type: 'string' },
  },
  additionalProperties: false,
};

export const RHI_READ_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    artifact: artifactRefSchema,
    reads: {
      type: 'array',
      minItems: 1,
      maxItems: RHI_READ_LIMIT,
      items: {
        type: 'object',
        properties: {
          resourceId: { type: 'string' },
          binding: {
            type: 'object',
            properties: {
              group: { type: 'integer', minimum: 0 },
              binding: { type: 'integer', minimum: 0 },
            },
            required: ['group', 'binding'],
            additionalProperties: false,
          },
          output: { type: 'string' },
          workIndex: { type: 'integer', minimum: 0 },
          subresource: { type: 'object', additionalProperties: true },
          records: recordsSchema,
          image: readImageSchema,
        },
        additionalProperties: false,
      },
    },
  },
  required: ['artifact', 'reads'],
  additionalProperties: false,
} as const;

export const RHI_DEBUG_OPERATION_MANIFEST: RhiDebugOperationManifest = {
  schemaVersion: '1.0.0',
  artifactRefSchema,
  operations: [
    {
      name: 'rhi.capture',
      summary: 'Capture the next frame and return one rhi-tape ArtifactRef.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: artifactRefSchema,
      recoveryCodes: [
        'capture-unavailable',
        'capture-busy',
        'capture-snapshot-failed',
        'capture-timeout',
      ],
    },
    {
      name: 'rhi.summary',
      summary:
        'List work indices, pipeline entry points, and missing initial contents from one tape.',
      inputSchema: {
        type: 'object',
        properties: { artifact: artifactRefSchema },
        required: ['artifact'],
        additionalProperties: false,
      },
      outputSchema: summaryOutputSchema,
      recoveryCodes: ['tape-invalid', 'tape-version-unsupported'],
    },
    {
      name: 'rhi.inspect',
      summary:
        'Replay one ArtifactRef and inspect a workIndex: pipeline, bindings with access, pixels, and every color/depth/storage output it wrote; optionally decode bounded buffer records.',
      inputSchema: RHI_INSPECT_INPUT_SCHEMA,
      outputSchema: inspectOutputSchema,
      recoveryCodes: [
        'tape-invalid',
        'tape-version-unsupported',
        'replay-capability-mismatch',
        'replay-event-failed',
        'replay-position-invalid',
        'readback-failed',
        'readback-unsupported',
      ],
    },
    {
      name: 'rhi.read',
      summary:
        'Replay one ArtifactRef once and read up to 64 resources, bindings or named work outputs at work indices as bytes, typed records, image stats, linearized depth, atlas tiles and PNGs.',
      inputSchema: RHI_READ_INPUT_SCHEMA,
      outputSchema: {
        type: 'object',
        properties: {
          artifact: artifactRefSchema,
          reads: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['artifact', 'reads'],
        additionalProperties: false,
      },
      recoveryCodes: [
        'tape-invalid',
        'tape-version-unsupported',
        'replay-capability-mismatch',
        'replay-event-failed',
        'replay-position-invalid',
        'readback-failed',
        'readback-unsupported',
        'read-request-invalid',
        'artifact-write-failed',
      ],
    },
    {
      name: 'rhi.timing',
      summary:
        'Replay one ArtifactRef once with replay-owned timestamps and report GPU nanoseconds per pass.',
      inputSchema: {
        type: 'object',
        properties: { artifact: artifactRefSchema },
        required: ['artifact'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          artifact: artifactRefSchema,
          timing: { type: 'object', additionalProperties: true },
        },
        required: ['artifact', 'timing'],
        additionalProperties: false,
      },
      recoveryCodes: [
        'tape-invalid',
        'tape-version-unsupported',
        'replay-capability-mismatch',
        'replay-event-failed',
        'readback-failed',
      ],
    },
  ],
};

export function discoverRhiDebugOperations(): readonly RhiDebugOperationDescriptor[] {
  return RHI_DEBUG_OPERATION_MANIFEST.operations;
}

export function renderRhiDebugHelp(): string {
  return [
    'forgeax rhi <capture|summary|inspect|read|timing>',
    ...discoverRhiDebugOperations().map((operation) => `  ${operation.name}: ${operation.summary}`),
    'Usage:',
    '  forgeax rhi summary --artifact PATH --json',
    `  forgeax rhi inspect --artifact PATH --work-index N --fields '["pipeline","bindings","outputs"]' --json`,
    `  forgeax rhi read --artifact PATH --reads '[{"binding":{"group":0,"binding":2},"workIndex":N,"image":{"format":"rgba16float","width":W,"height":H,"tile":{"tileWidth":8,"tileHeight":8,"index":0},"png":"probe.png"}}]' --json`,
    `  forgeax rhi read --artifact PATH --reads '[{"output":"depth","workIndex":N,"image":{"depth":{"near":0.1,"far":100,"reverseZ":true},"range":"auto","png":"shadow.png"}}]' --json`,
    `  forgeax rhi read --artifact PATH --reads '[{"binding":{"group":0,"binding":3},"workIndex":N,"records":{"layout":{"stride":16,"fields":[{"name":"radiance","offset":0,"type":"f32","components":4}]},"first":0,"count":64}}]' --json`,
    '  forgeax rhi timing --artifact PATH --json',
    'Records decode rows [first, first+count) of stride bytes inside the selected buffer window (binding range or subresource {offset,size}); a mappable staging buffer returns readback-unsupported, so read the buffer it was copied from.',
    'Replay uses Dawn; a tape that builds acceleration structures needs FORGEAX_WEBGPU_NODE=wgpu-native from a contributor checkout with @forgeax/engine-rhi-wgpu-native built (otherwise replay-backend-unavailable).',
    'Read requests: one of resourceId, binding or output (binding/output need workIndex); records {layout,first,count}; image {format,width,height,offset,bytesPerRow,tile,depth,exposure,range,tonemap,png}.',
    'Optional --digest verifies the file against an expected sha256 digest.',
    'Inspect fields: pipeline, bindings, pixels, outputs. Use summary.works[].workIndex.',
    'Outputs name what a work wrote: colorN, depth, @group(G)@binding(B) (writable storage); pixels fall back to depth or a storage texture.',
    'ArtifactRef schema:',
    JSON.stringify(RHI_DEBUG_OPERATION_MANIFEST.artifactRefSchema),
  ].join('\n');
}

export function recoverRhiDebugError(error: RhiDebugError): string {
  switch (error.code) {
    case 'capture-unavailable':
    case 'capture-busy':
    case 'capture-snapshot-failed':
    case 'capture-timeout':
      return `${error.hint}: ${error.detail?.cause ?? 'capture failed'}`;
    case 'tape-invalid':
      return `${error.hint}: ${error.detail?.cause ?? 'tape validation failed'}`;
    case 'tape-version-unsupported':
      return `${error.hint}: found ${error.detail?.foundVersion}, expected ${error.detail?.expectedVersion}`;
    case 'replay-capability-mismatch':
      return `${error.hint}: ${error.detail?.cause ?? 'capability mismatch'}`;
    case 'replay-event-failed':
      return `${error.hint}: event ${error.detail?.eventIndex} ${error.detail?.kind} at ${error.detail?.stage}`;
    case 'replay-position-invalid':
      return `${error.hint}: requested ${error.detail?.requested}, available ${error.detail?.available}`;
    case 'readback-failed':
      return `${error.hint}: ${error.detail?.cause ?? 'readback failed'}`;
    case 'readback-unsupported':
      return `${error.hint}: ${error.detail?.reason ?? 'readback is unsupported'}`;
  }
}

function coreError(error: RhiDebugError): CommandError {
  return {
    code: error.code,
    expected: error.expected,
    hint: recoverRhiDebugError(error),
    detail: error.detail === undefined ? {} : Object.fromEntries(Object.entries(error.detail)),
  };
}

function operationError(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

function validateArtifactRef(
  value: unknown,
):
  | { readonly ok: true; readonly value: ArtifactRef }
  | { readonly ok: false; readonly error: CommandError } {
  if (value === null || typeof value !== 'object') {
    return operationError(
      'artifact-ref-invalid',
      'an ArtifactRef object',
      'Pass the ArtifactRef returned by rhi.capture unchanged.',
    );
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== RHI_TAPE_ARTIFACT_KIND) {
    return operationError(
      'artifact-kind-invalid',
      `ArtifactRef.kind to equal ${RHI_TAPE_ARTIFACT_KIND}`,
      'Capture a new RHI tape and pass its ArtifactRef unchanged.',
      { kind: candidate.kind ?? null },
    );
  }
  if (typeof candidate.digest !== 'string' || candidate.digest.length === 0) {
    return operationError(
      'artifact-digest-invalid',
      'ArtifactRef.digest to be a non-empty digest',
      'Use the digest returned with the captured tape.',
    );
  }
  if (typeof candidate.source !== 'string' || candidate.source.length === 0) {
    return operationError(
      'artifact-source-invalid',
      'ArtifactRef.source to identify the producing operation',
      'Use the complete ArtifactRef returned by rhi.capture.',
    );
  }
  return {
    ok: true,
    value: {
      kind: RHI_TAPE_ARTIFACT_KIND,
      digest: candidate.digest,
      source: candidate.source,
      ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
    },
  };
}

async function readTape(
  artifact: ArtifactRef,
  context: RhiDebugOperationContext,
): Promise<CommandResult<Uint8Array>> {
  const validated = validateArtifactRef(artifact);
  if (!validated.ok) return validated;
  const bytes = await context.readArtifact(validated.value);
  if (!bytes.ok) return bytes;
  const actual = tapeDigest(bytes.value);
  if (actual !== validated.value.digest) {
    return operationError(
      'artifact-digest-mismatch',
      'the file bytes to match ArtifactRef.digest',
      'Use the original captured file or open this file by path to obtain its current digest.',
      { expected: validated.value.digest, actual, path: validated.value.path ?? null },
    );
  }
  return bytes;
}

export function runRhiDebugOperation(
  name: 'rhi.capture',
  input: RhiCaptureInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<ArtifactRef>>;
export function runRhiDebugOperation(
  name: 'rhi.summary',
  input: RhiSummaryInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiSummaryOutput>>;
export function runRhiDebugOperation(
  name: 'rhi.inspect',
  input: RhiInspectInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiInspectOutput>>;
export function runRhiDebugOperation(
  name: 'rhi.read',
  input: RhiReadInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiReadOutput>>;
export function runRhiDebugOperation(
  name: 'rhi.timing',
  input: RhiSummaryInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiTimingOutput>>;
export function runRhiDebugOperation(
  name: RhiDebugOperationName,
  input: RhiDebugOperationInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiDebugOperationOutput>>;
export async function runRhiDebugOperation(
  name: RhiDebugOperationName,
  input: RhiDebugOperationInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiDebugOperationOutput>> {
  switch (name) {
    case 'rhi.capture': {
      const capture = await context.captureFrame(input as RhiCaptureInput);
      if (!capture.ok) return { ok: false, error: coreError(capture.error) };
      const artifact = validateArtifactRef(capture.value);
      if (!artifact.ok) return artifact;
      return { ok: true, value: artifact.value };
    }
    case 'rhi.summary': {
      const summaryInput = input as RhiSummaryInput;
      const bytes = await readTape(summaryInput.artifact, context);
      if (!bytes.ok) return bytes;
      const decoded = decodeTape(bytes.value);
      if (!decoded.ok) return { ok: false, error: coreError(decoded.error) };
      const artifact = validateArtifactRef(summaryInput.artifact);
      if (!artifact.ok) return artifact;
      return {
        ok: true,
        value: {
          artifact: artifact.value,
          summary: summarizeFrame(buildFrameModel(decoded.value)),
        },
      };
    }
    case 'rhi.inspect': {
      const inspectInput = input as RhiInspectInput;
      if (!Number.isInteger(inspectInput.workIndex) || inspectInput.workIndex < 0) {
        return operationError(
          'work-index-invalid',
          'workIndex to be a non-negative integer',
          'Choose workIndex from the work inventory returned by rhi.summary.',
          { workIndex: inspectInput.workIndex },
        );
      }
      const opened = await openTapeReplay(inspectInput.artifact, context, name);
      if (!opened.ok) return opened;
      try {
        const inspection = await opened.value.session.inspectWork(
          inspectInput.workIndex,
          inspectInput.fields ?? ['pipeline', 'bindings'],
        );
        if (!inspection.ok) return { ok: false, error: coreError(inspection.error) };
        const artifact = validateArtifactRef(inspectInput.artifact);
        if (!artifact.ok) return artifact;
        const buffer = inspectInput.buffer;
        const records =
          buffer === undefined
            ? undefined
            : await inspectBufferRecords(
                opened.value.session,
                buffer.resourceId,
                inspectInput.workIndex,
                buffer.layout,
                { first: buffer.first, count: buffer.count },
              );
        if (records !== undefined && !records.ok)
          return { ok: false, error: coreError(records.error) };
        const { outputs, ...rest } = inspection.value;
        const projected =
          outputs === undefined
            ? rest
            : {
                ...rest,
                outputs: await Promise.all(
                  outputs.map(
                    async ({ result, ...output }): Promise<RhiInspectOutputRead> => ({
                      ...output,
                      read: result.ok
                        ? await projectRead(result.value, {}, context)
                        : { ok: false, error: coreError(result.error) },
                    }),
                  ),
                ),
              };
        return {
          ok: true,
          value: {
            artifact: artifact.value,
            inspection: projected,
            ...(records?.ok === true ? { bufferRecords: records.value } : {}),
          },
        };
      } finally {
        await opened.value.close();
      }
    }
    case 'rhi.read':
      return runRead(input as RhiReadInput, context);
    case 'rhi.timing': {
      const { artifact: ref } = input as RhiSummaryInput;
      const artifact = validateArtifactRef(ref);
      if (!artifact.ok) return artifact;
      const opened = await openTapeReplay(ref, context, name);
      if (!opened.ok) return opened;
      try {
        const timing = await opened.value.session.timePasses();
        if (!timing.ok) return { ok: false, error: coreError(timing.error) };
        return { ok: true, value: { artifact: artifact.value, timing: timing.value } };
      } finally {
        await opened.value.close();
      }
    }
  }
}

type OpenedReplay = Extract<Awaited<ReturnType<typeof openReplay>>, { ok: true }>['value'];

async function openTapeReplay(
  artifact: ArtifactRef,
  context: RhiDebugOperationContext,
  operation: RhiDebugOperationName,
): Promise<
  CommandResult<{
    readonly tape: V7Tape;
    readonly session: OpenedReplay;
    readonly close: () => Promise<void>;
  }>
> {
  const bytes = await readTape(artifact, context);
  if (!bytes.ok) return bytes;
  const decoded = decodeTape(bytes.value);
  if (!decoded.ok) return { ok: false, error: coreError(decoded.error) };
  if (context.createReplayBackend === undefined) {
    return operationError(
      'replay-backend-unavailable',
      'a fresh ReplayBackend factory',
      `Provide a fresh device and shader factory before running ${operation}.`,
    );
  }
  const backend = await context.createReplayBackend(decoded.value);
  if (!backend.ok) return backend;
  const opened = await openReplay(decoded.value, backend.value);
  if (!opened.ok) {
    backend.value.release();
    return { ok: false, error: coreError(opened.error) };
  }
  const session = opened.value;
  const close = async () => {
    try {
      await session.dispose();
    } finally {
      backend.value.release();
    }
  };
  return { ok: true, value: { tape: decoded.value, session, close } };
}

async function runRead(
  input: RhiReadInput,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiReadOutput>> {
  if (!Array.isArray(input.reads) || input.reads.length < 1 || input.reads.length > RHI_READ_LIMIT)
    return operationError(
      'read-request-invalid',
      `reads to hold 1..${RHI_READ_LIMIT} requests`,
      'Split large read sets into several rhi.read calls.',
      { count: Array.isArray(input.reads) ? input.reads.length : null },
    );
  const artifact = validateArtifactRef(input.artifact);
  if (!artifact.ok) return artifact;
  const opened = await openTapeReplay(input.artifact, context, 'rhi.read');
  if (!opened.ok) return opened;
  const { tape, session, close } = opened.value;
  try {
    const needsBindings = input.reads.some(
      (read) => read.binding !== undefined || read.output !== undefined,
    );
    const works = needsBindings ? buildFrameModel(tape).works : [];
    const reads: CommandResult<RhiReadValue>[] = new Array(input.reads.length);
    const batch: BatchReadRequest[] = [];
    const slots: number[] = [];
    input.reads.forEach((read, slot) => {
      const request = readRequest(read, works);
      if (!request.ok) reads[slot] = request;
      else {
        batch.push(request.value);
        slots.push(slot);
      }
    });
    if (batch.length > 0) {
      const results = await session.readAtWorks(batch);
      if (!results.ok) return { ok: false, error: coreError(results.error) };
      for (const [index, slot] of slots.entries()) {
        const read = results.value[index];
        const request = input.reads[slot] as RhiReadRequest;
        reads[slot] =
          read === undefined || !read.ok
            ? {
                ok: false,
                error: read === undefined ? readInvalid('missing result') : coreError(read.error),
              }
            : await projectRead(read.value, request, context);
      }
    }
    return { ok: true, value: { artifact: artifact.value, reads } };
  } finally {
    await close();
  }
}

function readRequest(
  read: RhiReadRequest,
  works: ReturnType<typeof buildFrameModel>['works'],
): CommandResult<BatchReadRequest> {
  const selectors = [read.resourceId, read.binding, read.output].filter((v) => v !== undefined);
  if (selectors.length !== 1)
    return { ok: false, error: readInvalid('name exactly one of resourceId, binding or output') };
  if (read.output !== undefined) {
    const work = read.workIndex === undefined ? undefined : works[read.workIndex];
    if (work === undefined)
      return {
        ok: false,
        error: readInvalid('an output read needs a workIndex from rhi.summary.works'),
      };
    const outputs = workOutputs(work);
    const output = outputs.find((candidate) => candidate.name === read.output);
    if (output === undefined)
      return {
        ok: false,
        error: readInvalid(
          `work ${work.workIndex} has no output ${read.output}; it wrote ${
            outputs.map((candidate) => candidate.name).join(', ') || 'nothing'
          }`,
        ),
      };
    return recordWindow(read, output.request);
  }
  if (read.binding !== undefined) {
    const work = read.workIndex === undefined ? undefined : works[read.workIndex];
    if (work === undefined)
      return {
        ok: false,
        error: readInvalid('a binding read needs a workIndex from rhi.summary.works'),
      };
    const request = bindingReadRequest(work, read.binding.group, read.binding.binding);
    if (!request.ok) return { ok: false, error: coreError(request.error) };
    return recordWindow(read, request.value);
  }
  return recordWindow(read, {
    resourceId: read.resourceId as string,
    ...(read.workIndex === undefined ? {} : { workIndex: read.workIndex }),
  });
}

/**
 * The byte window a read selects: an explicit `subresource` replaces the bound
 * window, and `records` then narrow it to `stride * [first, first + count)`
 * relative to that window, so a binding read decodes any row range of a large
 * buffer without restating the binding's offset.
 */
function recordWindow(
  read: RhiReadRequest,
  selected: BatchReadRequest,
): CommandResult<BatchReadRequest> {
  const request =
    read.subresource === undefined ? selected : { ...selected, subresource: read.subresource };
  if (read.records === undefined) return { ok: true, value: request };
  const selectedWindow = request.subresource;
  if (selectedWindow !== undefined && !('offset' in selectedWindow))
    return {
      ok: false,
      error: readInvalid('records decode buffer bytes; a texture subresource has no record rows'),
    };
  const window = selectedWindow;
  const base = window?.offset ?? 0;
  const { first, count } = read.records;
  const stride = read.records.layout.stride;
  const offset = base + stride * first;
  const size = stride * count;
  if (window?.size !== undefined && stride * (first + count) > window.size)
    return {
      ok: false,
      error: readInvalid(
        `records ${first}..${first + count - 1} (stride ${stride}) exceed the ${window.size}-byte window at offset ${base}`,
      ),
    };
  return { ok: true, value: { ...request, subresource: { offset, size } } };
}

async function projectRead(
  read: ReplayReadbackResult,
  request: RhiReadRequest,
  context: RhiDebugOperationContext,
): Promise<CommandResult<RhiReadValue>> {
  let records: BufferRecords['records'] | undefined;
  if (request.records !== undefined) {
    const decoded = decodeBufferRecords(read, request.records.layout, request.records);
    if (!decoded.ok) return { ok: false, error: coreError(decoded.error) };
    records = decoded.value.records;
  }
  let image: RhiReadValue['image'];
  if (request.image !== undefined) {
    const { tile, png, exposure, range, tonemap, depth, ...layout } = request.image;
    if (typeof range === 'string' && range !== 'auto')
      return {
        ok: false,
        error: readInvalid(`image.range ${range} is neither [min, max] nor 'auto'`),
      };
    const decoded = readbackImage(read, layout);
    if (!decoded.ok) return { ok: false, error: coreError(decoded.error) };
    const texels =
      depth === undefined
        ? decoded.value
        : depthImage(decoded.value, depth === true ? undefined : depth);
    const cropped = tile === undefined ? ok(texels) : extractTile(texels, tile);
    if (!cropped.ok) return { ok: false, error: coreError(cropped.error) };
    const { width, height } = cropped.value;
    let written: string | undefined;
    if (png !== undefined) {
      if (context.writeFile === undefined)
        return operationError(
          'artifact-write-failed',
          'a host that can write PNG previews',
          'Run rhi.read through the forgeax CLI, or omit image.png.',
        );
      const display: DisplayOptions = {
        ...(exposure === undefined ? {} : { exposure }),
        ...(range === undefined ? {} : { range }),
        ...(tonemap === undefined ? {} : { tonemap }),
      };
      const saved = await context.writeFile(
        png,
        encodePng(width, height, toRgba8(cropped.value, display)),
      );
      if (!saved.ok) return saved;
      written = saved.value;
    }
    image = {
      width,
      height,
      stats: imageStats(cropped.value),
      ...(written === undefined ? {} : { png: written }),
    };
  }
  return {
    ok: true,
    value: {
      resourceId: read.resourceId,
      provenance: read.provenance,
      byteLength: read.bytes.byteLength,
      digest: tapeDigest(read.bytes),
      ...(records === undefined ? {} : { records }),
      ...(image === undefined ? {} : { image }),
    },
  };
}

function readInvalid(cause: string): CommandError {
  return {
    code: 'read-request-invalid',
    expected: 'a read naming a resourceId, or a binding or output together with its workIndex',
    hint: cause,
    detail: {},
  };
}
