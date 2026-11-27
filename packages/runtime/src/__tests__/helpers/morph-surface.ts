import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  AmbientOcclusion,
  Camera,
  type FrameReceipt,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  ScreenSpaceReflection,
  Skylight,
} from '@forgeax/engine-render';
import type {
  RendererHostAssembly,
  RendererLegacyHostAdapter,
} from '@forgeax/engine-render/internal/construct-renderer';
import { MorphWeights, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import {
  decodeGBufferNormalXYZ10,
  decodeMaterialNormalX12Y12,
} from '../../../../render/src/__tests__/gtao-reference';
import {
  captureForwardGtaoTarget,
  type ForwardGtaoCaptureHost,
  type ForwardGtaoTargetCapture,
} from './forward-gtao-capture';
import { describeForwardGtaoFailure } from './forward-gtao-failure';
import { observeMorphSubmission, preserveMorphFailure } from './morph-original-frame';
import {
  attachStandardPbrSkin,
  standardPbrSkinMaterial,
  standardPbrSkinMesh,
} from './standard-pbr-skin-subject';

export const MORPH_SURFACE_SIZE = 96;

/** Verify the actual deformed surface consumed by AO and Forward SSR. */
export async function verifyMorphSurface(
  host: RendererHostAssembly,
  onState: (name: string, facts: unknown) => Promise<void>,
  skin = false,
  onFailure?: (draw: () => Promise<unknown>, cause: unknown) => Promise<void>,
  originalSsr?: { begin(): Promise<void>; submitted(receipt: FrameReceipt): void },
) {
  const { renderer, assets } = host;
  const debug = host.debugDrawHost as ForwardGtaoCaptureHost &
    Pick<RendererLegacyHostAdapter, 'setClusterWorkObservationForConformance'>;
  debug.setClusterWorkObservationForConformance(true);
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World({ assets });
  const camera = world
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
      { component: AmbientOcclusion, data: {} },
    )
    .unwrap();
  world.spawn({ component: Skylight, data: {} }).unwrap();
  const base = createBoxGeometry(1.4, 1.4, 0.1).unwrap();
  const count = (base.attributes.position as Float32Array).length;
  const deltas = (axis: number, amount: number, components = 3) =>
    Float32Array.from({ length: (count / 3) * components }, (_, i) =>
      i % components === axis ? amount : 0,
    );
  const source = {
    ...base,
    morphTargets: [
      {
        position: deltas(0, 0.25),
        normal: deltas(0, 0.4),
        tangent: deltas(1, 0.2, 4),
      },
    ],
  };
  const mesh = assets.create(skin ? standardPbrSkinMesh(source) : source).unwrap();
  const authored = Materials.standard({ baseColor: [0.8, 0.15, 0.05, 1], roughness: 0.2 });
  const material = assets.create(skin ? standardPbrSkinMaterial(authored) : authored).unwrap();
  const subject = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, skin ? 0 : -3] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: MorphWeights, data: { weights: [0] } },
    )
    .unwrap();
  const angle = skin ? 0.2 : 0;
  if (skin) {
    const binding = attachStandardPbrSkin(world, assets, subject, [0, 0, -3]);
    world
      .set(binding.joint, Transform, { quat: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)] })
      .unwrap();
  }
  const background = assets.create(createBoxGeometry(8, 8, 0.1).unwrap()).unwrap();
  const gray = assets
    .create(Materials.standard({ baseColor: [0.3, 0.3, 0.3, 1], roughness: 0.8 }))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -4] } },
      { component: MeshFilter, data: { assetHandle: background } },
      { component: MeshRenderer, data: { materials: [gray] } },
    )
    .unwrap();
  const lease = attachForwardMorphScene(renderer, world);
  let captureSsr = false;
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    try {
      const diagnostic = captureSsr ? originalSsr : undefined;
      captureSsr = false;
      const submitter = await observeMorphSubmission(renderer, diagnostic);
      return await drawReadyFrame(submitter, {
        source: lease,
        camera: { entityKey: camera },
      });
    } catch (cause) {
      throw new Error(
        JSON.stringify({
          failure: describeForwardGtaoFailure(cause),
          errors,
          inspection: renderer.inspect().ssr,
        }),
        { cause },
      );
    }
  };
  try {
    const aoCenters: number[] = [];
    for (const ssr of [false, true]) {
      captureSsr = ssr;
      if (ssr) {
        world
          .addComponent(camera, { component: ScreenSpaceReflection, data: { maxDistance: 8 } })
          .unwrap();
        await (await draw()).completed;
      }
      for (const [state, weight] of [0, 0.5, 1, 0].entries()) {
        world.set(subject, MorphWeights, { weights: [weight] }).unwrap();
        for (let frame = 0; frame < (weight === 1 ? 60 : 2); frame++) await draw();
        let surface: { normal: readonly number[] } | { aoCenter: number };
        if (ssr && debug.getCurrentGraphTarget('ssr-forward-normal') !== undefined) {
          const captured = await captureForwardGtaoTarget(debug, 'ssr-forward-normal', draw);
          const normal = centerSurfaceNormal(captured);
          const magnitude = Math.hypot(weight * 0.4, 1);
          expect(normal[0]).toBeCloseTo(
            (Math.cos(angle) * weight * 0.4 + Math.sin(angle)) / magnitude,
            2,
          );
          expect(normal[1]).toBeCloseTo(0, 2);
          expect(normal[2]).toBeCloseTo(
            (Math.cos(angle) - Math.sin(angle) * weight * 0.4) / magnitude,
            2,
          );
          surface = { normal };
        } else {
          expect(renderer.inspect().standardLighting?.ambientOcclusion?.input.normalSchema).toBe(
            'depth-reconstruction',
          );
          const visibility = await captureForwardGtaoTarget(debug, 'ssao-calc', draw);
          const aoCenter = horizontalOcclusionCenter(visibility);
          if (!ssr) aoCenters.push(aoCenter);
          surface = { aoCenter };
        }
        expect(renderer.inspect().standardLighting?.ambientOcclusion?.status).toBe('active');
        await onState(`${skin ? 'skin' : 'mesh'}-${ssr ? 'ao-ssr' : 'ao'}-${state}-${weight}`, {
          ...surface,
          inspection: renderer.inspect(),
          completedFramesThisState: weight === 1 ? 60 : 2,
        });
        if (ssr) expect(renderer.inspect().ssr.status).toBe('admitted');
      }
    }
    expectOcclusionFollowsMorph(aoCenters);
    expect(errors).toEqual([]);
  } catch (cause) {
    await preserveMorphFailure(onFailure, draw, cause);
  } finally {
    lease.dispose();
    unsubscribe();
    debug.setClusterWorkObservationForConformance(false);
  }
}

/** Own native admission and dispose an attached scene if its profile cannot be selected. */
function attachForwardMorphScene(renderer: Renderer, world: World) {
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const profiled = renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'forward' });
  if (!profiled.ok) {
    attached.value.dispose();
    throw profiled.error;
  }
  return attached.value;
}

function expectOcclusionFollowsMorph(aoCenters: readonly number[]) {
  const [start, half, full, restored] = aoCenters;
  expect(half, JSON.stringify(aoCenters)).toBeGreaterThan((start ?? NaN) + 0.5);
  expect(full, JSON.stringify(aoCenters)).toBeGreaterThan((half ?? NaN) + 0.5);
  expect(restored, JSON.stringify(aoCenters)).toBeCloseTo(start ?? NaN, 4);
}

function horizontalOcclusionCenter(capture: ForwardGtaoTargetCapture): number {
  expect(capture.format).toBe('r8unorm');
  let weight = 0;
  let moment = 0;
  for (const [index, visibility] of capture.bytes.entries()) {
    const occlusion = 255 - visibility;
    weight += occlusion;
    moment += (index % capture.width) * occlusion;
  }
  expect(weight).toBeGreaterThan(0);
  return moment / weight;
}

function centerSurfaceNormal(captured: ForwardGtaoTargetCapture) {
  const at =
    (Math.floor(captured.height / 2) * captured.width + Math.floor(captured.width / 2)) *
    captured.bytesPerTexel;
  const packed = new DataView(captured.bytes.buffer, captured.bytes.byteOffset).getUint32(at, true);
  return captured.format === 'rg32uint'
    ? decodeGBufferNormalXYZ10(packed)
    : decodeMaterialNormalX12Y12(packed);
}
