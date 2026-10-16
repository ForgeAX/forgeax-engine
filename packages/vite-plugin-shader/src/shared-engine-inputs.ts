import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  expandShaderManifestPublication,
  type MaterialShaderManifestEntry,
  SHADER_MANIFEST_PUBLICATION_VERSION,
  shaderSourceDigestInput,
} from '@forgeax/engine-shader';
import { SURFACE_SLOT_MODULE } from './engine-inputs/load-engine-shader-entries.js';
import {
  engineShaderSourceDigest,
  PACKAGED_SOURCE_RECORD,
  type PackagedSourceRecord,
} from './engine-inputs/source-digest.js';
import type { ShaderManifestPublication } from './manifest-publication.js';

export interface ShaderManifestInput {
  readonly hash: string;
  readonly wgsl: string;
  readonly bindings: string;
  readonly uvSetCount?: number;
}

/** Node publications share strict expansion and native source-byte verification. */
function readNodePublication(value: unknown): {
  entries: ShaderManifestInput[];
  materialShaders: MaterialShaderManifestEntry[];
  publication: ShaderManifestPublication;
} {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== SHADER_MANIFEST_PUBLICATION_VERSION
  ) {
    throw new Error('Unsupported shader manifest publication; rebuild shared shader inputs');
  }
  const expanded = expandShaderManifestPublication(value);
  const fragmentDigests = expanded.fragmentTable.map((fragment) =>
    createHash('sha256').update(fragment).digest(),
  );
  for (const [digest] of expanded.sourceFragments) {
    const indices = expanded.sourceIndices.get(digest) as readonly number[];
    const actual = createHash('sha256')
      .update(shaderSourceDigestInput(indices.map((index) => fragmentDigests[index] as Buffer)))
      .digest('hex');
    if (actual !== digest) throw new Error(`shader source digest mismatch: ${digest}`);
  }
  const manifest = expanded.manifest as {
    entries?: ShaderManifestInput[];
    materialShaders?: MaterialShaderManifestEntry[];
  };
  if (!Array.isArray(manifest?.entries) || !Array.isArray(manifest.materialShaders)) {
    throw new Error('shader manifest is missing rows');
  }
  return {
    entries: manifest.entries,
    materialShaders: manifest.materialShaders,
    publication: value as ShaderManifestPublication,
  };
}

/**
 * A release-input directory is only usable when it contains the engine rows
 * that the runtime boot contract consumes. An interrupted or first-time
 * source build can leave the generated manifest present but empty; treating
 * that placeholder as a successful packaged input silently suppresses the
 * source compiler and leaves the renderer without its Standard entry.
 */
export function hasUsablePackagedEngineShaderInputs(input: {
  readonly entries: readonly ShaderManifestInput[];
  readonly materialShaders: readonly MaterialShaderManifestEntry[];
}): boolean {
  return (
    input.entries.length > 0 &&
    input.materialShaders.some((entry) => entry.identifier === 'forgeax::default-standard-pbr') &&
    input.materialShaders.some((entry) => entry.identifier === 'forgeax::default-unlit')
  );
}

const reportedStaleProfiles = new Set<string>();

type PackagedEngineShaderInputs = ReturnType<typeof readNodePublication> & {
  readonly imports: Record<string, string>;
};
// One current publication per physical base/point profile. A server owns its
// authored state, while Editor, cancelled Play and replacement Play consume
// the same immutable engine fleet. Replaced profile bytes retire this entry.
const packagedEngineInputs = new Map<
  string,
  { readonly digest: string; readonly input: PackagedEngineShaderInputs }
>();

/**
 * A packaged profile is compiled output, valid only for the exact engine WGSL
 * it was prepared from. A checkout keeps a profile left by an earlier SDK or
 * Dawn preparation across source edits; using it would publish shaders whose
 * bindings no longer match the renderer, so any mismatch compiles from source.
 */
export function packagedProfileMatchesSource(
  inputRoot: string,
  shaderSourceRoot: string | undefined,
): boolean {
  let recorded: string | undefined;
  try {
    const record = JSON.parse(
      readFileSync(resolve(inputRoot, PACKAGED_SOURCE_RECORD), 'utf8'),
    ) as Partial<PackagedSourceRecord>;
    recorded = record.shaderSourceDigest;
  } catch {
    recorded = undefined;
  }
  const current =
    shaderSourceRoot === undefined ? undefined : engineShaderSourceDigest(shaderSourceRoot);
  if (recorded !== undefined && recorded === current) return true;
  if (!reportedStaleProfiles.has(inputRoot)) {
    reportedStaleProfiles.add(inputRoot);
    console.warn(
      `[forgeax-shader] packaged engine shader profile ${inputRoot} was not prepared from the current engine WGSL sources; compiling engine shaders from source. Re-prepare or delete the profile to silence this.`,
    );
  }
  return false;
}

export function loadPackagedEngineShaderInputs(
  pointShadows: boolean,
  hdrpSsao: boolean,
): PackagedEngineShaderInputs | null {
  if (process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD === '1') return null;
  const require = createRequire(import.meta.url);
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve('@forgeax/engine-vite-plugin-shader/package.json'));
  } catch {
    return null;
  }
  // SSAO is an independent utility entry, not a material compilation axis.
  const profile = `${pointShadows ? 'point' : 'base'}-ssao`;
  const inputRoot = resolve(packageRoot, 'dist/engine-inputs', profile);
  const manifestPath = resolve(inputRoot, 'manifest.json');
  const importsPath = resolve(inputRoot, 'imports.json');
  if (!existsSync(manifestPath) || !existsSync(importsPath)) return null;
  let shaderSourceRoot: string | undefined;
  try {
    shaderSourceRoot = resolve(
      dirname(require.resolve('@forgeax/engine-shader/package.json')),
      'src',
    );
  } catch {
    shaderSourceRoot = undefined;
  }
  if (!packagedProfileMatchesSource(inputRoot, shaderSourceRoot)) return null;
  const manifestBytes = readFileSync(manifestPath);
  const importBytes = readFileSync(importsPath);
  const digest = createHash('sha256')
    .update(manifestBytes)
    .update('\0')
    .update(importBytes)
    .digest('hex');
  const cached = packagedEngineInputs.get(inputRoot);
  if (cached?.digest === digest) {
    return {
      ...cached.input,
      entries: projectOptionalEngineEntries(cached.input.entries, hdrpSsao),
    };
  }
  const publication = JSON.parse(manifestBytes.toString('utf8'));
  // A profile prepared by an older transport producer is stale even when its
  // WGSL digest is unchanged. Keep the existing complete source-build fallback.
  if (
    publication.schemaVersion !== SHADER_MANIFEST_PUBLICATION_VERSION ||
    !Array.isArray(publication.receipts)
  ) {
    console.warn(
      `[forgeax-shader] packaged publication version is obsolete: ${manifestPath}; compiling from source`,
    );
    return null;
  }
  const manifest = readNodePublication(publication);
  const imports = JSON.parse(importBytes.toString('utf8')) as Record<string, string>;
  if (manifest.entries === undefined || manifest.materialShaders === undefined) {
    throw new Error(`packaged engine shader manifest is incomplete: ${manifestPath}`);
  }
  if (
    !hasUsablePackagedEngineShaderInputs(
      manifest as {
        readonly entries: ShaderManifestInput[];
        readonly materialShaders: MaterialShaderManifestEntry[];
      },
    )
  ) {
    return null;
  }
  if (typeof imports[SURFACE_SLOT_MODULE] !== 'string') {
    throw new Error(
      `packaged engine shader imports are missing ${SURFACE_SLOT_MODULE}: ${importsPath}`,
    );
  }
  const input = { ...manifest, imports };
  packagedEngineInputs.set(inputRoot, { digest, input });
  return {
    entries: projectOptionalEngineEntries(manifest.entries, hdrpSsao),
    materialShaders: manifest.materialShaders,
    imports,
    publication: manifest.publication,
  };
}

/** The source producer adds SSAO as one independent fullscreen utility. */
export function projectOptionalEngineEntries<T extends ShaderManifestInput>(
  entries: readonly T[],
  hdrpSsao: boolean,
): T[] {
  return entries.filter(
    (entry) =>
      hdrpSsao || !(entry.wgsl.includes('fs_ssao_calc') && entry.wgsl.includes('fs_ssao_blur')),
  );
}

/**
 * Projects engine and app entries into an app-local manifest. Engine entry
 * production remains shareable while app custom transforms continue to own the
 * map that is passed here.
 */
export function projectShaderManifestEntries(
  entries: ReadonlyMap<string, ShaderManifestInput>,
): Array<ShaderManifestInput & { readonly glsl: '' }> {
  // `undefined` disappears during JSON serialization, but `glsl` is a required
  // manifest field at the runtime boundary. The empty string is the declared
  // WebGPU-only placeholder and survives serialization.
  return [...entries.values()].map((entry) => ({ ...entry, glsl: '' }));
}

export async function loadSharedEngineShaderManifest(manifestPath: string): Promise<{
  readonly entries: ShaderManifestInput[];
  readonly materialShaders: MaterialShaderManifestEntry[];
  readonly publication: ShaderManifestPublication;
}> {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly schemaVersion?: number;
    readonly producer?: string;
    readonly inputFingerprint?: string;
    readonly inventory?: readonly string[];
    readonly payload?: { readonly engineShaderManifest?: string };
  };
  const path = manifest.payload?.engineShaderManifest;
  if (path === undefined)
    throw new Error(`shared shader manifest lacks serialized payload: ${manifestPath}`);
  const repositoryRoot = dirname(dirname(manifestPath));
  if (manifest.schemaVersion === 2) {
    if (manifest.producer !== 'repo-build-inputs' || manifest.inputFingerprint === undefined) {
      throw new Error(`shared shader manifest has invalid producer metadata: ${manifestPath}`);
    }
    if (!Array.isArray(manifest.inventory) || !manifest.inventory.includes(path)) {
      throw new Error(`shared shader manifest inventory does not declare ${path}: ${manifestPath}`);
    }
    for (const inventoryPath of manifest.inventory) {
      if (!existsSync(resolve(repositoryRoot, inventoryPath))) {
        throw new Error(
          `shared shader manifest inventory is missing ${inventoryPath}: ${manifestPath}`,
        );
      }
    }
  }
  return readNodePublication(JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')));
}
