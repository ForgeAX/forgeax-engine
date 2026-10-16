import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

for (const valid of [true, false]) test.skipIf(process.platform === 'win32')(
  valid ? 'uses the SDK selected by xcrun, including paths with spaces'
    : 'rejects xcrun failure before native source preparation',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'dawn-sdk-'));
    try {
      const sdk = join(root, 'Command Line Tools', 'SDKs', 'MacOSX.sdk');
      mkdirSync(sdk, { recursive: true });
      writeFileSync(join(sdk, 'SDKSettings.json'), '{}');
      writeFileSync(join(root, 'xcrun'), valid
        ? '#!/bin/sh\n[ "$1 $2 $3" = "--sdk macosx --show-sdk-path" ] || exit 2\nprintf "%s\\n" "$DAWN_TEST_SDK"\n'
        : '#!/bin/sh\nexit 21\n', { mode: 0o755 });
      const module = new URL('../prepare-native.mjs', import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
        `import { resolveMacOsSdk } from ${JSON.stringify(module)}; console.log(resolveMacOsSdk());`],
      { encoding: 'utf8', env: { ...process.env, PATH: root, DAWN_TEST_SDK: sdk } });
      if (valid) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), sdk);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /dawn-native-sdk-unavailable/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);
