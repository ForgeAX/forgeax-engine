import { resolve } from 'node:path';
import {
  type EngineWorkspaceAsset,
  type EngineWorkspaceRuntime,
  projectEngineWorkspaceAssets,
} from '@forgeax/engine-app';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { previewThumbnailInput } from '@forgeax/engine-preview';
import { defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { type CatalogEntry, readCatalogRows } from '@forgeax/engine-types';
import {
  createWorkspacePreviewBatch,
  type PreviewImageCapture,
} from './workspace-preview-batch.js';
import { createThumbnailCache, thumbnailKey } from './workspace-thumbnail-cache.js';

export interface WorkspaceThumbnail {
  readonly guid: string;
  readonly state: 'queued' | 'cooking' | 'ready' | 'failed' | 'unsupported';
  readonly dataUrl?: string;
  readonly error?: { readonly code: string; readonly expected: string; readonly hint: string };
  readonly metrics?: {
    readonly cache: 'hit' | 'miss';
    readonly capture?: Omit<PreviewImageCapture, 'dataUrl'>;
  };
}
interface Job {
  readonly asset: EngineWorkspaceAsset;
  readonly input: string;
  readonly key: string;
  row: WorkspaceThumbnail;
  checked: boolean;
}
interface Inputs {
  readonly producer: string;
  readonly entries: readonly CatalogEntry[];
}

export async function readPreviewInputs(url: string, signal: AbortSignal): Promise<Inputs> {
  const response = await fetch(new URL('/__forgeax/preview-inputs', url), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok)
    throw new Error(
      `Preview input HTTP ${response.status}: ${(await response.text()).slice(0, 2048)}`,
    );
  const source = (await response.json()) as { producer?: unknown; catalog?: unknown };
  if (typeof source.producer !== 'string' || !source.producer)
    throw new Error('Preview producer identity missing');
  const decoded = decodeCatalogWire(source.catalog);
  if (!decoded.ok) throw decoded.error;
  const entries = readCatalogRows(decoded.value);
  if (!entries) throw new Error('Preview Catalog rows missing');
  return { producer: source.producer, entries: entries as readonly CatalogEntry[] };
}
function failure(cause: unknown): NonNullable<WorkspaceThumbnail['error']> {
  return {
    code: 'thumbnail-preview-failed',
    expected: 'A current Engine preview image',
    hint: (cause instanceof Error ? cause.message : JSON.stringify(cause) || String(cause)).slice(
      0,
      4096,
    ),
  };
}

/** The project owns a bounded asynchronous queue; View only reads its progressive results. */
export function createWorkspaceThumbnails(
  runtime: Pick<EngineWorkspaceRuntime, 'project'>,
  changed: () => void,
  dependencies = { readInputs: readPreviewInputs, createBatch: createWorkspacePreviewBatch },
) {
  let project: EngineWorkspaceRuntime['project'];
  let jobs = new Map<string, Job>();
  let cache: ReturnType<typeof createThumbnailCache> | undefined;
  let batch: ReturnType<typeof createWorkspacePreviewBatch> | undefined;
  let controller = new AbortController();
  let revision = 0;
  let producer = '';
  let scanning = false;
  let draining = false;
  let closed = false;
  let error: WorkspaceThumbnail['error'];
  let notification: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const notify = () => {
    if (closed || notification) return;
    notification = setTimeout(() => {
      notification = undefined;
      changed();
    }, 50);
  };
  const closeBatch = async () => {
    const old = batch;
    batch = undefined;
    if (idle) clearTimeout(idle);
    idle = undefined;
    await old?.close();
  };
  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    const signal = controller.signal;
    try {
      for (;;) {
        const job = [...jobs.values()].find((candidate) => candidate.row.state === 'queued');
        const url = project?.target?.url;
        if (!job?.checked || !url || !cache || signal.aborted) break;
        job.row = { guid: job.asset.guid, state: 'cooking' };
        notify();
        try {
          if (idle) clearTimeout(idle);
          idle = undefined;
          batch ??= dependencies.createBatch(url);
          const capture = await batch.capture(
            { guid: job.asset.guid, kind: job.asset.kind },
            job.input,
            signal,
          );
          if (signal.aborted || jobs.get(job.asset.guid) !== job) continue;
          await cache.write(job.key, job.asset.guid, producer, capture.dataUrl);
          if (signal.aborted || jobs.get(job.asset.guid) !== job) continue;
          const { dataUrl: _dataUrl, ...metrics } = capture;
          job.row = {
            guid: job.asset.guid,
            state: 'ready',
            metrics: { cache: 'miss', capture: metrics },
          };
        } catch (cause) {
          if (!signal.aborted && jobs.get(job.asset.guid) === job)
            job.row = { guid: job.asset.guid, state: 'failed', error: failure(cause) };
          await closeBatch();
        }
        notify();
      }
    } finally {
      draining = false;
      if (
        !closed &&
        project?.target?.url &&
        cache &&
        [...jobs.values()].find((job) => job.row.state === 'queued')?.checked
      )
        void drain();
      else if (!scanning && batch)
        idle = setTimeout(() => {
          void closeBatch();
        }, 30_000);
    }
  };
  const refresh = () => {
    if (closed) return;
    const next = runtime.project;
    if (next !== project) {
      controller.abort();
      controller = new AbortController();
      project = next;
      jobs.clear();
      cache = undefined;
      void closeBatch();
      if (next)
        cache = createThumbnailCache(resolve(next.project.root, '.forgeax/ddc/v2/thumbnails'));
    }
    const current = ++revision;
    const signal = controller.signal;
    const url = project?.target?.url;
    error = undefined;
    scanning = false;
    if (!url || !cache) {
      notify();
      return;
    }
    scanning = true;
    const previous = jobs;
    jobs = new Map();
    notify();
    const currentCache = cache;
    void dependencies
      .readInputs(url, signal)
      .then(async (input) => {
        if (closed || signal.aborted || revision !== current) return;
        producer = input.producer;
        const catalog = new Map(input.entries.map((entry) => [entry.guid, entry]));
        jobs = new Map(
          projectEngineWorkspaceAssets(input.entries).map((asset) => {
            const content = asset.previewable
              ? previewThumbnailInput(catalog, asset.guid)
              : undefined;
            const key = content === undefined ? '' : thumbnailKey(content, input.producer);
            const retained = previous.get(asset.guid);
            return [
              asset.guid,
              retained?.key === key &&
              (retained.row.state === 'ready' || retained.row.state === 'unsupported')
                ? retained
                : ({
                    asset,
                    input: content ?? '',
                    key,
                    checked: content === undefined,
                    row: {
                      guid: asset.guid,
                      state: content === undefined ? 'unsupported' : 'queued',
                    },
                  } satisfies Job),
            ];
          }),
        );
        notify();
        const pending = [...jobs.values()].filter((job) => !job.checked);
        let index = 0;
        await Promise.all(
          Array.from({ length: Math.min(8, pending.length) }, async () => {
            for (;;) {
              const job = pending[index++];
              if (!job || signal.aborted || revision !== current) return;
              const hit = await currentCache.read(job.key);
              if (signal.aborted || revision !== current || jobs.get(job.asset.guid) !== job)
                continue;
              job.checked = true;
              if (hit)
                job.row = { guid: job.asset.guid, state: 'ready', metrics: { cache: 'hit' } };
              notify();
              void drain();
            }
          }),
        );
      })
      .catch((cause) => {
        if (!signal.aborted && revision === current) {
          error = failure(cause);
          notify();
        }
      })
      .finally(() => {
        if (revision === current) {
          scanning = false;
          void drain();
        }
      });
  };
  const read = async (
    guids: readonly string[],
  ): Promise<{ thumbnails: readonly WorkspaceThumbnail[] }> => {
    if (runtime.project !== project) refresh();
    const active = project;
    const rows = await Promise.all(
      guids.map(async (guid): Promise<WorkspaceThumbnail> => {
        const job = jobs.get(guid);
        if (!job)
          return error
            ? { guid, state: 'failed', error }
            : { guid, state: scanning ? 'queued' : 'unsupported' };
        if (job.row.state !== 'ready') return job.row;
        const dataUrl = await cache?.read(job.key);
        if (project !== active || jobs.get(guid) !== job) return { guid, state: 'queued' };
        if (dataUrl) return { ...job.row, dataUrl };
        job.row = { guid, state: 'queued' };
        void drain();
        return job.row;
      }),
    );
    return { thumbnails: rows };
  };
  const schema = {
    type: 'object',
    required: ['projectId', 'guids'],
    properties: {
      projectId: { type: 'string', minLength: 1 },
      targetId: {
        type: 'string',
        minLength: 1,
        description: 'Exact project target when addressing another admitted workspace session.',
      },
      guids: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
      },
    },
  } as const;
  const outputSchema = {
    type: 'object',
    required: ['thumbnails'],
    properties: {
      thumbnails: {
        type: 'array',
        maxItems: 32,
        items: {
          type: 'object',
          required: ['guid', 'state'],
          properties: {
            guid: { type: 'string' },
            state: { enum: ['queued', 'cooking', 'ready', 'failed', 'unsupported'] },
            dataUrl: {
              type: 'string',
              description: 'A verified 128x128 transparent PNG, present when ready.',
            },
            error: {
              type: 'object',
              required: ['code', 'expected', 'hint'],
              properties: {
                code: { type: 'string' },
                expected: { type: 'string' },
                hint: { type: 'string' },
              },
            },
            metrics: {
              type: 'object',
              required: ['cache'],
              properties: {
                cache: { enum: ['hit', 'miss'] },
                capture: {
                  type: 'object',
                  properties: {
                    preparedMs: { type: 'number' },
                    totalMs: { type: 'number' },
                    submitted: { type: 'integer' },
                    ready: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
  } as const;
  const tool = defineTool<unknown, unknown>(
    {
      id: 'engine.assets.thumbnails',
      path: ['engine', 'assets', 'thumbnails'],
      title: 'Asset thumbnails',
      summary: 'Read progressively cached Engine asset previews; generation runs asynchronously.',
      realm: 'host',
      argsSchema: toolJsonSchema(schema),
      resultSchema: toolJsonSchema(outputSchema),
      inputSchema: schema,
      outputSchema,
      evidence: [],
    },
    async (value) => {
      const args = value as { projectId: string; guids: string[] };
      if (!runtime.project || args.projectId !== runtime.project.project.id)
        return {
          ok: false,
          error: {
            code: 'engine-workspace-project-mismatch',
            expected: 'The current project',
            hint: 'Open the project first.',
          },
        };
      return read(args.guids);
    },
  );
  return {
    refresh,
    read,
    tool,
    async close() {
      closed = true;
      revision++;
      controller.abort();
      if (notification) clearTimeout(notification);
      await closeBatch();
      jobs.clear();
    },
  };
}
