import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import {
  assertPhoneBundleSyntax,
  buildNativeGameplayBenchmark,
  instrumentCompletionDriver,
  instrumentGameplayHost,
  instrumentPhoneDiagnostic,
} from '../build_gameplay_benchmark.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const require = createRequire(
  await realpath(join(process.cwd(), 'node_modules/tsup/dist/index.js')),
);
const { parse } = require('acorn');

test('minified async App names retain the resolved App, platform and original callbacks', async () => {
  for (const appName of ['u', 'c', 'currentApp']) {
    const events = [];
    const platform = {};
    const app = {
      onError() {},
      start() {
        events.push('start');
        return { unwrap() {} };
      },
    };
    const source = `async function boot(){const ${appName}=(await makeApp({platform:actualPlatform,world:{},renderer:{},onFrameSubmitted(){record('submitted')},onFrameCompleted(){record('completed')}})).unwrap();${appName}.start().unwrap()}boot();`;
    const observed = instrumentGameplayHost(source, parse, []);
    await runInNewContext(observed, {
      actualPlatform: platform,
      record: (event) => events.push(event),
      async makeApp(options) {
        options.onFrameSubmitted();
        options.onFrameCompleted();
        return { unwrap: () => app };
      },
      __gameplayBenchmark: {
        observeOptions(options, host) {
          assert.equal(host, platform);
          return options;
        },
        bindApp(value) {
          assert.equal(value, app);
          assert.equal(typeof value.onError, 'function');
          events.push('bound');
          return value;
        },
      },
    });
    assert.deepEqual(events, ['submitted', 'completed', 'bound', 'start']);
  }
});

test('official phone gate rejects optional-chain/nullish output before publication', () => {
  assert.throws(
    () => assertPhoneBundleSyntax('var x=globalThis.owner?.ready;', parse),
    /unsupported/,
  );
  assert.throws(
    () => assertPhoneBundleSyntax('var x=globalThis.ready??false;', parse),
    /unsupported/,
  );
  assert.throws(() => assertPhoneBundleSyntax('globalThis.ready??=false;', parse), /unsupported/);
  assert.doesNotThrow(() =>
    assertPhoneBundleSyntax('var x=globalThis.owner&&globalThis.owner.ready;', parse),
  );
  assert.doesNotThrow(() => assertPhoneBundleSyntax('try{var x=1n;}catch{}', parse));
});

test('diagnostic assembly selects one existing Renderer or native Host owner', () => {
  const source =
    'const renderer=make(canvas,{rhi:backend,features:[],ui:{},dynamicGeometryMeshBudgetBytes:undefined});const host=provider.o(wx,`payload/wasm/wgpu.wasm.br`,[canvas]).unwrap();';
  assert.match(instrumentPhoneDiagnostic(source, parse, [], 'cpu'), /rendererOptions\(/);
  assert.match(instrumentPhoneDiagnostic(source, parse, [], 'gpu'), /gpuHost\(/);
  assert.throws(
    () => instrumentPhoneDiagnostic(`${source}{${source}}`, parse, [], 'cpu'),
    /Exactly one/,
  );
  assert.throws(() => instrumentPhoneDiagnostic('const x={};', parse, [], 'gpu'), /Exactly one/);
});

for (const mode of ['timed', 'cpu', 'gpu', 'qualification', 'transport-probe', 'completion'])
  test(`actual ${mode} phone bundle lowers unsupported syntax and preserves source`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), 'forgeax-phone-syntax-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const publication = join(temporary, 'ordinary'),
      out = join(temporary, 'phone');
    const path = 'payload/assets/wechat-main-contract.js';
    const original =
      'async function main(e){const v={},M={};const host=provider.o(wx,`payload/wasm/wgpu.wasm.br`,[canvas]).unwrap();const d=make(canvas,{rhi:backend,features:[],ui:{},dynamicGeometryMeshBudgetBytes:undefined});const u=(await createApp({platform:v,world:M,renderer:d.renderer,onFrameSubmitted(){},onFrameCompleted(){}})).unwrap();u.start().unwrap()}';
    await mkdir(dirname(join(publication, path)), { recursive: true });
    await writeFile(join(publication, path), original);
    const driverPath = 'payload/assets/queue-contract.js';
    const driver = 'class Queue{done(){return this.raw.onSubmittedWorkDone.call(this.raw,driver)}}';
    await writeFile(join(publication, driverPath), driver);
    const manifest = JSON.stringify({
      target: 'wechat',
      artifacts: [
        { path, bytes: Buffer.byteLength(original), sha256: hash(original) },
        { path: driverPath, bytes: Buffer.byteLength(driver), sha256: hash(driver) },
      ],
    });
    await writeFile(join(publication, 'forgeax-dist.json'), manifest);
    const built = await buildNativeGameplayBenchmark({
      publication,
      out,
      toolRoot: process.cwd(),
      sourceCommit: 'a'.repeat(40),
      expectedManifestSha256: hash(manifest),
      phone: {
        controlUrl: 'http://127.0.0.1:18766/contract',
        runId: 'phone_syntax_contract',
        mode: mode === 'completion' ? 'cpu' : mode,
        ...(mode === 'completion' ? { completionTiming: true } : {}),
      },
    });
    const output = await readFile(join(out, path), 'utf8');
    assert.doesNotThrow(() => assertPhoneBundleSyntax(output, parse));
    assert.match(output, /createPhoneGameplayObserver/);
    assert.equal(await readFile(join(publication, path), 'utf8'), original);
    assert.equal(built.source.publicationManifestSha256, hash(manifest));
    assert.equal(built.source.phone.mode, mode === 'completion' ? 'cpu' : mode);
    if (mode === 'completion') {
      assert.match(output, /__forgeaxCompletionTiming.wrapHost/);
      assert.match(
        await readFile(join(out, driverPath), 'utf8'),
        /__forgeaxCompletionTiming.driver\(driver\)/,
      );
      assert.deepEqual(built.source.adaptedHostModules, [path, driverPath]);
    } else assert.equal(await readFile(join(out, driverPath), 'utf8'), driver);
    assert.match(built.source.phone.reportSource.bundleSha256, /^[0-9a-f]{64}$/);
  });

test('driver seam accepts minified names and rejects unknown or duplicate ABI', () => {
  for (const name of ['_', 'minifiedDriver']) {
    const source = `q.onSubmittedWorkDone.call(receiver,${name})`;
    assert.match(instrumentCompletionDriver(source, parse), /__forgeaxCompletionTiming.driver/);
    assert.throws(() => instrumentCompletionDriver(`${source};${source}`, parse), /Ambiguous/);
  }
  assert.equal(instrumentCompletionDriver('other.call(receiver,driver)', parse), null);
  assert.throws(
    () => instrumentCompletionDriver('q.onSubmittedWorkDone.call(receiver)', parse),
    /ABI/,
  );
});
