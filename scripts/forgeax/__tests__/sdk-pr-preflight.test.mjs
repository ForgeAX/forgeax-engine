import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { verifySdkViewRuntime } from '../sdk-lib.mjs';
import {
  aggregateSdkConsumers,
  checkSeed,
  SDK_NPM_PARTITIONS,
  SDK_PR_CONSUMERS,
  writeSeedChecksums,
} from '../sdk-pr-preflight.mjs';

const head = 'a'.repeat(40);
const version = `0.0.0-pr.${head}`;
const identity = {
  ok: true,
  sdkVersion: version,
  engineCommit: head,
  viewCommit: 'b'.repeat(40),
  sha256: 'c'.repeat(64),
};
const reports = [
  ...Object.entries(SDK_NPM_PARTITIONS).map(([partition, workloads]) => ({
    ...identity,
    group: 'npm',
    partition,
    workloads,
    packageCount: 69,
  })),
  ...SDK_PR_CONSUMERS.filter((group) => group !== 'npm').map((group) => ({
    ...identity,
    group,
  })),
];

test('the required SDK aggregate rejects missing, duplicate, failed or mismatched consumers', () => {
  assert.equal(aggregateSdkConsumers(reports, head, version).ok, true);
  assert.throws(() => aggregateSdkConsumers(reports.slice(1), head, version));
  assert.throws(() =>
    aggregateSdkConsumers([reports[0], reports[0], ...reports.slice(2)], head, version),
  );
  for (const mutation of [
    { ok: false },
    { ok: 'true' },
    { engineCommit: 'd'.repeat(40) },
    { sha256: 'd'.repeat(64) },
    { viewCommit: 'd'.repeat(40) },
    { sdkVersion: 'different' },
  ])
    assert.throws(() =>
      aggregateSdkConsumers([{ ...reports[0], ...mutation }, ...reports.slice(1)], head, version),
    );
});

test('the actual aggregate CLI requires all four transported receipts and rejects extra or partial npm results', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-pr-partitions-'));
  const script = resolve(import.meta.dirname, '../sdk-pr-preflight.mjs');
  const command = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [script, '--aggregate', root, '--expected-head', head, '--version', version],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  try {
    for (const report of reports)
      writeFileSync(
        resolve(
          root,
          `sdk-verify-${report.group}${report.partition ? `-${report.partition}` : ''}-result.json`,
        ),
        JSON.stringify(report),
      );
    assert.equal(command().ok, true);
    assert.deepEqual(command().groups, SDK_PR_CONSUMERS);
    const project = resolve(root, 'sdk-verify-npm-js-result.json');
    writeFileSync(
      project,
      JSON.stringify({ ...reports[1], workloads: reports[1].workloads.slice(0, 1) }),
    );
    assert.throws(command, /partition-incomplete/);
    writeFileSync(project, JSON.stringify(reports[1]));
    writeFileSync(resolve(root, 'unexpected-result.json'), JSON.stringify(reports[0]));
    assert.throws(command, /consumer-conservation/);
    rmSync(resolve(root, 'unexpected-result.json'));
    rmSync(project);
    assert.throws(command, /consumer-conservation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('npm folds only two complete same-seed owner receipts into its logical consumer', () => {
  assert.throws(() => aggregateSdkConsumers([reports[0], ...reports.slice(3)], head, version));
  assert.deepEqual(aggregateSdkConsumers(reports, head, version).npm, {
    partitions: ['diagnostics', 'js'],
    workloads: ['diagnostics', 'game3d-installed', 'runtime-js-live', 'runtime-js-cold'],
    packageCount: 69,
  });
  for (const mutation of [
    { partition: 'all' },
    { partition: 'unknown' },
    { partition: 'js' },
    { workloads: [] },
    { workloads: ['diagnostics'] },
    { workloads: ['diagnostics', 'diagnostics'] },
    { packageCount: 0 },
    { packageCount: 68 },
  ])
    assert.throws(() =>
      aggregateSdkConsumers([{ ...reports[0], ...mutation }, ...reports.slice(1)], head, version),
    );
  for (const workloads of [
    ['runtime-js-live'],
    ['runtime-js-cold', 'runtime-js-live'],
    ['runtime-js-live', 'runtime-js-cold', 'diagnostics'],
  ])
    assert.throws(() =>
      aggregateSdkConsumers(
        [reports[0], { ...reports[1], workloads }, ...reports.slice(2)],
        head,
        version,
      ),
    );
});

function seedFixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-pr-seed-test-'));
  mkdirSync(resolve(root, 'npm/packages'), { recursive: true });
  const zip = resolve(root, `forgeax-sdk-v${version}.zip`);
  const carrier = resolve(root, `npm/forgeax-engine-sdk-${version}.tgz`);
  const pkg = resolve(root, 'npm/packages/engine.tgz');
  writeFileSync(zip, 'zip-bytes');
  writeFileSync(carrier, 'carrier');
  writeFileSync(pkg, 'package');
  writeFileSync(
    resolve(root, 'sdk-build-result.json'),
    JSON.stringify({
      ok: true,
      engineCommit: head,
      sdkVersion: version,
      sha256: createHash('sha256').update(readFileSync(zip)).digest('hex'),
      npm: { packageCount: 1 },
    }),
  );
  writeSeedChecksums(root, version);
  return { root, zip, carrier, pkg };
}

test('seed transfer verifies every ZIP and npm payload byte and the exact build identity', () => {
  const { root, carrier, pkg } = seedFixture();
  try {
    assert.equal(checkSeed(root, head, version).ok, true);
    assert.throws(() => checkSeed(root, 'd'.repeat(40), version));
    writeFileSync(pkg, 'Package');
    assert.throws(() => checkSeed(root, head, version), /byte-closure/);
    writeFileSync(pkg, 'package');
    rmSync(carrier);
    assert.throws(() => checkSeed(root, head, version), /byte-closure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const group of SDK_PR_CONSUMERS) {
  test(`the ${group} seed route verifies its real payload without the unused family`, () => {
    const { root, zip, pkg } = seedFixture();
    try {
      const npm = group === 'npm';
      rmSync(npm ? zip : resolve(root, 'npm'), { recursive: true });
      assert.equal(checkSeed(root, head, version, group).ok, true);
      execFileSync(
        process.execPath,
        [
          resolve(import.meta.dirname, '../sdk-pr-preflight.mjs'),
          '--check-seed',
          root,
          '--expected-head',
          head,
          '--version',
          version,
          '--group',
          group,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      assert.throws(() => checkSeed(root, 'd'.repeat(40), version, group), /seed-identity/);
      writeFileSync(npm ? pkg : zip, 'corrupted used bytes');
      assert.throws(() => checkSeed(root, head, version, group), /byte-closure/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('route selection retains the complete seed identity and rejects incomplete or duplicate declarations', () => {
  const { root, zip, carrier, pkg } = seedFixture();
  const checksums = resolve(root, 'SHA256SUMS');
  const original = readFileSync(checksums, 'utf8');
  const lines = original.trimEnd().split('\n');
  try {
    assert.throws(() => checkSeed(root, head, version, 'unknown'), /seed-group/);
    rmSync(zip);
    for (const changed of [
      `${lines.slice(1).join('\n')}\n`,
      `${[lines[0], lines[1], lines[1]].join('\n')}\n`,
      original.replace(lines[0].slice(0, 64), 'd'.repeat(64)),
      original.replace('npm/packages/engine.tgz', 'npm/../engine.tgz'),
      original.replace('npm/packages/engine.tgz', 'npm/packages/engine.zip'),
      `${original}\n`,
    ]) {
      writeFileSync(checksums, changed);
      assert.throws(() => checkSeed(root, head, version, 'npm'), /byte-closure/);
    }
    writeFileSync(checksums, original);
    writeFileSync(resolve(root, 'npm/packages/extra.tgz'), 'unexpected bytes');
    assert.throws(() => checkSeed(root, head, version, 'npm'), /byte-closure/);
    rmSync(resolve(root, 'npm/packages/extra.tgz'));
    rmSync(carrier);
    assert.throws(() => checkSeed(root, head, version, 'npm'), /byte-closure/);
    writeFileSync(carrier, 'carrier');
    rmSync(pkg);
    assert.throws(() => checkSeed(root, head, version, 'npm'), /byte-closure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive group selection is explicit while release qualification retains the complete default', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../verify-sdk.mjs'), 'utf8');
  assert.match(source, /groupIndex < 0 \? 'all'/);
  assert.match(source, /sdk-verify-unknown-group/);
  assert.match(
    source,
    /if\s*\(selected\('source'\)\)\s*\{\s*await sdkStage\('buildSourceSnapshot'/,
  );
  const project = source.slice(
    source.indexOf("if (selected('project'))"),
    source.indexOf('async function verifySourceTemplate'),
  );
  assert.match(project, /verifySelectedTemplate/);
  const publicSource = source.slice(
    source.indexOf("if (selected('source'))"),
    source.indexOf(
      "if (selected('project'))",
      source.indexOf("await sdkGpuStage('verifyPublicSourceViewTool'"),
    ),
  );
  assert.match(publicSource, /verifySourceTemplate/);
  assert.match(publicSource, /verifyPublicSourceViewTool/);
  const installed = source.slice(
    source.indexOf(
      "if (selected('project'))",
      source.indexOf("await sdkGpuStage('verifyPublicSourceViewTool'"),
    ),
  );
  assert.match(installed, /verifyIndependentRun/);
  assert.match(installed, /selected\('project'\)[\s\S]*verifyInstalledViewRuntime/);
  assert.match(installed, /sdk-consumer-mutated-store/);
});

test('public source preparation completes before consumers start and is absent from other groups', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '../verify-sdk.mjs'), 'utf8');
  const body = source.slice(
    source.indexOf("if (selected('source'))"),
    source.indexOf('const initializedSdk'),
  );
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)(
    'context',
    `const { selected, sdkStage, sourceBuildPnpm, consumerReady, verifySdkSourceEdit,
      sdkRoot, sourceRoot, unpackRoot, sourceEnv, resolve, execFileAsync, process } = context;
      ${body}\nconsumerReady();`,
  );
  for (const group of ['source', 'project']) {
    const commands = [];
    const stages = [];
    let ready = false;
    let release;
    const running = execute({
      selected: (candidate) => candidate === group,
      sdkStage: (label, work) => {
        stages.push(label);
        if (stages.length > 1) return work();
        return new Promise((resolveStage) => {
          release = () => resolveStage(work());
        });
      },
      sourceBuildPnpm: async (args) => {
        commands.push(args);
      },
      consumerReady: () => {
        ready = true;
      },
      verifySdkSourceEdit: async () => commands.push(['source-edit']),
      execFileAsync: async (_file, args) => commands.push(args),
      sdkRoot: '/sdk',
      sourceRoot: '/source',
      unpackRoot: '/unpack',
      sourceEnv: {},
      resolve,
      process,
    });
    if (group === 'source') {
      assert.equal(ready, false, 'a consumer cannot retire input while source preparation is live');
      assert.deepEqual(stages, ['buildSourceSnapshot']);
      release();
    }
    await running;
    assert.equal(ready, true);
    assert.deepEqual(
      commands,
      group === 'source'
        ? [
            ['install', '--frozen-lockfile', '--ignore-scripts'],
            ['source-edit'],
            ['scripts/clean-build-outputs.mjs'],
            ['build:engine'],
            ['build:tools'],
            ['build:app', 'preview'],
          ]
        : [],
    );
    assert.deepEqual(
      stages,
      group === 'source' ? ['buildSourceSnapshot', 'verify single-module source editing'] : [],
    );
  }
});

test('archive project owns independent runs and installed View while source keeps separate inputs', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '../verify-sdk.mjs'), 'utf8');
  const body = source
    .slice(
      source.indexOf(
        "if (selected('project'))",
        source.indexOf("await sdkGpuStage('verifyPublicSourceViewTool'"),
      ),
      source.indexOf('\nfor (const expected of manifest.artifacts.filter'),
    )
    .replaceAll('import.meta.dirname', JSON.stringify(resolve(import.meta.dirname, '..')));
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)(
    'group',
    'selected',
    'sdkStage',
    'sdkGpuStage',
    'execFileAsync',
    'verifySdkViewRuntime',
    'resolve',
    'sdkRoot',
    'sourceRoot',
    'offlineEnv',
    'archive',
    'dirname',
    body,
  );
  const observed = {};
  const independentCommands = [];
  const viewSourceRoots = [];
  for (const group of ['project', 'source', 'all']) {
    const stages = [];
    await execute(
      group,
      (owner) => group === 'all' || group === owner,
      async (stage, run) => {
        stages.push(stage);
        await run();
      },
      async (stage, run) => {
        stages.push(stage);
        await run();
      },
      async (executable, args, options) => {
        if (args[0]?.endsWith('verify-diagnostic-pages-integration.mjs'))
          viewSourceRoots.push({ group, root: options.env.FORGEAX_VIEW_ENGINE_SOURCE_ROOT });
        if (args[0].endsWith('verify-independent-run.mjs'))
          independentCommands.push({
            group,
            executable,
            engine: options.env.FORGEAX_INDEPENDENT_ENGINE_PACKAGE,
          });
        return { stdout: '', stderr: '' };
      },
      async () => {},
      resolve,
      '/sdk',
      '/source',
      {},
      '/sdk.zip',
      dirname,
    );
    observed[group] = stages;
  }
  assert.deepEqual(observed, {
    project: ['verifyIndependentRun', 'verifyInstalledViewRuntimeJS', 'verifyInstalledViewRuntime'],
    source: [],
    all: ['verifyIndependentRun', 'verifyPairedViewTool', 'verifyInstalledViewRuntime'],
  });
  assert.deepEqual(viewSourceRoots, [{ group: 'all', root: '/source' }]);
  assert.deepEqual(
    independentCommands,
    ['project', 'all'].map((group) => ({
      group,
      executable: process.execPath,
      engine: resolve('/sdk', '.forgeax/cli-runtime/node_modules/@forgeax/engine'),
    })),
  );
  assert.equal(
    observed.project.filter((stage) => stage === 'verifyInstalledViewRuntime').length,
    1,
  );
});

test('the real installed View and npm schedulers conserve complete chains and full defaults', async () => {
  const npm = readFileSync(resolve(import.meta.dirname, '../check-sdk-npm-consumer.mjs'), 'utf8');
  const start = npm.indexOf('async function verifyInstalledNpmOwners(');
  assert.ok(start >= 0);
  const declaration = npm.slice(start, npm.indexOf('\ntry {', start));
  const runtimeScript = `
    import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
    import { resolve } from 'node:path';
    import assert from 'node:assert/strict';
    const env = process.env, language = env.FORGEAX_RUNTIME_PACK_LANGUAGE;
    for (const key of ['NODE_PATH','FORGEAX_SHARED_APP_INPUTS_MANIFEST','FORGEAX_LOCAL_ENGINE','FORGEAX_RUNTIME_PACK_DIRECT'])
      assert.equal(env[key], undefined, key);
    if (env.FORGEAX_RUNTIME_PACK_SNAPSHOT)
      assert.equal(readFileSync(env.FORGEAX_RUNTIME_PACK_SNAPSHOT,'utf8'), language);
    else {
      mkdirSync(env.FORGEAX_EVIDENCE_DIR,{recursive:true});
      writeFileSync(resolve(env.FORGEAX_EVIDENCE_DIR,'saved-content.json'),language);
    }
    appendFileSync(env.FORGEAX_TEST_RECEIPT, language + (env.FORGEAX_RUNTIME_PACK_SNAPSHOT ? '-cold' : '-live') + '\\n');
  `;
  const observed = {};
  for (const group of [
    'all',
    'view',
    'project',
    'game3d',
    'npm-all',
    ...Object.keys(SDK_NPM_PARTITIONS).map((partition) => `npm-${partition}`),
  ]) {
    const root = mkdtempSync(resolve(tmpdir(), 'sdk-view-language-chain-'));
    try {
      const scripts = resolve(root, '.forgeax/cli-runtime/node_modules/@forgeax/view/scripts');
      const receipt = resolve(root, 'receipt.txt');
      mkdirSync(scripts, { recursive: true });
      writeFileSync(resolve(scripts, 'verify-runtime-content-engine.mjs'), runtimeScript);
      writeFileSync(
        resolve(scripts, 'verify-game3d-workspace.mjs'),
        `import assert from 'node:assert/strict';
         import { readFileSync, appendFileSync } from 'node:fs';
         import { resolve } from 'node:path';
         for (const key of ['NODE_PATH', 'FORGEAX_SHARED_APP_INPUTS_MANIFEST', 'FORGEAX_LOCAL_ENGINE', 'FORGEAX_RUNTIME_PACK_DIRECT'])
           assert.equal(process.env[key], undefined, key);
         assert.equal(process.env.FORGEAX_ENGINE_CHECKOUT, process.cwd());
         for (const name of ['reduce-test-project.mjs', 'render-quality.json'])
           assert.ok(readFileSync(resolve(process.cwd(), 'scripts/test', name)).length > 0);
         appendFileSync(process.env.FORGEAX_TEST_RECEIPT, 'game3d-installed\\n');`,
      );
      const diagnostic = resolve(root, 'tools/view/scripts');
      mkdirSync(diagnostic, { recursive: true });
      writeFileSync(
        resolve(diagnostic, 'verify-diagnostic-pages-integration.mjs'),
        `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.FORGEAX_TEST_RECEIPT,'diagnostics\\n');`,
      );
      const options = {
        sdkRoot: root,
        evidenceRoot: resolve(root, 'evidence'),
        env: {
          ...process.env,
          FORGEAX_TEST_RECEIPT: receipt,
          NODE_PATH: '/forbidden',
          FORGEAX_SHARED_APP_INPUTS_MANIFEST: '/forbidden',
          FORGEAX_LOCAL_ENGINE: '/forbidden',
          FORGEAX_RUNTIME_PACK_DIRECT: '/forbidden',
          FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1',
        },
      };
      if (group.startsWith('npm-')) {
        const partition = group.slice(4);
        const runNpm = new Function(
          'execFileAsync',
          'verifySdkViewRuntime',
          'resolve',
          'root',
          'sdkGpuStage',
          `${declaration}\nreturn verifyInstalledNpmOwners;`,
        )(promisify(execFile), verifySdkViewRuntime, resolve, root, async (_stage, run) => run());
        const workloads = await runNpm(root, options.env, options.evidenceRoot, partition);
        assert.deepEqual(
          workloads,
          partition === 'all'
            ? Object.values(SDK_NPM_PARTITIONS).flat()
            : SDK_NPM_PARTITIONS[partition],
        );
        if (partition === 'all' || partition === 'diagnostics') {
          const probe = resolve(scripts, 'verify-game3d-workspace.mjs');
          const source = readFileSync(probe, 'utf8');
          writeFileSync(probe, "throw new Error('game3d-owned-failure');");
          await assert.rejects(
            runNpm(
              root,
              { ...options.env, FORGEAX_TEST_RECEIPT: resolve(root, 'failure-receipt') },
              options.evidenceRoot,
              partition,
            ),
            /game3d-owned-failure/,
          );
          assert.match(
            readFileSync(
              resolve(options.evidenceRoot, 'view-registry/game3d-installed.log'),
              'utf8',
            ),
            /game3d-owned-failure/,
          );
          writeFileSync(probe, source);
        }
        await assert.rejects(
          runNpm(
            root,
            { ...options.env, FORGEAX_TEST_RECEIPT: resolve(root, 'missing/receipt') },
            options.evidenceRoot,
            partition,
          ),
        );
      } else await verifySdkViewRuntime(group === 'all' ? options : { ...options, group });
      observed[group] = readFileSync(receipt, 'utf8').trim().split('\n');
      await assert.rejects(verifySdkViewRuntime({ ...options, group: 'missing' }), /unknown-group/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(observed.all, ['js-live', 'js-cold', 'ts-live', 'ts-cold']);
  assert.deepEqual(observed.view, ['js-live', 'js-cold']);
  assert.deepEqual(observed.project, ['ts-live', 'ts-cold']);
  assert.deepEqual(observed.game3d, ['game3d-installed']);
  assert.deepEqual([...observed.view, ...observed.project], observed.all);
  assert.deepEqual(observed['npm-all'], ['diagnostics', ...observed.game3d, ...observed.view]);
  assert.deepEqual(observed['npm-diagnostics'], ['diagnostics', ...observed.game3d]);
  assert.deepEqual(observed['npm-js'], observed.view);
  assert.deepEqual([...observed['npm-diagnostics'], ...observed['npm-js']], observed['npm-all']);
});

test('the real SDK page-readiness route activates the page before asynchronous gameplay inspection', async () => {
  const source = readFileSync('scripts/forgeax/verify-sdk.mjs', 'utf8');
  const declaration = source.slice(
    source.indexOf('  async function waitForProjectPage('),
    source.indexOf('  async function readSelectedPlayerProjection('),
  );
  let foreground = false;
  const calls = [];
  const page = {
    on() {},
    async bringToFront() {
      foreground = true;
      calls.push('focus');
    },
    async goto() {
      assert.ok(
        foreground,
        'a background page cannot service the Engine Worker inspection boundary',
      );
      calls.push('navigate');
    },
    async waitForFunction() {},
    async evaluate() {
      assert.ok(foreground);
      calls.push('inspection');
      return true;
    },
  };
  const open = new Function(
    'sdkStage',
    'appendDiagnostic',
    'frameTimeoutDiagnostics',
    `${declaration} return waitForProjectPage;`,
  )(
    (_label, operation) => operation(),
    () => {},
    async () => ({}),
  );
  const result = await open(
    page,
    'http://sdk-fixture.invalid',
    { pageErrors: [], consoleErrors: [], failedResponses: [] },
    'movement',
  );
  assert.equal(result, undefined);
  assert.deepEqual(calls, ['focus', 'navigate', 'inspection']);
});

test('SDK first-frame polling rejects a visible terminal startup error without waiting out its deadline', async () => {
  const source = readFileSync('scripts/forgeax/verify-sdk.mjs', 'utf8');
  const declaration = source.slice(
    source.indexOf('  async function waitForProjectPage('),
    source.indexOf('  async function readSelectedPlayerProjection('),
  );
  for (const scenario of [
    { visible: true, frame: 0 },
    { visible: true, frame: 3 },
    { visible: false, frame: 0 },
    { visible: false, frame: 3 },
  ]) {
    const timeout = new Error('fixture-no-completed-frame');
    let polls = 0;
    let diagnostics = 0;
    const page = {
      on() {},
      async bringToFront() {},
      async goto() {},
      async evaluate() {
        return true;
      },
      async waitForFunction(predicate, _argument, options) {
        if (++polls !== 2) return;
        assert.equal(options.timeout, 120_000);
        const ready = runInNewContext(`(${predicate.toString()})()`, {
          document: {
            querySelector: (selector) =>
              selector === 'canvas'
                ? { forgeaxFrameProgress: { submitted: { frameId: scenario.frame } } }
                : {
                    textContent: 'Renderer construct failed: external Instance lost',
                    getClientRects: () => (scenario.visible ? [{}] : []),
                  },
          },
          getComputedStyle: () => ({
            display: scenario.visible ? 'block' : 'none',
            visibility: 'visible',
          }),
        });
        if (!ready) throw timeout;
      },
    };
    const open = new Function(
      'sdkStage',
      'appendDiagnostic',
      'frameTimeoutDiagnostics',
      `${declaration} return waitForProjectPage;`,
    )(
      (_label, operation) => operation(),
      () => {},
      async () => {
        diagnostics++;
        return { fatal: scenario.visible };
      },
    );
    const result = open(
      page,
      'http://sdk-fixture.invalid',
      {
        pageErrors: [],
        consoleErrors: [],
        failedResponses: [],
      },
      'movement',
    );
    if (scenario.visible) {
      await assert.rejects(result, (error) => {
        assert.match(error.cause.message, /sdk-selected-startup-failed:.*external Instance lost/);
        assert.match(error.message, /"fatal":true/);
        return true;
      });
      assert.equal(diagnostics, 1);
    } else if (scenario.frame === 0) {
      await assert.rejects(result, (error) => error.cause === timeout);
    } else {
      await result;
      assert.equal(diagnostics, 0);
    }
  }
});

for (const failureAt of ['page readiness', 'player read']) {
  test(`the real SDK ${failureAt} rejection retains its page and diagnostics through cleanup`, async () => {
    const source = readFileSync('scripts/forgeax/verify-sdk.mjs', 'utf8');
    const declaration = source.slice(
      source.indexOf('  async function verifyProjectBrowser('),
      source.indexOf('  async function waitForProjectPackCatalog('),
    );
    const cause = new Error('player read stalled');
    const calls = [];
    const page = { evaluate: async () => ({ canvas: { width: 320, height: 180 } }) };
    const deps = {
      LIVE_DEV_STARTUP_TIMEOUT_MS: 1_000,
      spawnProjectServer: () => ({
        exitCode: 0,
        once: (_event, callback) => queueMicrotask(() => callback(0)),
        stdout: { on: (_event, callback) => callback('{"command":"dev","ok":true,"value":{}}\n') },
        stderr: { on() {} },
      }),
      sdkStage: (_label, operation) => operation(),
      liveProjectUrl: async () => 'http://sdk-fixture.invalid',
      waitForProjectPackCatalog: async () => {},
      launchSelectedBrowser: async () => ({}),
      createProjectPage: async () => page,
      waitForProjectPage: async () => {
        if (failureAt === 'page readiness') throw cause;
      },
      readSelectedPlayerProjection: async () => {
        throw cause;
      },
      boundedTail: (value) => value,
      frameTimeoutDiagnostics: async (actualPage, diagnostics, phase) => {
        assert.equal(actualPage, page);
        assert.equal(phase, 'gameplay');
        assert.deepEqual(diagnostics.pageErrors, []);
        assert.match(diagnostics.serverOutput().stdout, /"command":"dev"/);
        calls.push('diagnostics');
        return { phase, renderer: { state: 'alive' } };
      },
      closeSelectedPage: async () => calls.push('page'),
      closeSelectedBrowser: async () => calls.push('browser'),
      stopLiveProject: async () => calls.push('server'),
    };
    const verify = new Function(
      ...Object.keys(deps),
      `${declaration} return verifyProjectBrowser;`,
    )(...Object.values(deps));
    await assert.rejects(verify('/fixture', 'scope'), (error) => {
      assert.equal(error.cause, cause);
      assert.match(error.message, /sdk-selected-gameplay-failed/);
      assert.match(error.message, /"state":"alive"/);
      return true;
    });
    assert.deepEqual(calls, ['diagnostics', 'page', 'browser', 'server']);
  });
}

test('ZIP Project packaging retains the authored lighting and has no retired reduction dependency', async () => {
  const source = readFileSync(resolve(import.meta.dirname, '../verify-sdk.mjs'), 'utf8');
  const begin = source.indexOf('  async function verifySelectedTemplate() {');
  const end = source.indexOf('  async function verifyProjectBrowser', begin);
  assert.ok(begin >= 0 && end > begin);
  const body = source.slice(begin, end);
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)(
    'resolve',
    'unpackRoot',
    'sdkRoot',
    'offlineEnv',
    'execFileAsync',
    'readFile',
    'writeFile',
    'verifyGamePackage',
    'verifyProjectBrowser',
    'sdkGpuStage',
    'process',
    'console',
    'reduceTestProject',
    `${body}\nreturn verifySelectedTemplate();`,
  );
  const root = mkdtempSync(resolve(tmpdir(), 'forgeax-sdk-selected-'));
  const project = resolve(root, 'game-3d');
  const authored = 'mapSize: 1024, cascadeCount: 3, PointLight: { intensity: 1 }';
  mkdirSync(resolve(project, 'assets'), { recursive: true });
  writeFileSync(resolve(project, 'assets/scene.pack.ts'), authored);
  writeFileSync(resolve(project, 'forge.json'), JSON.stringify({ id: 'game-3d', name: 'game-3d' }));
  writeFileSync(resolve(project, 'package.json'), JSON.stringify({ name: '@local/game-3d' }));
  const commands = [];
  const stages = [];
  try {
    const result = await execute(
      resolve,
      root,
      '/immutable-sdk',
      {},
      async (file, args) => {
        commands.push([file, args]);
      },
      async (path, encoding) => readFileSync(path, encoding),
      async (path, bytes) => writeFileSync(path, bytes),
      async (path, archive) => {
        stages.push('package');
        assert.equal(path, project);
        assert.equal(archive, resolve(root, 'game-3d-web.zip'));
        assert.equal(
          readFileSync(resolve(path, 'assets/scene.pack.ts'), 'utf8'),
          authored.replace('1024', '256'),
        );
        return { archive };
      },
      async (path, id) => {
        stages.push('browser');
        assert.equal(path, project);
        assert.equal(id, 'game-3d');
        return { id };
      },
      async (label, run) => {
        assert.equal(label, 'verifyProjectBrowser');
        return run();
      },
      { env: { FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1' } },
      { log() {} },
      async (path) => {
        const file = resolve(path, 'assets/scene.pack.ts');
        writeFileSync(file, readFileSync(file, 'utf8').replace('1024', '256'));
      },
    );
    assert.equal(result.id, 'game-3d');
    assert.deepEqual(stages, ['package', 'browser']);
    assert.deepEqual(
      commands.map(([, args]) => args.slice(0, 2)),
      [
        [resolve('/immutable-sdk', 'bin', 'forgeax.mjs'), 'project'],
        ['exec', 'forgeax'],
        ['run', 'doctor'],
        ['run', 'test'],
        ['run', 'typecheck'],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
