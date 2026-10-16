import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Preview project programs', () => {
  it('uses the generated program tables and native root activation', async () => {
    const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('activateExecutionRoot');
    expect(source).toContain('virtual:forgeax/plugin-programs/');
    expect(source).not.toContain('defaultSceneRoot');
    expect(source).not.toContain('manifest.plugins');
  });
  it.each(['empty', 'game-3d'])('selects the explicit engine root of %s', async (template) => {
    const manifest = JSON.parse(await readFile(new URL(`../../../templates/${template}/forge.json`, import.meta.url), 'utf8'));
    expect(manifest).toMatchObject({ schemaVersion: '3.0.0', roots: { engine: expect.any(String) } });
    expect(manifest).not.toHaveProperty('plugins');
  });
});
