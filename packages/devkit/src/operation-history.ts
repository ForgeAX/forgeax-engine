import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ArtifactRef,
  defineTool,
  type JsonValue,
  type ToolJsonSchema,
  type ToolTerminal,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';

export interface OperationHistoryEntry {
  schemaVersion: 1;
  id: string;
  root: string;
  operation: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  state: 'running' | 'succeeded' | 'failed';
  args: JsonValue;
  result?: JsonValue;
  failure?: JsonValue;
  artifacts: (ArtifactRef & { available: boolean; unavailableReason?: string })[];
}
export type OperationHistorySummary = Omit<
  OperationHistoryEntry,
  'args' | 'result' | 'failure' | 'artifacts'
> & { artifactCount: number; imageCount: number };
export interface OperationHistoryPage {
  root: string;
  items: OperationHistorySummary[];
  nextCursor?: string;
}
const ID = /^\d{13}-[0-9a-f-]{36}$/;
const MAX_IMAGE = 32 * 1024 * 1024;
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Bounded diagnostic projection. Binary payloads and credentials are never history text. */
function project(value: unknown, depth = 0, budget = { remaining: 65536 }): JsonValue {
  if (budget.remaining <= 0 || depth > 6) return '[omitted]';
  budget.remaining -= 16;
  if (budget.remaining <= 0) return '[omitted]';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary artifact]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return '[binary artifact]';
    const size = Math.min(value.length, 2048, budget.remaining);
    budget.remaining -= size;
    return (
      value
        .slice(0, size)
        .replace(
          /([?&][^?&=\s]*(?:token|password|secret|authorization)[^?&=\s]*=)[^&#\s]*/gi,
          '$1[redacted]',
        ) + (size < value.length ? '…' : '')
    );
  }
  if (Array.isArray(value))
    return value.slice(0, 64).map((item) => project(item, depth + 1, budget));
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .map(([key, item]) => [
        key.slice(0, 256),
        /token|password|secret|authorization|cookie/i.test(key)
          ? '[redacted]'
          : project(item, depth + 1, budget),
      ]),
  );
}
function requireId(id: string) {
  if (!ID.test(id)) throw new TypeError('Invalid operation history ID');
}
function artifactIndex(index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 64)
    throw new TypeError('Invalid artifact index');
}
function summary(entry: OperationHistoryEntry): OperationHistorySummary {
  const { args: _args, result: _result, failure: _failure, artifacts, ...metadata } = entry;
  return {
    ...metadata,
    artifactCount: artifacts.length,
    imageCount: artifacts.filter((item) => item.available).length,
  };
}

/** Node-owned durable command receipts; no renderer, View, background game, or parallel run authority. */
export async function createOperationHistoryStore(rootInput: string, directoryInput?: string) {
  let root = resolve(rootInput);
  try {
    root = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const directory =
    directoryInput ??
    join(
      process.env.FORGEAX_HISTORY_DIR ?? join(homedir(), '.local/share/ForgeaX/operations'),
      createHash('sha256').update(root).digest('hex'),
    );
  const read = async (id: string): Promise<OperationHistoryEntry> => {
    requireId(id);
    const path = join(directory, id, 'record.json');
    const bytes = await readFile(path);
    if (bytes.length > 1024 * 1024) throw new Error('Operation history record exceeds its bound');
    const entry = JSON.parse(bytes.toString()) as OperationHistoryEntry;
    if (
      entry.schemaVersion !== 1 ||
      entry.id !== id ||
      entry.root !== root ||
      !Array.isArray(entry.artifacts)
    )
      throw new Error('Invalid operation history record');
    return entry;
  };
  const save = async (entry: OperationHistoryEntry, initial = false) => {
    const folder = join(directory, entry.id);
    if (initial) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(join(directory, '.staging-'));
      try {
        await writeFile(join(staging, 'record.json'), JSON.stringify(entry), { mode: 0o600 });
        await rename(staging, folder);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      return;
    }
    await mkdir(folder, { recursive: true });
    const temporary = join(folder, `record-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
    await rename(temporary, join(folder, 'record.json'));
  };
  return {
    root,
    async list({
      limit = 50,
      before,
    }: {
      limit?: number;
      before?: string;
    } = {}): Promise<OperationHistoryPage> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError('History limit must be between 1 and 100');
      if (before !== undefined) requireId(before);
      const ids = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const page = ids
        .filter((id) => ID.test(id) && (before === undefined || id < before))
        .sort()
        .reverse()
        .slice(0, limit + 1);
      const entries = await Promise.all(page.slice(0, limit).map(read));
      return {
        root,
        items: entries.map(summary),
        ...(page.length > limit ? { nextCursor: page[limit - 1] } : {}),
      };
    },
    get: read,
    async readArtifact(id: string, index: number) {
      artifactIndex(index);
      const entry = await read(id);
      const artifact = entry.artifacts[index];
      if (!artifact?.available)
        throw new Error(artifact?.unavailableReason ?? 'Screenshot artifact is unavailable');
      const bytes = await readFile(join(directory, id, 'artifacts', `${index}.png`));
      if (bytes.length > MAX_IMAGE || digest(bytes) !== artifact.digest)
        throw new Error('Screenshot artifact digest mismatch');
      return {
        mediaType: 'image/png' as const,
        digest: artifact.digest,
        data: bytes.toString('base64'),
      };
    },
    async track<T>(
      operation: string,
      args: unknown,
      execute: () => Promise<ToolTerminal<T>>,
    ): Promise<ToolTerminal<T>> {
      // Reading history never creates more history. Help has no execution effect.
      if (
        operation.startsWith('engine.history.') ||
        operation.startsWith('view.workspace.history.') ||
        operation === 'help'
      )
        return execute();
      const started = Date.now();
      const entry: OperationHistoryEntry = {
        schemaVersion: 1,
        id: `${started}-${randomUUID()}`,
        root,
        operation,
        startedAt: new Date(started).toISOString(),
        state: 'running',
        args: project(args),
        artifacts: [],
      };
      await save(entry, true);
      let terminal: ToolTerminal<T>;
      try {
        terminal = await execute();
      } catch (error) {
        Object.assign(entry, {
          state: 'failed',
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          failure: project({ message: error instanceof Error ? error.message : String(error) }),
        });
        await save(entry);
        throw error;
      }
      entry.state = terminal.outcome;
      entry.completedAt = new Date().toISOString();
      entry.durationMs = Date.now() - started;
      if (terminal.outcome === 'succeeded') entry.result = project(terminal.result);
      else entry.failure = project(terminal.failure);
      entry.artifacts = terminal.artifacts
        .slice(0, 64)
        .map((ref) => ({ ...ref, available: false }));
      for (const [index, artifact] of entry.artifacts.entries()) {
        if (artifact.mediaType !== 'image/png' && artifact.kind !== 'png') continue;
        try {
          if (!artifact.uri) throw new Error('Producer returned no image URI');
          const path = artifact.uri.startsWith('file:')
            ? fileURLToPath(artifact.uri)
            : resolve(root, artifact.uri);
          if ((await stat(path)).size > MAX_IMAGE) throw new Error('Screenshot exceeds 32 MiB');
          const bytes = await readFile(path);
          if (bytes.length > MAX_IMAGE) throw new Error('Screenshot exceeds 32 MiB');
          if (digest(bytes) !== artifact.digest) throw new Error('Producer image digest mismatch');
          if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
            throw new Error('Producer image is not PNG');
          const folder = join(directory, entry.id, 'artifacts');
          await mkdir(folder, { recursive: true });
          await writeFile(join(folder, `${index}.png`), bytes, { mode: 0o600 });
          artifact.available = true;
        } catch (error) {
          artifact.unavailableReason = error instanceof Error ? error.message : String(error);
        }
      }
      await save(entry);
      return terminal;
    },
  };
}

export function createOperationHistoryTools(defaultRoot?: string) {
  const root = { type: 'string' as const };
  const create = (
    operation: string,
    properties: Record<string, ToolJsonSchema>,
    required: string[],
    execute: (
      store: Awaited<ReturnType<typeof createOperationHistoryStore>>,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
  ) => {
    const schema: ToolJsonSchema = {
      type: 'object',
      properties: { root, ...properties },
      required: defaultRoot ? required : ['root', ...required],
      additionalProperties: false,
    };
    return defineTool(
      {
        id: `engine.history.${operation}`,
        title: `Engine operation history ${operation}`,
        summary: 'Read durable Engine command history without starting a game or View.',
        realm: 'host',
        argsSchema: toolJsonSchema(schema),
        resultSchema: toolJsonSchema({ type: 'object' }),
        evidence: [],
        inputSchema: schema as JsonValue,
      },
      async (value) => {
        const args = value as Record<string, unknown>;
        return execute(await createOperationHistoryStore(String(args.root ?? defaultRoot)), args);
      },
    );
  };
  return [
    create(
      'list',
      { limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string' } },
      [],
      (store, args) => store.list(args as { limit?: number; before?: string }),
    ),
    create('get', { id: { type: 'string' } }, ['id'], (store, args) => store.get(String(args.id))),
    create(
      'artifact.read',
      { id: { type: 'string' }, index: { type: 'integer', minimum: 0, maximum: 63 } },
      ['id', 'index'],
      (store, args) => store.readArtifact(String(args.id), Number(args.index)),
    ),
  ];
}
