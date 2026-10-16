import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { World, EntityHandle } from '@forgeax/engine-ecs';
import {
  Materials,
  MeshFilter,
  MeshRenderer,
  ReflectionProbe,
  type Renderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

function difference(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length || a.length === 0) throw new Error('Probe readback size mismatch');
  let changed = 0,
    sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d += Math.abs(a[i + c]! - b[i + c]!);
    if (d > 3) changed++;
    sum += d;
  }
  return { changed, meanRgbDelta: sum / ((a.length / 4) * 3 * 255) };
}


/** Foreground floor samples lie outside the probe and cannot be occluded by the probe-updates fixture. */
function outsideFloorDifference(a: Uint8Array, b: Uint8Array) {
  const size = Math.sqrt(a.length / 4);
  let pixels = 0, maxChannel = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Independent pinhole ray / y=-1.025 plane intersection for the probe-updates fixture.
    const sx = ((x + 0.5) / size * 2 - 1) / Math.sqrt(3);
    const sy = (1 - (y + 0.5) / size * 2) / Math.sqrt(3);
    const dy = -1 / 3 + sy * Math.sqrt(8 / 9);
    if (dy >= 0) continue;
    const t = (-1.025 - 3) / dy;
    const wx = 6 + t * (-2 / 3 + sx * Math.SQRT1_2 - sy / Math.sqrt(18));
    const wz = 6 + t * (-2 / 3 - sx * Math.SQRT1_2 - sy / Math.sqrt(18));
    if (wx < 2 || wx > 4 || wz < 2 || wz > 4) continue;
    pixels++;
    for (let c = 0; c < 3; c++) maxChannel = Math.max(maxChannel, Math.abs(a[(y * size + x) * 4 + c]! - b[(y * size + x) * 4 + c]!));
  }
  if (pixels < 100 || maxChannel > 1) throw new Error(`Probe leaked outside its box: ${JSON.stringify({pixels, maxChannel})}`);
  return {pixels, maxChannel};
}

/** The receiver/camera stay fixed between each frozen/new-capture comparison. */
export async function verifyProbeUpdates(
  world: World,
  renderer: Renderer,
  probe: EntityHandle,
  object: EntityHandle,
  draw: () => Promise<void>,
  capture: () => Promise<Uint8Array>,
  receiver: EntityHandle,
) {
  const origin = Array.from(world.get(object, Transform).unwrap().pos);
  const data = world.get(probe, ReflectionProbe).unwrap();
  const original = { ...data, halfExtents: data.halfExtents.slice() };
  const inspections: unknown[] = [];
  const owner = () => renderer.inspect().reflectionProbes;
  const generation = () => owner().updates?.[0]?.activeGeneration ?? 0;
  let maxWork = 0;
  const step = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await draw();
      const gpu = renderer.inspect().renderScene.gpuDriven;
      if (!gpu.submitted || gpu.indirectDrawCount === 0 || gpu.cpuFallbackDrawItems !== 0)
        throw new Error(`Probe capture disabled display GPU-driven work: ${JSON.stringify(gpu)}`);
      const work = renderer
        .inspect()
        .perFramePassNames.filter((name) => name.startsWith('reflection-probe.')).length;
      maxWork = Math.max(maxWork, work);
      if (work > 1) throw new Error(`Probe exceeded shared one-step frame budget: ${work}`);
    }
  };
  const settled = async (previous: number) => {
    for (let i = 0; i < 100; i++) {
      await step(1);
      if (generation() > previous) {
        await step(2);
        return;
      }
    }
    throw new Error(`Probe did not publish after 100 frames: ${JSON.stringify(owner().updates)}`);
  };
  let offscreen: EntityHandle | undefined;
  let secondProbe: EntityHandle | undefined;
  const receiverMaterials = [...world.get(receiver, MeshRenderer).unwrap().materials];
  const objectMaterials = [...world.get(object, MeshRenderer).unwrap().materials];
  try {
    world.set(probe, ReflectionProbe, { updateIntent: 0 }).unwrap();
    await step(100);
    world.set(probe, ReflectionProbe, { boxProjection: true }).unwrap();
    await step(3);
    const boundaryOn = await capture();
    world.removeComponent(probe, ReflectionProbe).unwrap();
    let boundary;
    try {
      await step(3);
      const boundaryOff = await capture();
      boundary = outsideFloorDifference(boundaryOn, boundaryOff);
      if (difference(boundaryOn, boundaryOff).changed < 100) throw new Error('Probe boundary test lost its inside control');
    } finally {
      world.addComponent(probe, { component: ReflectionProbe, data: { ...original, updateIntent: 0 } }).unwrap();
    }
    await step(100);
    // With only a flat receiver, an otherwise empty probe must preserve the
    // same environment radiance as global IBL instead of capturing black sky.
    const hidden = Array.from(world.query({ read: [MeshRenderer, Transform] }).unwrap(),
      (row) => ({ entity: row.entity, pos: Array.from(row.get(Transform).pos) }))
      .filter((row) => row.pos[1]! > -1);
    let environment;
    try {
      for (const row of hidden) world.set(row.entity, Transform, { pos: [1000, 1000, 1000] }).unwrap();
      const before = generation();
      world.set(probe, ReflectionProbe, { invalidationVersion: original.invalidationVersion + 1 }).unwrap();
      await settled(before);
      const withProbe = await capture();
      world.removeComponent(probe, ReflectionProbe).unwrap();
      try {
        await step(3);
        const withoutProbe = await capture();
        environment = difference(withProbe, withoutProbe);
        let maxChannel = 0;
        for (let i = 0; i < withProbe.length; i++) maxChannel = Math.max(maxChannel, Math.abs(withProbe[i]! - withoutProbe[i]!));
        if (maxChannel > 2) throw new Error(`Empty probe changed its environment: ${JSON.stringify({ ...environment, maxChannel })}`);
        environment = { ...environment, maxChannel };
      } finally {
        world.addComponent(probe, { component: ReflectionProbe, data: { ...original, updateIntent: 0 } }).unwrap();
      }
    } finally {
      for (const row of hidden) world.set(row.entity, Transform, { pos: row.pos }).unwrap();
    }
    await step(100);
    // Identical payloads must render identically whether their material handle
    // is shared across an inside/outside receiver or independently allocated.
    const payload = Materials.standard({
      baseColor: [0.8, 0.85, 0.9, 1],
      metallic: 0.8,
      roughness: 0.2,
    });
    const shared = world.allocSharedRef('MaterialAsset', payload);
    const independent = world.allocSharedRef('MaterialAsset', structuredClone(payload));
    world.set(receiver, MeshRenderer, { materials: [shared] }).unwrap();
    world.set(object, MeshRenderer, { materials: [independent] }).unwrap();
    await step(3);
    const distinctPixels = await capture();
    world.set(object, MeshRenderer, { materials: [shared] }).unwrap();
    await step(3);
    const sharedMaterials = difference(distinctPixels, await capture());
    if (sharedMaterials.meanRgbDelta > 0.00001)
      throw new Error(
        `Shared material changed per-object probe selection: ${JSON.stringify(sharedMaterials)}`,
      );
    world.set(receiver, MeshRenderer, { materials: receiverMaterials }).unwrap();
    world.set(object, MeshRenderer, { materials: objectMaterials }).unwrap();
    await step(3);
    const first = generation();
    if (first < 1) throw new Error('Initial probe capture never published');
    world.set(object, Transform, { pos: [origin[0]! - 1, origin[1]!, origin[2]!] }).unwrap();
    await step(3);
    const frozen = await capture();
    await step(40);
    if (generation() !== first) throw new Error('Once probe updated without invalidation');
    world.set(probe, ReflectionProbe, { updateIntent: 1 }).unwrap();
    await settled(first);
    const changed = difference(frozen, await capture());
    if (changed.changed < 100)
      throw new Error(`Updated probe did not reach final pixels: ${JSON.stringify(changed)}`);
    inspections.push(owner().updates);
    const steady = generation();
    await step(45);
    if (generation() !== steady)
      throw new Error('Unchanged scene caused another on-change capture');

    // A bright ordinary mesh behind the display camera must still enter the
    // probe. Its authored pose is identical across the two pixel reads.
    world.set(probe, ReflectionProbe, { updateIntent: 0 }).unwrap();
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({
        baseColor: [1, 0.01, 0.01, 1],
        emissive: [1, 0, 0],
        emissiveIntensity: 6,
        roughness: 0.6,
      }),
    );
    offscreen = world
      .spawn(
        { component: Transform, data: { pos: [8, 3, 8], scale: [3, 5, 3] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    await step(3);
    const beforeOffscreen = await capture();
    const old = generation();
    world
      .set(probe, ReflectionProbe, { invalidationVersion: original.invalidationVersion + 1 })
      .unwrap();
    await settled(old);
    const outside = difference(beforeOffscreen, await capture());
    if (outside.changed < 20)
      throw new Error(`Offscreen mesh missing from probe: ${JSON.stringify(outside)}`);
    inspections.push(owner().updates);

    world.set(probe, ReflectionProbe, { updateIntent: 2 }).unwrap();
    const beforeContinuous = generation();
    for (let i = 0; i < 90; i++) {
      world
        .set(object, Transform, { pos: [origin[0]! + Math.sin(i * 0.1), origin[1]!, origin[2]!] })
        .unwrap();
      await step(1);
    }
    const continuousGenerations = generation() - beforeContinuous;
    if (continuousGenerations < 2) throw new Error('Continuous motion starved probe publication');
    // Two independently allocated cubes share the same frame budget. Exercise
    // the advertised 256 face size as well as the small-probe path on real GPU.
    world.set(probe, ReflectionProbe, { resolution: 256, updateIntent: 0 }).unwrap();
    secondProbe = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        {
          component: ReflectionProbe,
          data: { resolution: 16, updateIntent: 0, halfExtents: [1, 1, 1] },
        },
      )
      .unwrap();
    await step(80);
    const simultaneous = owner().updates;
    if (
      simultaneous?.length !== 2 ||
      simultaneous.some((row) => row.activeGeneration < 1 || row.pending)
    )
      throw new Error(
        `Shared probe budget starved an admitted probe: ${JSON.stringify(simultaneous)}`,
      );
    return {
      boundary,
      environment,
      changed,
      outside,
      sharedMaterials,
      continuousGenerations,
      maxWork,
      simultaneous,
      inspections,
    };
  } finally {
    if (secondProbe !== undefined) world.despawn(secondProbe).unwrap();
    if (offscreen !== undefined) world.despawn(offscreen).unwrap();
    world.set(receiver, MeshRenderer, { materials: receiverMaterials }).unwrap();
    world.set(object, MeshRenderer, { materials: objectMaterials }).unwrap();
    world.set(object, Transform, { pos: [origin[0]!, origin[1]!, origin[2]!] }).unwrap();
    world.set(probe, ReflectionProbe, original).unwrap();
    await step(100);
  }
}
