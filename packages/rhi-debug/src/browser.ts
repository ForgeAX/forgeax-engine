// @forgeax/engine-rhi-debug/browser -- browser-only capture transport.

import { err, ok, type Result } from '@forgeax/engine-types';
import type { RhiDebugError } from './errors';
import { digestBytesAsync } from './protocol/digest-async';
import type {
  CaptureFrameOptions,
  EncodedTape,
  RecorderAttachment,
  TapeArtifact,
} from './recorder/session';

export interface BrowserCaptureProvider {
  captureFrame(options?: CaptureFrameOptions): Promise<Result<EncodedTape, RhiDebugError>>;
}

export interface BrowserCaptureOptions {
  /** Tape route root; chunks go to `<endpoint>/chunks`, the commit to `<endpoint>/commit`. */
  readonly endpoint?: string;
  readonly runId?: string;
  readonly capture?: CaptureFrameOptions;
  readonly signal?: AbortSignal;
  /** Upload window; bounds the extra renderer memory of one upload. Default 16 MiB. */
  readonly chunkBytes?: number;
  /** Attempts per chunk for transport failures and 5xx replies. Default 3. */
  readonly chunkAttempts?: number;
}

export interface BrowserArtifactRef {
  readonly kind: 'rhi-tape';
  readonly digest: string;
  readonly path?: string;
  readonly bytes?: number;
}

export type BrowserUploadStage = 'status' | 'chunk' | 'commit';

export type BrowserCaptureError =
  | {
      readonly code: 'browser-capture-transport-unavailable';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly endpoint: string; readonly stage: BrowserUploadStage };
    }
  | {
      readonly code: 'browser-capture-upload-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly endpoint: string;
        readonly status: number;
        readonly stage: BrowserUploadStage;
        readonly offset?: number;
        readonly serverCode?: string;
      };
    }
  | {
      readonly code: 'browser-capture-response-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly endpoint: string; readonly cause: string };
    };

export function browserCaptureProvider(attachment: RecorderAttachment): BrowserCaptureProvider {
  return attachment;
}

export async function captureAndUpload(
  provider: BrowserCaptureProvider,
  options: BrowserCaptureOptions = {},
): Promise<Result<BrowserArtifactRef, RhiDebugError | BrowserCaptureError>> {
  const captureOptions = mergeCaptureOptions(options.capture, options.signal);
  const captured = await provider.captureFrame(captureOptions);
  if (!captured.ok) return captured;
  return uploadTape(captured.value, options);
}

interface ReceivedChunk {
  readonly offset: number;
  readonly length: number;
  readonly digest: string;
}

/**
 * Resumable chunked upload. Each window carries its SHA-256; windows the
 * server already holds with the same digest are skipped, so a retried or
 * reloaded upload resends only what is missing. The commit returns the
 * server-verified whole-container digest.
 */
export async function uploadTape(
  tape: Pick<TapeArtifact, 'byteLength' | 'chunks'>,
  options: BrowserCaptureOptions = {},
): Promise<Result<BrowserArtifactRef, BrowserCaptureError>> {
  const endpoint = options.endpoint ?? '/__forgeax-debug/tape';
  const runId = options.runId ?? createRunId();
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const attempts = Math.max(1, options.chunkAttempts ?? 3);
  const query = `runId=${encodeURIComponent(runId)}&size=${tape.byteLength}`;
  const signal = options.signal === undefined ? {} : { signal: options.signal };

  const status = await request(endpoint, 'status', undefined, () =>
    fetch(`${endpoint}/chunks?${query}`, { method: 'GET', ...signal }),
  );
  if (!status.ok) return status;
  const statusBody = await readJson(endpoint, status.value);
  if (!statusBody.ok) return statusBody;
  const received = new Map<number, ReceivedChunk>();
  for (const chunk of receivedChunks(statusBody.value)) received.set(chunk.offset, chunk);

  const manifest: ReceivedChunk[] = [];
  // At most UPLOAD_WINDOW chunks are in flight: hashing the next window
  // overlaps the previous PUT while renderer memory stays bounded.
  const inFlight: Promise<Result<Response, BrowserCaptureError> | undefined>[] = [];
  const drain = async (keep: number) => {
    while (inFlight.length > keep) {
      const sent = await inFlight.shift();
      if (sent !== undefined && !sent.ok) return sent;
    }
    return undefined;
  };
  for (const chunk of tape.chunks(chunkBytes)) {
    const digest = await digestBytesAsync(chunk.bytes as Uint8Array<ArrayBuffer>);
    const entry = { offset: chunk.offset, length: chunk.bytes.byteLength, digest };
    manifest.push(entry);
    const held = received.get(chunk.offset);
    if (held?.length === entry.length && held.digest === digest) continue;
    const failed = await drain(UPLOAD_WINDOW - 1);
    if (failed !== undefined) {
      await drain(0);
      return failed;
    }
    // A Blob body streams through the browser's blob store; an ArrayBufferView
    // body is serialized through a far slower in-renderer path (~8x here).
    const body = new Blob([chunk.bytes as Uint8Array<ArrayBuffer>]);
    inFlight.push(
      (async () => {
        let sent: Result<Response, BrowserCaptureError> | undefined;
        for (let attempt = 0; attempt < attempts; attempt++) {
          sent = await request(endpoint, 'chunk', chunk.offset, () =>
            fetch(`${endpoint}/chunks?${query}&offset=${chunk.offset}`, {
              method: 'PUT',
              headers: {
                'content-type': 'application/octet-stream',
                [CHUNK_DIGEST_HEADER]: digest,
              },
              body,
              ...signal,
            }),
          );
          if (sent.ok || !retryable(sent.error) || options.signal?.aborted) break;
        }
        return sent;
      })(),
    );
  }
  const failed = await drain(0);
  if (failed !== undefined) return failed;

  const committed = await request(endpoint, 'commit', undefined, () =>
    fetch(`${endpoint}/commit?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: tape.byteLength, chunks: manifest }),
      ...signal,
    }),
  );
  if (!committed.ok) return committed;
  const value = await readJson(endpoint, committed.value);
  if (!value.ok) return value;
  if (!isArtifactRef(value.value)) {
    return err({
      code: 'browser-capture-response-invalid',
      expected: 'the RHI tape endpoint to return a rhi-tape artifact reference',
      hint: 'check the endpoint contract and capture again',
      detail: { endpoint, cause: 'response is not a rhi-tape artifact reference' },
    });
  }
  return ok(value.value);
}

const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;
const UPLOAD_WINDOW = 2;
const CHUNK_DIGEST_HEADER = 'x-forgeax-chunk-digest';

async function request(
  endpoint: string,
  stage: BrowserUploadStage,
  offset: number | undefined,
  send: () => Promise<Response>,
): Promise<Result<Response, BrowserCaptureError>> {
  let response: Response;
  try {
    response = await send();
  } catch {
    return err({
      code: 'browser-capture-transport-unavailable',
      expected: 'the configured RHI tape endpoint to accept a browser upload',
      hint: 'start the Vite RHI-debug transport or provide a reachable endpoint; a retried upload resumes',
      detail: { endpoint, stage },
    });
  }
  if (response.ok) return ok(response);
  let serverCode: string | undefined;
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body.code === 'string') serverCode = body.code;
  } catch {}
  return err({
    code: 'browser-capture-upload-failed',
    expected: 'the RHI tape endpoint to accept every verified chunk and the commit',
    hint: 'inspect detail.serverCode; uploading the same tape again resumes from the held chunks',
    detail: {
      endpoint,
      status: response.status,
      stage,
      ...(offset === undefined ? {} : { offset }),
      ...(serverCode === undefined ? {} : { serverCode }),
    },
  });
}

function retryable(error: BrowserCaptureError): boolean {
  return (
    error.code === 'browser-capture-transport-unavailable' ||
    (error.code === 'browser-capture-upload-failed' && error.detail.status >= 500)
  );
}

async function readJson(
  endpoint: string,
  response: Response,
): Promise<Result<unknown, BrowserCaptureError>> {
  try {
    return ok(await response.json());
  } catch (cause) {
    return err({
      code: 'browser-capture-response-invalid',
      expected: 'the RHI tape endpoint to return JSON',
      hint: 'check the dev transport response body before retrying',
      detail: { endpoint, cause: String(cause) },
    });
  }
}

function receivedChunks(value: unknown): ReceivedChunk[] {
  const chunks = (value as { chunks?: unknown } | null)?.chunks;
  if (!Array.isArray(chunks)) return [];
  return chunks.filter(
    (chunk): chunk is ReceivedChunk =>
      typeof chunk?.offset === 'number' &&
      typeof chunk.length === 'number' &&
      typeof chunk.digest === 'string',
  );
}

function mergeCaptureOptions(
  capture: CaptureFrameOptions | undefined,
  signal: AbortSignal | undefined,
): CaptureFrameOptions | undefined {
  if (capture === undefined && signal === undefined) return undefined;
  return { ...capture, ...(signal === undefined ? {} : { signal }) };
}

function createRunId(): string {
  const crypto = globalThis.crypto;
  return crypto?.randomUUID === undefined
    ? `rhi-capture-${Date.now().toString(36)}`
    : `rhi-capture-${crypto.randomUUID()}`;
}

function isArtifactRef(value: unknown): value is BrowserArtifactRef {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as {
    readonly kind?: unknown;
    readonly digest?: unknown;
    readonly path?: unknown;
    readonly bytes?: unknown;
  };
  return (
    candidate.kind === 'rhi-tape' &&
    typeof candidate.digest === 'string' &&
    (candidate.path === undefined || typeof candidate.path === 'string') &&
    (candidate.bytes === undefined || typeof candidate.bytes === 'number')
  );
}
