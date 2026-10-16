import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../../tools/view/scripts/build-inputs.mjs';

const root = resolve(import.meta.dirname, '../..');
const view = resolve(root, 'tools/view');
const requireEngine = createRequire(resolve(root, 'packages/engine/package.json'));
const requireView = createRequire(resolve(view, 'package.json'));
const paths = {};
for (const name of ['@forgeax/engine', '@forgeax/engine-host', '@forgeax/engine-plugin']) {
  const engine = await realpath(requireEngine.resolve(`${name}/package.json`));
  const consumer = await realpath(requireView.resolve(`${name}/package.json`));
  assert.equal(consumer, engine, `View must resolve ${name} to the selected Engine instance`);
  paths[name] = engine;
}
const pluginManifest = JSON.parse(await readFile(paths['@forgeax/engine-plugin']));
const pluginEntry = resolve(
  paths['@forgeax/engine-plugin'],
  '..',
  pluginManifest.exports['.'].import,
);
const producer = await import(pathToFileURL(pluginEntry));
const consumerManifestPath = requireView.resolve('@forgeax/engine-plugin/package.json');
const consumerManifest = JSON.parse(await readFile(consumerManifestPath));
const consumer = await import(
  pathToFileURL(resolve(consumerManifestPath, '..', consumerManifest.exports['.'].import))
);
const context = new producer.Context();
const origin = {
  guid: 'identity-fixture',
  program: 'identity-fixture',
  evidence: {},
  sessionId: 'identity-fixture',
};
const scope = context.extend({ [producer.pluginAssetOrigin]: origin });
assert.equal(
  scope[consumer.pluginAssetOrigin],
  origin,
  'the actual origin symbol must cross the producer/consumer boundary',
);
await context.fiber.dispose();
const graph = JSON.parse(await readFile(resolve(view, 'dist/viewer/panel-graph.json')));
assert.ok(graph.modules.length > 0, 'the served panel graph must contain actual chunks');
const forbidden = graph.modules.filter((path) =>
  /(?:packages\/(?:plugin|host|ecs)\/|engine-(?:plugin|host|ecs)[@/])/.test(path),
);
assert.deepEqual(forbidden, [], 'static panels must not contain identity-sensitive Engine modules');
const native = JSON.parse(await readFile(resolve(view, 'dist/build-revision.json')));
assert.equal(
  graph.codeRevision,
  native.codeRevision,
  'resident and embedded roots must be built from the same selected inputs',
);
const viewerHash = createHash('sha256');
await digest(resolve(view, 'dist/viewer'), viewerHash);
assert.equal(
  viewerHash.digest('hex'),
  native.viewerDigest,
  'served viewer bytes must match the selected native build',
);
assert.equal(
  await readFile(resolve(view, 'pnpm-lock.yaml')).then(
    () => true,
    () => false,
  ),
  false,
);
assert.equal(
  await readFile(resolve(view, 'pnpm-workspace.yaml')).then(
    () => true,
    () => false,
  ),
  false,
);
await mkdir(resolve(root, 'artifacts/view-integration'), { recursive: true });
const engineCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const viewCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: view,
  encoding: 'utf8',
}).trim();
const lockDigest = createHash('sha256')
  .update(await readFile(resolve(root, 'pnpm-lock.yaml')))
  .digest('hex');
await writeFile(
  resolve(root, 'artifacts/view-integration/dependency-identity.json'),
  JSON.stringify(
    {
      ok: true,
      engineCommit,
      viewCommit,
      lockDigest,
      paths,
      originSymbolTransferred: true,
      codeRevision: native.codeRevision,
      panelModules: graph.modules,
    },
    null,
    2,
  ),
);
console.log('View dependency and per-realm origin identity passed');
