// migrate-standard-material-pack.test.mjs (feat-20260523-shader-template-instance-split M6-T02).
//
// Unit test for the M6 codemod. Coverage:
//   (a) standard -> schema-driven 1:1 migration (values populated;
//       shadingModel removed; materialShader = forgeax::default-standard-pbr).
//   (b) unlit shading model is left untouched (codemod skip).
//   (c) already-migrated payload (no shadingModel) is left untouched
//       (idempotent on second run).
//   (d) channelMap object encoding (legacy {metallic,roughness,occlusion} ->
//       vec4 [m,r,o,0]).
//   (e) deepEquals after running migratePack twice on the same input
//       (architecture principle #6 idempotency).
//
// The codemod is exported as pure functions (migratePack, migratePayload),
// so the test does not spawn a subprocess; it imports directly and asserts
// over JS values.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { migratePack, migratePayload } from '../migrate-standard-material-pack.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const RUSTED_WGSL = join(REPO_ROOT, 'templates/game-3d/assets/shaders/rusted-iron.wgsl');
const RUSTED_PACK = join(REPO_ROOT, 'templates/game-3d/assets/materials.pack.ts');

const SCHEMA = [
  { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
  { name: 'metallic', type: 'f32', default: 0.0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'channelMap', type: 'vec4', default: [2, 1, 0, 0] },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
  { name: 'sampler', type: 'sampler' },
];

describe('migrate-standard-material-pack codemod', () => {
  it('(a) maps standard shading payload to schema-driven shape', () => {
    const legacy = {
      shadingModel: 'standard',
      baseColor: [0.8, 0.4, 0.2, 1],
      metallic: 0,
      roughness: 0.5,
    };
    const migrated = migratePayload(legacy, SCHEMA);
    expect(migrated).not.toBeNull();
    expect(migrated.materialShader).toBe('forgeax::default-standard-pbr');
    expect(migrated.paramSchema).toEqual(SCHEMA);
    expect(migrated.values).toEqual({
      baseColor: [0.8, 0.4, 0.2, 1],
      metallic: 0,
      roughness: 0.5,
    });
    expect(Object.hasOwn(migrated.values, 'shadingModel')).toBe(false);
  });

  it('(a2) carries texture references through values verbatim', () => {
    const legacy = {
      shadingModel: 'standard',
      baseColor: [1, 1, 1, 1],
      baseColorTexture: '019e3969-1d46-7945-a75a-ef97d537531e',
      metallicRoughnessTexture: '019e3969-1d46-76ca-9a46-2168b746a292',
    };
    const migrated = migratePayload(legacy, SCHEMA);
    expect(migrated.values.baseColorTexture).toBe('019e3969-1d46-7945-a75a-ef97d537531e');
    expect(migrated.values.metallicRoughnessTexture).toBe('019e3969-1d46-76ca-9a46-2168b746a292');
  });

  it('(b) returns null for unlit payload (skip)', () => {
    const unlit = {
      shadingModel: 'unlit',
      baseColor: [1, 1, 1, 1],
    };
    expect(migratePayload(unlit, SCHEMA)).toBeNull();
  });

  it('(c) returns null for already-migrated payload (idempotent on second run)', () => {
    const alreadyMigrated = {
      materialShader: 'forgeax::default-standard-pbr',
      paramSchema: SCHEMA,
      values: { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 },
    };
    expect(migratePayload(alreadyMigrated, SCHEMA)).toBeNull();
  });

  it('(d) encodes legacy channelMap object as vec4 numeric tuple', () => {
    const legacy = {
      shadingModel: 'standard',
      baseColor: [1, 1, 1, 1],
      metallic: 0,
      roughness: 0.5,
      channelMap: { metallic: 'b', roughness: 'g', occlusion: 'r' },
    };
    const migrated = migratePayload(legacy, SCHEMA);
    expect(migrated.values.channelMap).toEqual([2, 1, 0, 0]);
  });

  it('(e) idempotency: running migratePack twice yields the same result', () => {
    const pack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: 'f6af7007-158f-4d92-9e47-93bf2f213e1f',
          kind: 'material',
          payload: {
            shadingModel: 'standard',
            baseColor: [0.8, 0.4, 0.2, 1],
            metallic: 0,
            roughness: 0.5,
          },
          refs: [],
        },
      ],
    };
    const first = migratePack(pack, SCHEMA);
    expect(first.changed).toBe(true);
    const second = migratePack(first.pack, SCHEMA);
    expect(second.changed).toBe(false);
    // Round-tripping: third pass over the same output is a no-op.
    const third = migratePack(second.pack, SCHEMA);
    expect(third.changed).toBe(false);
    expect(JSON.stringify(third.pack)).toBe(JSON.stringify(first.pack));
  });

  it('(f) does not touch non-material assets', () => {
    const pack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        { guid: 'g1', kind: 'mesh', payload: { positions: [0, 0, 0] } },
        {
          guid: 'g2',
          kind: 'material',
          payload: { shadingModel: 'unlit', baseColor: [1, 1, 1, 1] },
        },
      ],
    };
    const result = migratePack(pack, SCHEMA);
    expect(result.changed).toBe(false);
  });

  it('(g) preserves guid + refs on migrated asset entries', () => {
    const pack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: 'mat-guid-1',
          kind: 'material',
          payload: {
            shadingModel: 'standard',
            baseColor: [1, 1, 1, 1],
            metallic: 0,
            roughness: 0.5,
            baseColorTexture: 'tex-guid-a',
          },
          refs: ['tex-guid-a'],
        },
      ],
    };
    const result = migratePack(pack, SCHEMA);
    expect(result.changed).toBe(true);
    expect(result.pack.assets[0].guid).toBe('mat-guid-1');
    expect(result.pack.assets[0].refs).toEqual(['tex-guid-a']);
    expect(result.pack.assets[0].payload.materialShader).toBe('forgeax::default-standard-pbr');
  });

  it('(h) keeps rusted-iron as one Surface-only Standard authoring path', async () => {
    const [wgsl, packText] = await Promise.all([
      readFile(RUSTED_WGSL, 'utf8'),
      readFile(RUSTED_PACK, 'utf8'),
    ]);
    expect(packText).toContain("'material/rusted-iron'");
    expect(packText).toContain('packageId: PACKAGE_IDS.materials');
    expect(packText).not.toContain('rusted-iron.pack.json');
    expect(wgsl).toContain('#define_import_path game_3d::rusted_iron_surface');
    expect(wgsl).toContain('fn evaluate_surface(');
    expect(wgsl).not.toMatch(/@(?:vertex|fragment)/);
    expect(wgsl).not.toMatch(/(?:vs_main|fs_main|lightDir|f_schlick|@builtin\(position\))/);
    expect(packText.match(/'material\/rusted-iron'/g)).toHaveLength(1);
    expect(packText.match(/surfaceModule: 'game_3d::rusted_iron_surface'/g)).toHaveLength(1);
  });
});
