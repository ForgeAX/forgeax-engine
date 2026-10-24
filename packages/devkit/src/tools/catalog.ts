import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PACK_AUTHORING_OPERATION_DESCRIPTORS,
  type PackAuthoringOperation,
  type PackAuthoringOperationResult,
} from '@forgeax/engine-pack/source';
import { Context, createToolApiPlugin, registerTools } from '@forgeax/engine-plugin';
import { PluginRealmSchema } from '@forgeax/engine-project';
import {
  capabilityUnavailableError,
  operationCommandPath,
  type ToolApi,
  type ToolApiProviderInput,
  type ToolApiRunOptions,
  type ToolContribution,
  type ToolDescriptor,
  type ToolJsonSchema,
  type ToolSchema,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import { animationPlaybackSchema } from '../animation-playback.js';
import type {
  BuildOptions,
  PluginCreateOptions,
  PluginInspectOptions,
  PluginRootOptions,
} from '../types.js';
import type { OfflineAnalysisRequest, OfflineAnalysisResult } from './offline-analysis.js';
import { nativePreviewDescriptors } from './preview-catalog.js';
import type { PreviewHostRequest, PreviewHostResult } from './preview-host.js';

export interface ToolCatalogAuthority {
  readonly authorityDigest?: string;
  readonly root?: string;
  readonly read?: () => Promise<ToolCatalogAuthoritySnapshot>;
  readonly projectionPath?: string;
}

export interface ToolCatalogAuthoritySnapshot {
  readonly authorityDigest: string;
  readonly descriptors: readonly ToolDescriptor[];
}

export interface ToolCatalogEntry
  extends Pick<ToolDescriptor, 'id' | 'title' | 'summary' | 'realm' | 'evidence'> {
  readonly path: readonly string[];
  readonly argsSchema?: string;
  readonly resultSchema?: string;
}

export interface ToolCatalog {
  readonly schemaVersion: '1.0.0';
  readonly authorityDigest: string;
  readonly digest: string;
  readonly entries: readonly ToolCatalogEntry[];
}

export type ToolCatalogLoadResult =
  | {
      readonly ok: true;
      readonly value: ToolCatalog;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'tool-catalog-authority-unreadable' | 'tool-catalog-projection-invalid';
        readonly expected: string;
        readonly hint: string;
        readonly detail: Readonly<Record<string, string>>;
      };
    };

const buildArgsSchema: ToolSchema<BuildOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected an options object' };
    const options = value as BuildOptions;
    if (options.target !== undefined && !['browser', 'wechat', 'tauri'].includes(options.target))
      return { ok: false, error: 'target must be browser, wechat or tauri' };
    if (options.appid !== undefined && !/^wx[0-9a-f]{16}$/.test(options.appid))
      return { ok: false, error: 'appid must be wx followed by 16 hexadecimal characters' };
    if (options.appid !== undefined && options.target !== 'wechat')
      return { ok: false, error: 'appid belongs to the wechat target' };

    if (options.materialProfile !== undefined && options.materialProfile !== 'webgpu-storage')
      return { ok: false, error: 'materialProfile must be webgpu-storage when provided' };
    if (options.materialProfile !== undefined && options.target === 'wechat')
      return {
        ok: false,
        error: 'webgpu-storage materialProfile requires a desktop WebGPU target',
      };

    if ('sourcemap' in value && value.sourcemap !== undefined && value.sourcemap !== 'hidden')
      return { ok: false, error: 'sourcemap must be hidden when provided' };
    return { ok: true, value: value as BuildOptions };
  },
  describe: JSON.stringify({
    type: 'object',
    properties: {
      root: { type: 'string' },
      base: { type: 'string' },
      outDir: { type: 'string' },
      target: { type: 'string', enum: ['browser', 'wechat', 'tauri'] },
      appid: { type: 'string', description: 'WeChat Mini Game AppID; omitted uses tourist mode.' },

      materialProfile: {
        type: 'string',
        enum: ['webgpu-storage'],
        description:
          'Validation-only storage-capable WebGPU raster build; omits portable fallback and ray programs.',
      },
      sourcemap: {
        type: 'string',
        enum: ['hidden'],
        description: 'Emit hidden source maps for the actual production bundles.',
      },
      json: { type: 'boolean' },
      animation: animationPlaybackSchema,
    },
  }),
};

const pluginCreateArgsSchema: ToolSchema<PluginCreateOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected plugin asset options' };
    return { ok: true, value: value as PluginCreateOptions };
  },
  describe:
    '{"type":"object","required":["path"],"additionalProperties":false,"properties":{"path":{"type":"string","description":"New .pack.ts (same-file behavior by default) or .pack.json (requires module)."},"module":{"type":"string","description":"Optional existing implementation module, relative to the Pack or an npm specifier."},"export":{"type":"string","description":"Named runtime export; defaults to plugin for same-file authoring, default for an existing module."},"packageId":{"type":"string"},"sourceKey":{"type":"string"},"config":{},"dryRun":{"type":"boolean"},"root":{"type":"string"}}}',
};

const pluginInspectArgsSchema: ToolSchema<PluginInspectOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected plugin inspect options object' };
    const id = (value as { readonly guid?: unknown }).guid;
    if (id !== undefined && typeof id !== 'string')
      return { ok: false, error: 'expected id to be a string when provided' };
    return { ok: true, value: value as PluginInspectOptions };
  },
  describe: '{"type":"object","properties":{"guid":{"type":"string"},"root":{"type":"string"}}}',
};

const pluginRootArgsSchema: ToolSchema<PluginRootOptions> = {
  parse(value) {
    if (!value || typeof value !== 'object') return { ok: false, error: 'expected root options' };
    return { ok: true, value: value as PluginRootOptions };
  },
  describe: JSON.stringify({
    type: 'object',
    required: ['realm', 'guid'],
    properties: {
      realm: { enum: PluginRealmSchema.options },
      guid: { type: ['string', 'null'] },
      root: { type: 'string' },
    },
  }),
};

const packAuthoringArgsSchema: ToolSchema<PackAuthoringOperation> = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected a Pack authoring operation object' };
    }
    const operation = value as { readonly requestId?: unknown };
    if (typeof operation.requestId !== 'string' || operation.requestId.trim().length === 0) {
      return { ok: false, error: 'requestId must be a non-empty caller-minted string' };
    }
    return { ok: true, value: value as PackAuthoringOperation };
  },
  describe:
    '{"type":"object","required":["requestId"],"properties":{"requestId":{"type":"string","minLength":1},"expectedRevision":{"type":"string"},"subject":{"type":"string"},"sourcePath":{"type":"string"},"sourceRoot":{"type":"string"},"targetPath":{"type":"string"},"packageId":{"type":"string","format":"uuid"},"parentPackageId":{"type":"string","format":"uuid"},"parent":{"type":"string","format":"uuid"},"sourceKey":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$"},"format":{"enum":["pack.ts","pack.json"]},"require":{"enum":["identity","present","ready"]},"values":{"type":"object"},"initialAssets":{"type":"object"},"parameters":{"type":"array","minItems":1}}}',
};

const packAuthoringResultSchema: ToolSchema<PackAuthoringOperationResult> = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected a Pack authoring result object' };
    }
    return { ok: true, value: value as PackAuthoringOperationResult };
  },
  describe: '{"type":"object"}',
};

const packRootSchema: ToolJsonSchema = { type: 'string' };
const packStringSchema: ToolJsonSchema = { type: 'string' };
const packBooleanSchema: ToolJsonSchema = { type: 'boolean' };

/**
 * The public asset read paths use the same schema in the command tree and
 * in their Pack domain descriptors. Keeping these JSON shapes here prevents
 * help from advertising the lower-level request envelope to CLI callers.
 */
export const assetListInputSchema: ToolJsonSchema = {
  type: 'object',
  properties: {
    root: packRootSchema,
    type: packStringSchema,
    limit: { type: 'integer', minimum: 1, maximum: 256 },
    cursor: packStringSchema,
    json: packBooleanSchema,
  },
  additionalProperties: false,
};

export const assetInspectInputSchema: ToolJsonSchema = {
  type: 'object',
  properties: {
    root: packRootSchema,
    subject: packStringSchema,
    json: packBooleanSchema,
    parametersOnly: {
      type: 'boolean',
      description:
        'Read and validate only .pack.ts parameter declarations, with generation/runtime mode, bindings and source locations. No module execution, project scan, generation or runtime target validation.',
    },
  },
  required: ['subject'],
  additionalProperties: false,
};

export const assetResolveInputSchema: ToolJsonSchema = {
  type: 'object',
  properties: {
    root: packRootSchema,
    subject: packStringSchema,
    packageId: packStringSchema,
    sourceKey: packStringSchema,
    require: { enum: ['identity', 'present', 'ready'] },
    json: packBooleanSchema,
  },
  additionalProperties: false,
};

export const assetVerifyInputSchema: ToolJsonSchema = {
  type: 'object',
  properties: { root: packRootSchema, json: packBooleanSchema },
  additionalProperties: false,
};

function packReadArgsSchemaFor(inputSchema: ToolJsonSchema): ToolSchema<PackAuthoringOperation> {
  // Read-only requests need correlation, but have no mutation replay/CAS
  // identity. Derive that correlation at the adapter instead of making CLI
  // callers mint it.
  return {
    parse(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return packAuthoringArgsSchema.parse(value);
      }
      return packAuthoringArgsSchema.parse({ requestId: randomUUID(), ...value });
    },
    describe: JSON.stringify(inputSchema),
  };
}

const operationTitles: Readonly<Record<string, string>> = {
  'asset.list': 'List Pack assets',
  'asset.inspect': 'Inspect Pack subject',
  'asset.resolve': 'Resolve Pack asset identity',
  'asset.verify': 'Verify Pack authoring',
  'asset.source.create': 'Create Pack source',
  'asset.source.clone': 'Clone Pack source closure',
  'asset.source.import': 'Import Pack source closure',
  'asset.source.instance.create': 'Create Pack instance',
  'asset.source.values.apply': 'Apply Pack instance values',
  'asset.source.rebuild': 'Rebuild Pack source',
  'asset.source.cold-cook': 'Cold-cook Pack source',
};

const PACK_READ_OPERATIONS: ReadonlySet<string> = new Set([
  'asset.list',
  'asset.inspect',
  'asset.resolve',
  'asset.verify',
]);

/** The Pack domain owns these descriptors; DevKit only projects them. */
export const packAuthoringToolDescriptors: readonly ToolDescriptor[] =
  PACK_AUTHORING_OPERATION_DESCRIPTORS.map((operation) => ({
    id: operation.id,
    path: operationCommandPath(operation.id),
    title: operationTitles[operation.id] ?? operation.id,
    // The input schema, not the Pack readOnly flag, separates adapter-correlated
    // reads from mutations that need caller requestId and revision CAS.
    summary: PACK_READ_OPERATIONS.has(operation.id)
      ? `${operationTitles[operation.id] ?? operation.id}.`
      : `${operationTitles[operation.id] ?? 'Runs the Pack authoring gateway'} with requestId and revision CAS semantics.`,
    realm: 'build' as const,
    argsSchema:
      operation.id === 'asset.list'
        ? packReadArgsSchemaFor(assetListInputSchema)
        : operation.id === 'asset.inspect'
          ? packReadArgsSchemaFor(assetInspectInputSchema)
          : operation.id === 'asset.resolve'
            ? packReadArgsSchemaFor(assetResolveInputSchema)
            : operation.id === 'asset.verify'
              ? packReadArgsSchemaFor(assetVerifyInputSchema)
              : packAuthoringArgsSchema,
    resultSchema: packAuthoringResultSchema,
    evidence: [],
  }));

const previewArgsSchema: ToolSchema<PreviewHostRequest> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected a preview request object' };
    const request = value as { readonly recipe?: unknown };
    if (request.recipe === undefined || typeof request.recipe !== 'object')
      return { ok: false, error: 'expected recipe in the preview request' };
    return { ok: true, value: value as PreviewHostRequest };
  },
  describe:
    '{"type":"object","required":["recipe"],"properties":{"recipe":{"type":"object","required":["snapshot"],"properties":{"snapshot":{"type":"object","required":["revision","digest"]},"backend":{"const":"webgpu"},"presentation":{"enum":["hidden","visible"]},"viewport":{"type":"object","properties":{"width":{"type":"integer","minimum":1},"height":{"type":"integer","minimum":1}}},"actions":{"type":"array","items":{"type":"object","required":["frame","name"],"properties":{"frame":{"type":"integer","minimum":0},"name":{"type":"string","minLength":1},"value":{}}}},"deltaSeconds":{"type":"number","minimum":0},"frames":{"type":"integer","minimum":1}}}}}',
};

const resultSchema: ToolSchema<unknown> = {
  parse: (value) => ({ ok: true, value }),
  describe: '{"type":"object"}',
};

const offlineAnalysisArgsSchema: ToolSchema<OfflineAnalysisRequest> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected an offline analysis request object' };
    const request = value as { readonly manifest?: unknown };
    if (request.manifest === undefined || typeof request.manifest !== 'object')
      return { ok: false, error: 'expected manifest in the offline analysis request' };
    return { ok: true, value: value as OfflineAnalysisRequest };
  },
  describe:
    '{"type":"object","required":["manifest"],"properties":{"manifest":{"type":"object","required":["schemaVersion","identity","artifacts"]},"required":{"type":"array","items":{"enum":["rhi-tape","png","profile-capture"]}}}}',
};

export const pluginMigrationDescriptor: ToolDescriptor<
  import('../plugin/migration.js').PluginMigrationOptions,
  unknown
> = {
  id: 'project.migrate',
  path: ['project', 'migrate'],
  title: 'Migrate plugin assets',
  summary: 'Converts a static schema 2 project into a validated schema 3 candidate directory.',
  realm: 'build',
  evidence: [],
  resultSchema,
  argsSchema: {
    parse(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as { output?: unknown }).output !== 'string'
      )
        return { ok: false, error: 'output is required' };
      return { ok: true, value: value as import('../plugin/migration.js').PluginMigrationOptions };
    },
    describe:
      '{"type":"object","required":["output"],"properties":{"output":{"type":"string"},"root":{"type":"string"}}}',
  },
};

export const projectBuildDescriptor: ToolDescriptor<BuildOptions, unknown> = {
  id: 'project.build',
  path: operationCommandPath('project.build'),
  title: 'Build project',
  summary: 'Builds the project through the existing Vite and Pack authorities.',
  realm: 'build',
  argsSchema: buildArgsSchema,
  resultSchema,
  evidence: [],
};
export const authorPluginCreateDescriptor: ToolDescriptor<PluginCreateOptions, unknown> = {
  id: 'asset.plugin.create',
  path: operationCommandPath('asset.plugin.create'),
  title: 'Create plugin asset',
  summary: 'Creates a same-file .pack.ts behavior, or a Pack referencing an existing module.',
  realm: 'build',
  argsSchema: pluginCreateArgsSchema,
  resultSchema,
  evidence: [],
};
export const authorPluginInspectDescriptor: ToolDescriptor<PluginInspectOptions, unknown> = {
  id: 'asset.plugin.inspect',
  path: operationCommandPath('asset.plugin.inspect'),
  title: 'Inspect project plugins',
  summary: 'Inspects source plugin definitions and project root references.',
  realm: 'build',
  argsSchema: pluginInspectArgsSchema,
  resultSchema,
  evidence: [],
};
export const authorPluginRootDescriptor: ToolDescriptor<PluginRootOptions, unknown> = {
  id: 'project.root.set',
  path: ['project', 'root', 'set'],
  title: 'Set project root',
  summary: 'References a plugin asset in one realm; null removes the root reference.',
  realm: 'build',
  argsSchema: pluginRootArgsSchema,
  resultSchema,
  evidence: [],
};
export const previewRunDescriptor: ToolDescriptor<PreviewHostRequest, PreviewHostResult> = {
  id: 'preview.run',
  path: operationCommandPath('preview.run'),
  title: 'Run hidden WebGPU preview',
  summary: 'Runs one fixed real-WebGPU preview recipe and returns structured evidence refs.',
  realm: 'host',
  argsSchema: previewArgsSchema,
  resultSchema: resultSchema as ToolDescriptor<
    PreviewHostRequest,
    PreviewHostResult
  >['resultSchema'],
  evidence: ['rhi-tape', 'png', 'profile-capture'],
};
export const previewOfflineAnalysisDescriptor: ToolDescriptor<
  OfflineAnalysisRequest,
  OfflineAnalysisResult
> = {
  id: 'preview.analyze',
  path: operationCommandPath('preview.analyze'),
  title: 'Analyze preview artifacts',
  summary: 'Validates owner-separated evidence identity before offline consumption.',
  realm: 'build',
  argsSchema: offlineAnalysisArgsSchema,
  resultSchema: resultSchema as ToolSchema<OfflineAnalysisResult>,
  evidence: ['rhi-tape', 'png', 'profile-capture'],
};

export const defaultToolDescriptors: readonly ToolDescriptor[] = [
  projectBuildDescriptor,
  authorPluginCreateDescriptor,
  authorPluginRootDescriptor,
  pluginMigrationDescriptor,
  authorPluginInspectDescriptor,
  ...packAuthoringToolDescriptors,
  ...nativePreviewDescriptors,
];

function projectDescriptor(descriptor: ToolDescriptor): ToolCatalogEntry {
  return {
    id: descriptor.id,
    path: descriptor.path ?? operationCommandPath(descriptor.id),
    title: descriptor.title,
    summary: descriptor.summary,
    realm: descriptor.realm,
    evidence: [...descriptor.evidence],
    ...(descriptor.argsSchema.describe === undefined
      ? {}
      : { argsSchema: descriptor.argsSchema.describe }),
    ...(descriptor.resultSchema.describe === undefined
      ? {}
      : { resultSchema: descriptor.resultSchema.describe }),
  };
}

export interface ToolRealmOwner
  extends Pick<ToolApiProviderInput, 'realm' | 'module'>,
    Partial<Pick<ToolApiProviderInput, 'sourceId' | 'providerId'>> {
  readonly contributions: ToolApiProviderInput['tools'];
}

export interface ToolRealmDispatch {
  readonly list: () => readonly ToolDescriptor[];
  readonly describe: (id: string) => ToolDescriptor | undefined;
  readonly run: <TResult = unknown>(
    id: string,
    args: unknown,
    options?: ToolApiRunOptions,
  ) => Promise<ToolTerminal<TResult>>;
  /** Disposes only the owner Fibers created for this dispatch. */
  readonly dispose: () => Promise<void>;
}

function missingRealmOwner<TResult>(
  descriptor: ToolDescriptor | undefined,
  id: string,
): ToolTerminal<TResult> {
  const realm = descriptor?.realm ?? 'build';
  return {
    outcome: 'failed',
    failure: capabilityUnavailableError(`realm:${realm}:tool:${id}`, realm),
    artifacts: [],
  } as ToolTerminal<TResult>;
}

/**
 * Dispatches descriptors through real Cordis native plugin tool owners.
 *
 * A realm is only an execution classification. Multiple owners may publish the
 * same operation from different sources; callers must route those operations
 * explicitly through the source/provider pair returned by the owner contract.
 */
export function createRealmDispatch(
  contributions: readonly ToolContribution[],
  owners: readonly ToolRealmOwner[],
): ToolRealmDispatch {
  const contributionById = new Map<string, ToolContribution[]>();
  for (const contribution of contributions) {
    const matches = contributionById.get(contribution.descriptor.id) ?? [];
    matches.push(contribution);
    contributionById.set(contribution.descriptor.id, matches);
  }
  for (const owner of owners) {
    const invalid = owner.contributions.find(
      (contribution) => contribution.descriptor.realm !== owner.realm,
    );
    if (invalid !== undefined) {
      throw new TypeError(
        `Tool ${invalid.descriptor.id} declares ${invalid.descriptor.realm} but owner is ${owner.realm}`,
      );
    }
  }
  const ownerContext = new Context();
  const ownerFibers: Array<{ dispose: () => Promise<unknown> }> = [];
  const routesById = new Map<string, Array<{ providerId: string; sourceId: string }>>();
  const providerInputs = owners.map((owner, index) => ({
    owner,
    index,
    providerId:
      owner.providerId ?? `devkit-realm-owner:${owner.realm}:${index}:${crypto.randomUUID()}`,
    sourceId: owner.sourceId ?? `devkit-realm-source:${owner.realm}:${index}`,
  }));
  const ready = (async (): Promise<ToolApi> => {
    await ownerContext.plugin(createToolApiPlugin());
    const api = ownerContext.get('toolApi', false) as ToolApi | undefined;
    if (api === undefined) throw new Error('realm dispatch owner did not install ToolApi');
    for (const { owner, index, providerId, sourceId } of providerInputs) {
      if (owner.contributions.length === 0) continue;
      const bound = {
        name: `forgeax:realm-dispatch/${owner.realm}/${index}`,
        inject: ['toolApi'],
        apply(ctx: Context) {
          ctx.effect(() =>
            registerTools(ctx, owner.contributions, {
              sourceId,
              providerId,
              module: owner.module ?? '@forgeax/engine-devkit',
              realm: owner.realm,
            }),
          );
        },
      };
      const fiber = await ownerContext.plugin(bound);
      ownerFibers.push(fiber);
      for (const contribution of owner.contributions) {
        const routes = routesById.get(contribution.descriptor.id) ?? [];
        routes.push({ providerId, sourceId });
        routesById.set(contribution.descriptor.id, routes);
      }
    }
    return api;
  })();
  return {
    list: () => contributions.map((contribution) => contribution.descriptor),
    describe: (id) => {
      const matches = contributionById.get(id) ?? [];
      return matches.length === 1 ? matches[0]?.descriptor : undefined;
    },
    async run<TResult = unknown>(id: string, args: unknown, options: ToolApiRunOptions = {}) {
      const matches = contributionById.get(id);
      if (matches === undefined || matches.length === 0)
        return missingRealmOwner(undefined, id) as ToolTerminal<TResult>;
      const api = await ready;
      const routes = routesById.get(id) ?? [];
      if (routes.length === 0) {
        return missingRealmOwner(matches[0]?.descriptor, id) as ToolTerminal<TResult>;
      }
      const explicitRoute =
        options.providerId === undefined || options.sourceId === undefined
          ? undefined
          : routes.find(
              (route) =>
                route.providerId === options.providerId && route.sourceId === options.sourceId,
            );
      const route =
        options.providerId !== undefined || options.sourceId !== undefined
          ? explicitRoute
          : routes.length === 1
            ? routes[0]
            : undefined;
      const runOptions: ToolApiRunOptions =
        route === undefined
          ? options
          : {
              ...options,
              providerId: route.providerId,
              sourceId: route.sourceId,
            };
      return (await api.run<TResult>(id, args, runOptions).terminal) as ToolTerminal<TResult>;
    },
    async dispose() {
      try {
        await ready;
      } finally {
        for (const fiber of [...ownerFibers].reverse()) await fiber.dispose();
        ownerFibers.length = 0;
        await ownerContext.fiber.dispose();
      }
    },
  };
}

function requiredAuthorityDigest(authority: ToolCatalogAuthority): string {
  if (authority.authorityDigest === undefined) {
    throw new TypeError('Catalog materialization requires an authority digest');
  }
  return authority.authorityDigest;
}

function digestCatalog(authorityDigest: string, entries: readonly ToolCatalogEntry[]): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ authorityDigest, entries }))
    .digest('hex')}`;
}

function digestAuthority(bytes: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const value of bytes) hash.update(value);
  return `sha256:${hash.digest('hex')}`;
}

function projectionValid(
  catalog: unknown,
  authorityDigest: string,
  descriptors: readonly ToolDescriptor[] = defaultToolDescriptors,
): catalog is ToolCatalog {
  if (catalog === null || typeof catalog !== 'object') return false;
  const value = catalog as Partial<ToolCatalog>;
  const expectedEntries = descriptors
    .map(projectDescriptor)
    .sort((left, right) => left.id.localeCompare(right.id));
  return (
    value.schemaVersion === '1.0.0' &&
    value.authorityDigest === authorityDigest &&
    Array.isArray(value.entries) &&
    JSON.stringify(value.entries) === JSON.stringify(expectedEntries) &&
    value.digest === digestCatalog(authorityDigest, value.entries as ToolCatalogEntry[])
  );
}

export function createProjectToolCatalogAuthority(
  rootInput: string,
  descriptors: readonly ToolDescriptor[] = defaultToolDescriptors,
): ToolCatalogAuthority {
  const root = resolve(rootInput);
  return {
    root,
    projectionPath: resolve(root, '.forgeax/generated/tool-catalog.json'),
    async read() {
      const [forge, packageJson] = await Promise.all([
        readFile(resolve(root, 'forge.json')),
        readFile(resolve(root, 'package.json')),
      ]);
      return { authorityDigest: digestAuthority([forge, packageJson]), descriptors };
    },
  };
}

export async function loadToolCatalog(
  authority: ToolCatalogAuthority,
  descriptors: readonly ToolDescriptor[] = defaultToolDescriptors,
): Promise<ToolCatalogLoadResult> {
  const read = authority.read;
  if (read === undefined) {
    if (authority.authorityDigest === undefined) {
      return {
        ok: false,
        error: {
          code: 'tool-catalog-authority-unreadable',
          expected: 'an injectable project authority reader',
          hint: 'Create a project authority from a real project root before listing tools.',
          detail: { reason: 'authority reader is missing' },
        },
      };
    }
    return { ok: true, value: materializeToolDescriptorCatalog(descriptors, authority) };
  }
  let snapshot: ToolCatalogAuthoritySnapshot;
  try {
    snapshot = await read();
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'tool-catalog-authority-unreadable',
        expected: 'project authority files to be readable',
        hint: 'Repair forge.json and package.json, then retry catalog rebuild.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
  const projectionPath = authority.projectionPath;
  if (projectionPath !== undefined) {
    try {
      const current = JSON.parse(await readFile(projectionPath, 'utf8')) as unknown;
      if (projectionValid(current, snapshot.authorityDigest, snapshot.descriptors)) {
        return { ok: true, value: current };
      }
    } catch {
      // Missing or corrupt projections are rebuilt from the authority below.
    }
  }
  const catalog = materializeToolDescriptorCatalog(snapshot.descriptors, {
    authorityDigest: snapshot.authorityDigest,
  });
  if (projectionPath !== undefined) {
    try {
      await mkdir(resolve(projectionPath, '..'), { recursive: true });
      await writeFile(projectionPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'tool-catalog-projection-invalid',
          expected: 'the generated catalog projection to be writable',
          hint: 'Restore write access to .forgeax/generated and retry cold rebuild.',
          detail: { reason: cause instanceof Error ? cause.message : String(cause) },
        },
      };
    }
  }
  return { ok: true, value: catalog };
}

export function materializeToolCatalog<TArgs, TResult>(
  contributions: readonly ToolContribution<TArgs, TResult>[],
  authority: ToolCatalogAuthority,
): ToolCatalog;
export function materializeToolCatalog(
  contributions: readonly unknown[],
  authority: ToolCatalogAuthority,
): ToolCatalog;
export function materializeToolCatalog(
  contributions: readonly unknown[],
  authority: ToolCatalogAuthority,
): ToolCatalog {
  const entries = contributions
    .map((candidate) => {
      if (typeof candidate !== 'object' || candidate === null)
        throw new TypeError('Invalid tool contribution');
      return projectDescriptor((candidate as ToolContribution<unknown, unknown>).descriptor);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const authorityDigest = requiredAuthorityDigest(authority);
  return {
    schemaVersion: '1.0.0',
    authorityDigest,
    digest: digestCatalog(authorityDigest, entries),
    entries,
  };
}

export function materializeToolDescriptorCatalog(
  descriptors: readonly ToolDescriptor[],
  authority: ToolCatalogAuthority,
): ToolCatalog {
  const entries = descriptors
    .map(projectDescriptor)
    .sort((left, right) => left.id.localeCompare(right.id));
  const authorityDigest = requiredAuthorityDigest(authority);
  return {
    schemaVersion: '1.0.0',
    authorityDigest,
    digest: digestCatalog(authorityDigest, entries),
    entries,
  };
}

export function rebuildToolCatalog<TArgs, TResult>(
  contributions: readonly ToolContribution<TArgs, TResult>[],
  current: ToolCatalog | undefined,
  authority: ToolCatalogAuthority,
): ToolCatalog;
export function rebuildToolCatalog(
  contributions: readonly unknown[],
  current: ToolCatalog | undefined,
  authority: ToolCatalogAuthority,
): ToolCatalog {
  if (
    current !== undefined &&
    authority.authorityDigest !== undefined &&
    current.authorityDigest === authority.authorityDigest &&
    projectionValid(current, authority.authorityDigest)
  )
    return current;
  if (authority.authorityDigest === undefined) {
    throw new TypeError('Catalog rebuild requires an authority digest');
  }
  return materializeToolCatalog(contributions, authority);
}

export function listTools(catalog: ToolCatalog): readonly ToolCatalogEntry[] {
  return catalog.entries;
}

export function describeTool(catalog: ToolCatalog, id: string): ToolCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id);
}
