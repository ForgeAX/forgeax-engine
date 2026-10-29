import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const action = readFileSync(
  resolve('.github/actions/install-playwright-chrome-beta/action.yml'),
  'utf8',
);
const detector = action
  .split('      run: |\n')[1]
  .split('\n    - name:')[0]
  .split('\n')
  .map((line) => line.slice(8))
  .join('\n');
const minimumMajor = JSON.parse(
  readFileSync(resolve('scripts/ci/browser-version-policy.json'), 'utf8'),
).minimumMajor;
const verifier = action
  .split('    - name: Verify Chrome Beta binary (Linux only)')[1]
  .split('      run: |\n')[1]
  .split('\n    - name:')[0]
  .split('\n')
  .map((line) => line.slice(8))
  .join('\n');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

for (const displayAvailable of [false, true])
  for (const major of [154, minimumMajor, minimumMajor + 1]) {
    test(`Chrome host reuse qualifies version ${major} and display dependency ${displayAvailable}`, {
      skip: process.platform === 'win32',
    }, () => {
      const root = mkdtempSync(join(tmpdir(), 'forgeax-chrome-host-'));
      try {
        const executable = (name, body) => {
          const path = join(root, name);
          writeFileSync(path, `#!/bin/sh\n${body}\n`);
          chmodSync(path, 0o755);
          return path;
        };
        const chrome = executable('google-chrome-beta', `echo Google Chrome ${major}.0.0.0 beta`);
        symlinkSync(process.execPath, join(root, 'node'));
        executable('ldd', 'exit 0');
        symlinkSync('/usr/bin/grep', join(root, 'grep'));
        if (displayAvailable) executable('Xvfb', 'exit 0');
        const output = join(root, 'output');
        execFileSync(
          '/bin/bash',
          [
            '-eu',
            '-c',
            detector.replace('binary=/opt/google/chrome-beta/chrome', `binary=${quote(chrome)}`),
          ],
          { env: { PATH: root, GITHUB_OUTPUT: output }, stdio: 'pipe' },
        );
        assert.equal(
          readFileSync(output, 'utf8').trim(),
          `minimum-major=${minimumMajor}\ninstalled=${displayAvailable && major >= minimumMajor}`,
        );
        const verify = () =>
          execFileSync(
            '/bin/bash',
            [
              '-eu',
              '-c',
              verifier.replace('binary=/opt/google/chrome-beta/chrome', `binary=${quote(chrome)}`),
            ],
            { env: { PATH: root }, stdio: 'pipe' },
          );
        if (major < minimumMajor) assert.throws(verify, (error) => error.status === 1);
        else verify();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
