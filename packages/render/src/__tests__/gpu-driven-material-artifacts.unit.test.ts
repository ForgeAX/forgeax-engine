import { expect, it } from 'vitest';
import { gpuDrivenMaterialProgramSelection } from '../gpu-driven/material-artifacts';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import { defaultMaterialSnapshot } from '../render-system-extract';

const prepared = {
  identity: { material: 'game::surface', geometry: 'box', deformation: 'rigid' },
} as PreparedGpuDrivenDraw;
const material = {
  ...defaultMaterialSnapshot(1),
  materialShaderId: 'game::surface',
  materialProgramKeys: { Forward: 'game::surface', Shadow: 'game::shadow' },
  materialSceneIndexProgramKeys: {
    Forward: { pass: 'forward' as const, specializationKey: 'game::surface-scene' },
    Shadow: { pass: 'shadow' as const, specializationKey: 'game::shadow-scene' },
  },
};

it('selects the direct and scene program pair for the actual pass', () => {
  expect(
    gpuDrivenMaterialProgramSelection(material, prepared, 'forward', undefined, {
      logicalMaterialShaderId: '',
      sceneIndexProgramKey: undefined,
      materialShaderId: '',
    }),
  ).toEqual({
    logicalMaterialShaderId: 'game::surface',
    materialShaderId: 'game::surface-scene',
    sceneIndexProgramKey: 'game::surface-scene',
  });
  expect(
    gpuDrivenMaterialProgramSelection(
      material,
      prepared,
      'shadow',
      {
        materialShaderId: 'game::shadow',
      },
      { logicalMaterialShaderId: '', sceneIndexProgramKey: undefined, materialShaderId: '' },
    ),
  ).toEqual({
    logicalMaterialShaderId: 'game::surface',
    materialShaderId: 'game::shadow-scene',
    sceneIndexProgramKey: 'game::shadow-scene',
  });
});

it('does not reinterpret a direct shadow program when its publication has no scene pair', () => {
  expect(
    gpuDrivenMaterialProgramSelection(
      {
        ...material,
        materialSceneIndexProgramKeys: { Forward: material.materialSceneIndexProgramKeys.Forward },
      },
      prepared,
      'shadow',
      { materialShaderId: 'game::shadow' },
      { logicalMaterialShaderId: '', sceneIndexProgramKey: undefined, materialShaderId: '' },
    ),
  ).toBeUndefined();
});

it('fills the supplied selection only after finding an accepted program pair', () => {
  const out = {
    logicalMaterialShaderId: '',
    materialShaderId: '',
    sceneIndexProgramKey: undefined as string | undefined,
  };
  expect(gpuDrivenMaterialProgramSelection(material, prepared, 'forward', undefined, out)).toBe(
    out,
  );
  expect(out.materialShaderId).toBe('game::surface-scene');
  expect(
    gpuDrivenMaterialProgramSelection(material, prepared, 'shadow', undefined, out),
  ).toBeUndefined();
  expect(out.materialShaderId).toBe('game::surface-scene');
  expect(
    gpuDrivenMaterialProgramSelection(
      material,
      prepared,
      'shadow',
      { materialShaderId: 'game::shadow' },
      out,
    ),
  ).toBe(out);
  expect(out.materialShaderId).toBe('game::shadow-scene');
});

it('retains an explicit scene pair even when its key equals the direct identity', () => {
  const same = {
    ...material,
    materialSceneIndexProgramKeys: {
      Forward: { pass: 'forward' as const, specializationKey: 'game::surface' },
    },
  };
  expect(
    gpuDrivenMaterialProgramSelection(same, prepared, 'forward', undefined, {
      logicalMaterialShaderId: '',
      sceneIndexProgramKey: undefined,
      materialShaderId: '',
    }),
  ).toMatchObject({
    sceneIndexProgramKey: 'game::surface',
    materialShaderId: 'game::surface',
  });
});
