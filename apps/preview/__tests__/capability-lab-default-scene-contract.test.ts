import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENE_GUID } from '../../../apps/game-capability-lab/assets/plugins/scene-runtime';

type ForgeManifest = {
  roots: { engine?: string };
};

type ScenePack = {
  assets?: Record<string, { kind?: string }>;
};

describe('capability-lab Preview scene contract', () => {
  it('references the authored scene from the engine plugin asset', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../apps/game-capability-lab/forge.json', import.meta.url), 'utf8'),
    ) as ForgeManifest;
    const scenePack = JSON.parse(
      readFileSync(new URL('../../../apps/game-capability-lab/assets/scene.pack.json', import.meta.url), 'utf8'),
    ) as ScenePack;

    expect(manifest.roots.engine).toEqual(expect.any(String));
    const game = JSON.parse(readFileSync(new URL('../../../apps/game-capability-lab/assets/game.pack.json', import.meta.url), 'utf8'));
    expect(game.assets['plugin/engine'].payload.config.scene).toEqual({ $asset: SCENE_GUID });
    expect(scenePack.assets?.['scene/main']).toMatchObject({ kind: 'scene' });
  });
});
