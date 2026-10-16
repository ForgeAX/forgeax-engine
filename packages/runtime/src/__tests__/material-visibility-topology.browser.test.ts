import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
} from '@forgeax/engine-render';
import {
  Mobility,
  MobilityKindValue,
  propagateTransforms,
  scenePlugin,
  Transform,
} from '@forgeax/engine-scene';
import type { Handle } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it('retains the graph and static shadow targets across camera material visibility changes', {
  timeout: 120_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const host = value(await constructRuntimeRendererHost(canvas));
  const { renderer } = host;
  value(
    renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'deferred', ssao: false }),
  );
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let residentCube:
    | { mesh: Handle<'MeshAsset', 'shared'>; material: Handle<'MaterialAsset', 'shared'> }
    | undefined;
  for (const [size, pos, color] of [
    [
      [24, 0.2, 24],
      [0, -0.1, 0],
      [0.6, 0.6, 0.6, 1],
    ],
    [
      [1, 2, 1],
      [0, 1, 0],
      [1, 0.05, 0.05, 1],
    ],
    [
      [1, 2, 1],
      [2, 1, 0],
      [0.05, 0.05, 1, 1],
    ],
  ] as const) {
    const mesh = world.allocSharedRef(
      'MeshAsset',
      createBoxGeometry(size[0], size[1], size[2]).unwrap(),
    );
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: color, roughness: 1, specular: 0 }),
    );
    if (pos[0] === 2) residentCube = { mesh, material };
    world
      .spawn(
        { component: Transform, data: { pos } },
        { component: Mobility, data: { kind: MobilityKindValue.static } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, -1, -1],
        intensity: 3,
        castShadow: true,
        cascadeCount: 3,
        shadowDistance: 30,
        mapSize: 128,
      },
    })
    .unwrap();
  world.spawn({ component: Skylight, data: { intensity: 0.15, color: [1, 1, 1] } }).unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 1, 6] } },
      {
        component: Camera,
        data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 40, antialias: 0, bloom: 0 },
      },
    )
    .unwrap();
  const lease = value(renderer.attach(world));
  let completedFrames = 0;
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = value(
      renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
        fixedStep: world.getResource(FixedTime).tick,
      }),
    );
    value(await receipt.completed);
    completedFrames++;
    return renderer.inspect();
  };
  const pixels = async (name: string) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const base64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
    await commands.writeFile(
      `artifacts/material-visibility-topology/${name}.png`,
      base64,
      'base64',
    );
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }),
    );
    const target = new OffscreenCanvas(128, 128);
    const ctx = target.getContext('2d');
    if (ctx === null) throw new Error('pixel readback unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return Array.from(ctx.getImageData(60, 60, 8, 8).data);
  };
  const addResidentCube = () => {
    if (residentCube === undefined) throw new Error('resident mesh missing');
    return world
      .spawn(
        { component: Transform, data: { pos: [2, 1, -2] } },
        { component: Mobility, data: { kind: MobilityKindValue.static } },
        { component: MeshFilter, data: { assetHandle: residentCube.mesh } },
        { component: MeshRenderer, data: { materials: [residentCube.material] } },
      )
      .unwrap();
  };
  try {
    // Establish the shadow buffers' high-water capacities before the test.
    // Actual buffer growth is an independent, legitimate graph dependency.
    const reserves = Array.from({ length: 4 }, addResidentCube);
    for (let i = 0; i < 12; i++) await draw();
    for (const entity of reserves) world.despawn(entity).unwrap();
    for (let i = 0; i < 12; i++) await draw();
    const initial = renderer.inspect();
    await commands.writeFile(
      'artifacts/material-visibility-topology/initial.json',
      JSON.stringify(initial, null, 2),
    );
    const initialGraph = initial.featureGraph;
    if (initialGraph === undefined) throw new Error('feature graph inspection unavailable');
    const compileAttempts = initialGraph.compileAttempts;
    const topologyKey = initialGraph.last.topologyKey;
    const graphGeneration = initial.directionalShadow.graphGeneration;
    expect(initial.renderScene.gpuDriven.channels.some((channel) => channel.lane === 'gpu')).toBe(
      true,
    );
    expect(
      initial.shadowRaster.views.filter((view) => view.identity.layer === 'static'),
    ).toHaveLength(3);
    const initialPixels = await pixels('visible');
    const evidence: unknown[] = [];
    for (const [name, x] of [
      ['hidden', 10],
      ['returned', 0],
    ] as const) {
      world.set(camera, Transform, { pos: [x, 1, 6] }).unwrap();
      if (name === 'hidden') {
        // A new receiver has no prior GPU draw claim. Its first frame therefore
        // uses the CPU camera cull, just as a streamed tile does. Reuse the exact
        // mesh and material so this adds no graph resource or raster class.
        addResidentCube();
      }
      for (let i = 0; i < 18; i++) {
        const inspection = await draw();
        const graph = inspection.featureGraph;
        if (graph === undefined) throw new Error('feature graph inspection unavailable');
        evidence.push({
          name,
          frame: completedFrames,
          compileAttempts: graph.compileAttempts,
          topologyKey: graph.last.topologyKey,
          shadows: inspection.shadowRaster,
        });
        expect(inspection.directionalShadow.graphGeneration).toBe(graphGeneration);
        expect(
          inspection.shadowRaster.views.some(
            (view) => view.invalidationReason === 'graph-compiled',
          ),
        ).toBe(false);
      }
      await commands.writeFile(
        'artifacts/material-visibility-topology/result.json',
        JSON.stringify({ compileAttempts, completedFrames, evidence }, null, 2),
      );
      expect(renderer.inspect().featureGraph?.compileAttempts).toBe(compileAttempts);
      expect(renderer.inspect().featureGraph?.last.topologyKey).toBe(topologyKey);
      const currentPixels = await pixels(name);
      if (name === 'hidden') expect(currentPixels).not.toEqual(initialPixels);
      else {
        expect(
          Math.max(
            ...currentPixels.map((value, i) => Math.abs(value - (initialPixels[i] ?? Number.NaN))),
          ),
        ).toBeLessThanOrEqual(2);
      }
    }
    expect(completedFrames).toBe(60);
    expect(errors).toEqual([]);
  } catch (error) {
    await commands.writeFile(
      'artifacts/material-visibility-topology/failure.json',
      JSON.stringify({ completedFrames, error, inspection: renderer.inspect(), errors }, null, 2),
    );
    throw error;
  } finally {
    off();
    lease.dispose();
    await context.fiber.dispose();
    await renderer.dispose();
    canvas.remove();
  }
});
