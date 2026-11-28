import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PluginRealmSchema } from '@forgeax/engine-project';
import {
  operationCommandPath,
  type ToolContribution,
  type ToolDescriptor,
  type ToolSchema,
} from '@forgeax/engine-tool-runtime';
import { sha256 } from '@forgeax/engine-types';
import { animationPlaybackSchema } from '../animation-playback.js';
import type {
  BuildOptions,
  PluginCreateOptions,
  PluginInspectOptions,
  PluginRootOptions,
} from '../types.js';
import { failCommand } from '../types.js';
import type { OfflineAnalysisRequest, OfflineAnalysisResult } from './offline-analysis.js';
import { packAuthoringToolDescriptors } from './pack-contributions.js';
import { nativePreviewDescriptors } from './preview-catalog.js';
import type { PreviewHostRequest, PreviewHostResult } from './preview-host.js';

export {
  assetInspectInputSchema,
  assetListInputSchema,
  assetResolveInputSchema,
  assetVerifyInputSchema,
  packAuthoringToolDescriptors,
} from './pack-contributions.js';

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

function buildTargetError(options: BuildOptions): string | undefined {
  if (
    options.target !== undefined &&
    !['browser', 'wechat', 'tauri', 'native'].includes(options.target)
  )
    return 'target must be browser, wechat, tauri or native';
  if ((options.platform !== undefined || options.arch !== undefined) && options.target !== 'native')
    return 'platform and arch belong to the native build target';
  if (options.platform !== undefined && !['windows', 'macos', 'linux'].includes(options.platform))
    return 'platform must be windows, macos or linux';
  if (options.arch !== undefined && !['x64', 'arm64'].includes(options.arch))
    return 'arch must be x64 or arm64';
  if (options.appid !== undefined && !/^wx[0-9a-f]{16}$/.test(options.appid))
    return 'appid must be wx followed by 16 hexadecimal characters';
  if (options.appid !== undefined && options.target !== 'wechat')
    return 'appid belongs to the wechat target';
  return undefined;
}

const buildArgsSchema: ToolSchema<BuildOptions> = {
  parse(value) {
    if (value === null || typeof value !== 'object')
      return { ok: false, error: 'expected an options object' };
    const options = value as BuildOptions;
    const targetError = buildTargetError(options);
    if (targetError !== undefined) return { ok: false, error: targetError };
    if (options.materialProfile !== undefined && options.materialProfile !== 'webgpu-storage')
      return { ok: false, error: 'materialProfile must be webgpu-storage when provided' };
    if (options.materialProfile !== undefined && options.target === 'wechat')
      return {
        ok: false,
        error: 'webgpu-storage materialProfile requires a desktop WebGPU target',
      };

    if (
      options.htmlHead !== undefined &&
      (typeof options.htmlHead !== 'string' || options.htmlHead.trim().length === 0)
    )
      return { ok: false, error: 'htmlHead must be a non-empty project-relative file path' };
    if ('sourcemap' in value && value.sourcemap !== undefined && value.sourcemap !== 'hidden')
      return { ok: false, error: 'sourcemap must be hidden when provided' };
    if (
      'viewportDebugView' in value &&
      value.viewportDebugView !== undefined &&
      typeof value.viewportDebugView !== 'boolean'
    )
      return { ok: false, error: 'viewportDebugView must be a boolean when provided' };
    return { ok: true, value: value as BuildOptions };
  },
  describe: JSON.stringify({
    type: 'object',
    properties: {
      root: { type: 'string' },
      base: { type: 'string' },
      outDir: { type: 'string' },
      target: { type: 'string', enum: ['browser', 'wechat', 'tauri', 'native'] },
      platform: { type: 'string', enum: ['windows', 'macos', 'linux'] },
      arch: { type: 'string', enum: ['x64', 'arm64'] },
      appid: { type: 'string', description: 'WeChat Mini Game AppID; omitted uses tourist mode.' },

      materialProfile: {
        type: 'string',
        enum: ['webgpu-storage'],
        description:
          'Validation-only storage-capable WebGPU raster build; omits portable fallback and ray programs.',
      },
      htmlHead: {
        type: 'string',
        description:
          'Project-relative HTML head fragment applied before dist is sealed. Use inline content or absolute platform URLs.',
      },
      sourcemap: {
        type: 'string',
        enum: ['hidden'],
        description: 'Emit hidden source maps for the actual production bundles.',
      },
      viewportDebugView: {
        type: 'boolean',
        description:
          'Opt in to bundling the viewport debug output visualizer into the built game (default false; tree-shaken out when omitted).',
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

function objectFieldSchema<T>(
  key: string,
  expectedRequest: string,
  expectedField: string,
  describe: string,
): ToolSchema<T> {
  return {
    parse(value) {
      if (value === null || typeof value !== 'object') return { ok: false, error: expectedRequest };
      if (typeof Reflect.get(value, key) !== 'object') return { ok: false, error: expectedField };
      return { ok: true, value: value as T };
    },
    describe,
  };
}

const previewArgsSchema = objectFieldSchema<PreviewHostRequest>(
  'recipe',
  'expected a preview request object',
  'expected recipe in the preview request',
  '{"type":"object","required":["recipe"],"properties":{"recipe":{"type":"object","required":["snapshot"],"properties":{"snapshot":{"type":"object","required":["revision","digest"]},"backend":{"const":"webgpu"},"presentation":{"enum":["hidden","visible"]},"viewport":{"type":"object","properties":{"width":{"type":"integer","minimum":1},"height":{"type":"integer","minimum":1}}},"actions":{"type":"array","items":{"type":"object","required":["frame","name"],"properties":{"frame":{"type":"integer","minimum":0},"name":{"type":"string","minLength":1},"value":{}}}},"deltaSeconds":{"type":"number","minimum":0},"frames":{"type":"integer","minimum":1}}}}}',
);

const resultSchema: ToolSchema<unknown> = {
  parse: (value) => ({ ok: true, value }),
  describe: '{"type":"object"}',
};

const offlineAnalysisArgsSchema = objectFieldSchema<OfflineAnalysisRequest>(
  'manifest',
  'expected an offline analysis request object',
  'expected manifest in the offline analysis request',
  '{"type":"object","required":["manifest"],"properties":{"manifest":{"type":"object","required":["schemaVersion","identity","artifacts"]},"required":{"type":"array","items":{"enum":["rhi-tape","png","profile-capture"]}}}}',
);

function projectToolDescriptor<T>(
  id: string,
  title: string,
  summary: string,
  argsSchema: ToolSchema<T>,
): ToolDescriptor<T, unknown> {
  return {
    id,
    path: operationCommandPath(id),
    title,
    summary,
    realm: 'build',
    argsSchema,
    resultSchema,
    evidence: [],
  };
}

export const pluginMigrationDescriptor = projectToolDescriptor<
  import('../plugin/migration.js').PluginMigrationOptions
>(
  'project.migrate',
  'Migrate plugin assets',
  'Converts a static schema 2 project into a validated schema 3 candidate directory.',
  {
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
);
export const projectBuildDescriptor = projectToolDescriptor(
  'project.build',
  'Build project',
  'Builds the project through the existing Vite and Pack authorities.',
  buildArgsSchema,
);
export const authorPluginCreateDescriptor = projectToolDescriptor(
  'asset.plugin.create',
  'Create plugin asset',
  'Creates a same-file .pack.ts behavior, or a Pack referencing an existing module.',
  pluginCreateArgsSchema,
);
export const authorPluginInspectDescriptor = projectToolDescriptor(
  'asset.plugin.inspect',
  'Inspect project plugins',
  'Inspects source plugin definitions and project root references.',
  pluginInspectArgsSchema,
);
export const authorPluginRootDescriptor = projectToolDescriptor(
  'project.root.set',
  'Set project root',
  'References a plugin asset in one realm; null removes the root reference.',
  pluginRootArgsSchema,
);
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

function requiredAuthorityDigest(authority: ToolCatalogAuthority): string {
  if (authority.authorityDigest === undefined) {
    throw new TypeError('Catalog materialization requires an authority digest');
  }
  return authority.authorityDigest;
}

function digestCatalog(authorityDigest: string, entries: readonly ToolCatalogEntry[]): string {
  return `sha256:${sha256(JSON.stringify({ authorityDigest, entries }))}`;
}

function digestAuthority(bytes: readonly Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const value of bytes) hash.update(value);
  return `sha256:${hash.digest('hex')}`;
}

function projectionValid(catalog: unknown, expected: ToolCatalog): catalog is ToolCatalog {
  if (catalog === null || typeof catalog !== 'object') return false;
  const value = catalog as Partial<ToolCatalog>;
  return (
    value.schemaVersion === expected.schemaVersion &&
    value.authorityDigest === expected.authorityDigest &&
    Array.isArray(value.entries) &&
    JSON.stringify(value.entries) === JSON.stringify(expected.entries) &&
    value.digest === expected.digest
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

function catalogLoadFailure(
  code: Extract<ToolCatalogLoadResult, { ok: false }>['error']['code'],
  expected: string,
  hint: string,
  cause: unknown,
): ToolCatalogLoadResult {
  return failCommand(code, expected, hint, {
    reason: cause instanceof Error ? cause.message : String(cause),
  });
}

export async function loadToolCatalog(
  authority: ToolCatalogAuthority,
  descriptors: readonly ToolDescriptor[] = defaultToolDescriptors,
): Promise<ToolCatalogLoadResult> {
  const read = authority.read;
  if (read === undefined) {
    if (authority.authorityDigest === undefined) {
      return catalogLoadFailure(
        'tool-catalog-authority-unreadable',
        'an injectable project authority reader',
        'Create a project authority from a real project root before listing tools.',
        'authority reader is missing',
      );
    }
    return { ok: true, value: materializeToolDescriptorCatalog(descriptors, authority) };
  }
  let snapshot: ToolCatalogAuthoritySnapshot;
  try {
    snapshot = await read();
  } catch (cause) {
    return catalogLoadFailure(
      'tool-catalog-authority-unreadable',
      'project authority files to be readable',
      'Repair forge.json and package.json, then retry catalog rebuild.',
      cause,
    );
  }
  const catalog = materializeToolDescriptorCatalog(snapshot.descriptors, {
    authorityDigest: snapshot.authorityDigest,
  });
  const projectionPath = authority.projectionPath;
  if (projectionPath !== undefined) {
    try {
      const current = JSON.parse(await readFile(projectionPath, 'utf8')) as unknown;
      if (projectionValid(current, catalog)) return { ok: true, value: current };
    } catch {
      // Missing or corrupt projections are rebuilt from the authority below.
    }
    try {
      await mkdir(resolve(projectionPath, '..'), { recursive: true });
      await writeFile(projectionPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    } catch (cause) {
      return catalogLoadFailure(
        'tool-catalog-projection-invalid',
        'the generated catalog projection to be writable',
        'Restore write access to .forgeax/generated and retry cold rebuild.',
        cause,
      );
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
  const entries = contributions.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null)
      throw new TypeError('Invalid tool contribution');
    return projectDescriptor((candidate as ToolContribution<unknown, unknown>).descriptor);
  });
  return finishToolCatalog(entries, authority);
}

export function materializeToolDescriptorCatalog(
  descriptors: readonly ToolDescriptor[],
  authority: ToolCatalogAuthority,
): ToolCatalog {
  return finishToolCatalog(descriptors.map(projectDescriptor), authority);
}

function finishToolCatalog(
  entries: ToolCatalogEntry[],
  authority: ToolCatalogAuthority,
): ToolCatalog {
  entries.sort((left, right) => left.id.localeCompare(right.id));
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
  if (authority.authorityDigest === undefined) {
    throw new TypeError('Catalog rebuild requires an authority digest');
  }
  const expected = materializeToolCatalog(contributions, authority);
  return projectionValid(current, expected) ? current : expected;
}

export function listTools(catalog: ToolCatalog): readonly ToolCatalogEntry[] {
  return catalog.entries;
}

export function describeTool(catalog: ToolCatalog, id: string): ToolCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id);
}
