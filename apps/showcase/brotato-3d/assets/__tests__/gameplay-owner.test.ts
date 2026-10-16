import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../gameplay.plugin.ts');

describe('Brotato gameplay owner', () => {
  it('owns combat, spawn, camera, and HUD through plugin composition', async () => {
    const pluginRoot = resolve(dirname(source), 'plugins');
    const text = (
      await Promise.all([
        readFile(source, 'utf8'),
        readFile(resolve(pluginRoot, 'game-plugin.ts'), 'utf8'),
        readFile(resolve(pluginRoot, 'gameplay.ts'), 'utf8'),
        readFile(resolve(pluginRoot, 'hud.ts'), 'utf8'),
      ])
    ).join('\n');
    expect(text).toContain('ctx.plugin');
    expect(text).toContain('FixedUpdate');
    expect(text).toContain('hud');
  });
});
