import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { structuredPluginError } from './structured-plugin-error.js';

interface PackBuildInputOptions {
  readonly roots?: readonly string[] | undefined;
  readonly base?: string | undefined;
}

function normalizeBasePrefix(base: string | undefined): string {
  return (base ?? '/').replace(/\/$/, '');
}

/** Resolve the configured source boundary and the Vite URL prefix once. */
export function resolvePackBuildInputs(options: PackBuildInputOptions): {
  readonly roots: readonly string[];
  readonly basePrefix: string;
} {
  const cwd = process.cwd();
  const roots =
    options.roots === undefined
      ? [join(cwd, 'assets')]
      : options.roots.map((root) => resolve(cwd, root));
  return { roots, basePrefix: normalizeBasePrefix(options.base) };
}

export function projectPackIndexUrl(basePrefix: string, packageUrl: string): string {
  return `${basePrefix}/${packageUrl.replace(/^\/+/, '')}`;
}

export async function assertBuildRoots(roots: readonly string[]): Promise<void> {
  if (roots.length === 0) {
    throw structuredPluginError({
      code: 'config-failed',
      expected: 'at least one existing Pack root for a build',
      hint: 'configure pluginPack roots or project asset roots before building',
      detail: { stage: 'config', subject: 'pack-roots' },
    });
  }
  for (const root of roots) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(root);
    } catch (error) {
      throw structuredPluginError({
        code: 'config-failed',
        expected: `the configured Pack root ${root} to be readable`,
        hint: 'create the root or remove it from the build configuration',
        detail: { stage: 'config', subject: root },
        cause: error,
      });
    }
    if (!info.isDirectory() && !info.isFile()) {
      throw structuredPluginError({
        code: 'config-failed',
        expected: `the configured Pack root ${root} to be a file or directory`,
        hint: 'point pluginPack roots at existing files or directories containing validated asset declarations',
        detail: { stage: 'config', subject: root },
      });
    }
  }
}
