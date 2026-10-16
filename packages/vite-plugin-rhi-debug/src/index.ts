// @forgeax/engine-vite-plugin-rhi-debug -- serve-only tape transport.
//
// The plugin is a leaf: it accepts one encoded v7 tape (a single raw body or
// resumable digest-checked chunks), validates it from disk with the core index
// decoder, persists one `.rhitape` file, and exposes no replay or report owner.

import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { verifyTapeFile } from './tape-file';

export const RAW_TAPE_ROUTE = '/__forgeax-debug/tape' as const;
/** GET: held chunks for `runId`+`size`; PUT: one chunk at `offset` with its digest header. */
export const TAPE_CHUNKS_ROUTE = '/__forgeax-debug/tape/chunks' as const;
/** POST `{ size, chunks }`: verify coverage, validate the container, publish atomically. */
export const TAPE_COMMIT_ROUTE = '/__forgeax-debug/tape/commit' as const;
export const RHITAPE_MIME = 'application/x-forgeax-rhitape' as const;
export const CHUNK_DIGEST_HEADER = 'x-forgeax-chunk-digest' as const;
/** Largest accepted chunk body; bounds dev-server memory per request. */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

const DEFINE_KEY = 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG';
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CaptureProvider {
  readonly id: string;
}

export type CaptureProviderError =
  | { readonly code: 'capture-target-unavailable'; readonly providerIds: readonly string[] }
  | { readonly code: 'capture-target-ambiguous'; readonly providerIds: readonly string[] };

export type ViteProviderError =
  | CaptureProviderError
  | {
      readonly code:
        | 'capture-run-id-invalid'
        | 'capture-mime-invalid'
        | 'capture-tape-invalid'
        | 'capture-upload-incomplete'
        | 'capture-chunk-invalid'
        | 'capture-artifact-write-failed';
      readonly hint: string;
    };

export interface RawTapeUpload {
  readonly runId: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface RawTapeArtifactRef {
  readonly kind: 'rhi-tape';
  readonly digest: string;
  readonly path: string;
  readonly bytes: number;
}

export interface TapeChunk {
  readonly offset: number;
  readonly length: number;
  readonly digest: string;
}

export interface TapeChunkUpload {
  readonly runId: string;
  readonly size: number;
  readonly offset: number;
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export interface TapeCommit {
  readonly runId: string;
  readonly size: number;
  readonly chunks: readonly TapeChunk[];
}

export interface RawTapeProviderOptions {
  readonly rootDir: string;
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
}

export interface RawTapeProvider {
  accept(upload: RawTapeUpload): Promise<ProviderResult<RawTapeArtifactRef, ViteProviderError>>;
  /** Chunks already held for this run and size; a different size restarts the run. */
  status(
    runId: string,
    size: number,
  ): Promise<
    ProviderResult<
      { readonly size: number; readonly chunks: readonly TapeChunk[] },
      ViteProviderError
    >
  >;
  putChunk(upload: TapeChunkUpload): Promise<ProviderResult<TapeChunk, ViteProviderError>>;
  commit(commit: TapeCommit): Promise<ProviderResult<RawTapeArtifactRef, ViteProviderError>>;
}

type ProviderResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function selectCaptureProvider(
  providers: readonly CaptureProvider[],
): ProviderResult<CaptureProvider, CaptureProviderError> {
  const providerIds = providers.map((provider) => provider.id);
  if (providers.length === 0) {
    return { ok: false, error: { code: 'capture-target-unavailable', providerIds } };
  }
  if (providers.length > 1) {
    return { ok: false, error: { code: 'capture-target-ambiguous', providerIds } };
  }
  const provider = providers[0];
  if (provider === undefined) {
    return { ok: false, error: { code: 'capture-target-unavailable', providerIds } };
  }
  return { ok: true, value: provider };
}

function failure(
  code: Exclude<ViteProviderError['code'], CaptureProviderError['code']>,
  hint: string,
) {
  return { ok: false as const, error: { code, hint } };
}

const RUN_ID_HINT = 'runId must contain only ASCII letters, numbers, underscore, or hyphen';

export function createRawTapeProvider(options: RawTapeProviderOptions): RawTapeProvider {
  const rootDir = resolve(options.rootDir);
  const debugDir = join(rootDir, '.forgeax-debug');
  const uploadsDir = join(debugDir, '.uploads');
  const write =
    options.writeFile ??
    (async (path: string, bytes: Uint8Array) => {
      await writeFile(path, bytes);
    });
  // One mutation at a time per run: chunk writes, manifest saves and commit
  // never interleave even if a client sends windows concurrently.
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(runId: string, task: () => Promise<T>): Promise<T> => {
    const run = (queues.get(runId) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => undefined);
    queues.set(runId, settled);
    void settled.then(() => {
      if (queues.get(runId) === settled) queues.delete(runId);
    });
    return run;
  };
  const uploadDir = (runId: string) => join(uploadsDir, runId);
  const manifestPath = (runId: string) => join(uploadDir(runId), 'chunks.json');
  const partPath = (runId: string) => join(uploadDir(runId), 'frame.rhitape.part');

  async function readManifest(runId: string, size: number): Promise<Map<number, TapeChunk>> {
    try {
      const saved = JSON.parse(await readFile(manifestPath(runId), 'utf8')) as {
        size?: unknown;
        chunks?: TapeChunk[];
      };
      if (saved.size === size && Array.isArray(saved.chunks))
        return new Map(saved.chunks.map((chunk) => [chunk.offset, chunk]));
    } catch {}
    await rm(uploadDir(runId), { recursive: true, force: true });
    return new Map();
  }

  async function saveManifest(runId: string, size: number, chunks: Map<number, TapeChunk>) {
    const sorted = [...chunks.values()].sort((a, b) => a.offset - b.offset);
    const temp = `${manifestPath(runId)}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify({ size, chunks: sorted }));
    await rename(temp, manifestPath(runId));
  }

  async function publish(
    runId: string,
    sourcePath: string,
    cleanup: string,
  ): Promise<ProviderResult<RawTapeArtifactRef, ViteProviderError>> {
    let verified: Awaited<ReturnType<typeof verifyTapeFile>>;
    try {
      verified = await verifyTapeFile(sourcePath);
    } catch {
      await rm(cleanup, { recursive: true, force: true });
      return failure(
        'capture-artifact-write-failed',
        'the staged tape could not be read back; inspect the dev-server filesystem and retry',
      );
    }
    if (!verified.ok) {
      await rm(cleanup, { recursive: true, force: true });
      return failure('capture-tape-invalid', verified.hint);
    }
    const outDir = join(debugDir, runId);
    const finalPath = join(outDir, 'frame.rhitape');
    const outDirExisted = await pathExists(outDir);
    try {
      await mkdir(outDir, { recursive: true });
      await rename(sourcePath, finalPath);
    } catch {
      if (!outDirExisted) await rm(outDir, { recursive: true, force: true });
      await rm(cleanup, { recursive: true, force: true });
      return failure(
        'capture-artifact-write-failed',
        'the tape could not be published atomically; inspect the dev-server filesystem and retry',
      );
    }
    await rm(cleanup, { recursive: true, force: true });
    if ((await readdirSafe(uploadsDir)).length === 0)
      await rm(uploadsDir, { recursive: true, force: true });
    return {
      ok: true,
      value: { kind: 'rhi-tape', digest: verified.digest, path: finalPath, bytes: verified.bytes },
    };
  }

  return {
    async accept(upload) {
      if (!RUN_ID_PATTERN.test(upload.runId)) return failure('capture-run-id-invalid', RUN_ID_HINT);
      if (upload.contentType !== RHITAPE_MIME)
        return failure('capture-mime-invalid', `content-type must be exactly ${RHITAPE_MIME}`);
      const tempDir = join(debugDir, `.rhitape-${upload.runId}-${randomUUID()}`);
      const debugDirExisted = await pathExists(debugDir);
      try {
        await mkdir(tempDir, { recursive: true });
        await write(join(tempDir, 'frame.rhitape'), upload.bytes);
      } catch {
        await rm(tempDir, { recursive: true, force: true });
        if (!debugDirExisted) await rm(debugDir, { recursive: true, force: true });
        return failure(
          'capture-artifact-write-failed',
          'the raw tape could not be written atomically; inspect the dev-server filesystem and retry',
        );
      }
      const published = await publish(upload.runId, join(tempDir, 'frame.rhitape'), tempDir);
      if (!published.ok && !debugDirExisted) {
        const leftovers = await readdirSafe(debugDir);
        if (leftovers.length === 0) await rm(debugDir, { recursive: true, force: true });
      }
      return published;
    },

    async status(runId, size) {
      if (!RUN_ID_PATTERN.test(runId)) return failure('capture-run-id-invalid', RUN_ID_HINT);
      if (!Number.isSafeInteger(size) || size <= 0)
        return failure('capture-chunk-invalid', 'size must be the positive container byte length');
      return serial(runId, async () => {
        const chunks = await readManifest(runId, size);
        return { ok: true as const, value: { size, chunks: [...chunks.values()] } };
      });
    },

    async putChunk(upload) {
      if (!RUN_ID_PATTERN.test(upload.runId)) return failure('capture-run-id-invalid', RUN_ID_HINT);
      const { size, offset, bytes } = upload;
      if (
        !Number.isSafeInteger(size) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_CHUNK_BYTES ||
        offset + bytes.byteLength > size
      )
        return failure(
          'capture-chunk-invalid',
          `chunk must be 1..${MAX_CHUNK_BYTES} bytes inside the declared container size`,
        );
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (digest !== upload.digest)
        return failure(
          'capture-chunk-invalid',
          `chunk at ${offset} does not match its ${CHUNK_DIGEST_HEADER}; resend it`,
        );
      return serial(upload.runId, async () => {
        const chunks = await readManifest(upload.runId, size);
        try {
          await mkdir(uploadDir(upload.runId), { recursive: true });
          const file = await open(partPath(upload.runId), chunks.size === 0 ? 'w' : 'r+');
          try {
            await file.write(bytes, 0, bytes.byteLength, offset);
          } finally {
            await file.close();
          }
          const chunk = { offset, length: bytes.byteLength, digest };
          chunks.set(offset, chunk);
          await saveManifest(upload.runId, size, chunks);
          return { ok: true as const, value: chunk };
        } catch {
          return failure(
            'capture-artifact-write-failed',
            'the chunk could not be staged; inspect the dev-server filesystem and retry',
          );
        }
      });
    },

    async commit(commit) {
      if (!RUN_ID_PATTERN.test(commit.runId)) return failure('capture-run-id-invalid', RUN_ID_HINT);
      return serial(commit.runId, async () => {
        const held = await readManifest(commit.runId, commit.size);
        let covered = 0;
        for (const chunk of [...commit.chunks].sort((a, b) => a.offset - b.offset)) {
          const stored = held.get(chunk.offset);
          if (
            chunk.offset !== covered ||
            stored?.length !== chunk.length ||
            stored.digest !== chunk.digest
          )
            return failure(
              'capture-upload-incomplete',
              `chunk at ${covered} is missing or differs from the client manifest; resume the upload`,
            );
          covered += chunk.length;
        }
        if (covered !== commit.size)
          return failure(
            'capture-upload-incomplete',
            `chunks cover ${covered} of ${commit.size} bytes; resume the upload`,
          );
        return publish(commit.runId, partPath(commit.runId), uploadDir(commit.runId));
      });
    },
  };
}

async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export interface RhiDebugPluginOptions {
  readonly rootDir?: string;
}

interface MiddlewareRequest extends AsyncIterable<Uint8Array> {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

interface MiddlewareResponse {
  readonly destroyed?: boolean;
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string | Uint8Array): void;
}

function sendJson(res: MiddlewareResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readRawBody(
  req: AsyncIterable<Uint8Array>,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    chunks.push(bytes);
    size += bytes.byteLength;
    if (size > limit) throw new Error('body exceeds limit');
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function header(req: MiddlewareRequest, name: string): string {
  const value = req.headers?.[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function vitePluginRhiDebug(options: RhiDebugPluginOptions = {}): Plugin {
  return {
    name: 'forgeax:rhi-debug',

    config(_config, env) {
      return {
        define: { [DEFINE_KEY]: JSON.stringify(env.command === 'serve' ? '1' : '0') },
      };
    },

    configureServer(server: ViteDevServer) {
      const provider = createRawTapeProvider({ rootDir: options.rootDir ?? process.cwd() });
      server.middlewares.use(async (request, response, next) => {
        const req = request as MiddlewareRequest;
        const res = response as unknown as MiddlewareResponse;
        const url = new URL(req.url ?? '', 'http://localhost');
        const route = ROUTES.find((candidate) => candidate.path === url.pathname);
        if (route === undefined) {
          next();
          return;
        }
        if (!(route.methods as readonly string[]).includes(req.method ?? '')) {
          res.setHeader('Allow', route.methods.join(', '));
          sendJson(res, 405, { error: 'method-not-allowed', hint: route.usage });
          return;
        }
        const runId = url.searchParams.get('runId') ?? '';
        const size = Number(url.searchParams.get('size'));
        let body: Uint8Array | undefined;
        if (req.method !== 'GET') {
          try {
            body = await readRawBody(
              req,
              route.path === TAPE_CHUNKS_ROUTE ? MAX_CHUNK_BYTES : undefined,
            );
          } catch {
            // Connect does not await an async middleware. A cancelled browser
            // upload must not escape as an unhandled rejection and kill Vite.
            if (!res.destroyed) {
              sendJson(res, 400, {
                code: 'capture-upload-incomplete',
                hint: 'the request body ended early or exceeded the chunk limit; retry the upload',
              } satisfies ViteProviderError);
            }
            return;
          }
        }
        const result = await dispatch(provider, route.path, req, runId, size, url, body);
        if (!result.ok) {
          sendJson(
            res,
            result.error.code === 'capture-artifact-write-failed' ? 500 : 400,
            result.error,
          );
          return;
        }
        sendJson(res, 200, result.value);
      });
    },
  };
}

const ROUTES = [
  {
    path: RAW_TAPE_ROUTE,
    methods: ['POST'],
    usage: `use POST ${RAW_TAPE_ROUTE}?runId=<id> with raw ${RHITAPE_MIME} bytes, or the chunk routes for large tapes`,
  },
  {
    path: TAPE_CHUNKS_ROUTE,
    methods: ['GET', 'PUT'],
    usage: `GET ${TAPE_CHUNKS_ROUTE}?runId=<id>&size=<n> lists held chunks; PUT ...&offset=<n> with ${CHUNK_DIGEST_HEADER}`,
  },
  {
    path: TAPE_COMMIT_ROUTE,
    methods: ['POST'],
    usage: `POST ${TAPE_COMMIT_ROUTE}?runId=<id>&size=<n> with JSON { size, chunks }`,
  },
] as const;

async function dispatch(
  provider: RawTapeProvider,
  path: (typeof ROUTES)[number]['path'],
  req: MiddlewareRequest,
  runId: string,
  size: number,
  url: URL,
  body: Uint8Array | undefined,
): Promise<ProviderResult<unknown, ViteProviderError>> {
  switch (path) {
    case RAW_TAPE_ROUTE:
      return provider.accept({
        runId,
        contentType: header(req, 'content-type'),
        bytes: body ?? new Uint8Array(),
      });
    case TAPE_CHUNKS_ROUTE:
      if (req.method === 'GET') return provider.status(runId, size);
      return provider.putChunk({
        runId,
        size,
        offset: Number(url.searchParams.get('offset')),
        digest: header(req, CHUNK_DIGEST_HEADER),
        bytes: body ?? new Uint8Array(),
      });
    case TAPE_COMMIT_ROUTE: {
      let chunks: TapeChunk[];
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { chunks?: unknown };
        if (!Array.isArray(parsed.chunks)) throw new Error('chunks');
        chunks = parsed.chunks as TapeChunk[];
      } catch {
        return failure('capture-upload-incomplete', 'commit body must be JSON { size, chunks }');
      }
      return provider.commit({ runId, size, chunks });
    }
  }
}

export default vitePluginRhiDebug;
