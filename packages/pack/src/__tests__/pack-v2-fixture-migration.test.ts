import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePackV2, validateCookedMaterialRecord } from '../index.js';
import { parsePackSourceJson, projectDirectPackJson } from '../scriptable-pack.js';

const root = resolve(import.meta.dirname, '../../../../');

const fixtures = [
  {
    path: 'apps/hello/room/assets/room.pack.json',
    assets: [
      {
        guid: '6498c168-6c36-55ae-aa5a-9ed01836ff62',
        refs: [
          '440eb5ef-dcfd-5bc5-80ac-e16ebe5fd4bd',
          '315af299-555b-5569-b9b6-7033289fc831',
          '058b4012-05e4-55a4-8919-69684a911120',
        ],
      },
      { guid: '315af299-555b-5569-b9b6-7033289fc831', refs: [] },
      { guid: '058b4012-05e4-55a4-8919-69684a911120', refs: [] },
    ],
  },
  {
    path: 'apps/hello/scene-nesting/assets/outer-scene.pack.json',
    assets: [
      {
        guid: 'e96aaac3-b5f2-5630-9cf7-39fbd54c3d8c',
        refs: ['76a6cee8-353d-5b03-a683-22a1f10a3a64', 'a2a95227-db50-5e9a-bf22-2a9d3c74a890'],
      },
    ],
  },
];

describe('Pack v2 fixture migration', () => {
  it('keeps authored fixture GUIDs and reference order under v3 projection', () => {
    for (const fixture of fixtures) {
      const raw = JSON.parse(readFileSync(resolve(root, fixture.path), 'utf8'));
      expect(parsePackV2(raw).ok, fixture.path).toBe(false);
      const pack = parsePackSourceJson(raw).unwrap();
      if (pack.format !== 'direct') throw new Error(`${fixture.path} must be a direct Pack`);
      expect(
        projectDirectPackJson(pack).assets.map(({ guid, refs, artifacts }) => ({
          guid,
          refs,
          artifacts: artifacts ?? {},
        })),
      ).toEqual(
        expect.arrayContaining(
          fixture.assets.map((asset) => ({ guid: asset.guid, refs: asset.refs, artifacts: {} })),
        ),
      );
      expect(Object.keys(pack.assets)).toHaveLength(fixture.assets.length);
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
