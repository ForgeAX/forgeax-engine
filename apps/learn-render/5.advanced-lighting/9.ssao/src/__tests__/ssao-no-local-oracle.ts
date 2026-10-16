import type { App } from '@forgeax/engine-app';
import { PointLight } from '@forgeax/engine-render';

/** Pixel proof on the ordinary demo, including reversible runtime profile changes. */
export async function verifySsaoWithoutLocalLights(
  app: App,
  capture: () => Promise<Uint8Array>,
  algorithm: 'ssao' | 'gtao' = 'ssao',
) {
  app.pause().unwrap();
  const entities = Array.from(app.world.query({ with: [PointLight] }).unwrap(), (row) => row.entity);
  for (const entity of entities) app.world.despawn(entity).unwrap();
  const profile = app.renderer.inspect().profile;
  const images: Uint8Array[] = [];
  const routes = [];
  try {
    for (const enabled of [false, true, false]) {
      const changed = app.renderer.setProfile({ ...profile, renderPath: 'deferred', ssao: enabled ? { algorithm } : false });
      if (!changed.ok) throw changed.error;
      // Drive real frames through the existing capture hook; no timer substitutes for a frame.
      for (let frame = 0; frame < 3; frame++) await capture();
      images.push(new Uint8Array(await capture()));
      const inspection = app.renderer.inspect();
      routes.push({ enabled, lighting: inspection.standardLighting, gpu: inspection.renderScene.gpuDriven });
    }
    const [off, on, restored] = images;
    if (!off || !on || !restored || off.length === 0 || off.length % 4 !== 0 ||
      on.length !== off.length || restored.length !== off.length) throw new Error('SSAO capture RGBA shape mismatch');
    let changed = 0;
    let restoredChanges = 0;
    let rgbDelta = 0;
    for (let pixel = 0; pixel < off.length; pixel += 4) {
      let different = false;
      let restoreDifferent = false;
      for (let channel = 0; channel < 3; channel++) {
        const index = pixel + channel;
        const delta = Math.abs(off[index]! - on[index]!);
        rgbDelta += delta;
        different ||= delta > 0;
        restoreDifferent ||= off[index] !== restored[index];
      }
      if (different) changed++;
      if (restoreDifferent) restoredChanges++;
    }
    const evidence = { algorithm, changed, restoredChanges, meanRgbDelta: rgbDelta / (off.length / 4 * 3 * 255), meanChangedRgbDelta: changed === 0 ? 0 : rgbDelta / (changed * 3 * 255), routes };
    if (changed < 25 || evidence.meanChangedRgbDelta < 0.01 || restoredChanges !== 0) {
      throw new Error(`SSAO without local lights failed: ${JSON.stringify(evidence)}`);
    }
    return evidence;
  } finally {
    const restored = app.renderer.setProfile(profile);
    if (!restored.ok) throw restored.error;
    app.resume().unwrap();
  }
}
