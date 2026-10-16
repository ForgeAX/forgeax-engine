import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePackV2, validateCookedMaterialRecord } from '../index.js';

const root = resolve(import.meta.dirname, '../../../../');

const fixtures = [
  {
    path: 'apps/hello/cube/assets/cube-mesh.pack.json',
    assets: [{ guid: 'cbe42beb-8975-5096-b3a1-3dda4cb4c077', refs: [] }],
  },
  {
    path: 'apps/hello/room/assets/room.pack.json',
    assets: [
      {
        guid: '019e2808-d3ba-735f-811f-ae7bbb465392',
        refs: [
          'cbe42beb-8975-5096-b3a1-3dda4cb4c077',
          'f6af7007-158f-4d92-9e47-93bf2f213e1f',
          '008e4f75-e7a3-4715-b05b-b93a9ec12074',
        ],
      },
    ],
  },
  {
    path: 'apps/hello/scene-nesting/assets/outer-scene.pack.json',
    assets: [
      {
        guid: 'd07a7b8e-9c12-4f6b-a8e1-3d4f5a6b7c8d',
        refs: ['f47ac10b-58cc-4372-a567-0e02b2c3d479', '008e4f75-e7a3-4715-b05b-b93a9ec12074'],
      },
    ],
  },
];

describe('Pack v2 fixture migration', () => {
  it('preserves logical GUID and refs while requiring local artifact maps', () => {
    for (const fixture of fixtures) {
      const parsed = parsePackV2(JSON.parse(readFileSync(resolve(root, fixture.path), 'utf8')));
      expect(parsed.ok, fixture.path).toBe(true);
      if (!parsed.ok) continue;
      expect(
        parsed.value.assets.map(({ guid, refs, artifacts }) => ({ guid, refs, artifacts })),
      ).toEqual(
        fixture.assets.map((asset) => ({ guid: asset.guid, refs: asset.refs, artifacts: {} })),
      );
    }
  });

  it('rejects the empty legacy envelope and package-global payload arms', () => {
    expect(
      parsePackV2({ schemaVersion: '1.0.0', kind: 'internal-text-package', assets: [] }).ok,
    ).toBe(false);
    expect(
      parsePackV2({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [],
        artifacts: [{ path: 'shared.bin', bytes: 'base64' }],
      }).ok,
    ).toBe(false);
  });

  it('rejects retired material cook records instead of retaining a cross-generation reader', () => {
    const retiredSchema = ['material-cook', '2'].join('/');
    expect(
      validateCookedMaterialRecord({
        schemaVersion: retiredSchema,
        guid: 'mat-v2',
        resolved: { passes: [], parameters: [], values: {} },
        refs: { parent: [], textures: [], samplers: [], modules: [] },
        artifact: { mediaType: 'text/wgsl', path: 'shader.wgsl', digest: 'sha256:a', bytes: [] },
        receipt: {
          schemaVersion: retiredSchema,
          sourceClosure: [],
          profile: 'webgpu/v1',
          compilerVersion: 'compiler/1',
          inputDigest: 'sha256:i',
          outputDigest: 'sha256:a',
          layoutIdentity: 'sha256:l',
          derivedInterface: { layoutIdentity: 'sha256:l' },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'material-cook-record-invalid' } });
  });
});
