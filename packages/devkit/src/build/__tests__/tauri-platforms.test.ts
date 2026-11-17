import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { tauriBuildScript } from '../tauri-source.js';

const exec = promisify(execFile);

it.each([
  ['windows', 'win32', ['build', '--ci', '--bundles', 'nsis,msi']],
  ['macos', 'darwin', ['build', '--ci', '--bundles', 'app,dmg']],
  ['linux', 'linux', ['build', '--ci', '--bundles', 'appimage,deb,rpm']],
  ['android', 'linux', ['android', 'build', '--ci', '--apk', '--aab']],
  ['ios', 'darwin', ['ios', 'build', '--ci']],
])('dispatches generated %s builds and initializes mobile projects once', async (platform, host, expected) => {
  const root = await mkdtemp(resolve(tmpdir(), 'tauri platform '));
  try {
    await mkdir(resolve(root, 'scripts'));
    await mkdir(resolve(root, 'node_modules/@tauri-apps/cli'), { recursive: true });
    await writeFile(resolve(root, 'scripts/build.mjs'), tauriBuildScript);
    await mkdir(resolve(root, 'src-tauri/android'), { recursive: true });
    await writeFile(
      resolve(root, 'src-tauri/android/loopback-network.xml'),
      '<network-security-config />',
    );
    await writeFile(
      resolve(root, 'host.mjs'),
      `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(host)} });`,
    );
    await writeFile(
      resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'),
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (process.env.CI !== 'true') process.exit(11);
      fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
      if (args[1] === 'init') {
        fs.mkdirSync('src-tauri/gen/' + (args[0] === 'ios' ? 'apple' : 'android'), { recursive: true });
        if (args[0] === 'android') {
          fs.mkdirSync('src-tauri/gen/android/app/src/main', { recursive: true });
          fs.writeFileSync('src-tauri/gen/android/app/src/main/AndroidManifest.xml', '<manifest><application /></manifest>');
        }
      }
      if (process.env.FAIL_BUILD === 'true' && args.includes('build')) process.exit(9);
    `,
    );
    const args = [
      '--import',
      pathToFileURL(resolve(root, 'host.mjs')).href,
      resolve(root, 'scripts/build.mjs'),
      '--platform',
      platform,
    ];
    await exec(process.execPath, [...args, '--config', '{"bundle":{"active":true}}'], {
      cwd: root,
    });
    await exec(process.execPath, args, { cwd: root });
    const calls = (await readFile(resolve(root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls[0]).toEqual(['icon', 'icon.svg']);
    if (platform === 'android') {
      expect(
        await readFile(
          resolve(root, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
          'utf8',
        ),
      ).toContain('android:networkSecurityConfig="@xml/forgeax_loopback"');
      expect(
        await readFile(
          resolve(root, 'src-tauri/gen/android/app/src/main/res/xml/forgeax_loopback.xml'),
          'utf8',
        ),
      ).toBe('<network-security-config />');
    }
    expect(calls).toContainEqual([...expected, '--config', '{"bundle":{"active":true}}']);
    expect(calls.at(-1)).toEqual(expected);
    expect(calls.filter((call) => call[1] === 'init')).toHaveLength(
      ['android', 'ios'].includes(platform) ? 1 : 0,
    );
    await expect(
      exec(process.execPath, args, { cwd: root, env: { ...process.env, FAIL_BUILD: 'true' } }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects foreign desktop and non-macOS iOS builds before invoking tools', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'tauri-host-'));
  try {
    await mkdir(resolve(root, 'node_modules/@tauri-apps/cli'), { recursive: true });
    await writeFile(
      resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'),
      'throw new Error("must not run");',
    );
    await writeFile(resolve(root, 'build.mjs'), tauriBuildScript);
    await writeFile(
      resolve(root, 'host.mjs'),
      "Object.defineProperty(process, 'platform', { value: 'linux' });",
    );
    for (const platform of ['windows', 'ios', 'invalid']) {
      const result = await exec(process.execPath, [
        '--import',
        pathToFileURL(resolve(root, 'host.mjs')).href,
        resolve(root, 'build.mjs'),
        '--platform',
        platform,
      ]).catch((error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/native host|Expected --platform/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
