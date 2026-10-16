import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { derive, type MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { lowerStandardContract } from '../lower-standard-contract.js';
import { createMaterialPackCooker } from '../pack-cooker.js';

const fixtureRoot = fileURLToPath(
  new URL('../../../../render/src/__tests__/fixtures/ai-weapon-spirit/', import.meta.url),
);

describe('ai-weapon-spirit frozen Toon material', () => {
  it('keeps the migrated fixture as an explicit root contract', async () => {
    const material = JSON.parse(
      await readFile(`${fixtureRoot}/material.json`, 'utf8'),
    ) as MaterialAsset;
    expect(material.parent).toBeUndefined();
    expect(material.parameters).toHaveLength(11);
    expect(material.passes?.map((pass) => pass.name)).toEqual(['Forward', 'ShadowCaster']);
    expect(material.passes?.map((pass) => pass.program.module)).toEqual([
      'ai_weapon_spirit::low_poly_toon',
      'ai_weapon_spirit::low_poly_toon',
    ]);
    const lightModes = material.passes?.map((pass) => {
      const tags = pass.renderState?.tags;
      if (tags === undefined || tags === null || typeof tags !== 'object') return undefined;
      return Object.entries(tags).find(([name]) => name === 'LightMode')?.[1];
    });
    expect(lightModes).toEqual(['Forward', 'ShadowCaster']);
    const parameterNames = new Set(material.parameters?.map((parameter) => parameter.name));
    expect(Object.keys(material.values ?? {}).every((name) => parameterNames.has(name))).toBe(true);
    expect(material.values).toMatchObject({
      emissionStrength: 0,
      pigmentStrength: 0,
      surfaceMetallic: 0,
      sideShade: 0.84,
    });
  });

  it('cooks the actual migrated Forward and ShadowCaster without expanding its 80-byte contract', async () => {
    const material = JSON.parse(
      await readFile(`${fixtureRoot}/material.json`, 'utf8'),
    ) as MaterialAsset;
    const lowered = lowerStandardContract(material.parameters ?? [], material.passes);
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) throw lowered.error;
    expect(derive(lowered.value.paramSchema).totalBytes).toBe(80);
    const cooked = await createMaterialPackCooker([fixtureRoot]).cook({
      guid: '4846fa5b-8f80-57c0-9cdc-e345102fdb6b',
      source: material,
    });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    expect(record.programs).toHaveLength(6);
    expect(record.programs.map((program) => program.selections[0]?.context.capability)).toEqual([
      'storage-buffer',
      'uniform-fallback',
      'uniform-fallback',
      'storage-buffer-minimum',
      'storage-buffer-projector',
      'storage-buffer-atmosphere',
    ]);
    expect(
      record.programs.slice(1, 3).map((program) => program.selections[0]?.context.backend),
    ).toEqual(['webgpu', 'webgl2']);
    expect(record.programs[0]?.selections).toMatchObject([
      { pass: 'Forward', context: { pass: 'forward' } },
      { pass: 'ShadowCaster', context: { pass: 'shadow' } },
    ]);
    expect(Object.values(cooked.artifacts)).toHaveLength(2);
    const wgsl = new TextDecoder().decode(record.programs[0]?.artifact.bytes);
    expect(wgsl).toContain('fn vs_shadow');
    expect(wgsl).toContain('fn fs_shadow');
    expect(wgsl).toContain('fn fs_main');
    const webgl2 = new TextDecoder().decode(record.programs[2]?.artifact.bytes);
    expect(webgl2).toContain('var<uniform> meshes');
    expect(webgl2).toContain('var<uniform> instances');
    expect(webgl2).not.toContain('var<storage');
  });
  it('composes the frozen Toon with the Engine opaque shadow template using the same 80-byte root', async () => {
    const original = JSON.parse(
      await readFile(`${fixtureRoot}/material.json`, 'utf8'),
    ) as MaterialAsset;
    if (original.parent !== undefined) throw new Error('frozen material must be a root');
    const forward = original.passes?.find((pass) => pass.name === 'Forward');
    if (forward === undefined) throw new Error('frozen Forward pass missing');
    const material: MaterialAsset = {
      ...original,
      passes: [
        forward,
        {
          name: 'ShadowCaster',
          program: { module: 'forgeax::default-shadow-caster' },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ],
    };
    const cooked = await createMaterialPackCooker([fixtureRoot]).cook({
      guid: '4846fa5b-8f80-57c0-9cdc-e345102fdb6b',
      source: material,
    });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    expect(record.resolved.parameters).toEqual(original.parameters);
    expect(record.programs).toHaveLength(12);
    const shadow = record.programs.find((program) =>
      program.selections.some((selection) => selection.pass === 'ShadowCaster'),
    );
    if (shadow === undefined) throw new Error('shadow program missing');
    const wgsl = new TextDecoder().decode(shadow.artifact.bytes);
    expect(wgsl).toContain('fn fs_main');
    expect(wgsl).not.toContain('material.metallic');
    expect(wgsl).not.toContain('joints');
    const lowered = lowerStandardContract(
      record.resolved.parameters,
      record.resolved.passes,
    ).unwrap();
    expect(derive(lowered.paramSchema).totalBytes).toBe(80);
  });
});
