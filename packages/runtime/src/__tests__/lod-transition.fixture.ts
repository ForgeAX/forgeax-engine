import { World } from '@forgeax/engine-ecs';
import { createMeshBuilder, createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  halfToFloat,
  type RecorderAttachment,
} from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import type { RendererHostAssembly } from '../renderer-host';

export function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

export const LOD_SIZE = 128;
export async function verifyLodTransition(
  host: RendererHostAssembly,
  options: {
    renderPath?: 'forward' | 'deferred';
    taa?: boolean;
    heldFrames?: number;
    masked?: boolean;
    recorder?: RecorderAttachment;
    save?: (name: string, bytes: Uint8Array) => void;
    captured?: (encoded: EncodedTape, live: readonly number[], covered: boolean) => Promise<void>;
  } = {},
) {
  const { renderer, assets } = host;
  const world = new World();
  const lease = value(renderer.attach(world));
  const profile = renderer.inspect().profile;
  value(
    renderer.setProfile({ ...profile, renderPath: options.renderPath ?? 'forward', ssao: false }),
  );
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const mesh = (low: boolean) => {
    const base = createPlaneGeometry(low ? 1.6 : 2, 2, low ? 1 : 4, low ? 1 : 4).unwrap();
    const count = (base.attributes.position as Float32Array).length / 3;
    const color = Float32Array.from({ length: count * 4 }, (_, i) =>
      i % 4 === (low ? 1 : 0) || i % 4 === 3 ? 1 : 0,
    );
    if (base.indices === undefined) throw new Error('Missing indexed LOD fixture');
    return createMeshBuilder({ attributes: { ...base.attributes, color }, indices: base.indices })
      .build()
      .unwrap();
  };
  const lowerGuid = assets.parseGuid('019a0000-0000-7000-8000-000000000321');
  assets.catalog(lowerGuid, mesh(true)).unwrap();
  const root = mesh(false);
  const rootHandle = (width: number) =>
    world.allocSharedRef('MeshAsset', {
      ...root,
      lods: [{ mesh: lowerGuid, screenCoverage: 0.5 }],
      lodHysteresis: width,
    });
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1, 1, 1, 1],
      roughness: 1,
      specular: 0,
      ...(options.masked ? { alphaCutoff: 0.5 } : {}),
      renderState: { cullMode: 'none' },
    }),
  );
  const object = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: rootHandle(0.1) } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -3,
          right: 3,
          bottom: -3,
          top: 3,
          near: 0.1,
          far: 20,
          aspect: 1,
          antialias: options.taa ? 3 : 0,
          tonemap: 1,
          bloom: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, 0, -1],
        intensity: 3,
        castShadow: true,
        mapSize: 128,
        cascadeCount: 1,
        shadowDistance: 10,
      },
    })
    .unwrap();
  let frames = 0;
  const sample = async (height: number, name: string, capture = false, covered = true) => {
    const half = Math.SQRT2 / height;
    world.set(camera, Camera, { left: -half, right: half, bottom: -half, top: half }).unwrap();
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    if (!renderer.requestObservation) throw new Error('Observation unavailable');
    value(renderer.requestObservation(['linear-hdr']));
    const pending = capture ? options.recorder?.captureFrame() : undefined;
    if (pending && options.recorder) (await options.recorder.frameBoundary()).unwrap();
    const drawn = value(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    value(await drawn.completed);
    frames++;
    if (pending && options.recorder) (await options.recorder.frameBoundary()).unwrap();
    const observation = value(
      await renderer.observe(drawn, { include: ['linear-hdr'] }),
    ).observations?.find((item) => item.domain === 'linear-hdr');
    if (!observation) throw new Error('Missing LOD live observation');
    expect(observation.metadata.format).toBe('rgba16float');
    options.save?.(`${name}.rgba16f`, observation.bytes);
    options.save?.(`${name}.json`, new TextEncoder().encode(JSON.stringify(observation.metadata)));
    const data = new DataView(
      observation.bytes.buffer,
      observation.bytes.byteOffset,
      observation.bytes.byteLength,
    );
    const pixels: number[] = [];
    let green = 0;
    for (let y = 54; y < 74; y++)
      for (let x = 54; x < 74; x++) {
        const at = y * observation.metadata.bytesPerRow + x * 8;
        const red = halfToFloat(data.getUint16(at, true));
        const g = halfToFloat(data.getUint16(at + 2, true));
        if (covered) expect(red + g, `coverage hole at ${name}:${x},${y}`).toBeGreaterThan(0.05);
        else expect(red + g, `alpha mask at ${name}:${x},${y}`).toBeLessThan(0.001);
        expect(Math.min(red, g), 'opaque complementary coverage never blends levels').toBeLessThan(
          0.001,
        );
        if (g > red) green++;
        pixels.push(red, g);
      }
    if (pending) {
      const encoded = (await pending).unwrap();
      options.save?.(`${name}.rhitape`, encoded.bytes);
      const model = buildFrameModel(decodeTape(encoded.bytes).unwrap());
      options.save?.(
        `${name}-frame.json`,
        new TextEncoder().encode(
          JSON.stringify({
            digest: encoded.digest,
            works: model.works.map((work) => ({
              workIndex: work.workIndex,
              eventIndex: work.eventIndex,
              kind: work.kind,
              shaders: work.pipeline.shaders.map((shader) => ({
                stage: shader.stage,
                entryPoint: shader.entryPoint,
              })),
            })),
            unseededResources: model.unseededResources,
          }),
        ),
      );
      await options.captured?.(encoded, pixels, covered);
    }
    const inspection = renderer.inspect().renderScene?.gpuDriven;
    if (!inspection) throw new Error('Missing GPU LOD inspection');
    return { green: green / 400, pixels, inspection };
  };
  const evidence = [];
  try {
    for (const [height, expected] of [
      [0.56, 0],
      [0.525, 0.25],
      [0.5, 0.5],
      [0.475, 0.75],
      [0.44, 1],
      [0.5, 0.5],
      [0.525, 0.25],
    ] as const) {
      const result = await sample(height, `height-${height}`, height === 0.5);
      expect(result.green).toBeCloseTo(expected, 1);
      // Each LOD level owns one stable indirect row; selection and crossfade
      // only change instance counts, which the green coverage above proves.
      expect(result.inspection.indirectDrawCount).toBe(2);
      evidence.push({ height, green: result.green, draws: result.inspection.indirectDrawCount });
    }
    const stable = await sample(0.5, 'stable');
    for (let i = 0; i < (options.heldFrames ?? 52); i++) {
      const held = (await sample(0.5, 'held')).pixels;
      if (!options.taa) expect(held).toEqual(stable.pixels);
      else {
        // Camera jitter changes the tiny grazing-light term; it must never
        // change which LOD owns any sample in the overlapping silhouettes.
        let delta = 0;
        for (let at = 0; at < held.length; at += 2) {
          expect((held[at] ?? 0) > (held[at + 1] ?? 0)).toBe(
            (stable.pixels[at] ?? 0) > (stable.pixels[at + 1] ?? 0),
          );
          delta = Math.max(
            delta,
            Math.abs((held[at] ?? 0) - (stable.pixels[at] ?? 0)),
            Math.abs((held[at + 1] ?? 0) - (stable.pixels[at + 1] ?? 0)),
          );
        }
        expect(delta).toBeLessThan(0.00001);
      }
    }
    expect(frames).toBe(8 + (options.heldFrames ?? 52));
    world.set(object, MeshFilter, { assetHandle: rootHandle(0) }).unwrap();
    expect((await sample(0.501, 'hard-near')).green).toBe(0);
    expect((await sample(0.499, 'hard-far')).green).toBe(1);
    if (options.masked) {
      const invisible = world.allocSharedRef(
        'MaterialAsset',
        Materials.standard({
          baseColor: [1, 1, 1, 0],
          alphaCutoff: 0.5,
          renderState: { cullMode: 'none' },
        }),
      );
      world.set(object, MeshFilter, { assetHandle: rootHandle(0.1) }).unwrap();
      world.set(object, MeshRenderer, { materials: [invisible] }).unwrap();
      const clipped = await sample(0.5, 'alpha-clipped', options.recorder !== undefined, false);
      expect(clipped.inspection.indirectDrawCount).toBe(2);
    }
    expect(errors).toEqual([]);
    options.save?.(
      'metrics.json',
      new TextEncoder().encode(JSON.stringify({ frames, evidence }, null, 2)),
    );
  } finally {
    off();
    lease.dispose();
    value(renderer.setProfile(profile));
  }
}
