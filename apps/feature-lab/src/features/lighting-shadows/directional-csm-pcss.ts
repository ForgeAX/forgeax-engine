import { DirectionalLight, DirectionalShadowFilterValue, Skylight } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Directional CSM/PCSS',
  catalog: 'Directional CSM/PCSS',
  kind: 'visual',
  summary:
    'The sun renders 4 cascades with the pcssHigh filter: tall pillars cast long shadows whose penumbra widens with distance from the caster.',
  expect:
    'ON: dark shadows stretch from the colored pillars across the floor, sharp at the base and soft at the tip. OFF: castShadow = false and every shadow disappears. Checks: status accepted, effective pcssHigh, 4 cascades.',
  setup({ world, app }) {
    const { sun } = spawnStage(world, { eye: [0, 3, 7], target: [0, 0.5, 0] });
    world.set(sun, DirectionalLight, {
      direction: [0.6, -0.5, -0.4],
      intensity: 3,
      cascadeCount: 4,
      shadowFilter: DirectionalShadowFilterValue.pcssHigh,
      shadowAngularRadius: 0.02,
    } as never);
    world
      .spawn({ component: Skylight, data: { color: [0.5, 0.6, 0.8], intensity: 0.2 } as never })
      .unwrap();
    const colors = [
      [0.9, 0.2, 0.2, 1],
      [0.2, 0.8, 0.3, 1],
      [0.2, 0.4, 0.95, 1],
    ] as const;
    colors.forEach((baseColor, index) => {
      spawnMesh(world, MESH.cube, standard(world, { baseColor }), {
        pos: [-2 + index * 2, 1, -0.5 + index * 0.4],
        scale: [0.35, 2, 0.35],
      });
    });
    let enabled = true;
    let onSample = app.renderer.inspect().directionalShadow;
    return {
      toggle(on) {
        if (!on && enabled) onSample = app.renderer.inspect().directionalShadow;
        enabled = on;
        world.set(sun, DirectionalLight, { castShadow: on } as never);
      },
      checks() {
        // The runner checks after OFF; judge the ON state by the sample taken before the toggle.
        const shadow = enabled ? app.renderer.inspect().directionalShadow : onSample;
        return [
          {
            name: 'status accepted',
            ok: shadow.status === 'accepted',
            detail: `status=${shadow.status} fallback=${shadow.fallbackReason}`,
          },
          {
            name: 'requested pcssHigh',
            ok: shadow.requested === 'pcssHigh',
            detail: `requested=${shadow.requested}`,
          },
          {
            name: 'effective pcssHigh',
            ok: shadow.effective === 'pcssHigh',
            detail: `effective=${shadow.effective}`,
          },
          {
            name: 'four cascades',
            ok: shadow.cascadeCount === 4,
            detail: `cascadeCount=${shadow.cascadeCount}`,
          },
          {
            name: 'shadow map allocated',
            ok: shadow.shadowMapBytes > 0,
            detail: `bytes=${shadow.shadowMapBytes}`,
          },
        ];
      },
    };
  },
});
