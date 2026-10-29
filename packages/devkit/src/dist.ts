import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { isFilesystemPathWithin } from './filesystem-path.js';
import type { BuildOptions, CommandResult, ProjectFacts } from './types.js';

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

async function filesUnder(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await stat(path);
    if (info.isDirectory()) result.push(...(await filesUnder(root, path)));
    else if (info.isFile() && name !== 'forgeax-dist.json') result.push(path);
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
        paths.slice(offset, offset + 32).map(async (path): Promise<DistArtifact> => {
          const bytes = await readFile(path);
          return {
            path: relative(root, path).split(sep).join('/'),
            mediaType: mediaType(path),
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        }),
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
  const artifacts = await collectDistArtifacts(root);
  const manifest: DistManifest = {
    schemaVersion: '1.0.0',
    target,
    ...(materialProfile === undefined ? {} : { materialProfile }),
    project: { id: facts.id, name: facts.name },
    base,
    runtime: {
      packIndexUrl:
        target === 'wechat'
          ? 'payload/pack-index.json.br'
          : target === 'tauri'
            ? 'web/pack-index.json'
            : 'pack-index.json',
      shaderManifestUrl:
        target === 'wechat'
          ? 'payload/shaders/manifest.json.br'
          : target === 'tauri'
            ? 'web/shaders/manifest.json'
            : 'shaders/manifest.json',
    },
    artifacts,
  };
  await writeFile(resolve(root, 'forgeax-dist.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyDist(rootInput: string): Promise<CommandResult<DistManifest>> {
  const root = resolve(rootInput);
  let manifest: DistManifest;
  try {
    manifest = JSON.parse(
      await readFile(resolve(root, 'forgeax-dist.json'), 'utf8'),
    ) as DistManifest;
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'dist-manifest-unreadable',
        expected: 'a readable dist/forgeax-dist.json',
        hint: 'Run forgeax project build and do not edit its derived manifest.',
        detail: { root, reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
  if (
    manifest.schemaVersion !== '1.0.0' ||
    !Array.isArray(manifest.artifacts) ||
    (manifest.materialProfile !== undefined && manifest.materialProfile !== 'webgpu-storage') ||
    (manifest.materialProfile !== undefined && manifest.target === 'wechat') ||
    (manifest.target !== undefined && !['browser', 'wechat', 'tauri'].includes(manifest.target))
  ) {
    return {
      ok: false,
      error: {
        code: 'dist-manifest-invalid',
        expected: 'forgeax-dist schema 1.0.0',
        hint: 'Rebuild the game with a compatible ForgeaX DevKit.',
        detail: { root },
      },
    };
  }
  const declaredPaths = new Set(manifest.artifacts.map((artifact) => artifact.path));
  if (declaredPaths.size !== manifest.artifacts.length) {
    return {
      ok: false,
      error: {
        code: 'dist-artifact-duplicate',
        expected: 'every dist artifact path to be declared exactly once',
        hint: 'Rebuild the derived dist manifest.',
        detail: { root },
      },
    };
  }
  for (const artifact of manifest.artifacts) {
    const path = resolve(root, artifact.path);
    if (!isFilesystemPathWithin(root, path)) {
      return {
        ok: false,
        error: {
          code: 'dist-path-escape',
          expected: 'every artifact path to remain inside dist',
          hint: 'Rebuild the derived dist manifest.',
          detail: { path: artifact.path },
        },
      };
    }
    try {
      const bytes = await readFile(path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.byteLength !== artifact.bytes || digest !== artifact.sha256) {
        return {
          ok: false,
          error: {
            code: 'dist-artifact-mismatch',
            expected: 'artifact bytes and SHA-256 to match forgeax-dist.json',
            hint: 'Rebuild the complete dist; include platform HTML with build --html-head before sealing instead of modifying output.',
            detail: { path: artifact.path },
          },
        };
      }
    } catch {
      return {
        ok: false,
        error: {
          code: 'dist-artifact-missing',
          expected: 'every declared dist artifact to exist',
          hint: 'Rebuild the complete dist; include platform HTML with build --html-head before sealing instead of modifying output.',
          detail: { path: artifact.path },
        },
      };
    }
  }
  for (const required of [
    ...(manifest.target === 'wechat'
      ? ['game.js', 'game.json', 'project.config.json', 'payload/game.js']
      : manifest.target === 'tauri'
        ? ['web/index.html', 'src-tauri/tauri.conf.json']
        : ['index.html']),
    manifest.runtime.packIndexUrl,
    manifest.runtime.shaderManifestUrl,
  ]) {
    if (!manifest.artifacts.some((artifact) => artifact.path === required)) {
      return {
        ok: false,
        error: {
          code: 'dist-required-artifact-missing',
          expected: 'target entry, Pack index, and Shader manifest in the dist closure',
          hint: 'Rebuild after repairing the owning producer.',
          detail: { path: required },
        },
      };
    }
  }
  for (const path of await filesUnder(root)) {
    const artifactPath = relative(root, path).split(sep).join('/');
    if (!declaredPaths.has(artifactPath)) {
      return {
        ok: false,
        error: {
          code: 'dist-artifact-undeclared',
          expected: 'every file in dist to be covered by forgeax-dist.json',
          hint: 'Remove the foreign file or rebuild the complete dist.',
          detail: { path: artifactPath },
        },
      };
    }
  }
  return { ok: true, value: manifest };
}
