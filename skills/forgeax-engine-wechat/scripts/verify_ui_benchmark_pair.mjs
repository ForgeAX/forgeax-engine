import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { brotliDecompressSync } from 'node:zlib';

const { values } = parseArgs({
  options: {
    browser: { type: 'string' },
    wechat: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const usage =
  'node verify_ui_benchmark_pair.mjs --browser BUILT_BROWSER --wechat BUILT_WECHAT --out NEW_JSON';
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!values.browser || !values.wechat || !values.out) throw Error(usage);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const browser = resolve(values.browser),
  wechat = resolve(values.wechat);
const report = { kind: 'ui-benchmark-pair-offline-contract', renderingVerified: false, checks: [] };
const check = (name, condition) => {
  report.checks.push({ name, passed: !!condition });
  assert.ok(condition, name);
};
try {
  const browserInputs = JSON.parse(await readFile(join(browser, 'inputs.json'), 'utf8'));
  const nativeInputs = JSON.parse(await readFile(join(wechat, 'inputs.json'), 'utf8'));
  for (const [root, inputs] of [
    [browser, browserInputs],
    [wechat, nativeInputs],
  ]) {
    for (const [path, identity] of Object.entries(inputs.files)) {
      const bytes = await readFile(join(root, path));
      check(
        `${inputs.host}:${path}`,
        bytes.length === identity.bytes && digest(bytes) === identity.sha256,
      );
    }
  }
  check(
    'same-workload',
    JSON.stringify(browserInputs.workloadIdentity) ===
      JSON.stringify(nativeInputs.workloadIdentity),
  );
  check(
    'same-native-ui-receipt',
    JSON.stringify(browserInputs.kernel) === JSON.stringify(nativeInputs.kernel),
  );
  check('selected-hosts', browserInputs.host === 'browser' && nativeInputs.host === 'wechat');
  check(
    'same-webgl2-backend',
    browserInputs.backend === 'wgpu-webgl2' && nativeInputs.backend === 'wgpu-webgl2',
  );
  for (const [nativePath, browserPath] of [
    ['ui/ui.wasm.br', 'ui.wasm'],
    ['ui/wgpu.wasm.br', 'pkg/wgpu_wasm_bg.wasm'],
  ]) {
    const decoded = brotliDecompressSync(await readFile(join(wechat, nativePath)));
    check(
      `same-decoded:${nativePath}`,
      digest(decoded) === browserInputs.files[browserPath].sha256,
    );
  }
  const normalize = (path) =>
    /\/(startup|identity)\.generated\.js$/.test(path) ? path.split('/').at(-1) : path;
  const browserModules = new Map(
    browserInputs.moduleContent.map((row) => [normalize(row.path), row]),
  );
  const shared = nativeInputs.moduleContent.filter((row) =>
    browserModules.has(normalize(row.path)),
  );
  check(
    'same-shared-module-bytes',
    shared.every((row) => row.sha256 === browserModules.get(normalize(row.path)).sha256),
  );
  check(
    'no-browser-loader-in-native-graph',
    !nativeInputs.moduleInputs.some(
      (path) =>
        path.endsWith('/wasm-browser.ts') ||
        path.endsWith('/browser-host.js') ||
        path === 'packages/wgpu-wasm/src/index.ts',
    ),
  );
  report.workloadIdentity = nativeInputs.workloadIdentity;
  report.sharedModuleCount = shared.length;
  report.nativeWorkspaceDist = nativeInputs.moduleContent.filter(
    (row) => row.path.startsWith('packages/') && row.path.includes('/dist/'),
  );

  // This is only a bootstrap/lifecycle contract. No GPU operation or benchmark
  // method runs against these host observations; real pixels require the IDE.
  const subscriptions = new Set();
  let canvases = 0,
    reads = 0,
    instances = 0;
  const wx = {
    createCanvas: () => ({
      id: ++canvases,
      width: 2532,
      height: 1170,
      getContext: (kind) => (kind === '2d' ? {} : null),
    }),
    getPerformance: () => ({ now: () => performance.now() }),
    getDeviceInfo: () => ({ platform: 'devtools' }),
    getWindowInfo: () => ({
      windowWidth: 844,
      windowHeight: 390,
      pixelRatio: 3,
      safeArea: { left: 0, top: 0, width: 844, height: 390 },
    }),
    getFileSystemManager() {
      reads++;
      throw Error('Unexpected file read before a step starts');
    },
  };
  for (const event of ['Show', 'Hide', 'WindowResize', 'DeviceOrientationChange']) {
    wx[`on${event}`] = (listener) => subscriptions.add(listener);
    wx[`off${event}`] = (listener) => subscriptions.delete(listener);
  }
  const realm = vm.createContext({
    wx,
    WXWebAssembly: {
      instantiate() {
        instances++;
        throw Error('Unexpected native instance before a step starts');
      },
    },
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console: { info() {}, error() {} },
    document: undefined,
    window: undefined,
    fetch: undefined,
    WebAssembly: undefined,
    performance: undefined,
  });
  vm.runInContext(await readFile(join(wechat, 'ui/game.js'), 'utf8'), realm, { timeout: 2000 });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
    assert.ok(predicate(), JSON.stringify(realm.__forgeaxUiBenchmark?.read()));
  };
  await waitFor(() => realm.__forgeaxUiBenchmark?.read().phase !== 'loading');
  report.bootstrapState = realm.__forgeaxUiBenchmark?.read();
  check(
    'native-bootstrap-ready-without-browser-globals',
    realm.__forgeaxUiBenchmark?.read().phase === 'ready',
  );
  check(
    'native-driver-defaults-to-correctness',
    realm.__forgeaxUiBenchmark.read().mode === 'correctness' &&
      realm.__forgeaxUiBenchmark.read().next === 'initialize',
  );
  const earlyPerformance = realm.__forgeaxUiBenchmark.startPerformance();
  check(
    'performance-cannot-skip-correctness',
    earlyPerformance.phase === 'ready' && earlyPerformance.mode === 'correctness',
  );
  check(
    'host-bootstrap-is-not-a-performance-run',
    reads === 0 && instances === 0 && canvases === 2,
  );
  check(
    'native-standards-installed-first',
    typeof realm.TextEncoder === 'function' && typeof realm.MessageChannel === 'function',
  );
  check(
    'no-browser-global-shims',
    realm.window === undefined &&
      realm.document === undefined &&
      realm.fetch === undefined &&
      realm.WebAssembly === undefined,
  );
  check(
    'native-identity-reaches-driver',
    realm.__forgeaxUiBenchmark.read().identity.sha256 === nativeInputs.workloadIdentity.sha256,
  );
  realm.__forgeaxUiBenchmark.dispose();
  await waitFor(() => realm.__forgeaxUiBenchmark.read().phase !== 'running');
  const terminal = realm.__forgeaxUiBenchmark.read();
  check(
    'bootstrap-cleanup-releases-platform',
    terminal.cleanup.success && subscriptions.size === 0,
  );
  check(
    'unexecuted-workload-cannot-pass',
    terminal.accepted === false && terminal.completed.length === 0,
  );
  report.bootstrap = {
    canvasCount: canvases,
    packagedReads: reads,
    nativeInstances: instances,
    remainingSubscriptions: subscriptions.size,
    accepted: terminal.accepted,
  };
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = { name: error.name, message: error.message };
} finally {
  await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(
  JSON.stringify({
    out: resolve(values.out),
    ok: report.ok,
    checks: report.checks.length,
    error: report.error,
  }),
);
process.exitCode = report.ok ? 0 : 1;
