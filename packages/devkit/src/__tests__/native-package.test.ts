import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { nativeInstallerSource } from '../build/native-installer-source';
import { buildNativeInstaller, planNativePackage } from '../native-package';

const project = {
  root: resolve('fixtures/game'),
  id: 'native-sample',
  name: 'Game & Demo',
  packageJson: { version: '1.2.3' },
};
const options = {
  format: 'native',
  publisher: 'ForgeaX & Friends',
  nodeDist: 'test-runtime',
  vcRuntime: 'test-redist',
} as const;

function plan(overrides = {}) {
  const result = planNativePackage(project, { ...options, ...overrides });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

it('keeps the installation identity across upgrades and separates channels', () => {
  const original = plan();
  const update = plan({ version: '1.2.4' });
  const preview = plan({ channel: 'preview' });
  expect(update.upgradeCode).toBe(original.upgradeCode);
  expect(update.installKey).toBe(original.installKey);
  expect(update.productCode).not.toBe(original.productCode);
  expect(plan().productCode).toBe(original.productCode);
  expect(preview.upgradeCode).not.toBe(original.upgradeCode);
  expect(preview.shortcutName).not.toBe(original.shortcutName);
  expect(nativeInstallerSource(original)).toContain('Manufacturer="ForgeaX &amp; Friends"');
});

it('rejects incompatible targets, empty signing inputs, and in-dist output', () => {
  for (const [override, code] of [
    [{ arch: 'arm64' }, 'native-package-target-invalid'],
    [{ version: '1.256.0' }, 'native-package-identity-invalid'],
    [{ timestampUrl: 'https://timestamp.example.org' }, 'native-package-signing-invalid'],
    [{ output: 'dist/final.msi' }, 'native-package-output-invalid'],
  ] as const) {
    expect(planNativePackage(project, { ...options, ...override })).toMatchObject({
      ok: false,
      error: { code },
    });
  }
});

it('plans signing with a selected certificate store and a timestamp endpoint', () => {
  const thumbprint = 'A1'.repeat(20);
  const signed = plan({
    signThumbprint: thumbprint.toLowerCase(),
    signStore: 'machine',
    timestampUrl: 'https://timestamp.example.org/sign',
  });
  expect(signed.signature).toEqual({
    thumbprint,
    timestamp: 'https://timestamp.example.org/sign',
    machine: true,
  });
});

it('admits the output before preflight and retires a failed installer stage', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-installer-stage-'));
  try {
    const occupied = resolve(root, 'occupied.msi');
    await writeFile(occupied, 'existing installer');
    const preflight = vi.fn(async () => {});
    const failure = Object.assign(new Error('signing failed'), { stderr: 'signing diagnostic' });
    const build = vi.fn(async (stage: string, progress: { phase: string }) => {
      await writeFile(resolve(stage, 'payload'), 'unpublished');
      progress.phase = 'installer-signing';
      throw failure;
    });
    expect(await buildNativeInstaller(occupied, 'msi', build, preflight)).toMatchObject({
      ok: false,
      error: { code: 'native-package-output-exists' },
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(
      await buildNativeInstaller(resolve(root, 'game.msi'), 'msi', build, preflight),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'native-package-failed',
        detail: {
          phase: 'installer-signing',
          reason: 'signing failed',
          toolOutput: 'signing diagnostic',
        },
      },
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual(['occupied.msi']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
