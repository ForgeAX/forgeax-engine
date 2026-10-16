import { Materials } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, material, spawnMesh, spawnStage } from '../../lab/stage';
import { materialToggle } from './lib/swap';

export default defineFeature({
  title: 'Pass-based MaterialAsset',
  catalog: 'Pass-based MaterialAsset',
  kind: 'visual',
  summary:
    'A MaterialAsset is a list of passes (program module + renderState tags). Materials.standard emits forward, deferred and shadow-caster passes; the same asset with its shadow-caster pass removed casts no shadow, with no renderer switch. Per-entity opt-out is ShadowParticipation.',
  expect:
    'ON: the orange slab casts a large dark shadow on the floor. OFF: the same asset with its shadow-caster pass removed casts no shadow. Checks list the pass names and LightMode tags.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 4, 6], target: [0, 0, 0] });
    const withShadow = Materials.standard({ baseColor: [1, 0.5, 0.1, 1], roughness: 0.6 });
    if (withShadow.parent !== undefined) throw new Error('Materials.standard emits a root asset');
    const [first, ...rest] = (withShadow.passes ?? []).filter((p) => p.name !== 'shadow-caster');
    if (first === undefined) throw new Error('Materials.standard emits color passes');
    const noShadow = { ...withShadow, passes: [first, ...rest] as const };
    const on = material(world, withShadow);
    const off = material(world, noShadow);
    const slab = spawnMesh(world, MESH.cube, on, { pos: [0, 1.6, 0], scale: [2.2, 0.15, 2.2] });
    return {
      toggle: materialToggle(world, slab, on, off),
      checks() {
        const passes = withShadow.passes ?? [];
        const lightMode = (p: (typeof passes)[number]) =>
          (p.renderState?.tags as Record<string, string> | undefined)?.LightMode;
        const names = passes.map((p) => p.name);
        const modes = passes.map(lightMode);
        const shadowModule = passes.find((p) => p.name === 'shadow-caster')?.program.module;
        return [
          {
            name: 'standard passes',
            ok: JSON.stringify(names) === '["forward","deferred","shadow-caster"]',
            detail: names.join(','),
          },
          {
            name: 'LightMode tags',
            ok: JSON.stringify(modes) === '["Forward","Deferred","ShadowCaster"]',
            detail: modes.join(','),
          },
          {
            name: 'shadow program module',
            ok: shadowModule === 'forgeax::default-shadow-caster',
            detail: String(shadowModule),
          },
          {
            name: 'removing the shadow-caster pass leaves no ShadowCaster tag',
            ok: !(noShadow.passes ?? []).some((p) => lightMode(p) === 'ShadowCaster'),
            detail: (noShadow.passes ?? []).map((p) => p.name).join(','),
          },
        ];
      },
    };
  },
});
