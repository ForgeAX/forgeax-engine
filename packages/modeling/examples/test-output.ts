import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root (the directory holding src/ and examples/). */
export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Directory for generated evidence (renders, reports, summaries). `FORGEAX_MODELING_VIZ_DIR`
 * collects every example's output in one place; otherwise the OS temp directory is used.
 */
export function vizOutputDir(name: string): string {
  const base = process.env.FORGEAX_MODELING_VIZ_DIR ?? join(tmpdir(), 'forgeax-modeling-viz');
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface GitProvenance {
  readonly head: string;
  readonly tree: 'clean' | 'dirty' | 'unknown';
}

/** Records the checkout a render came from; never fails, so it cannot gate a test. */
export function gitProvenance(): GitProvenance {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return undefined;
    }
  };
  const head = git(['rev-parse', 'HEAD']);
  if (head === undefined) return { head: 'unknown', tree: 'unknown' };
  const status = git(['status', '--porcelain']);
  if (status === undefined) return { head, tree: 'unknown' };
  return { head, tree: status === '' ? 'clean' : 'dirty' };
}
