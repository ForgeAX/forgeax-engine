import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const gate = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/gltf/scripts/check-no-image-import.mjs',
);

const fixtures: readonly [string, string, number][] = [
  [
    'comment after an unrelated import',
    "import { cook } from '@forgeax/engine-import';\n// Do not import from '@forgeax/engine-image';\n",
    0,
  ],
  ['block comment with import syntax', "/*\nimport decoder from '@forgeax/engine-image';\n*/\n", 0],
  [
    'import text inside a string',
    "const example = `\nimport decoder from '@forgeax/engine-image';\n`;\n",
    0,
  ],
  ['ordinary import', "import decoder from '@forgeax/engine-image';\n", 1],
  ['multiline import', "import {\n decode\n} from '@forgeax/engine-image';\n", 1],
  ['type import', "import type { Image } from '@forgeax/engine-image';\n", 1],
  ['subpath import', "import decoder from '@forgeax/engine-image/decode';\n", 1],
  ['side effect import', "import '@forgeax/engine-image';\n", 1],
];

test.each(fixtures)('image import gate distinguishes %s', (_name, source, exitCode) => {
  const root = mkdtempSync(join(tmpdir(), 'gltf-image-gate-'));
  const dir = join(root, 'packages/gltf/src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture.ts'), source);
  try {
    const result = spawnSync(process.execPath, [gate, '--root', root], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(exitCode);
    if (exitCode) expect(result.stderr).toContain('fixture.ts:1: static import');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
