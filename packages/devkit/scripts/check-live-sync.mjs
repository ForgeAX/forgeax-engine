// Real CLI/daemon/browser regression. The source fixture is copied before edits.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { reduceTestProject } from '../../../scripts/test/reduce-test-project.mjs';

const exec = promisify(execFile);
const source = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../../../templates/game-3d', import.meta.url)),
);
const root = await mkdtemp(join(tmpdir(), 'forgeax-live-sync-'));
const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const ignored = new Set(['node_modules', '.forgeax', '.git', 'artifacts', 'dist']);
await cp(source, root, {
  recursive: true,
  filter: (path) =>
    !path
      .slice(source.length)
      .split('/')
      .some((part) => ignored.has(part)),
});
if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1') await reduceTestProject(root);
await mkdir(join(root, 'node_modules'), { recursive: true });
for (const name of await readdir(join(source, 'node_modules'))) {
  if (name.startsWith('.vite')) continue;
  await symlink(join(source, 'node_modules', name), join(root, 'node_modules', name));
}
const evidence = resolve(
  process.env.FORGEAX_LIVE_SYNC_EVIDENCE ?? join(root, '.forgeax', 'sync-evidence'),
);
await mkdir(evidence, { recursive: true });
const hook = join(evidence, 'watch-unavailable.mjs');
await writeFile(
  hook,
  `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
if (process.argv.includes('--__forgeax-live-daemon')) {
  fs.watch = () => { throw new Error('Regression: filesystem event delivery unavailable'); };
  syncBuiltinESMExports();
}`,
);
const env = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(hook).href}`,
  ...(process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'
    ? { FORGEAX_DEV_PACK_READINESS: 'on-demand' }
    : {}),
};
// `dev start` owns a detached daemon whose project child is allowed one
// 300-second cold build. Keep this outer child-process budget just above that
// owner budget; the old 180-second limit killed a valid, resource-starved
// runner before the daemon could publish its terminal JSON state.
const START_COMMAND_TIMEOUT_MS = 330_000;
const results = [];
let sequence = 0;
async function command(...args) {
  const started = performance.now();
  let result;
  try {
    result = await exec(process.execPath, [cli, 'dev', ...args, '--root', root, '--json'], {
      cwd: root,
      env,
      timeout: args[0] === 'start' ? START_COMMAND_TIMEOUT_MS : 180_000,
      maxBuffer: 4_000_000,
    });
  } catch (error) {
    result = error;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  await writeFile(join(evidence, `${++sequence}-${args[0]}.log`), output);
  const line = output.split('\n').findLast((line) => line.startsWith('{'));
  assert.ok(line, output);
  const value = JSON.parse(line);
  results.push({ args, elapsedMs: Math.round(performance.now() - started), result: value });
  return value;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready(previous, timeout = 150_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const status = await command('status');
    if (status.value?.phase === 'ready' && status.value.revision !== previous) return status.value;
    await delay(500);
  }
  assert.fail(`No fresh ready revision within ${timeout} ms`);
}
let failure;
try {
  const started = await command('start', '--headless=true', '--backend=auto');
  assert.equal(started.ok, true, JSON.stringify(started));
  const first = await ready(undefined);
  const found = await command('find', '--name', 'Player');
  assert.equal(found.ok, true);
  const ref = found.value.matches[0]?.ref;
  assert.ok(ref, 'fixture needs a named Player');
  const focused = await command('focus', '--ref', ref);
  assert.equal(focused.ok, true, JSON.stringify(focused));
  assert.equal(focused.value.control, 'observer');
  const released = await command('camera', 'release');
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(released.value.control, 'game');
  // The guide title is now owned by its authored translation resource.
  const messages = join(root, 'assets', 'guide.ui.i18n.json');
  const original = await readFile(messages, 'utf8');
  await writeFile(`${messages}.tmp`, original.replace('3C starter', 'SYNC INITIAL'));
  await rename(`${messages}.tmp`, messages);
  const stale = await command('camera', 'get', '--revision', first.revision);
  assert.equal(
    stale.ok,
    false,
    'a direct disk edit must not admit an old revision even without file events',
  );
  const second = await ready(first.revision);
  assert.equal(second.pid, first.pid);
  assert.equal(second.endpoint, first.endpoint);
  assert.equal((await command('focus', '--ref', ref)).error?.code, 'live-revision-stale');

  // Change again while the previous rebuild is in flight; only the final input may be ready.
  await writeFile(messages, original.replace('3C starter', 'SYNC INTERMEDIATE'));
  const backgroundEnd = Date.now() + 20_000;
  let owner;
  do {
    await delay(250);
    owner = await readFile(join(root, '.forgeax', 'dev-session.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => undefined);
  } while (
    (owner === undefined || owner.revision === second.revision) &&
    Date.now() < backgroundEnd
  );
  assert.ok(owner);
  assert.notEqual(
    owner.revision,
    second.revision,
    'background refresh must work without any CLI request',
  );
  await writeFile(messages, original.replace('3C starter', 'SYNC FINAL'));
  const third = await ready(second.revision);
  const capture = await command(
    'capture',
    '--revision',
    third.revision,
    '--output',
    join(evidence, 'final.png'),
  );
  assert.equal(capture.ok, true);
  const report = JSON.parse(await readFile(capture.value.report.uri, 'utf8'));
  assert.match(report.record.runtime.domUi.textWitness, /SYNC FINAL/);
  assert.equal(capture.value.pixels.rendered, true);

  // Asset membership is an authored input even when its bytes are not imported
  // by a program. Unrelated root files are outside the accepted compiler scope.
  const broken = join(root, 'assets', 'unreadable-input');
  await symlink(join(root, 'missing-input'), broken);
  const unreadable = await command('status');
  assert.equal(unreadable.value.phase, 'failed');
  assert.match(unreadable.value.error, /live-inputs-unavailable/);
  assert.equal((await command('camera', 'get')).ok, false);
  await rm(broken);
  await ready(third.revision);

  const manifest = join(root, 'forge.json');
  const manifestBytes = await readFile(manifest);
  await writeFile(manifest, '{ invalid');
  const failedEnd = Date.now() + 60_000;
  let failed;
  do {
    failed = await command('status');
    if (failed.value?.phase === 'failed') break;
    await delay(500);
  } while (Date.now() < failedEnd);
  assert.equal(failed.value?.phase, 'failed');
  assert.equal((await command('camera', 'get')).ok, false);
  await writeFile(manifest, manifestBytes);
  const recovered = await ready(failed.value.revision);
  assert.equal(recovered.pid, first.pid);
  assert.equal((await command('camera', 'get', '--revision', third.revision)).ok, false);
} catch (error) {
  failure = error;
} finally {
  // Preserve the producer state before stop replaces the failed revision.
  if (failure) {
    for (const name of ['dev.log', 'dev-session.json']) {
      try {
        await cp(join(root, '.forgeax', name), join(evidence, name));
      } catch (error) {
        await writeFile(join(evidence, `${name}.unavailable.txt`), String(error));
      }
    }
  }
  await command('stop');
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify({ ok: !failure, root, results, error: failure?.stack }, null, 2),
  );
  console.log(JSON.stringify({ ok: !failure, root, evidence, error: failure?.message }));
}
if (failure) throw failure;
