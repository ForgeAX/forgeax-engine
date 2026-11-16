import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { writeTauriProject } from '../build/tauri.js';
import { verifyDist, writeDistManifest } from '../dist.js';
import {
  canBuildTauriPlatform,
  collectTauriBundles,
  packageTauriProject,
  TAURI_PLATFORMS,
} from '../tauri-package.js';
import type { ProjectFacts } from '../types.js';

const nativeSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: nativeSpawn,
}));

vi.mock('../host.js', () => ({
  buildProject: vi.fn(async ({ outDir }: { outDir: string }) => {
    await mkdir(resolve(outDir, 'shaders'), { recursive: true });
    await writeFile(resolve(outDir, 'index.html'), '<title>Packaged game</title>');
    await writeFile(resolve(outDir, 'pack-index.json'), '[]');
    await writeFile(resolve(outDir, 'shaders/manifest.json'), '{}');
    const facts = { id: 'fixture', name: 'Fixture' } as ProjectFacts;
    await writeTauriProject(facts, outDir);
    await writeDistManifest(facts, './', outDir, 'tauri');
    return { ok: true, value: {} };
  }),
}));

it('exports sealed projects for all five platforms without native tools or source edits', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'tauri-package-'));
  const facts = { root, id: 'fixture', name: 'Fixture' } as ProjectFacts;
  try {
    for (const platform of TAURI_PLATFORMS) {
      const result = await packageTauriProject(facts, {
        format: 'tauri',
        platform,
        prepareOnly: true,
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          platform,
          status: 'prepared',
          artifacts: [],
          verification: { nativeBuild: 'not-run', runtime: 'not-run' },
        },
      });
      const output = resolve(root, `release/fixture-tauri-${platform}`);
      expect((await verifyDist(output)).ok).toBe(true);
      const before = await readFile(resolve(output, 'web/index.html'), 'utf8');
      expect(await packageTauriProject(facts, { platform, prepareOnly: true })).toMatchObject({
        ok: false,
        error: { code: 'tauri-package-output-exists' },
      });
      expect(await readFile(resolve(output, 'web/index.html'), 'utf8')).toBe(before);
    }
    expect(await readdir(resolve(root, '.forgeax'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps host support explicit and rejects invalid native options', async () => {
  expect(canBuildTauriPlatform('windows', 'darwin')).toBe(false);
  expect(canBuildTauriPlatform('ios', 'linux')).toBe(false);
  expect(canBuildTauriPlatform('ios', 'darwin')).toBe(true);
  expect(canBuildTauriPlatform('android', 'linux')).toBe(true);
  expect(
    await packageTauriProject({ root: '/unused' } as ProjectFacts, {
      platform: 'android',
      compress: true,
    }),
  ).toMatchObject({ ok: false, error: { code: 'tauri-package-options-invalid' } });
});

it('collects complete application bundles and installers without intermediate binaries', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'tauri-artifacts-'));
  try {
    await mkdir(resolve(root, 'macos/Game.app/Contents/MacOS'), { recursive: true });
    await writeFile(resolve(root, 'macos/Game.app/Contents/MacOS/game'), 'binary');
    for (const name of [
      'Game.dmg',
      'setup.exe',
      'setup.msi',
      'game.AppImage',
      'game.deb',
      'game.rpm',
      'game.apk',
      'game.aab',
      'game.ipa',
      'game-unaligned.apk',
      'intermediate.so',
    ])
      await writeFile(resolve(root, name), name);
    expect((await collectTauriBundles(root)).map((path) => path.slice(root.length + 1))).toEqual([
      'Game.dmg',
      'game.AppImage',
      'game.aab',
      'game.apk',
      'game.deb',
      'game.ipa',
      'game.rpm',
      'macos/Game.app',
      'setup.exe',
      'setup.msi',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('installs the native CLI in production environments and retains only deliverable native output', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'tauri-native-package-'));
  const facts = { root, id: 'fixture', name: 'Fixture' } as ProjectFacts;
  nativeSpawn.mockImplementation(
    (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      queueMicrotask(async () => {
        try {
          expect(options.env.CARGO_TARGET_DIR).toBe(resolve(options.cwd, 'src-tauri/target'));
          if (args[0] === 'install') {
            expect(command).toBe('npm');
            expect(args).toContain('--include=dev');
            expect(args).toContain('--include=optional');
            await mkdir(resolve(options.cwd, 'node_modules'), { recursive: true });
          } else {
            // Mobile IDE callbacks must inherit a package manager CLI entry.
            expect(command).toBe('npm');
            expect(args[0]).toBe('run');
            expect(args[1]).toMatch(/^build:(windows|macos|linux)$/);
            const bundles = resolve(options.cwd, 'src-tauri/target/release/bundle/dmg');
            await mkdir(bundles, { recursive: true });
            await writeFile(resolve(bundles, 'Fixture.dmg'), 'native-package');
            await writeFile(resolve(options.cwd, 'src-tauri/Cargo.lock'), '# Cargo lock');
          }
          child.emit('exit', 0);
        } catch (cause) {
          child.emit('error', cause);
        }
      });
      return child;
    },
  );
  try {
    const result = await packageTauriProject(facts, { format: 'tauri' });
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'built',
        verification: { nativeBuild: 'passed', runtime: 'not-run' },
        artifacts: [
          {
            path: expect.stringContaining('Fixture.dmg'),
            bytes: 14,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
      },
    });
    if (!result.ok) throw result.error;
    const output = (result.value as { directory: string }).directory;
    expect(await readFile(resolve(output, 'src-tauri/Cargo.lock'), 'utf8')).toBe('# Cargo lock');
    expect((await readdir(output)).includes('node_modules')).toBe(false);
    expect(await readdir(resolve(output, 'src-tauri'))).not.toContain('target');
    expect((await verifyDist(output)).ok).toBe(true);
    expect(nativeSpawn).toHaveBeenCalledTimes(2);
  } finally {
    nativeSpawn.mockReset();
    await rm(root, { recursive: true, force: true });
  }
});
