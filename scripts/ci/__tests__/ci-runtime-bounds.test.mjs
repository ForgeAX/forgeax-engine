import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  MESH_IO_LOGICAL_FRAMES,
  meshIoFrameIndices,
} from '../../../apps/parity/mesh-io/src/frame-profile.ts';

const taaCarrierModule = pathToFileURL(resolve('apps/hello/taa/scripts/smoke-carrier.mjs')).href;

test('Preview forwards validated CI readiness to its actual Pack configuration', async () => {
  const ts = await import('typescript');
  const source = readFileSync(resolve('apps/preview/vite.config.ts'), 'utf8');
  const tree = ts.createSourceFile('preview.ts', source, ts.ScriptTarget.Latest, true);
  const config = tree.statements.find(ts.isExportAssignment)?.expression;
  assert.ok(config && ts.isCallExpression(config));
  const callback = config.arguments[0];
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const statements = callback.body.statements;
  const readiness = statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((row) => row.name.getText(tree) === 'readiness'),
  );
  assert.ok(readiness, 'Preview must consume the CI readiness setting');
  const rejection = statements.find(
    (node) => ts.isIfStatement(node) && node.expression.getText(tree) === '!readiness.ok',
  );
  assert.ok(rejection, 'invalid readiness must fail rather than silently select another policy');
  const pack = statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => node.name.getText(tree) === 'pack')?.initializer;
  assert.ok(pack && ts.isCallExpression(pack));
  const options = pack.arguments[0];
  assert.ok(options && ts.isObjectLiteralExpression(options));
  const selected = options.properties.find(
    (node) => node.name?.getText(tree) === 'producerReadiness',
  );
  assert.ok(
    selected && ts.isPropertyAssignment(selected),
    'the Pack owner must receive the selection',
  );

  // Execute these exact configuration statements with the source-owned parser;
  // this is a routing contract, not a replacement for the real Catalog deadline.
  const parserSource = readFileSync(resolve('packages/import/src/source-package.ts'), 'utf8');
  const parserTree = ts.createSourceFile(
    'readiness.ts',
    parserSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const parser = parserTree.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'parseProducerReadiness',
  );
  assert.ok(parser);
  const body = [
    parser.getText(parserTree).replace(/^export\s+/, ''),
    readiness.getText(tree),
    rejection.getText(tree),
    `return ${selected.initializer.getText(tree)};`,
  ].join('\n');
  const { outputText } = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const select = new Function('process', outputText);
  assert.equal(select({ env: {} }), 'before-consume');
  assert.equal(select({ env: { FORGEAX_DEV_PACK_READINESS: 'on-demand' } }), 'on-demand');
  assert.equal(select({ env: { FORGEAX_DEV_PACK_READINESS: 'before-consume' } }), 'before-consume');
  assert.throws(
    () => select({ env: { FORGEAX_DEV_PACK_READINESS: 'lazy' } }),
    (error) => error.code === 'producer-readiness-invalid',
  );
});

test('TAA carrier timeout preserves actions and bounds process lifetime', () => {
  const success = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { withTimeout } from ${JSON.stringify(taaCarrierModule)};
const value = await withTimeout('value', () => 42, 35_000);
if (value !== 42) throw new Error('value was not preserved: ' + value);
try {
  await withTimeout('reject', () => Promise.reject(new Error('sentinel')), 35_000);
  throw new Error('action rejection was not propagated');
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'sentinel') throw error;
}`,
    ],
    { encoding: 'utf8', timeout: 2_000 },
  );
  assert.equal(success.error, undefined, success.error?.message);
  assert.equal(success.status, 0, success.stderr || success.stdout);

  const timeout = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { withTimeout } from ${JSON.stringify(taaCarrierModule)};
try {
  await withTimeout('hang', () => new Promise(() => {}), 50);
  process.exitCode = 1;
} catch (error) {
  process.exitCode = error instanceof Error && error.message === 'hang timed out after 50ms' ? 0 : 2;
}`,
    ],
    { encoding: 'utf8', timeout: 2_000 },
  );
  assert.equal(timeout.error, undefined, timeout.error?.message);
  assert.equal(timeout.status, 0, timeout.stderr || timeout.stdout);
});

test('Mesh CI sampling retains the full trajectory and exact captured pose', () => {
  const full = meshIoFrameIndices(false);
  const bounded = meshIoFrameIndices(true);
  assert.equal(full.length, 60);
  assert.equal(bounded.length, 16);
  assert.equal(new Set(bounded).size, bounded.length);
  assert.deepEqual(
    bounded,
    [...bounded].sort((a, b) => a - b),
  );
  assert.ok(bounded.every((frame) => full.includes(frame)));
  assert.equal(bounded[0], full[0]);
  assert.equal(bounded.at(-1), full.at(-1));
  assert.equal(bounded.at(-1), MESH_IO_LOGICAL_FRAMES - 1);
  assert.ok(bounded.some((frame) => frame < 30));
  assert.ok(bounded.some((frame) => frame >= 30));
  // Keep every retained cubic-pose oracle and the exact final geometry-readback pose.
  const pose = (frame) => {
    const time = (2 * (frame + 0.371)) / MESH_IO_LOGICAL_FRAMES;
    return 0.6 * (time / 2) * (1 - time / 2);
  };
  assert.equal(pose(bounded.at(-1)), pose(full.at(-1)));
});
