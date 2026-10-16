import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { SDK_SOURCE_GIT_DEPENDENCIES, SDK_SOURCE_WASM } from '../forgeax/sdk-lib.mjs';

const root = resolve(import.meta.dirname, '../..');
const scratch =
  process.env.FORGEAX_ENGINE_WITHOUT_VIEW_ROOT ??
  (await mkdtemp(resolve(tmpdir(), 'engine-without-view-')));
assert.ok(!scratch.startsWith(root), 'verification must use a separate source directory');
assert.equal(
  dirname(resolve(scratch)),
  resolve(tmpdir()),
  'scratch must be in the system temporary directory',
);
assert.match(
  basename(scratch),
  /^engine-without-view-[A-Za-z0-9]+$/,
  'scratch must be a verifier-owned source directory',
);
const output = resolve(root, 'artifacts/view-integration');
const result = { stages: [], viewPresent: false };
const selected = spawnSync('git', ['ls-files', '--stage', '-z'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
assert.equal(selected.status, 0);
const entries = selected.stdout.split('\0').filter(Boolean);
try {
  for (const entry of entries) {
    if (entry.startsWith('160000 ')) continue;
    const file = entry.slice(entry.indexOf('\t') + 1);
    if (
      /^(?:tools\/view(?:\/|$)|forgeax-engine-assets(?:\/|$)|third_party\/wgpu(?:\/|$))/.test(file)
    )
      continue;
    await mkdir(dirname(resolve(scratch, file)), { recursive: true });
    await cp(resolve(root, file), resolve(scratch, file));
  }
  // Native prebuilds verify source identity even when their WASM is already prepared.
  const archive = resolve(scratch, '.native-source.tar');
  for (const dependency of SDK_SOURCE_GIT_DEPENDENCIES) {
    if (dependency === 'tools/view') continue;
    const entry = entries.find(
      (value) => value.startsWith('160000 ') && value.slice(value.indexOf('\t') + 1) === dependency,
    );
    assert.ok(entry, `${dependency} must have a pinned Git source`);
    const pin = entry.split(' ')[1];
    const archived = spawnSync('git', ['archive', '--format=tar', `--output=${archive}`, pin], {
      cwd: resolve(root, dependency),
      encoding: 'utf8',
    });
    assert.equal(archived.status, 0, archived.stderr);
    const destination = resolve(scratch, dependency);
    await mkdir(destination, { recursive: true });
    const extracted = spawnSync('tar', ['-xf', archive, '-C', destination], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
  }
  await rm(archive);
  // Contributor builds carry these checked substrate inputs independently of View.
  for (const { root: owner, files } of SDK_SOURCE_WASM)
    for (const file of files) {
      const destination = resolve(scratch, owner, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(root, owner, file), destination);
    }
  for (const [name, args] of [
    ['install', ['install', '--frozen-lockfile', '--ignore-scripts']],
    ['build:engine', ['build:engine']],
  ]) {
    const start = performance.now();
    const run = spawnSync('pnpm', args, {
      cwd: scratch,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
    });
    result.stages.push({ name, milliseconds: performance.now() - start, exitCode: run.status });
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, `without-view-${name.replace(':', '-')}.log`),
      run.stdout + run.stderr,
    );
    assert.equal(
      run.status,
      0,
      `${name} failed; inspect artifacts/view-integration/without-view-${name.replace(':', '-')}.log`,
    );
  }
  const probe = resolve(scratch, 'without-view-probe.mjs');
  await writeFile(
    probe,
    `import assert from 'node:assert/strict';
import {createProfiler,buildProfileModel} from './packages/engine/dist/facades/profiler.mjs';
import {encodeTape,decodeTape} from './packages/engine/dist/facades/rhi-debug.mjs';
const profiler=createProfiler({phaseCatalog:{app:['frame'],render:[]}});
const started=profiler.startCapture({frameLimit:1,eventLimit:4,detail:'owner'});
assert.equal(started.ok,true); const capture=started.value;
assert.equal(capture.beginFrame(1).ok,true); assert.equal(capture.beginPhase('app','frame').ok,true);
assert.equal(capture.endPhase().ok,true); assert.equal(capture.endFrame().ok,true);
assert.equal(buildProfileModel(profiler.latestCapture()).ok,true);
const tape=encodeTape({header:{formatVersion:7,rhiCaps:{},eventCount:1,blobCount:0},bootstrap:[],events:[{kind:'frameMark',frameIdx:0}],blobs:[]});
assert.equal(tape.ok,true);assert.equal(decodeTape(tape.value).ok,true);
console.log('Public profiler and RHI tape APIs work without View');`,
  );
  for (const [name, args] of [
    ['cli', ['packages/engine/dist/bin/forgeax.mjs', '--help']],
    ['diagnostics', ['without-view-probe.mjs']],
  ]) {
    const run = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8' });
    result.stages.push({ name, exitCode: run.status });
    await writeFile(resolve(output, `without-view-${name}.log`), run.stdout + run.stderr);
    assert.equal(run.status, 0, `${name} must work without View`);
  }
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = String(error);
  throw error;
} finally {
  try {
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, 'without-view.json'), JSON.stringify(result, null, 2));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
