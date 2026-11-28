import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserGpuLaunchOptions, selectBrowserExecutable } from '../browser-executable.mjs';
import launch from '../browser-launch.json' with { type: 'json' };
import { requireNativeBrowserAdapter } from '../browser-native-admission.mjs';

const base = { channel: 'chrome', chromiumSandbox: true, args: ['--enable-features=Vulkan'] };

test('a pinned executable removes the ambient channel without disabling the sandbox', () => {
  assert.deepEqual(selectBrowserExecutable(base, { FORGEAX_BROWSER_EXECUTABLE: '/ci/chrome' }), {
    chromiumSandbox: true,
    args: base.args,
    executablePath: '/ci/chrome',
  });
  assert.equal(base.channel, 'chrome');
});

test('unqualified callers retain their existing carrier', () => {
  assert.deepEqual(selectBrowserExecutable(base, {}), base);
});

test('relative executables cannot accidentally select a different binary', () => {
  assert.throws(
    () => selectBrowserExecutable(base, { FORGEAX_BROWSER_EXECUTABLE: 'chrome' }),
    /absolute/,
  );
});

test('explicit Windows native admission removes only software adapter selection', () => {
  const native = browserGpuLaunchOptions(
    launch,
    { FORGEAX_BROWSER_GPU: 'native', CI: 'true' },
    'win32',
  );
  assert.equal(native.chromiumSandbox, true);
  assert.ok(!native.args.some((flag) => /swiftshader|use-angle|enable-features=Vulkan/.test(flag)));
  assert.ok(native.args.includes('--enable-unsafe-webgpu'));
  assert.ok(
    native.args.includes('--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits'),
  );
  assert.ok(launch.args.includes('--use-vulkan=swiftshader'));
});

test('macOS native admission keeps normal features but removes software GPU selection', () => {
  const native = browserGpuLaunchOptions(
    launch,
    { FORGEAX_BROWSER_GPU: 'native', CI: 'true' },
    'darwin',
  );
  const software = browserGpuLaunchOptions(launch, { CI: 'true' }, 'darwin');
  assert.equal(native.chromiumSandbox, true);
  assert.ok(native.args.includes('--enable-features=UseSkiaRenderer,SharedArrayBuffer'));
  assert.ok(!native.args.some((flag) => /swiftshader|use-angle|Vulkan/.test(flag)));
  assert.ok(software.args.includes('--use-angle=swiftshader'));
});

test('unqualified Windows and Linux retain the required software Browser carrier', () => {
  const windows = browserGpuLaunchOptions(launch, { CI: 'true' }, 'win32');
  const linux = browserGpuLaunchOptions(launch, { CI: 'true' }, 'linux');
  assert.ok(windows.args.includes('--use-webgpu-adapter=swiftshader'));
  assert.ok(linux.args.includes('--use-vulkan=swiftshader'));
  assert.ok(linux.args.includes('--use-angle=swiftshader'));
  assert.equal(windows.chromiumSandbox, true);
  assert.equal(linux.chromiumSandbox, true);
  assert.throws(
    () => browserGpuLaunchOptions(launch, { FORGEAX_BROWSER_GPU: 'typo' }, 'win32'),
    /software or native/,
  );
  assert.throws(
    () => browserGpuLaunchOptions(launch, { FORGEAX_BROWSER_GPU: 'native' }, 'linux'),
    /Windows/,
  );
});

test('native acceptance retains hardware identity and rejects software or missing adapter evidence', () => {
  const info = {
    vendor: 'nvidia',
    architecture: 'ada',
    device: 'physical',
    description: '',
    isFallbackAdapter: false,
  };
  assert.deepEqual(requireNativeBrowserAdapter({ info }), info);
  for (const adapter of [
    null,
    {},
    { info: { ...info, isFallbackAdapter: true } },
    { info: { ...info, isFallbackAdapter: undefined } },
    { info: { ...info, description: 'Microsoft WARP' } },
    { info: { ...info, architecture: 'swiftshader' } },
  ])
    assert.throws(() => requireNativeBrowserAdapter(adapter), /admission failed/);
});
