import { describe, expect, it } from 'vitest';
import {
  type AssetBindingCatalog,
  assetBindingDeclarationSource,
  assetBindingModuleSource,
} from '../build/asset-bindings.js';

describe('asset binding projections', () => {
  it('projects one literal virtual module from the author inventory', () => {
    const catalog: AssetBindingCatalog = {
      assets: [
        {
          guid: '00000000-0000-0000-0000-000000000011',
          sourceKey: 'hero/body',
          kind: 'mesh',
        },
      ],
      scenes: [],
    };
    const source = assetBindingModuleSource(catalog);

    expect(source).toContain('"sourceKey":"hero/body"');
    expect(source).toContain('function asset');
  });

  it('projects sceneEntity addresses and a rebuildable declaration surface', () => {
    const source = assetBindingModuleSource({
      assets: [],
      scenes: [{ sourceKey: 'level/main', entityKeys: ['player-spawn', 'follow-camera'] }],
    });

    expect(source).toContain('function sceneEntity');
    expect(source).toContain('player-spawn');
    expect(source).toContain('follow-camera');
    expect(
      assetBindingDeclarationSource({
        assets: [],
        scenes: [{ sourceKey: 'level/main', entityKeys: ['player-spawn', 'follow-camera'] }],
      }),
    ).toContain("declare module 'virtual:forgeax/assets'");
    expect(
      assetBindingDeclarationSource({
        assets: [
          { guid: '00000000-0000-0000-0000-000000000013', sourceKey: 'world/main', kind: 'scene' },
        ],
        scenes: [],
      }),
    ).toContain('"world/main": import(\'@forgeax/engine/types\').AssetRef<"scene">');
  });

  it('fails closed for duplicate and missing entity keys', () => {
    try {
      assetBindingModuleSource({
        assets: [],
        scenes: [{ sourceKey: 'level/main', entityKeys: ['player', 'player'] }],
      });
      throw new Error('duplicate binding was accepted');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'asset-binding-duplicate',
        expected: expect.stringContaining('entity keys'),
      });
    }
  });
});
