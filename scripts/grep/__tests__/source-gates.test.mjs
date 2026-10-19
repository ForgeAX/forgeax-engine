import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cases = [
  ['check-no-buffer-colon-keyword.mjs', "const value = 'buffer:8';"],
  ['check-no-entity-array-literal.mjs', "const value = 'entity[]';"],
  ['check-no-result-reproject-cast.mjs', 'const value = source as unknown as Result<number>;'],
  ['check-no-managed-array-error-code.mjs', "const value = 'managed-array-pop-empty';"],
  ['check-no-array-stride-option.mjs', "defineComponent('P', { arrayStride: 4 });"],
  ['check-no-managed-array-view-import.mjs', "import { VarArrayView } from 'old';"],
  ['check-asset-registry-instanced-removed.mjs', 'createInstancedBuffer();'],
  ['check-no-shader-manifest-url-literal.mjs', "fetch('/shaders/manifest.json');"],
];

for (const [script, violation] of cases) {
  test(`${script} keeps nested source detection and scan exclusions`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-grep-source-'));
    const scriptPath = fileURLToPath(new URL(`../${script}`, import.meta.url));
    const put = (path, source) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    };
    const run = () => spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' });
    try {
      const sourceRoot = script.includes('shader-manifest') ? 'apps/demo' : 'packages/ecs/src';
      put(`${sourceRoot}/nested/comment.ts`, `// ${violation}\n/* ${violation} */\nexport {};`);
      for (const directory of ['node_modules', 'dist', '.next', '.cache', 'test-output'])
        put(`${sourceRoot}/${directory}/hidden.ts`, violation);
      put(`${sourceRoot}/note.md`, violation);
      if (script.includes('shader-manifest'))
        put(`${sourceRoot}/__test-stubs__/hidden.ts`, violation);
      if (script.includes('buffer-colon'))
        put('packages/ecs/src/__tests__/buffer-array-vocab.test-d.ts', violation);
      if (script.includes('managed-array-error'))
        put('packages/ecs/src/__tests__/errors.unit.test.ts', violation);
      const clean = run();
      assert.equal(clean.status, 0, clean.stdout + clean.stderr);
      for (const extension of ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs']) {
        const path = `${sourceRoot}/nested/violation.${extension}`;
        put(path, violation);
        const invalid = run();
        assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
        assert.ok(invalid.stderr.includes(path), invalid.stderr);
        rmSync(join(root, path));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
