import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectBrowserExecutable } from '../browser-executable.mjs';

const base = { channel: 'chrome-beta', chromiumSandbox: true, args: ['--enable-features=Vulkan'] };

test('a pinned executable removes the ambient channel without disabling the sandbox', () => {
  assert.deepEqual(selectBrowserExecutable(base, { FORGEAX_BROWSER_EXECUTABLE: '/ci/chrome' }), {
    chromiumSandbox: true,
    args: base.args,
    executablePath: '/ci/chrome',
  });
  assert.equal(base.channel, 'chrome-beta');
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
