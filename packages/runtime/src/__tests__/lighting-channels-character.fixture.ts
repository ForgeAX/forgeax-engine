import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createCapsuleGeometry,
  createSphereGeometry,
} from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  type Renderer,
} from '@forgeax/engine-render';
import { buildFrameModel, decodeTape, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { compactTape } from './compact-tape.fixture';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { CHANNEL_EPSILON } from './lighting-channels.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

export const CHANNEL_CHARACTER_SIZE = 160;

/** A visible procedural humanoid and environment, separate from the analytical oracle. */
export async function verifyCharacterFill(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: (name: string, bytes: Uint8Array) => void | Promise<void>,
) {
  const world = new World();
  const roleMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.35, 0.45, 0.65, 1],
      roughness: 0.7,
      emissive: [0.01, 0.01, 0.01],
      emissiveIntensity: 1,
    }),
  );
  const environmentMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.2, 0.3, 0.35, 1],
      roughness: 0.9,
      emissive: [0.01, 0.01, 0.01],
      emissiveIntensity: 1,
    }),
  );
  const part = (mesh: MeshAsset, x: number, y: number) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x - 0.45, y, -4] } },
        { component: MeshFilter, data: { assetHandle: world.allocSharedRef('MeshAsset', mesh) } },
        { component: MeshRenderer, data: { materials: [roleMaterial], lightingChannels: 3 } },
      )
      .unwrap();
  part(createCapsuleGeometry(0.22, 0.45, 4, 12).unwrap(), 0, 0);
  part(createSphereGeometry(0.2, 12, 8).unwrap(), 0, 0.68);
  for (const x of [-0.34, 0.34]) part(createCapsuleGeometry(0.075, 0.5).unwrap(), x, 0.02);
  for (const x of [-0.13, 0.13]) part(createCapsuleGeometry(0.085, 0.55).unwrap(), x, -0.67);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -4.5] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(5, 3, 0.1).unwrap()),
        },
      },
      { component: MeshRenderer, data: { materials: [environmentMaterial], lightingChannels: 1 } },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [0, 0, -1],
        intensity: 0.5,
        castShadow: false,
        lightingChannels: 1,
      },
    })
    .unwrap();
  const fill = world
    .spawn(
      { component: Transform, data: { pos: [-0.3, 0.5, -2] } },
      {
        component: PointLight,
        data: { color: [1, 0.8, 0.55], intensity: 6, range: 10, lightingChannels: 0xffffffff },
      },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 20,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
        },
      },
    )
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const samples: unknown[] = [];
  const draw = async (name?: string) => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    if (renderer.requestObservation === undefined)
      throw new Error('missing character HDR observation');
    renderValue(renderer.requestObservation(['linear-hdr']));
    const pending = name === undefined ? undefined : recorder.captureFrame();
    if (pending) (await recorder.frameBoundary()).unwrap();
    const receipt = renderValue(
      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
    );
    renderValue(await receipt.completed);
    if (pending && name) {
      (await recorder.frameBoundary()).unwrap();
      const tape = compactTape((await pending).unwrap());
      await save(`${name}.rhitape`, tape.bytes);
      const decoded = decodeTape(tape.bytes).unwrap();
      expect(decoded.events.filter((event) => event.kind === 'submit')).toHaveLength(1);
      const model = buildFrameModel(decoded);
      await save(
        `${name}-work.json`,
        new TextEncoder().encode(
          JSON.stringify(
            {
              digest: tape.digest,
              generation: receipt.deviceGeneration,
              input: {
                roleChannels: 3,
                environmentChannels: 1,
                fillChannels: world.get(fill, PointLight).unwrap().lightingChannels,
              },
              works: model.works,
              resources: model.resources,
            },
            null,
            2,
          ),
        ),
      );
    }
    const observation = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((value) => value.domain === 'linear-hdr');
    if (!observation) throw new Error('missing character HDR image');
    if (name) await save(`${name}.rgba16float`, observation.bytes);
    return luminanceRgba16f(
      observation.bytes,
      CHANNEL_CHARACTER_SIZE,
      CHANNEL_CHARACTER_SIZE,
      observation.metadata.bytesPerRow,
    );
  };
  const roi = (image: Float32Array, x: number) => {
    let sum = 0;
    for (let y = 78; y <= 82; y++)
      for (let column = x - 2; column <= x + 2; column++)
        sum += image[y * CHANNEL_CHARACTER_SIZE + column] ?? NaN;
    return sum / 25;
  };
  try {
    for (const path of ['forward', 'deferred'] as const) {
      renderValue(renderer.setProfile({ ...renderer.inspect().profile, renderPath: path }));
      world.set(fill, PointLight, { lightingChannels: 0xffffffff }).unwrap();
      for (let frame = 0; frame < testQuality.staticFrames; frame++) await draw();
      const before = await draw(`${path}-before`);
      world.set(fill, PointLight, { lightingChannels: 2 }).unwrap();
      for (let frame = 0; frame < testQuality.staticFrames; frame++) await draw();
      const after = await draw(`${path}-after`);
      const sample = {
        path,
        roleBefore: roi(before, 64),
        roleAfter: roi(after, 64),
        environmentBefore: roi(before, 120),
        environmentAfter: roi(after, 120),
      };
      samples.push(sample);
      await save(
        'samples.json',
        new TextEncoder().encode(
          JSON.stringify(
            {
              scene: 'procedural rigid humanoid and environment wall; one Renderer',
              size: CHANNEL_CHARACTER_SIZE,
              epsilon: CHANNEL_EPSILON,
              samples,
            },
            null,
            2,
          ),
        ),
      );
      expect(sample.roleBefore).toBeGreaterThan(0.02);
      expect(Math.abs(sample.roleBefore - sample.roleAfter)).toBeLessThanOrEqual(CHANNEL_EPSILON);
      expect(sample.environmentBefore - sample.environmentAfter).toBeGreaterThan(0.01);
      expect(sample.environmentAfter).toBeGreaterThan(0.01);
    }
  } finally {
    lease.dispose();
  }
}
