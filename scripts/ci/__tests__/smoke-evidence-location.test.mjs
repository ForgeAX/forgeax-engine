import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const external = resolve(root, '..', '.tmp', 'smoke evidence');
const owners = [
  ['apps/hello/bloom/scripts/smoke-browser.mjs', 'evidenceDir'],
  ['apps/hello/bloom/scripts/smoke-browser-device-loss.mjs', 'evidenceDir'],
  ['apps/hello/bloom/scripts/bloom-quality-dawn.mjs', 'evidenceDir'],
  ['apps/hello/bloom/scripts/smoke-odd-dawn.mjs', 'evidenceDir'],
  ['apps/hello/bloom/scripts/smoke-dawn.mjs', 'evidenceDir'],
  ['apps/hello/bloom/scripts/smoke-falsify.mjs', 'evidenceDir'],
  ['apps/hello/ssr/scripts/smoke-composite.mjs', 'artifactDirectory'],
];

for (const [path, variable] of owners) {
  test(`${path} keeps evidence in the explicit external directory`, () => {
    const source = readFileSync(resolve(root, path), 'utf8');
    const expression = source.match(new RegExp(`const ${variable} = (.+);`))?.[1];
    assert.ok(expression, 'the runner must own its evidence directory');
    const appRoot = resolve(root, path, '../..');
    const evaluate = (env) =>
      runInNewContext(expression, {
        appRoot,
        packageRoot: appRoot,
        here: resolve(appRoot, 'scripts'),
        process: { env },
        resolve,
      });
    assert.equal(evaluate({ SMOKE_EVIDENCE_DIR: external }), external);
    assert.equal(
      evaluate({}),
      path.includes('/bloom/')
        ? resolve(appRoot, 'evidence')
        : resolve(appRoot, '../../../artifacts/ssr-fallback/dawn'),
    );
  });
}
