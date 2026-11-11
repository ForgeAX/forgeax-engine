#!/usr/bin/env node
// Each game-3d feature folder must be deletable on its own: copy the template,
// remove one folder under assets/ (shared/ and __tests__/ excepted), then typecheck.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const KEEP = new Set(['shared', '__tests__']);

export function featureFolders(template) {
  return readdirSync(join(template, 'assets'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !KEEP.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function checkFeatureDeletion(template = join(ROOT, 'templates/game-3d')) {
  const tsc = join(template, 'node_modules/typescript/bin/tsc');
  const results = [];
  for (const folder of featureFolders(template)) {
    const copy = mkdtempSync(join(tmpdir(), `game-3d-without-${folder}-`));
    try {
      cpSync(template, copy, {
        recursive: true,
        filter: (path) =>
          !path.startsWith(join(template, 'node_modules')) &&
          !path.startsWith(join(template, '.forgeax')),
      });
      symlinkSync(join(template, 'node_modules'), join(copy, 'node_modules'), 'dir');
      rmSync(join(copy, 'assets', folder), { recursive: true });
      const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', copy], { encoding: 'utf8' });
      results.push({ folder, ok: run.status === 0, output: `${run.stdout}${run.stderr}`.trim() });
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = checkFeatureDeletion(process.argv[2] ? resolve(process.argv[2]) : undefined);
  for (const result of results) {
    console.log(`${result.ok ? 'ok  ' : 'FAIL'} without assets/${result.folder}/`);
    if (!result.ok) console.log(result.output);
  }
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
