import { ReflectionProbe, Skylight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import {
  MESH,
  spawnCamera,
  spawnMesh,
  spawnSun,
  standard,
  unlit,
  type Vec3,
} from '../../lab/stage';
import { serial } from './support/serial';

const PANELS: readonly {
  pos: Vec3;
  scale: Vec3;
  rgba: readonly [number, number, number, number];
}[] = [
  { pos: [-3, 1, 0], scale: [0.2, 4, 6], rgba: [1, 0.05, 0.05, 1] },
  { pos: [3, 1, 0], scale: [0.2, 4, 6], rgba: [0.05, 1, 0.1, 1] },
  { pos: [0, 1, -3], scale: [6, 4, 0.2], rgba: [0.1, 0.2, 1, 1] },
  { pos: [0, -1, 0], scale: [6, 0.2, 6], rgba: [1, 0.9, 0.1, 1] },
];

export default defineFeature({
  title: 'ReflectionProbe IBL',
  catalog: 'ReflectionProbe IBL',
  kind: 'visual',
  summary:
    'A ReflectionProbe volume captures its surroundings; receivers inside it take specular IBL from the probe, outside it fall back to Skylight.',
  expect:
    'ON: the chrome sphere mirrors the red, green, blue and yellow panels. OFF: the probe is removed and the sphere only reflects the pale Skylight.',
  async setup({ app, world, frames }) {
    spawnCamera(world, { eye: [0, 1.2, 4.5], target: [0, 0.6, 0] });
    spawnSun(world);
    world
      .spawn({ component: Skylight, data: { color: [0.8, 0.85, 1], intensity: 1 } as never })
      .unwrap();
    for (const panel of PANELS)
      spawnMesh(world, MESH.cube, unlit(world, panel.rgba), { pos: panel.pos, scale: panel.scale });
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [1, 1, 1, 1], metallic: 1, roughness: 0.05 }),
      { pos: [0, 0.6, 0], scale: [1.6, 1.6, 1.6] },
    );
    const probeData = {
      halfExtents: [4, 4, 4],
      priority: 1,
      intensity: 1,
      resolution: 64,
      updateIntent: 0,
      invalidationVersion: 1,
    };
    const probe = world
      .spawn(
        { component: Transform, data: { pos: [0, 0.6, 0] } },
        { component: ReflectionProbe, data: probeData as never },
      )
      .unwrap();
    // Capture is amortized: six faces plus 30 PMREM steps, one per frame, so
    // the probe publishes roughly 40+ frames after it is added. ON means
    // published; until then receivers keep the Skylight fallback.
    const awaitPublished = async () => {
      for (let i = 0; i < 240 && app.renderer.inspect().reflectionProbes.activeCount === 0; i++)
        await frames(1);
    };
    const setProbe = async (on: boolean) => {
      if (on !== world.hasComponent(probe, ReflectionProbe)) {
        if (on)
          world
            .addComponent(probe, { component: ReflectionProbe, data: probeData as never })
            .unwrap();
        else world.removeComponent(probe, ReflectionProbe).unwrap();
      }
      if (on) await awaitPublished();
    };
    await awaitPublished();
    return {
      toggle: setProbe,
      checks: serial(async () => {
        const checks = new CheckList();
        await setProbe(true);
        const probes = app.renderer.inspect().reflectionProbes;
        checks.ok(
          'probe captured six faces and is active',
          probes.rawFacesCaptured === 6 && probes.activeCount > 0,
          JSON.stringify({
            raw: probes.rawFacesCaptured,
            filtered: probes.filteredStepsCompleted,
            active: probes.activeCount,
          }),
        );
        checks.equal(
          'receiver selects the probe',
          app.renderer.inspect().reflectionProbes.selection.kind,
          'probe',
        );
        await setProbe(false);
        await frames(4);
        checks.equal(
          'without the probe it falls back to skylight',
          app.renderer.inspect().reflectionProbes.selection.kind,
          'skylight',
        );
        await setProbe(true);
        return checks.items;
      }),
    };
  },
});
