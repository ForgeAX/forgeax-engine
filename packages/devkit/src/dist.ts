import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { sha256 } from '@forgeax/engine-types';
import { isFilesystemPathWithin } from './filesystem-path.js';
import type { BuildOptions, CommandResult, ProjectFacts } from './types.js';
import { failCommand } from './types.js';

export interface DistArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DistManifest {
  readonly schemaVersion: '1.0.0';
  /** A partial validation build never claims the default portable material set. */
  readonly materialProfile?: BuildOptions['materialProfile'];
  /** Older distributions without a target are browser distributions. */
  readonly target?: BuildOptions['target'];
  readonly project: { readonly id: string; readonly name: string };
  readonly base: string;
  readonly runtime: {
    readonly packIndexUrl: string;
    readonly shaderManifestUrl: string;
  };
  readonly artifacts: readonly DistArtifact[];
}

export function mediaType(path: string): string {
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.ogg')) return 'audio/ogg';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.ttf')) return 'font/ttf';
  if (path.endsWith('.otf')) return 'font/otf';
  if (path.endsWith('.wgsl') || path.endsWith('.glsl')) return 'text/plain';
  return 'application/octet-stream';
}

export const DIST_MANIFEST_FILE = 'forgeax-dist.json';

export function matchesArtifactBytes(
  bytes: Uint8Array,
  artifact: Pick<DistArtifact, 'bytes' | 'sha256'>,
): boolean {
  return bytes.byteLength === artifact.bytes && sha256(bytes) === artifact.sha256;
}

export function withDistBytes(
  artifact: Pick<DistArtifact, 'path' | 'mediaType'>,
  bytes: Uint8Array,
): DistArtifact {
  return { ...artifact, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function filesUnder(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(resolve(root, prefix))).sort()) {
    const path = posix.join(prefix, name);
    const info = await stat(resolve(root, path));
    if (info.isDirectory()) result.push(...(await filesUnder(root, path)));
    else if (info.isFile() && name !== DIST_MANIFEST_FILE) result.push(path);
  }
  return result;
}

/** Inventory the producer's current files before selecting a delivery transport. */
export async function collectDistArtifacts(rootInput: string): Promise<DistArtifact[]> {
  const root = resolve(rootInput);
  const paths = await filesUnder(root);
  const artifacts: DistArtifact[] = [];
  // A cooked project can contain thousands of shader artifacts. Keep the
  // manifest complete while bounding the file descriptors used to hash it.
  for (let offset = 0; offset < paths.length; offset += 32) {
    artifacts.push(
      ...(await Promise.all(
        paths
          .slice(offset, offset + 32)
          .map(async (path) =>
            withDistBytes(
              { path, mediaType: mediaType(path) },
              await readFile(resolve(root, path)),
            ),
          ),
      )),
    );
  }
  return artifacts;
}

export async function writeDistManifest(
  facts: ProjectFacts,
  base: string,
  rootInput = resolve(facts.root, 'dist'),
  target: NonNullable<BuildOptions['target']> = 'browser',
  materialProfile?: BuildOptions['materialProfile'],
): Promise<DistManifest> {
  const root = resolve(rootInput);
  const manifest = await collectDistManifest(
    facts,
    base,
    root,
    target,
    'packaged',
    materialProfile,
  );
  await publishDistManifest(root, manifest);
  return manifest;
}

export function publishDistManifest(root: string, manifest: DistManifest): Promise<void> {
  return writeFile(resolve(root, DIST_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

const DIST_LAYOUTS = {
  browser: { entries: ['index.html'], root: '', codec: '' },
  native: { entries: ['game.mjs'], root: '', codec: '' },
  tauri: { entries: ['web/index.html', 'src-tauri/tauri.conf.json'], root: 'web/', codec: '' },
  wechat: {
    entries: ['game.js', 'game.json', 'project.config.json', 'payload/game.js'],
    root: 'payload/',
    codec: '.br',
  },
} satisfies Record<
  NonNullable<DistManifest['target']>,
  { entries: string[]; root: string; codec: string }
>;

function supportsDistTarget(target: unknown): boolean {
  return typeof target === 'string' && Object.hasOwn(DIST_LAYOUTS, target);
}

/** Build an unsealed manifest for a compiled tree before target-specific packaging. */
export async function collectDistManifest(
  facts: Pick<ProjectFacts, 'id' | 'name'>,
  base: string,
  root: string,
  target: NonNullable<BuildOptions['target']>,
  placement: 'compiled' | 'packaged',
  materialProfile?: BuildOptions['materialProfile'],
): Promise<DistManifest> {
  const { root: packRoot, codec } =
    DIST_LAYOUTS[placement === 'compiled' && target === 'wechat' ? 'browser' : target];
  return {
    schemaVersion: '1.0.0',
    target,
    ...(materialProfile === undefined ? {} : { materialProfile }),
    project: { id: facts.id, name: facts.name },
    base,
    runtime: {
      packIndexUrl: `${packRoot}pack-index.json${codec}`,
      shaderManifestUrl: `${packRoot}shaders/manifest.json${codec}`,
    },
    artifacts: await collectDistArtifacts(root),
  };
}

async function invalidDistArtifact(path: string, artifact: DistManifest['artifacts'][number]) {
  const bytes = await readFile(path).catch(() => undefined);
  const missing = bytes === undefined;
  if (missing || !matchesArtifactBytes(bytes, artifact))
    return failCommand(
      missing ? 'dist-artifact-missing' : 'dist-artifact-mismatch',
      missing
        ? 'every declared dist artifact to exist'
        : 'artifact bytes and SHA-256 to match forgeax-dist.json',
      'Rebuild the complete dist; include platform HTML with build --html-head before sealing instead of modifying output.',
      { path: artifact.path },
    );
  return undefined;
}

export async function verifyDist(rootInput: string): Promise<CommandResult<DistManifest>> {
  const root = resolve(rootInput);
  let manifest: DistManifest;
  try {
    manifest = JSON.parse(
      await readFile(resolve(root, DIST_MANIFEST_FILE), 'utf8'),
    ) as DistManifest;
  } catch (cause) {
    return failCommand(
      'dist-manifest-unreadable',
      'a readable dist/forgeax-dist.json',
      'Run forgeax project build and do not edit its derived manifest.',
      { root, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  const { target = 'browser' } = manifest;
  if (
    manifest.schemaVersion !== '1.0.0' ||
    !Array.isArray(manifest.artifacts) ||
    (manifest.materialProfile !== undefined && manifest.materialProfile !== 'webgpu-storage') ||
    (manifest.materialProfile !== undefined && manifest.target === 'wechat') ||
    !supportsDistTarget(target)
  ) {
    return failCommand(
      'dist-manifest-invalid',
      'forgeax-dist schema 1.0.0',
      'Rebuild the game with a compatible ForgeAX DevKit.',
      { root },
    );
  }
  const declaredPaths = new Set(manifest.artifacts.map((artifact) => artifact.path));
  if (declaredPaths.size !== manifest.artifacts.length) {
    return failCommand(
      'dist-artifact-duplicate',
      'every dist artifact path to be declared exactly once',
      'Rebuild the derived dist manifest.',
      { root },
    );
  }
  for (const artifact of manifest.artifacts) {
    const path = resolve(root, artifact.path);
    if (!isFilesystemPathWithin(root, path)) {
      return failCommand(
        'dist-path-escape',
        'every artifact path to remain inside dist',
        'Rebuild the derived dist manifest.',
        { path: artifact.path },
      );
    }
    const invalid = await invalidDistArtifact(path, artifact);
    if (invalid !== undefined) return invalid;
  }
  for (const required of [
    ...DIST_LAYOUTS[target].entries,
    manifest.runtime.packIndexUrl,
    manifest.runtime.shaderManifestUrl,
  ]) {
    if (!declaredPaths.has(required)) {
      return failCommand(
        'dist-required-artifact-missing',
        'target entry, Pack index, and Shader manifest in the dist closure',
        'Rebuild after repairing the owning producer.',
        { path: required },
      );
    }
  }
  for (const artifactPath of await filesUnder(root)) {
    if (!declaredPaths.has(artifactPath)) {
      return failCommand(
        'dist-artifact-undeclared',
        'every file in dist to be covered by forgeax-dist.json',
        'Remove the foreign file or rebuild the complete dist.',
        { path: artifactPath },
      );
    }
  }
  return { ok: true, value: manifest };
}
