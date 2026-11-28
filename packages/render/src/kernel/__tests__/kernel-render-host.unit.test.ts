import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { packKernelMeshVertices } from '@forgeax/engine-render-kernel';
import {
  createNativeRenderKernel,
  isNativeRenderKernelAvailable,
} from '@forgeax/engine-render-kernel/native';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  ANTIALIAS_FXAA,
  BLOOM_ENABLED,
  Camera,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
} from '../../components/camera';
import { DirectionalLight } from '../../components/directional-light';
import { Fog, FogModeValue } from '../../components/fog';
import { MeshFilter } from '../../components/mesh-filter';
import { MeshRenderer } from '../../components/mesh-renderer';
import { PointLight } from '../../components/point-light';
import { Skylight } from '../../components/skylight';
import { Visibility, VisibilityStateValue } from '../../components/visibility';
import type { RenderFeature } from '../../features/types';
import { Materials } from '../../materials';
import { createKernelRenderHost } from '../kernel-render-host';

const QUAD_VERTS = packKernelMeshVertices(
  [-1.2, -1.2, 0, 1.2, -1.2, 0, 1.2, 1.2, 0, -1.2, 1.2, 0],
  [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  [0, 0, 1, 0, 1, 1, 0, 1],
);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const FEATURE_GRADE_WGSL = /* wgsl */ `
struct GradeParams {
  gain: vec4<f32>,
};
@group(0) @binding(0) var t_in: texture_2d<f32>;
@group(0) @binding(1) var s_in: sampler;
@group(0) @binding(2) var<uniform> u_grade: GradeParams;
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var uv = array<vec2<f32>, 3>(vec2(0.0, 1.0), vec2(2.0, 1.0), vec2(0.0, -1.0));
  var o: VsOut; o.pos = vec4<f32>(p[idx], 0.0, 1.0); o.uv = uv[idx]; return o;
}
@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(t_in, s_in, in.uv);
  return vec4<f32>(clamp(c.rgb * u_grade.gain.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

describe('KernelRenderHost ECS + RenderFeature bridge', () => {
  it.skipIf(!isNativeRenderKernelAvailable())(
    'extracts live ECS World components and executes an adapted @forgeax/engine-render RenderFeature on real GPU',
    async () => {
      const worldAssets = new AssetRegistry();
      const world = new World({ assets: worldAssets });
      const meshHandle = worldAssets.create(createBoxGeometry(2.4, 2.4, 0.2).unwrap()).unwrap();
      const matHandle = worldAssets
        .create(Materials.standard({ baseColor: [0.9, 0.9, 0.9, 1], roughness: 0.4 }))
        .unwrap();
      const camEntity = world
        .spawn(
          { component: Transform, data: { pos: new Float32Array([0, 0, 4]) } },
          {
            component: Camera,
            data: {
              ...perspective({ fov: (55 * Math.PI) / 180, aspect: 1, near: 0.1, far: 100 }),
              clearColor: new Float32Array([0.02, 0.02, 0.04, 1]),
              tonemap: TONEMAP_ACES_FILMIC,
              exposure: 1.2,
              bloom: BLOOM_ENABLED,
              bloomThreshold: 0.9,
              bloomIntensity: 0.35,
              antialias: ANTIALIAS_FXAA,
            },
          },
        )
        .unwrap();

      world
        .spawn({
          component: DirectionalLight,
          data: {
            direction: new Float32Array([0, -0.2, -1]),
            color: new Float32Array([1, 1, 1]),
            intensity: 3.0,
            castShadow: true,
            cascadeCount: 1,
            shadowDistance: 12,
          },
        })
        .unwrap();

      world
        .spawn(
          { component: Transform, data: { pos: new Float32Array([1.5, 1.0, 2.5]) } },
          {
            component: PointLight,
            data: { color: new Float32Array([0.8, 0.9, 1.0]), intensity: 4.0, range: 15 },
          },
        )
        .unwrap();

      world
        .spawn({
          component: Skylight,
          data: { color: new Float32Array([0.3, 0.35, 0.4]), intensity: 0.3 },
        })
        .unwrap();

      world
        .spawn({
          component: Fog,
          data: {
            mode: FogModeValue.linear,
            color: new Float32Array([0.1, 0.12, 0.15]),
            near: 10,
            far: 60,
          },
        })
        .unwrap();

      const meshEntity = world
        .spawn(
          { component: Transform, data: { pos: new Float32Array([0, 0, 0]) } },
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
          { component: Visibility, data: { state: VisibilityStateValue.visible } },
        )
        .unwrap();

      const kernel = createNativeRenderKernel({ maxInFlight: 2 }).unwrap();
      const host = createKernelRenderHost(kernel, { headless: true, shadowMapSize: 256 }).unwrap();

      let submittedCount = 0;
      let greenGain = 0.25;
      const customFeature: RenderFeature<{ readonly gain: Float32Array }> = {
        identity: 'ecs-custom-grade',
        placement: 'post',
        extract() {
          return ok({ gain: new Float32Array([1.0, greenGain, 0.2, 1.0]) });
        },
        plan(data) {
          return ok({
            work: [
              {
                scope: { view: 'main' },
                resources: [
                  {
                    kind: 'fullscreen-program',
                    name: 'grade',
                    stage: 'after-output',
                    chain: true,
                    source: FEATURE_GRADE_WGSL,
                    params: { byteSize: 16, defaultValue: new Uint8Array(16) },
                    frameParams: new Uint8Array(data.gain.buffer, data.gain.byteOffset, 16),
                  },
                ],
                passes: [],
              },
            ],
          });
        },
        onFrameSubmitted() {
          submittedCount += 1;
        },
      };

      try {
        host
          .registerMesh({ key: Number(meshHandle), vertices: QUAD_VERTS, indices: QUAD_INDICES })
          .unwrap();
        host
          .registerMaterial({
            key: Number(matHandle),
            baseColor: [0.9, 0.9, 0.9, 1],
            roughness: 0.4,
          })
          .unwrap();
        host.installRenderFeature(customFeature).unwrap();

        // Frame 1: white quad -> graded strongly red (R high, G suppressed to 0.25)
        host.renderWorld(world, { width: 64, height: 64, readbackTicketId: 1 }).unwrap();
        const rb1 = (await host.readbackTicket(1)).unwrap();
        const center = (32 * 64 + 32) * 4;
        expect(submittedCount).toBe(1);
        expect(rb1.pixels[center] as number).toBeGreaterThan(150);
        expect(rb1.pixels[center + 1] as number).toBeLessThan(80);
        expect(rb1.pixels[center + 2] as number).toBeLessThan(70);

        // Frame 2: live update RenderFeature param (greenGain -> 1.0) & Camera tonemap -> AgX
        greenGain = 1.0;
        const camRes = world.get(camEntity, Camera);
        if (camRes.ok) {
          world.set(camEntity, Camera, { ...camRes.value, tonemap: TONEMAP_AGX });
        }
        host.renderWorld(world, { width: 64, height: 64, readbackTicketId: 2 }).unwrap();
        const rb2 = (await host.readbackTicket(2)).unwrap();
        expect(submittedCount).toBe(2);
        expect(rb2.pixels[center + 1] as number).toBeGreaterThan(140);

        // Frame 3: hide entity via ECS Visibility -> center pixel drops to clear color
        world.set(meshEntity, Visibility, { state: VisibilityStateValue.hidden });
        host.renderWorld(world, { width: 64, height: 64, readbackTicketId: 3 }).unwrap();
        const rb3 = (await host.readbackTicket(3)).unwrap();
        expect(rb3.pixels[center] as number).toBeLessThan(60);
      } finally {
        host.dispose();
        kernel.dispose();
      }
    },
  );
});
