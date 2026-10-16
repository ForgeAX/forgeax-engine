import type { App } from '@forgeax/engine-app';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { DirectionalLight, DirectionalShadowFilterValue, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { delta } from './ssao-evidence';
import type { spawnSsaoRoom } from './ssao-room';

export async function verifySsaoRoom(
  app: App,
  capture: () => Promise<Uint8Array>,
  advance: () => Promise<void>,
  room: ReturnType<typeof spawnSsaoRoom>,
  camera: EntityHandle,
) {
  const profile = app.renderer.inspect().profile;
  const setProfile = (value: typeof profile) => {
    const result = app.renderer.setProfile(value);
    if (!result.ok) throw result.error;
  };
  const light = { ...app.world.get(room.light, DirectionalLight).unwrap() };
  const cameraPos = Array.from(app.world.get(camera, Transform).unwrap().pos);
  const polePos = Array.from(app.world.get(room.pole, Transform).unwrap().pos);
  const sample = async () => {
    for (let frame = 0; frame < 4; frame++) await advance();
    const pixels = new Uint8Array(await capture());
    const gpu = app.renderer.inspect().renderScene.gpuDriven;
    if (!gpu.submitted || gpu.indirectDrawCount === 0 || gpu.cpuFallbackDrawItems !== 0)
      throw new Error('Room AO/shadows must retain GPU-driven display geometry');
    return pixels;
  };
  const requireChange = (name: string, a: Uint8Array, b: Uint8Array) => {
    const result = delta(a, b);
    if (result.changed < 20) throw new Error(`${name} had no visible effect: ${JSON.stringify(result)}`);
    return result;
  };
  const requireRestored = (name: string, a: Uint8Array, b: Uint8Array) => {
    const result = delta(a, b);
    if (result.meanRgbDelta > 0.00001)
      throw new Error(`${name} retained stale shading: ${JSON.stringify(result)}`);
    return result;
  };
  try {
    setProfile({ ...profile, ssao: false });
    app.world.set(room.light, DirectionalLight, { castShadow: false }).unwrap();
    const neither = await sample();
    setProfile({ ...profile, ssao: { ...(typeof profile.ssao === 'object' ? profile.ssao : {}), quality: 'high', radius: 0.5, intensity: 1 } });
    const ao = await sample();
    const aoOnly = requireChange('Room contact AO', neither, ao);
    app.world.set(room.light, DirectionalLight, { castShadow: true, shadowFilter: DirectionalShadowFilterValue.pcf3 }).unwrap();
    const pcf = await sample();
    const shadow = requireChange('Room direct shadow', ao, pcf);
    app.world.set(room.light, DirectionalLight, { shadowFilter: DirectionalShadowFilterValue.pcssMedium }).unwrap();
    const baseline = await sample();
    const soft = requireChange('PCSS penumbra', pcf, baseline);
    const angularEndpoints = [];
    for (const shadowFilter of [DirectionalShadowFilterValue.pcssMedium, DirectionalShadowFilterValue.pcssHigh]) {
      for (const shadowAngularRadius of [0.0001, 0.05]) {
        app.world.set(room.light, DirectionalLight, { shadowFilter, shadowAngularRadius }).unwrap();
        await sample();
        angularEndpoints.push({ shadowFilter, shadowAngularRadius: app.world.get(room.light, DirectionalLight).unwrap().shadowAngularRadius });
      }
    }
    app.world.set(room.light, DirectionalLight, { shadowFilter: DirectionalShadowFilterValue.pcssMedium, shadowAngularRadius: light.shadowAngularRadius }).unwrap();
    const restoredRadius = requireRestored('PCSS radius restore', baseline, await sample());
    app.world.set(room.pole, Transform, { pos: [1, 0.25, 1.5] }).unwrap();
    const moved = requireChange('Moving thin pole', baseline, await sample());
    app.world.set(room.pole, Transform, { pos: polePos }).unwrap();
    const restoredPole = requireRestored('Pole restore', baseline, await sample());
    const wall = app.world.get(room.wall, MeshRenderer).unwrap();
    const wallData = { ...wall, materials: [...wall.materials] };
    let opened;
    app.world.removeComponent(room.wall, MeshRenderer).unwrap();
    try {
      opened = requireChange('Thin wall removal', baseline, await sample());
    } finally {
      app.world.addComponent(room.wall, { component: MeshRenderer, data: wallData }).unwrap();
    }
    const restoredWall = requireRestored('Wall restore', baseline, await sample());
    app.world.set(camera, Transform, { pos: [cameraPos[0]! + 0.4, cameraPos[1]!, cameraPos[2]!] }).unwrap();
    const cameraMoved = requireChange('Camera motion', baseline, await sample());
    app.world.set(camera, Transform, { pos: cameraPos }).unwrap();
    const cameraRestored = requireRestored('Camera restore', baseline, await sample());
    for (let frame = 0; frame < 60; frame++) {
      const pixels = await capture();
      requireRestored('Stationary room', baseline, pixels);
      const gpu = app.renderer.inspect().renderScene.gpuDriven;
      if (gpu.cpuFallbackDrawItems !== 0 || !gpu.submitted)
        throw new Error('Stationary room lost GPU-driven submission');
    }
    return { stableFrames: 60, aoOnly, shadow, soft, angularEndpoints, restoredRadius, moved, restoredPole, opened, restoredWall, cameraMoved, cameraRestored,
      passNames: app.renderer.inspect().perFramePassNames };
  } finally {
    app.world.set(room.light, DirectionalLight, light).unwrap();
    app.world.set(room.pole, Transform, { pos: polePos }).unwrap();
    app.world.set(camera, Transform, { pos: cameraPos }).unwrap();
    setProfile(profile);
    await sample();
  }
}
