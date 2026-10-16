import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCAN_DIRS = ['packages', 'apps', 'templates'];
export function sourceHitsFallback(repoRoot: string, pattern: string): string[] {
  const expression = new RegExp(pattern);
  const hits: string[] = [];
  const visit = (relativeDir: string): void => {
    for (const entry of readdirSync(resolve(repoRoot, relativeDir), { withFileTypes: true })) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'dist' && entry.name !== 'node_modules') visit(relativePath);
        continue;
      }
      if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.mjs'))) {
        continue;
      }
      for (const [index, line] of readFileSync(resolve(repoRoot, relativePath), 'utf8')
        .split('\n')
        .entries()) {
        if (expression.test(line)) hits.push(`${relativePath}:${index + 1}:${line.trim()}`);
      }
    }
  };
  for (const directory of SCAN_DIRS) {
    visit(directory);
  }
  return hits;
}

export function sourceHits(repoRoot: string, pattern: string): string[] {
  const result = spawnSync(
    'rg',
    [
      '--threads=2',
      '--no-heading',
      '--color=never',
      '--line-number',
      '--glob',
      '*.ts',
      '--glob',
      '*.mjs',
      '--glob',
      '!**/dist/**',
      '--glob',
      '!**/node_modules/**',
      pattern,
      ...SCAN_DIRS,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.error === undefined) {
    if (result.status === 1) return [];
    if (result.status !== 0) {
      throw result.error ?? new Error(`rg exited with status ${result.status}`);
    }
    return result.stdout
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(':');
        const lineEnd = line.indexOf(':', separator + 1);
        return `${line.slice(0, separator)}:${line.slice(separator + 1, lineEnd)}:${line
          .slice(lineEnd + 1)
          .trim()}`;
      });
  }
  return sourceHitsFallback(repoRoot, pattern);
}
