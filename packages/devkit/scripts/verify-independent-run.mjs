import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sdkStage } from '../../../scripts/forgeax/sdk-stage.mjs';

const engine = resolve(process.env.FORGEAX_INDEPENDENT_ENGINE_PACKAGE ?? resolve(import.meta.dirname, '../../..', 'packages/engine'));
const engineManifest = JSON.parse(await readFile(join(engine, 'package.json'), 'utf8'));
const engineEntry = name => {
  const entry = engineManifest.exports[`./${name}`] ?? engineManifest.exports['./*'];
  const target = (typeof entry === 'string' ? entry : entry.import).replaceAll('*', name);
  return pathToFileURL(resolve(engine, target)).href;
};
const [{ parseImage }, { AssetGuid }, { definePackageId }, { runUnifiedCli }] = await Promise.all([
  import(engineEntry('image/parse-image')), import(engineEntry('pack/guid')),
  import(engineEntry('pack/source')), import(engineEntry('devkit')),
]);
const root = await mkdtemp(join(tmpdir(), 'forgeax-independent-run-'));
process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = '/missing-contributor-cache-must-not-affect-run';
process.env.FORGEAX_RUNS_DIR = await mkdtemp(join(tmpdir(), 'forgeax-run-state-'));
const call = async (operation, args = []) => {
  const result = await sdkStage(`independentRun.${operation}`, () =>
    runUnifiedCli(['engine', 'run', ...operation.split('.'), '--root', root, '--json', ...args]),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
try {
  await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engine, join(root, 'node_modules/@forgeax/engine'), 'junction');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'independent-run-proof', type: 'module', dependencies: { '@forgeax/engine': '*' } }));
  await mkdir(join(root, 'assets'));
  await cp(join(import.meta.dirname, 'fixtures/run-proof.pack.ts'), join(root, 'assets/proof.pack.ts'));
  await cp(join(import.meta.dirname, 'fixtures/run-proof-ui.ts'), join(root, 'assets/ui.ts'));
  await writeFile(join(root, 'public-lazy.txt'), 'original-version');
  await writeFile(join(root, 'forge.json'), JSON.stringify({
    id: 'independent-run-proof', name: 'Independent run proof', schemaVersion: '3.0.0',
    roots: Object.fromEntries([['engine', 'plugin/scene'], ['frontend', 'plugin/ui']].map(
      ([realm, sourceKey]) => [realm, AssetGuid.format(AssetGuid.derive(definePackageId('019fb7ce-3900-7000-8000-000000000000'), sourceKey))],
    )),
  }));
  console.error('Starting independent snapshot run');
  const launched = await sdkStage('independentRun.launch', () =>
    promisify(execFile)(process.execPath, [join(engine, 'dist/bin/forgeax.mjs'), 'engine', 'run', 'start', '--root', root, '--headless', 'true', '--backend', 'software', '--json'], { maxBuffer: 1024 * 1024 }),
  );
  const result = JSON.parse(launched.stdout);
  assert.equal(result.ok, true, JSON.stringify(result));
  const started = result.value;
  assert.equal((await fetch(started.endpoint + '/stop', {method:'POST'})).status, 403);
  assert.equal(started.headless, true);
  assert.equal(started.carrier, 'private-browser');
  assert.match(started.inputVersion, /^sha256:/);
  const revision = started.revision;
  const snapshotRoot = join(process.env.FORGEAX_RUNS_DIR, createHash('sha256').update(root).digest('hex'), `inputs-${started.runId}`, 'project');
  await writeFile(join(root, 'public-lazy.txt'), 'changed-version');
  await rm(join(root, 'assets'), { recursive: true });
  const evaluated = await call('eval', ['--revision', revision, '--code', `
    const text = await (await fetch(${JSON.stringify('/@fs/' + snapshotRoot + '/public-lazy.txt')})).text();
    if (text !== 'original-version') throw new Error('snapshot input changed: ' + text);
    return { text };
  `]);
  console.error('Evaluation', JSON.stringify(evaluated));
  const capture = await call('capture', ['--revision', revision, '--require-ui', 'true']);
  assert.equal(capture.pixels.rendered, true);
  assert.deepEqual(capture.errors, { console: 0, page: 0 });
  const decoded = parseImage(await readFile(capture.screenshot.uri), 'image/png', { mipmap: false });
  assert.equal(decoded.ok, true);
  const pixel = (x, y) => Array.from(decoded.value.bytes.slice((y * decoded.value.width + x) * 4, (y * decoded.value.width + x) * 4 + 3));
  assert.deepEqual(pixel(40, 50), [255, 0, 255], 'final PNG includes HTML UI');
  assert.deepEqual(pixel(40, 150), [0, 255, 255], 'final PNG includes Shadow DOM UI');
  const before = await call('status');
  const observations = await Promise.all(Array.from({ length: 8 }, () => call('observe')));
  for (const observation of observations) {
    assert.equal(observation.status.runId, started.runId);
    assert.equal('endpoint' in observation.status, false);
    assert.equal('url' in observation.status, false);
  }
  assert.equal((await call('status')).revision, before.revision);
  const reloaded = await call('reload');
  assert.equal(reloaded.inputVersion, started.inputVersion);
  assert.equal(reloaded.runId, started.runId);
  assert.notEqual(reloaded.revision, started.revision);
  await call('stop');
  await call('stop');
  await mkdir(join(root, 'assets'));
  await cp(join(import.meta.dirname, 'fixtures/run-proof.pack.ts'), join(root, 'assets/proof.pack.ts'));
  await cp(join(import.meta.dirname, 'fixtures/run-proof-ui.ts'), join(root, 'assets/ui.ts'));
  const replacement = await call('start', ['--backend', 'software']);
  assert.notEqual(replacement.inputVersion, started.inputVersion);
  assert.notEqual(replacement.runId, started.runId);
  console.log(JSON.stringify({ passed: true, runId: started.runId, inputVersion: started.inputVersion, capture: capture.screenshot.uri }));
} catch (error) {
  const log = join(process.env.FORGEAX_RUNS_DIR, createHash('sha256').update(root).digest('hex'), 'dev.log');
  console.error(await readFile(log, 'utf8').catch(() => 'No project log was published.'));
  throw error;
} finally {
  await call('stop').catch(error => console.error('cleanup', error.message));
  await rm(root, { recursive: true, force: true });
  await rm(process.env.FORGEAX_RUNS_DIR, { recursive: true, force: true });
}
