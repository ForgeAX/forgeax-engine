import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import {
  type ArtifactRef,
  defineCommand,
  type JsonValue,
  operationCommandPath,
  type ToolContribution,
  type ToolDomainFailure,
  type ToolExecutionContext,
  type ToolJsonSchema,
  type ToolRealm,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';
import { animationPlayback, animationPlaybackSchema } from '../animation-playback.js';
import { executionWorkers, executionWorkersSchema } from '../execution-workers.js';
import { createOperationHistoryTools } from '../operation-history.js';
import { PLAY_CONTEXT_HELP } from '../play-context-reference.js';
import { readProjectStartupTimeoutMs } from '../project.js';
import { RHI_INSPECT_INPUT_SCHEMA, RHI_READ_INPUT_SCHEMA } from '../rhi-debug/operations.js';
import { RHI_TIMING_OPTION_PROPERTIES } from '../rhi-debug/timing.js';
import { createWorkspaceLiveTools } from '../workspace-live-tools.js';
import {
  assetInspectInputSchema,
  assetListInputSchema,
  assetResolveInputSchema,
  assetVerifyInputSchema,
} from './catalog.js';
import { createModelRenderTool, createModelReplayTool } from './model-render.js';

type CommandValue =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly artifacts?: readonly ArtifactRef[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly expected?: string;
        readonly hint?: string;
        readonly detail?: unknown;
      };
      readonly artifacts?: readonly ArtifactRef[];
    };

type CommandError = Extract<CommandValue, { readonly ok: false }>['error'];

type LiveOperation =
  | 'status'
  | 'reload'
  | 'stop'
  | 'capture'
  | 'look'
  | 'verify'
  | 'rhi/capture'
  | 'profile/capture'
  | 'eval'
  | 'camera/get'
  | 'camera/set'
  | 'camera/release'
  | 'find'
  | 'pick'
  | 'focus';

const string = { type: 'string' } satisfies ToolJsonSchema;
const captureBackend = {
  type: 'string',
  enum: ['auto', 'hardware', 'software'],
} satisfies ToolJsonSchema;
const boolean = { type: 'boolean' } satisfies ToolJsonSchema;
const number = { type: 'number' } satisfies ToolJsonSchema;
const integer = { type: 'integer' } satisfies ToolJsonSchema;
const port = { type: 'integer', minimum: 0, maximum: 65_535 } satisfies ToolJsonSchema;
const liveIdentity = { revision: string };
const liveReady = {
  readyTimeoutMs: {
    type: 'integer',
    minimum: 0,
    description:
      'Wait up to this many milliseconds for a reloading, replaced, or busy live runtime before running; 0 fails immediately. Default 120000.',
  },
} satisfies Readonly<Record<string, ToolJsonSchema>>;

const schema = (
  properties: Readonly<Record<string, ToolJsonSchema>>,
  required: readonly string[] = [],
): ToolJsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const root = { root: string };
const commandSchemas: Readonly<Record<string, ToolJsonSchema>> = {
  'backend.start': schema({ ...root, hostPack: string }),
  'backend.status': schema(root),
  'backend.stop': schema(root),
  'project.new': schema({
    ...root,
    template: string,
    id: string,
    name: string,
    packageName: string,
    dryRun: boolean,
  }),
  'project.init': schema({ ...root, install: boolean, dryRun: boolean }),
  'project.check': schema({ ...root, json: boolean }),
  'project.test': schema({ ...root, json: boolean }),
  'project.package': schema({
    ...root,
    output: string,
    format: string,
    compress: boolean,
    json: boolean,
  }),
  'project.preview': schema({ ...root, dist: string, port, json: boolean }),
  'project.capture': schema({
    ...root,
    output: string,
    backend: captureBackend,
    headless: boolean,
    port,
    width: integer,
    height: integer,
    waitMs: integer,
    requireUi: boolean,
    deterministic: boolean,
  }),
  'project.play': {
    ...schema(
      {
        ...root,
        script: {
          type: 'string',
          description:
            'Playthrough module whose default export receives the play helper (`PlayContext` from `@forgeax/engine/devkit`; signatures in the schema description).',
        },
        backend: captureBackend,
        headless: boolean,
        port,
        viewports: {
          type: 'string',
          description:
            'WxH[,WxH...] (default 1280x720,1280x600); the script runs in the first, later ones get a screenshot under the final-frame gate.',
        },
        requireUi: boolean,
        timeoutMs: { type: 'integer', minimum: 1 },
        from: {
          type: 'string',
          description:
            'Start at this top-level step (name or 1-based position); earlier steps are skipped without input and the step runs its setup first. Not final acceptance.',
        },
        steps: {
          type: 'string',
          description:
            'a..b, a.. or a: run only these top-level steps (names or 1-based positions). Not final acceptance.',
        },
        timeScale: {
          type: 'number',
          minimum: 0.0625,
          maximum: 16,
          description:
            'Speed cap in game seconds per wall second (default 1, real time). Other values run the game in lockstep with the script: the App stays paused and steps fixed 1/60 s frames (physics and input included) only while a helper waits, waitFor and predicate holds check every 3 frames, and waits, holds and wait timeouts count game time. Not final acceptance.',
        },
        session: {
          type: 'boolean',
          description:
            "Run in the page of the project's running `forgeax dev start` owner: it reloads that page (warm browser and dev server) and the script runs there; the owner keeps running. Fails with play-not-ready (session-unavailable) when no owner runs; never starts one.",
        },
        release: {
          type: 'boolean',
          description:
            "Run the same playthrough against the built static release (run `forgeax project build` first) on play's own loopback server; this real-time run is the final acceptance. Requests to non-local hosts are blocked, listed in externalRequests and fail the run (play-runtime-failed, external-request). state, waitFor and hold predicates read the game's registered read projection as in development; advance needs the development host, so guard it with play.release. Refuses --time-scale and --session.",
        },
        dist: {
          type: 'string',
          description: '--release distribution directory relative to the root (default dist).',
        },
        headers: {
          type: 'string',
          enum: ['isolated', 'none'],
          description:
            "--release response headers. isolated (default) sends COOP/COEP/CORP like `project preview`; none sends none, like a plain static host (crossOriginIsolated false, the App's non-isolated path). The result names the headers used.",
        },
        detail: {
          type: 'boolean',
          description: 'Return the complete play report instead of the compact summary.',
        },
        progress: {
          type: 'boolean',
          description:
            'Progress lines on stderr (one at start, then at most one per 30 s). Default true.',
        },
        json: boolean,
      },
      ['script'],
    ),
    description: PLAY_CONTEXT_HELP,
  },
  'project.engine.status': schema({ ...root, json: boolean }),
  'project.engine.use-local': schema({ ...root, path: string, json: boolean }),
  'project.engine.unlink': schema({ ...root, json: boolean }),
  'project.engine.check': schema({ ...root, json: boolean }),
  'project.skill.install': schema({ ...root, json: boolean }),
  'project.skill.verify': schema({ ...root, json: boolean }),
  'asset.import': schema({ ...root, path: string, dryRun: boolean, json: boolean }, ['path']),
  'asset.list': assetListInputSchema,
  'asset.inspect': assetInspectInputSchema,
  'asset.resolve': assetResolveInputSchema,
  'asset.verify': assetVerifyInputSchema,
  'asset.guid': schema({ packageId: string, key: string, json: boolean }, ['packageId', 'key']),
  'asset.shader.check': schema({ ...root, path: string, json: boolean }),
  'asset.preview': schema(
    {
      ...root,
      kind: string,
      guid: string,
      backend: captureBackend,
      headless: boolean,
      width: integer,
      height: integer,
      output: string,
      json: boolean,
    },
    ['kind', 'guid'],
  ),
  'asset.atlas': schema(
    {
      ...root,
      input: string,
      name: string,
      output: string,
      maxAtlasSize: integer,
      json: boolean,
    },
    ['input', 'name'],
  ),
  'sdk.install': schema({ ...root, version: string }),
  'preview.analyze': schema({ ...root, artifact: string, json: boolean }),
  'rhi.capture': schema({ ...root, ...liveReady, output: string, json: boolean }),
  'rhi.summary': schema(
    { ...root, artifact: string, digest: string, passes: boolean, label: string, json: boolean },
    ['artifact'],
  ),
  'rhi.timing': schema(
    {
      ...root,
      ...RHI_TIMING_OPTION_PROPERTIES,
      artifact: string,
      digest: string,
      compare: string,
      json: boolean,
    },
    ['artifact'],
  ),
  'rhi.inspect': schema(
    {
      ...root,
      ...RHI_INSPECT_INPUT_SCHEMA.properties,
      artifact: string,
      digest: string,
      json: boolean,
    },
    RHI_INSPECT_INPUT_SCHEMA.required,
  ),
  'rhi.read': schema(
    {
      ...root,
      ...RHI_READ_INPUT_SCHEMA.properties,
      artifact: string,
      digest: string,
      json: boolean,
    },
    RHI_READ_INPUT_SCHEMA.required,
  ),
  'profile.capture': schema({
    ...root,
    ...liveReady,
    output: string,
    frameLimit: integer,
    eventLimit: integer,
    revision: string,
    json: boolean,
  }),
  'profile.summary': schema({ ...root, artifact: string, json: boolean }),
  'profile.frame': schema({ ...root, artifact: string, frameId: integer, json: boolean }),
  'profile.phase': schema({
    ...root,
    artifact: string,
    source: string,
    phase: string,
    json: boolean,
  }),
  'profile.compare': schema({ ...root, leftFile: string, rightFile: string, json: boolean }, [
    'leftFile',
    'rightFile',
  ]),
  'dev.start': schema({
    ...root,
    headless: boolean,
    backend: captureBackend,
    workers: executionWorkersSchema,
    animation: animationPlaybackSchema,
    rhiCapture: boolean,
  }),
  'dev.status': schema({ ...root }),
  'dev.verify': schema({
    ...root,
    ...liveIdentity,
    ...liveReady,
    output: string,
    checkpoint: string,
    requireUi: boolean,
    timeoutMs: { type: 'integer', minimum: 1 },
  }),
  'dev.pipelines.export': schema(
    {
      ...root,
      ...liveIdentity,
      output: string,
      limits: schema({
        outputBytes: { type: 'integer', minimum: 1 },
        temporaryBytes: { type: 'integer', minimum: 1 },
        entries: { type: 'integer', minimum: 1 },
      }),
    },
    ['revision'],
  ),
  'dev.reload': schema({ ...root }),
  'dev.stop': schema({ ...root }),
  'dev.eval': schema(
    { ...root, ...liveIdentity, ...liveReady, code: string, timeoutMs: integer, lease: boolean },
    ['code', 'revision'],
  ),
  'dev.find': schema({
    ...root,
    ...liveIdentity,
    ...liveReady,
    name: string,
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  'dev.pick': schema(
    {
      ...root,
      ...liveIdentity,
      ...liveReady,
      x: {
        type: 'number',
        description: 'Pixel column of the presented frame (0 = left), as in dev look PNGs.',
      },
      y: {
        type: 'number',
        description: 'Pixel row of the presented frame (0 = top), as in dev look PNGs.',
      },
    },
    ['x', 'y'],
  ),
  'dev.camera.release': schema({ ...root, ...liveIdentity, ...liveReady }),
  'dev.camera.get': schema({ ...root, ...liveIdentity, ...liveReady }),
  'dev.camera.set': schema({
    ...root,
    ...liveIdentity,
    ...liveReady,
    position: { type: 'array', items: number, minItems: 3 },
    target: { type: 'array', items: number, minItems: 3 },
    up: { type: 'array', items: number, minItems: 3 },
    lens: { type: 'object' },
    exposure: { type: 'object' },
  }),
  'dev.focus': schema({
    ...root,
    ...liveIdentity,
    ...liveReady,
    name: string,
    ref: string,
    distance: number,
    target: { type: 'array', items: number, minItems: 3 },
    position: { type: 'array', items: number, minItems: 3 },
    up: { type: 'array', items: number, minItems: 3 },
  }),
  'dev.capture': schema({
    ...root,
    ...liveIdentity,
    ...liveReady,
    output: string,
    checkpoint: {
      type: 'string',
      description:
        'Wait for a game-published forgeaxCaptureReady value. Omit for an immediate snapshot; this is not an image name.',
    },
  }),
  'dev.look': schema({
    ...root,
    ...liveIdentity,
    ...liveReady,
    output: { type: 'string', description: 'Directory for the view PNGs.' },
    cameras: {
      type: 'array',
      maxItems: 8,
      description:
        'Fixed observation cameras, each {name?, position, target, up?, lens?} as for dev camera set; omit for the game camera.',
      items: { type: 'object' },
    },
    viewports: {
      type: 'string',
      description:
        'WxH[,WxH...] CSS viewports, as for project play (headless dev page only); omit for the current size.',
    },
    hideUi: {
      type: 'boolean',
      description: 'Hide #game-ui while capturing so the image and metrics show the scene alone.',
    },
    view: {
      type: 'string',
      enum: ['final', 'luminance'],
      description:
        'luminance also writes a pre-tonemap HDR luminance heat map banded in stops around the bloom threshold.',
    },
  }),
};

function commandSchema(id: string): ToolJsonSchema {
  return commandSchemas[id] ?? schema({ ...root });
}

function result(
  value: CommandValue,
): unknown | { readonly ok: false; readonly error: ToolDomainFailure } {
  if (value.ok)
    return {
      ok: true,
      value: value.value,
      ...(value.artifacts === undefined ? {} : { artifacts: value.artifacts }),
    };
  return {
    ok: false,
    error: {
      code: value.error.code,
      expected: value.error.expected,
      hint: value.error.hint,
      detail: value.error.detail as JsonValue,
    },
    ...(value.artifacts === undefined ? {} : { artifacts: value.artifacts }),
  };
}

export function command<TArgs extends Record<string, unknown>>(
  id: string,
  title: string,
  summary: string,
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<CommandValue>,
  realm: ToolRealm = 'build',
  options: {
    readonly schema?: ToolJsonSchema;
    readonly capabilities?: readonly string[];
    readonly errors?: readonly string[];
    readonly example?: JsonValue;
  } = {},
): ToolContribution<TArgs, unknown> {
  const argsSchema = options.schema ?? commandSchema(id);
  return defineCommand(
    {
      id,
      path: operationCommandPath(id),
      title,
      summary,
      realm,
      argsSchema: toolJsonSchema<TArgs>(argsSchema),
      resultSchema: toolJsonSchema({ type: 'object' }),
      evidence: [],
      capabilities: options.capabilities ?? [],
      errors: options.errors ?? ['tool-invalid-args', 'tool-capability-unavailable'],
      ...(options.example === undefined ? {} : { example: options.example }),
      inputSchema: argsSchema as unknown as JsonValue,
    },
    async (args, context) => result(await execute(args, context)),
  );
}

function rootArgs<T extends Record<string, unknown>>(root: string, args: T): T & { root: string } {
  return { ...args, root: typeof args.root === 'string' ? args.root : root };
}

export function createUnifiedCommandContributions(
  projectRoot = process.cwd(),
): readonly ToolContribution[] {
  const project = (
    id: string,
    title: string,
    summary: string,
    method: string,
    loadOwner: () => Promise<unknown> = () =>
      method === 'sdkInstallCommand' ? import('../sdk-install.js') : import('../commands.js'),
  ) =>
    command(id, title, summary, async (args) => {
      const commands = (await loadOwner()) as Record<
        string,
        (value: unknown) => Promise<CommandValue>
      >;
      const handler = commands[method];
      if (handler === undefined) {
        return {
          ok: false,
          error: {
            code: 'command-unavailable',
            expected: method,
            hint: 'Install the matching DevKit command owner.',
          },
        };
      }
      return handler(rootArgs(projectRoot, args));
    });

  const live = (id: string, title: string, summary: string, operation: LiveOperation) =>
    command(
      id,
      title,
      summary,
      async (args) => {
        const liveDev = await import('../live-dev.js');
        if (operation === 'status')
          return (await liveDev.liveDevStatus(projectRoot)) as CommandValue;
        return (await liveDev.liveDevControl(projectRoot, operation, args)) as CommandValue;
      },
      'host',
      {
        capabilities: ['live-instance', ...(operation === 'status' ? [] : ['world-observation'])],
        errors: [
          ...(operation === 'status' || operation === 'stop' ? [] : ['live-not-running']),
          'live-not-ready',
          'live-revision-required',
          'live-revision-stale',
          'live-world-stale',
          'live-instance-changed',
        ],
        ...(operation === 'status'
          ? {}
          : {
              example:
                operation === 'focus'
                  ? { name: 'Player' }
                  : operation === 'pick'
                    ? { x: 640, y: 360 }
                    : operation === 'eval'
                      ? {
                          revision: '<from dev status>',
                          code: 'return simulation.execution.report()',
                        }
                      : {},
            }),
      },
    );
  const start = command(
    'dev.start',
    'Start live project',
    'Starts one persistent DevKit owner and its controlled browser Page.',
    async (args) =>
      (await (
        await import('../live-dev.js')
      ).startLiveDev(projectRoot, {
        ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
        ...(args.backend === 'auto' || args.backend === 'hardware' || args.backend === 'software'
          ? { backend: args.backend }
          : {}),
        ...(args.workers === undefined ? {} : { workers: executionWorkers(args.workers) }),
        ...(args.animation === undefined ? {} : { animation: animationPlayback(args.animation) }),
        ...(typeof args.rhiCapture === 'boolean' ? { rhiCapture: args.rhiCapture } : {}),
      })) as CommandValue,
    'host',
  );
  const offlinePreviewAnalysis = command(
    'preview.analyze',
    'Analyze preview artifacts',
    'Validates artifact identity and required evidence without starting a browser.',
    async (args) => {
      const { analyzePreviewArtifacts } = await import('./offline-analysis.js');
      const artifact =
        typeof args.artifact === 'string' ? resolve(projectRoot, args.artifact) : undefined;
      if (artifact === undefined) {
        return {
          ok: false,
          error: {
            code: 'tool-invalid-args',
            expected: '--artifact to point to a preview manifest or report',
            hint: 'Pass the retained .forgeax/tool-runs/.../manifest.json or report.json path.',
            detail: {},
          },
        };
      }
      let raw: string;
      try {
        raw = await readFile(artifact, 'utf8');
      } catch (cause) {
        return {
          ok: false,
          error: {
            code: 'preview-artifact-read-failed',
            expected: 'the preview artifact file to be readable',
            hint: 'Pass a retained preview manifest or report path, then retry.',
            detail: {
              path: artifact,
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (cause) {
        return {
          ok: false,
          error: {
            code: 'preview-artifact-invalid',
            expected: 'the preview artifact file to contain JSON',
            hint: 'Regenerate the preview artifacts and pass manifest.json or report.json.',
            detail: {
              path: artifact,
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }
      const isManifest = (
        candidate: unknown,
      ): candidate is {
        readonly schemaVersion: string;
        readonly identity: unknown;
        readonly artifacts: unknown;
      } =>
        candidate !== null &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        typeof Reflect.get(candidate, 'schemaVersion') === 'string' &&
        Reflect.get(candidate, 'identity') !== undefined &&
        Array.isArray(Reflect.get(candidate, 'artifacts'));
      let manifest: unknown = value;
      // `report.json` is a convenient user-facing input. Its sibling
      // manifest.json remains the identity authority consumed by the pure
      // offline analyzer.
      if (!isManifest(manifest)) {
        const sibling = resolve(dirname(artifact), 'manifest.json');
        try {
          manifest = JSON.parse(await readFile(sibling, 'utf8')) as unknown;
        } catch {
          return {
            ok: false,
            error: {
              code: 'preview-artifact-manifest-missing',
              expected: 'the artifact or its sibling manifest.json to contain a preview manifest',
              hint: 'Pass the retained manifest.json from the same ToolRun directory.',
              detail: { artifact, manifest: sibling },
            },
          };
        }
      }
      const analyzed = analyzePreviewArtifacts({ manifest: manifest as never });
      return analyzed.ok
        ? { ok: true, value: analyzed.value }
        : { ok: false, error: analyzed.error };
    },
  );
  const assetPreview = command(
    'asset.preview',
    'Preview an asset',
    'Produces canonical GUID-based resource evidence through the owning preview plugin; --kind scene renders a SceneAsset through its authored camera without running the game.',
    async (args, context) => {
      const kind = typeof args.kind === 'string' ? args.kind : 'mesh';
      if (kind === 'scene') {
        const { runScenePreviewTool } = await import('./scene-preview.js');
        const terminal = await runScenePreviewTool(args, projectRoot);
        return terminal.outcome === 'succeeded'
          ? { ok: true, value: terminal.result, artifacts: terminal.artifacts }
          : { ok: false, error: terminal.failure, artifacts: terminal.artifacts };
      }
      const nativePreview = await import('./native-preview.js');
      const catalog = await import('./preview-catalog.js');
      const contribution = catalog.nativePreviewTools.find(
        (candidate) => candidate.descriptor.id === `asset.${kind}.preview`,
      );
      if (contribution === undefined) {
        return {
          ok: false,
          error: {
            code: 'asset-preview-kind-unavailable',
            expected: 'kind to select scene, material, mesh, texture, or vfx',
            hint: 'Pass { kind, guid } and retry with one of the admitted preview owners.',
            detail: { kind },
          },
        };
      }
      const request = { guid: args.guid };
      const terminal = await nativePreview.runNativePreviewTool(
        contribution as ToolContribution<unknown, unknown>,
        request,
        {
          signal: context.signal,
          ...(context.snapshot === undefined ? {} : { snapshot: context.snapshot }),
        },
        projectRoot,
        {
          ...(args.backend === 'auto' || args.backend === 'hardware' || args.backend === 'software'
            ? { backend: args.backend }
            : {}),
          ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
          ...(typeof args.width === 'number' ? { width: args.width } : {}),
          ...(typeof args.height === 'number' ? { height: args.height } : {}),
          ...(typeof args.output === 'string' ? { output: args.output } : {}),
        },
      );
      return terminal.outcome === 'succeeded'
        ? { ok: true, value: terminal.result, artifacts: terminal.artifacts }
        : { ok: false, error: terminal.failure, artifacts: terminal.artifacts };
    },
    'host',
    { example: { kind: 'scene', guid: '<scene guid from asset list --type scene>' } },
  );
  const assetAtlas = command(
    'asset.atlas',
    'Build asset atlas',
    'Builds a deterministic PNG atlas and sidecar through the Pack producer.',
    async (args) => ({
      ...(await (async () => {
        const input = typeof args.input === 'string' ? args.input : undefined;
        const name = typeof args.name === 'string' ? args.name : undefined;
        if (input === undefined || name === undefined) {
          return {
            ok: false as const,
            error: {
              code: 'tool-invalid-args',
              expected: '--input <glob> and --name <prefix>',
              hint: 'Pass the image glob and output prefix, then retry.',
              detail: {},
            },
          };
        }
        const { runAtlas } = await import('@forgeax/engine-pack/cli-asset');
        const stdout: string[] = [];
        const stderr: string[] = [];
        const rest = ['--input', input, '--name', name];
        if (typeof args.output === 'string') rest.push('--output', args.output);
        if (typeof args.maxAtlasSize === 'number')
          rest.push('--max-atlas-size', String(args.maxAtlasSize));
        const exitCode = await runAtlas(rest, {
          cwd: projectRoot,
          stdoutWrite: (line: string) => stdout.push(line),
          stderrWrite: (line: string) => stderr.push(line),
        });
        if (exitCode !== 0) {
          let error: CommandError = {
            code: 'asset-atlas-failed',
            expected: 'the Pack atlas producer to complete',
            hint: stderr.at(-1) ?? 'Inspect the atlas inputs and retry.',
            detail: { exitCode },
          };
          const raw = stderr.at(-1);
          if (raw !== undefined) {
            try {
              const parsed = JSON.parse(raw) as Partial<CommandError>;
              if (typeof parsed.code === 'string') error = { ...error, ...parsed };
            } catch {
              // Keep the producer failure in the structured fallback envelope.
            }
          }
          return { ok: false as const, error };
        }
        const output = typeof args.output === 'string' ? args.output : projectRoot;
        return {
          ok: true as const,
          value: {
            root: projectRoot,
            name,
            output,
            artifacts: [`${name}.atlas.png`, `${name}.atlas.meta.json`],
            ...(stdout.length === 0 ? {} : { producer: stdout.join('\n') }),
          },
        };
      })()),
    }),
    'build',
    {
      capabilities: ['asset-atlas-producer'],
      errors: ['atlas-empty-input', 'atlas-size-exceeded', 'atlas-region-mismatch'],
      example: { input: 'assets/frames/*.png', name: 'walk', output: 'dist/assets' },
    },
  );
  const rhi = (
    operation: 'rhi.capture' | 'rhi.summary' | 'rhi.inspect' | 'rhi.read' | 'rhi.timing',
    summary: string,
  ) =>
    command(
      operation,
      operation,
      summary,
      async (args) => {
        if (operation === 'rhi.capture') {
          const liveDev = await import('../live-dev.js');
          return (await liveDev.liveDevControl(projectRoot, 'rhi/capture', args)) as CommandValue;
        }
        const { runCliRhiDebugOperation } = await import('../rhi-debug/cli-context.js');
        const outcome = await runCliRhiDebugOperation(operation, args as never);
        return outcome.ok
          ? { ok: true, value: JSON.parse(JSON.stringify(outcome.value)) }
          : { ok: false, error: outcome.error };
      },
      'host',
    );
  const profile = (
    operation: 'capture' | 'summary' | 'frame' | 'phase' | 'compare',
    summary: string,
  ) =>
    command(
      `profile.${operation}`,
      `Profile ${operation}`,
      summary,
      async (args) => {
        if (operation === 'capture') {
          const liveDev = await import('../live-dev.js');
          return (await liveDev.liveDevControl(
            projectRoot,
            'profile/capture',
            args,
          )) as CommandValue;
        }
        const { runProfilerCli } = await import('@forgeax/engine-profiler/cli');
        const input =
          operation === 'compare'
            ? ''
            : JSON.stringify((args.capture ?? args.artifact ?? args.input ?? args) as JsonValue);
        const cliArgs: string[] = [operation];
        if (operation !== 'compare' && typeof args.artifact === 'string') {
          cliArgs.push('--file', args.artifact);
        }
        if (operation === 'compare') {
          if (typeof args.leftFile === 'string') cliArgs.push('--left-file', args.leftFile);
          if (typeof args.rightFile === 'string') cliArgs.push('--right-file', args.rightFile);
        }
        if (operation === 'frame' && typeof args.frameId === 'number') {
          cliArgs.push('--frame-id', String(args.frameId));
        }
        if (operation === 'phase') {
          if (typeof args.source === 'string') cliArgs.push('--source', args.source);
          if (typeof args.phase === 'string') cliArgs.push('--phase', args.phase);
        }
        const result = runProfilerCli(cliArgs, input);
        const raw = result.exitCode === 0 ? result.stdout : result.stderr;
        let parsed: unknown = raw.trim();
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          // Preserve the owning CLI's plain diagnostic when it is not JSON.
        }
        if (result.exitCode === 0) return { ok: true, value: parsed };
        const failure =
          typeof parsed === 'object' && parsed !== null && 'error' in parsed
            ? (parsed as { readonly error: Extract<CommandValue, { readonly ok: false }>['error'] })
                .error
            : undefined;
        return {
          ok: false,
          error: failure ?? {
            code: 'profile-command-failed',
            expected: 'the profiler command to return a structured result',
            hint: 'Inspect the profile artifact and retry the same operation.',
            detail: { output: parsed },
          },
        };
      },
      operation === 'capture' ? 'host' : 'build',
    );
  const debugContributions = [
    offlinePreviewAnalysis,
    rhi('rhi.capture', 'Captures one live frame into an ArtifactRef.'),
    rhi(
      'rhi.summary',
      'Lists passes (labels, targets, draw and dispatch counts, pipeline labels; --passes, --label REGEX), work indices and missing initial contents. Needs no GPU.',
    ),
    rhi(
      'rhi.inspect',
      'Inspects one RHI work item: pipeline and bindings from the tape, pixels and outputs on a fresh replay backend.',
    ),
    rhi(
      'rhi.read',
      'Batch-reads resources or bindings at work indices as records, image stats, atlas tiles and PNGs.',
    ),
    rhi(
      'rhi.timing',
      'Replays a tape (positional or --artifact) with steady GPU restore and pipelined timestamps; prints frame union p50 with a 95% interval, drift, top passes and a preflight (GPU idle, raw timestamps) table, --json for everything. --skip for a paired cost delta, --compare BASELINE for an interleaved A/B.',
    ),
    profile('capture', 'Captures one bounded CPU profile from a live App host.'),
    profile('summary', 'Projects a profile ArtifactRef into an offline summary.'),
    profile('frame', 'Selects one frame from a profile ArtifactRef.'),
    profile('phase', 'Selects one phase from a profile ArtifactRef.'),
    profile('compare', 'Compares two profile ArtifactRefs without starting a browser.'),
  ];
  return [
    ...createOperationHistoryTools(projectRoot),
    ...createModelingTools({ projectRoot }),
    createModelRenderTool(projectRoot),
    createModelReplayTool(projectRoot),
    ...(['start', 'status', 'stop'] as const).map((operation) =>
      command(
        `backend.${operation}`,
        `Engine backend ${operation}`,
        `${operation} the Engine workspace backend independently of browsers and runs.`,
        async (args) => {
          const backend = await import('../backend-process.js');
          const selectedRoot = rootArgs(projectRoot, args).root;
          const hostPack = Reflect.get(args, 'hostPack');
          if (operation === 'start') {
            const startup = await readProjectStartupTimeoutMs(selectedRoot);
            if (!startup.ok) return startup;
            return {
              ok: true,
              value: await backend.startDevKitBackend(selectedRoot, {
                ...(typeof hostPack === 'string' ? { hostPack } : {}),
                ...(startup.value === undefined ? {} : { startupTimeoutMs: startup.value }),
              }),
            };
          }
          return {
            ok: true,
            value:
              operation === 'status'
                ? await backend.devKitBackendStatus(selectedRoot)
                : await backend.stopDevKitBackend(selectedRoot),
          };
        },
      ),
    ),
    ...createWorkspaceLiveTools(projectRoot),
    project(
      'project.new',
      'Create project',
      'Creates a project from an SDK template.',
      'newCommand',
    ),
    project(
      'project.init',
      'Initialize project',
      'Initializes the local project and its dependencies.',
      'initCommand',
    ),
    project(
      'project.check',
      'Check project',
      'Runs project diagnostics, dry-cooks authored material and particle-effect packs offline, and reports the supported HTML/CSS authoring profile without starting a live instance.',
      'doctorCommand',
    ),
    project('project.test', 'Test project', 'Runs the project test gate.', 'testCommand'),
    project(
      'project.package',
      'Package project',
      'Packages the built project for delivery.',
      'packageCommand',
    ),
    project(
      'project.preview',
      'Preview project',
      'Serves the built project for inspection.',
      'previewCommand',
    ),
    project(
      'project.capture',
      'Capture project',
      'Starts a temporary project and captures evidence.',
      'browserCaptureCommand',
    ),
    command(
      'project.play',
      'Play project',
      'Starts a temporary project (or serves its built release with --release), runs a playthrough module with real input, and verifies the final frame.',
      async (args, context) =>
        (await import('../play.js')).playCommand(rootArgs(projectRoot, args), {
          signal: context.signal,
        }),
      'build',
      {
        errors: [
          'tool-invalid-args',
          'tool-capability-unavailable',
          'play-script-invalid',
          'play-not-ready',
          'play-step-failed',
          'play-timeout',
          'play-runtime-failed',
          'tool-run-cancelled',
        ],
      },
    ),
    project(
      'project.engine.status',
      'Engine status',
      'Reports the project Engine binding.',
      'engineStatusCommand',
    ),
    project(
      'project.engine.use-local',
      'Use local Engine',
      'Binds the project to a local Engine source.',
      'engineUseLocalCommand',
    ),
    project(
      'project.engine.unlink',
      'Unlink Engine',
      'Removes the local Engine binding.',
      'engineUnlinkCommand',
    ),
    project(
      'project.engine.check',
      'Check Engine',
      'Checks the project Engine binding.',
      'engineDoctorCommand',
    ),
    project(
      'project.skill.install',
      'Install skills',
      'Installs the project skill surface.',
      'skillInstallCommand',
    ),
    project(
      'project.skill.verify',
      'Verify skills',
      'Verifies the project skill surface.',
      'skillVerifyCommand',
    ),

    project(
      'asset.import',
      'Import asset',
      'Imports a source asset through the project asset authority.',
      'assetAddCommand',
    ),
    project(
      'asset.guid',
      'Derive asset guid',
      'Prints the stable AssetGuid a Pack package id and sourceKey derive (UUIDv5), for example for material refs and effect renderer fields.',
      'assetGuidCommand',
    ),
    project(
      'asset.shader-check',
      'Check shader',
      'Checks authored shader sources.',
      'shaderCheckCommand',
    ),
    project(
      'sdk.install',
      'Install SDK',
      'Installs an SDK into a project directory.',
      'sdkInstallCommand',
    ),
    assetPreview,
    assetAtlas,
    ...debugContributions,
    start,
    live(
      'dev.status',
      'Live status',
      'Reports the current project phase, revision, frame, and unfinished evaluation.',
      'status',
    ),
    live(
      'dev.reload',
      'Reload live project',
      'Replaces the project execution environment and invalidates its old identity.',
      'reload',
    ),
    live(
      'dev.stop',
      'Stop live project',
      'Destroys the persistent page and project execution environment.',
      'stop',
    ),
    command(
      'dev.pipelines.export',
      'Export observed pipeline library',
      'Writes the current device pipeline recipes and compilation receipt for startup preparation.',
      async (args) => {
        const { exportPipelineLibrary } = await import('../pipeline-library-export.js');
        return exportPipelineLibrary(projectRoot, {
          revision: args.revision as string,
          ...(typeof args.output === 'string' ? { output: args.output } : {}),
          ...(args.limits === undefined
            ? {}
            : {
                limits: args.limits as NonNullable<
                  Parameters<typeof exportPipelineLibrary>[1]['limits']
                >,
              }),
        });
      },
      'host',
      { capabilities: ['live-instance', 'world-observation'] },
    ),
    live(
      'dev.eval',
      'Evaluate live project',
      'Evaluates through the project live inspection capability.',
      'eval',
    ),
    live(
      'dev.camera.get',
      'Get observation camera',
      'Reads transient observation camera state from the actual App realm.',
      'camera/get',
    ),
    live(
      'dev.camera.set',
      'Set observation camera',
      'Updates transient observation camera state in the actual App realm.',
      'camera/set',
    ),
    live(
      'dev.find',
      'Find scene entities',
      'Finds names and revision-bound references in the current World.',
      'find',
    ),
    live(
      'dev.pick',
      'Pick at a pixel',
      'Reports the HDR sample and the frontmost surface (entity, mesh, material, world hit; transparent surfaces included) under one canvas pixel without changing the World.',
      'pick',
    ),
    live(
      'dev.camera.release',
      'Release observation camera',
      'Returns control to the game camera.',
      'camera/release',
    ),
    live(
      'dev.focus',
      'Focus observation camera',
      'Focuses an exact name or revision-bound reference; ambiguous names fail without moving.',
      'focus',
    ),
    live(
      'dev.verify',
      'Verify live runtime',
      'Validates the exact live execution and publishes strict runtime evidence; blocked checks fail.',
      'verify',
    ),
    live(
      'dev.capture',
      'Capture live project',
      'Captures the held Page after a confirmed submitted frame.',
      'capture',
    ),
    live(
      'dev.look',
      'Look at live project',
      'Waits for the edited revision, captures fresh frames and flags a renderer error or a flat frame.',
      'look',
    ),
  ] as readonly ToolContribution[];
}
