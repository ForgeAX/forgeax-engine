import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveBrowserExecutable, softwareCaptureCommand } from '../software-capture.js';

describe('softwareCaptureCommand', () => {
  it('fails closed with actionable browser setup evidence', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-software-capture-'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'capture-fixture',
          name: 'Capture Fixture',
          schemaVersion: '3.0.0',
          roots: {},
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), `${JSON.stringify({ name: 'capture-fixture' })}\n`),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);
    const result = await softwareCaptureCommand({
      root,
      software: true,
      browser: resolve(root, 'missing-chrome-beta'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'software-capture-browser-missing',
        detail: { browser: resolve(root, 'missing-chrome-beta') },
      });
    }
  });
});

// Exercise installed-browser discovery without launching a platform-specific binary.
describe('installed browser discovery', () => {
  it.each([
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'LOCALAPPDATA',
  ])('finds Chrome through %s while preserving explicit executable priority', async (variable) => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-browser-discovery-'));
    const chrome = resolve(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
    const requested = resolve(root, 'requested-browser');
    try {
      await mkdir(dirname(chrome), { recursive: true });
      await writeFile(chrome, 'fixture');
      await writeFile(requested, 'fixture');
      for (const key of [
        'PROGRAMFILES',
        'PROGRAMFILES(X86)',
        'LOCALAPPDATA',
        'FORGEAX_BROWSER_EXECUTABLE',
      ])
        vi.stubEnv(key, '');
      vi.stubEnv(variable, root);
      expect(await resolveBrowserExecutable(undefined)).toBe(chrome);
      expect(await resolveBrowserExecutable(requested)).toBe(requested);
      expect(await resolveBrowserExecutable(resolve(root, 'missing'))).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
