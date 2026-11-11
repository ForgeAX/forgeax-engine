import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('game-3d project', () => {
  it('declares the engine and frontend roots as plugin GUIDs and mounts Engine Content', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../forge.json', import.meta.url), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: '3.0.0',
      assetLibraries: ['@forgeax/engine/content'],
      roots: {
        // game.pack.ts plugin/engine; ui/ui.pack.ts plugin/host
        engine: 'acd36c75-755b-577d-9c5a-e6deebb0ed40',
        frontend: '62f18971-a9ff-584c-aa55-f695fefadba6',
      },
    });
  });
});
