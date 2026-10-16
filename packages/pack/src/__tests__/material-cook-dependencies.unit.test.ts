import type { AssetGuid } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { collectMaterialCookRefs } from '../evidence/material-cook.js';
import { AssetGuid as Guid } from '../guid.js';
import { NativeCookerRegistry } from '../native-cooker-registry.js';
import { createRuntimePackPublication } from '../runtime-publication.js';

describe('material cook dependency closure', () => {
  it('keeps binary parent and texture GUIDs in the canonical catalog spelling', () => {
    const guid = '11111111-1111-4111-8111-111111111111';
    const parsed = Guid.parse(guid);
    if (!parsed.ok) throw parsed.error;
    expect(
      collectMaterialCookRefs({
        parent: parsed.value,
        values: { baseColorTexture: { texture: parsed.value, sampler: parsed.value } },
      }),
    ).toMatchObject({ parent: [guid], textures: [guid], samplers: [guid] });
  });
  it('collects parent, texture, sampler, and module references', () => {
    expect(
      collectMaterialCookRefs({
        parent: 'mat-parent' as unknown as AssetGuid,
        passes: [{ name: 'forward', program: { module: 'module/pbr' } }],
        values: {
          baseColor: {
            texture: 'texture/albedo' as unknown as AssetGuid,
            sampler: 'sampler/linear' as unknown as AssetGuid,
          },
        },
      }),
    ).toEqual({
      parent: ['mat-parent'],
      textures: ['texture/albedo'],
      samplers: ['sampler/linear'],
      modules: ['module/pbr'],
    });
  });

  it('collects transmission and thickness texture dependencies', () => {
    expect(
      collectMaterialCookRefs({
        parameters: [
          { name: 'transmissionTexture', type: 'texture' },
          { name: 'thicknessTexture', type: 'texture' },
        ],
        values: {
          transmissionTexture: { texture: 'texture/transmission', sampler: 'sampler/linear' },
          thicknessTexture: { texture: 'texture/thickness', sampler: 'sampler/linear' },
        },
      }),
    ).toEqual({
      parent: [],
      textures: ['texture/thickness', 'texture/transmission'],
      samplers: ['sampler/linear'],
      modules: [],
    });
  });

  it('keeps authored Standard values with both texture dependency edges', () => {
    const refs = collectMaterialCookRefs({
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } }],
      parameters: [
        { name: 'transmissionTexture', type: 'texture' },
        { name: 'thicknessTexture', type: 'texture' },
      ],
      values: {
        transmission: 0.8,
        ior: 1.45,
        thickness: 0.25,
        transmissionTexture: { texture: 'texture/transmission', sampler: 'sampler/linear' },
        thicknessTexture: { texture: 'texture/thickness', sampler: 'sampler/linear' },
      },
    });

    expect(refs).toEqual({
      parent: [],
      textures: ['texture/thickness', 'texture/transmission'],
      samplers: ['sampler/linear'],
      modules: ['forgeax::default-standard-pbr'],
    });
  });

  it('collects string shorthands only from declared texture parameters', () => {
    expect(
      collectMaterialCookRefs({
        parameters: [
          { name: 'surface', type: 'texture' },
          { name: 'label', type: 'f32' },
        ],
        values: { surface: 'texture/albedo', label: 'not-a-texture-ref' },
      }),
    ).toEqual({ parent: [], textures: ['texture/albedo'], samplers: [], modules: [] });
  });

  it('treats a string value as a texture shorthand when parameters are omitted', () => {
    expect(
      collectMaterialCookRefs({
        values: { baseColorTexture: 'texture/albedo' },
      }),
    ).toEqual({ parent: [], textures: ['texture/albedo'], samplers: [], modules: [] });
  });

  it('keeps the last known good candidate when a generation fails before publication', async () => {
    const registry = new NativeCookerRegistry();
    let fail = false;
    registry.register({
      key: 'material',
      cook: () => {
        if (fail) throw new Error('candidate rejected');
        return {
          guid: 'material-child',
          payload: { kind: 'material' },
          refs: ['texture/albedo'],
          artifacts: {
            'material-child/shader.wgsl': {
              mediaType: 'text/wgsl',
              bytes: new TextEncoder().encode('shader'),
            },
          },
          inputFingerprint: 'sha256:material-candidate',
        };
      },
    });

    const committed = await registry.runTransaction({ key: 'material', input: {} });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.error.hint);
    fail = true;
    const recovered = await registry.runTransaction({
      key: 'material',
      input: {},
      previous: committed.value,
    });

    expect(recovered).toMatchObject({
      ok: true,
      value: {
        status: 'recovered',
        generation: 1,
        candidateGeneration: 2,
        lastKnownGoodGeneration: 1,
        lastKnownGood: committed.value.draft,
      },
    });
  });

  it('keeps runtime publication identity independent from source-path diagnostics', () => {
    const input = {
      pack: {
        assets: [{ guid: 'material-child', kind: 'material', payload: { roughness: 0.5 } }],
      },
      scopeId: 'project',
      sourceRevision: 'rev-1',
      packageUrl: '/packs/materials.json',
    };
    const first = createRuntimePackPublication({ ...input, sourcePath: '/src/materials.json' });
    const moved = createRuntimePackPublication({ ...input, sourcePath: '/moved/materials.json' });

    expect(moved.pack.digest).toBe(first.pack.digest);
    expect(moved.publication.digest).toBe(first.publication.digest);
    expect(moved.publication.outputSetDigest).toBe(first.publication.outputSetDigest);
    expect(moved.publication.receipt.inputFingerprint).toBe(
      first.publication.receipt.inputFingerprint,
    );
    expect(moved.publication.sourcePath).toBe('/moved/materials.json');
  });
});
