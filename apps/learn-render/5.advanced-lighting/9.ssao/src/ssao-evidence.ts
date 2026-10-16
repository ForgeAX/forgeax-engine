import type { App } from '@forgeax/engine-app';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { MeshRenderer } from '@forgeax/engine-render';
export function delta(a: Uint8Array, b: Uint8Array) {
  if (!a.length || a.length !== b.length) throw new Error('SSAO readback dimensions disagree');
  let changed = 0,
    total = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d += Math.abs(a[i + c]! - b[i + c]!);
    if (d > 3) changed++;
    total += d;
  }
  return {
    changed,
    meanRgbDelta: total / ((a.length / 4) * 3 * 255),
    meanChangedRgbDelta: changed === 0 ? 0 : total / (changed * 3 * 255),
  };
}
/** Public profile -> submitted frame -> final pixels, with reversible scene edits. */
export async function verifySsaoScene(
  app: App,
  capture: () => Promise<Uint8Array>,
  object: EntityHandle,
) {
  const profile = app.renderer.inspect().profile;
  const origin = Array.from(app.world.get(object, Transform).unwrap().pos);
  const sample = async (ssao: typeof profile.ssao) => {
    const algorithm = typeof profile.ssao === 'object' ? profile.ssao.algorithm : undefined;
    const installed = app.renderer.setProfile({ ...profile, ssao: typeof ssao === 'object' ? { ...ssao, ...(algorithm === undefined ? {} : { algorithm }) } : ssao });
    if (!installed.ok) throw installed.error;
    for (let i = 0; i < 3; i++) await capture();
    const pixels = new Uint8Array(await capture());
    const gpu = app.renderer.inspect().renderScene.gpuDriven;
    if (!gpu.submitted || gpu.indirectDrawCount === 0 || gpu.cpuFallbackDrawItems !== 0)
      throw new Error(`AO/clustered lighting lost GPU-driven submission: ${JSON.stringify(gpu)}`);
    return pixels;
  };
  try {
    const off = await sample(false);
    const offPasses = app.renderer.inspect().perFramePassNames;
    if (offPasses.some((name) => name.startsWith('ssao-')))
      throw new Error('Disabled AO executed work');
    const on = await sample({ quality: 'high', radius: 0.5, intensity: 1 });
    const onPasses = app.renderer.inspect().perFramePassNames;
    for (const pass of ['ssao-calc', 'ssao-blur'])
      if (!onPasses.includes(pass)) throw new Error(`Missing ${pass}`);
    const enabled = delta(off, on);
    if (enabled.changed < 100 || enabled.meanChangedRgbDelta < 0.01)
      throw new Error(`AO has no visible effect: ${JSON.stringify(enabled)}`);
    const zero = delta(off, await sample({ intensity: 0 }));
    if (zero.meanRgbDelta > 0.00001)
      throw new Error(`Zero AO strength altered lighting: ${JSON.stringify(zero)}`);
    const restored = delta(off, await sample(false));
    if (restored.meanRgbDelta > 0.00001)
      throw new Error('Disabling AO did not restore the baseline');
    app.world.set(object, Transform, { pos: [origin[0]!, origin[1]! + 1, origin[2]!] }).unwrap();
    const movedOff = await sample(false),
      movedOn = await sample({ quality: 'high', radius: 0.5, intensity: 1 });
    const moved = delta(movedOff, movedOn);
    // Permit bounded half-resolution silhouette quantization, not retained contact.
    if (moved.meanRgbDelta > 0.0001 || moved.meanRgbDelta > enabled.meanRgbDelta * 0.2)
      throw new Error(
        `Lifting cube beyond the AO radius retained contact occlusion: ${JSON.stringify(moved)}`,
      );
    app.world.set(object, Transform, { pos: [origin[0]!, origin[1]!, origin[2]!] }).unwrap();
    const recovered = delta(on, await sample({ quality: 'high', radius: 0.5, intensity: 1 }));
    if (recovered.meanRgbDelta > 0.00001)
      throw new Error('Moving the object left stale AO after restoration');
    const mesh = app.world.get(object, MeshRenderer).unwrap();
    const rendererData = { ...mesh, materials: [...mesh.materials] };
    let removed;
    app.world.removeComponent(object, MeshRenderer).unwrap();
    try {
      removed = delta(await sample(false), await sample({ quality: 'high', radius: 0.5, intensity: 1 }));
      if (removed.meanRgbDelta > 0.00001)
        throw new Error(`Removing the occluder retained AO: ${JSON.stringify(removed)}`);
    } finally {
      app.world.addComponent(object, { component: MeshRenderer, data: rendererData }).unwrap();
    }
    const reinserted = delta(on, await sample({ quality: 'high', radius: 0.5, intensity: 1 }));
    if (reinserted.meanRgbDelta > 0.00001) throw new Error('Reinserted geometry did not restore AO');
    return { enabled, zero, restored, moved, recovered, removed, reinserted, offPasses, onPasses };
  } finally {
    app.world.set(object, Transform, { pos: [origin[0]!, origin[1]!, origin[2]!] }).unwrap();
    const restored = app.renderer.setProfile(profile);
    if (!restored.ok) throw restored.error;
    await capture();
  }
}
