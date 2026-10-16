import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderer as constructRenderer } from '../assembly/factory';
import { BarrelDistortion, MeshFilter, MeshRenderer } from '../components';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera as LocalCamera,
  TONEMAP_ACES_FILMIC,
} from '../components/camera';
import type { RenderFeaturePlanContext, RenderFeatureWork } from '../features/plan';
import type { RenderFeature } from '../features/types';
import * as helpers from '../record/helpers';
import * as viewUbo from '../record/view-ubo';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

interface ViewUboCameraInput {
  readonly position: number[];
  readonly projection: 'perspective' | 'orthographic';
  readonly world: number[];
}

const cameraInputs: number[][] = [];
const viewUboInputs: ViewUboCameraInput[] = [];
const postProcessUboInputs: Array<readonly [number, number, number, number]> = [];
const realWriteViewUbo = viewUbo.writeViewUbo;
vi.spyOn(viewUbo, 'writeViewUbo').mockImplementation((...args) => {
  const camera = args[2];
  viewUboInputs.push({
    position: [...camera.position],
    projection: camera.projection,
    world: [...camera.world],
  });
  return realWriteViewUbo(...args);
});
const realComputeViewMatrix = helpers.computeViewMatrix;
vi.spyOn(helpers, 'computeViewMatrix').mockImplementation((camera) => {
  cameraInputs.push([...camera.position]);
  return realComputeViewMatrix(camera);
});
const realNullWriteBuffer = RhiNullQueue.prototype.writeBuffer;
vi.spyOn(RhiNullQueue.prototype, 'writeBuffer').mockImplementation(function (
  this: RhiNullQueue,
  ...args: Parameters<RhiNullQueue['writeBuffer']>
) {
  const data = args[2];
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength === 16) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    postProcessUboInputs.push([
      view.getFloat32(0, true),
      view.getFloat32(4, true),
      view.getFloat32(8, true),
      view.getFloat32(12, true),
    ]);
  }
  return realNullWriteBuffer.apply(this, args);
});

describe('barrel distortion retained graph frame authority', () => {
  it('uses current View UBO and receipt camera after an LKG compile failure', async () => {
    cameraInputs.length = 0;
    viewUboInputs.length = 0;
    const compileSpy = vi.spyOn(RenderGraphBuilder.prototype, 'compile');
    let candidateEnabled = false;
    let featurePlanCalls = 0;
    let renderer: Awaited<ReturnType<typeof constructRenderer>> | undefined;
    try {
      const feature: RenderFeature<undefined> = {
        identity: 'synthetic.retained-camera',
        shaderModuleMode: 'immediate',
        extract: () => ok(undefined),
        plan: (_data: unknown, context: RenderFeaturePlanContext) => {
          featurePlanCalls += 1;
          if (!candidateEnabled)
            return ok({
              work: context.views
                .filter((view) => view.render)
                .map<RenderFeatureWork>((view) => ({
                  scope: { view: view.identity },
                  resources: [],
                  passes: [],
                })),
            });
          return ok({
            work: context.views
              .filter((view) => view.render)
              .map<RenderFeatureWork>((view) => ({
                scope: { view: view.identity },
                resources: [
                  {
                    kind: 'compute-program' as const,
                    name: 'retained-camera.candidate-program',
                    program: {
                      wgsl: '@compute @workgroup_size(1) fn main() {}',
                      entryPoints: ['main'],
                      bindings: [
                        {
                          entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
                        },
                      ],
                    },
                  },
                  {
                    kind: 'buffer' as const,
                    name: 'retained-camera.candidate-buffer',
                    size: 4,
                    usage: ['storage' as const],
                    data: new Uint32Array([0]),
                  },
                  {
                    kind: 'compute-bindings' as const,
                    name: 'retained-camera.candidate-bindings',
                    program: 'retained-camera.candidate-program',
                    entries: [{ binding: 0, resource: 'retained-camera.candidate-buffer' }],
                  },
                ],
                passes: [
                  {
                    kind: 'compute' as const,
                    name: 'retained-camera.candidate-pass',
                    program: 'retained-camera.candidate-program',
                    bindings: 'retained-camera.candidate-bindings',
                    dispatches: [
                      { kind: 'direct' as const, entryPoint: 'main', workgroups: [1, 1, 1] },
                    ],
                  },
                ],
              })),
          });
        },
      };
      renderer = await constructRenderer(
        { width: 64, height: 64, getContext: () => null },
        { rhi, features: [feature] },
        { shaderManifestUrl: renderLifecycleManifestUrl() },
      );
      const initialized = await renderer.initialization;
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      const world = new World();
      const attached = renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      registerPropagateTransforms(world);
      const cameraEntity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          {
            component: LocalCamera,
            data: {
              fov: 1,
              aspect: 1,
              near: 0.1,
              far: 100,
              antialias: ANTIALIAS_NONE,
              tonemap: TONEMAP_ACES_FILMIC,
              bloom: BLOOM_DISABLED,
            },
          },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, -4] } },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      expect(world.update().ok).toBe(true);
      const frameInput = {
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      };
      const initial = renderer.draw(frameInput);
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      if (initial.value === undefined) throw new Error('Expected a submitted frame receipt');
      expect(initial.value.barrelDistortion).toMatchObject({
        width: 64,
        height: 64,
        strength: 0,
        camera: { projection: 'perspective' },
      });
      const lastKnownGoodPasses = [...renderer.perFramePassNames];
      expect(lastKnownGoodPasses.length).toBeGreaterThan(0);

      const halfYaw = Math.sin(Math.PI / 36);
      const halfYawW = Math.cos(Math.PI / 36);
      world
        .set(cameraEntity, Transform, {
          pos: [0.5, 0, 0],
          quat: [0, halfYaw, 0, halfYawW],
        })
        .unwrap();
      world
        .set(cameraEntity, LocalCamera, {
          bloom: BLOOM_ENABLED,
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          orthoLeft: -2,
          orthoRight: 2,
          orthoBottom: -2,
          orthoTop: 2,
        })
        .unwrap();
      world
        .addComponent(cameraEntity, {
          component: BarrelDistortion,
          data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
        })
        .unwrap();
      expect(world.update().ok).toBe(true);
      candidateEnabled = true;
      compileSpy.mockReturnValue(
        err(
          Object.assign(new Error('forced compile rejection'), { code: 'graph-compile-failed' }),
        ) as never,
      );
      const candidate = renderer.draw(frameInput);
      expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
      if (!candidate.ok) return;
      if (candidate.value === undefined) throw new Error('Expected a submitted frame receipt');
      await Promise.resolve();
      const pending = renderer.draw(frameInput);
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      if (pending.value === undefined) throw new Error('Expected a submitted frame receipt');
      expect(pending.value.barrelDistortion).toMatchObject({
        width: 64,
        height: 64,
        strength: 0,
        camera: { projection: 'orthographic' },
      });
      expect(cameraInputs).toContainEqual([0.5, 0, 0]);
      const currentUboCamera = [...viewUboInputs]
        .reverse()
        .find((input) => input.position[0] === 0.5);
      expect(currentUboCamera).toBeDefined();
      if (currentUboCamera === undefined) return;
      const expectedView = mat4.invert(mat4.create(), Float32Array.from(currentUboCamera.world));
      const pendingMapping = pending.value.barrelDistortion;
      expect(pendingMapping?.camera?.viewMatrix).toEqual(Array.from(expectedView));
      expect(pendingMapping?.camera?.viewMatrix[12]).not.toBe(0);
      expect(featurePlanCalls).toBeGreaterThan(1);
      expect(compileSpy).toHaveBeenCalled();
      expect(renderer.perFramePassNames).toEqual(lastKnownGoodPasses);
      expect(renderer.inspect().featureDiagnostics[0]).toMatchObject({
        identity: 'synthetic.retained-camera',
        status: 'active',
      });
    } finally {
      compileSpy.mockRestore();
      await renderer?.dispose();
    }
  });

  it('retains nonzero parameters through failed disable and publishes identity on success', async () => {
    postProcessUboInputs.length = 0;
    const canvas = { width: 64, height: 64, getContext: () => null };
    const renderer = await constructRenderer(
      canvas,
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    try {
      const initialized = await renderer.initialization;
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      const world = new World();
      const attached = renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      registerPropagateTransforms(world);
      const cameraEntity = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          {
            component: LocalCamera,
            data: {
              fov: 1,
              aspect: 1,
              near: 0.1,
              far: 100,
              antialias: ANTIALIAS_NONE,
              tonemap: TONEMAP_ACES_FILMIC,
              bloom: BLOOM_DISABLED,
            },
          },
          { component: BarrelDistortion, data: { strength: 0.2, centerX: 0.5, centerY: 0.5 } },
        )
        .unwrap();
      expect(world.update().ok).toBe(true);
      const frameInput = {
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      };
      const initial = renderer.draw(frameInput);
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      if (initial.value === undefined) throw new Error('Expected a submitted frame receipt');
      expect(initial.value.barrelDistortion?.strength).toBeCloseTo(0.2, 6);

      canvas.width = 1280;
      canvas.height = 720;
      world.removeComponent(cameraEntity, BarrelDistortion).unwrap();
      expect(world.update().ok).toBe(true);
      const compileSpy = vi.spyOn(RenderGraphBuilder.prototype, 'compile');
      compileSpy.mockReturnValue(
        err(
          Object.assign(new Error('forced disable rejection'), { code: 'graph-compile-failed' }),
        ) as never,
      );
      try {
        const candidate = renderer.draw(frameInput);
        expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
        if (!candidate.ok) return;
        if (candidate.value === undefined) throw new Error('Expected a submitted frame receipt');
        await Promise.resolve();
        const pending = renderer.draw(frameInput);
        expect(pending.ok).toBe(true);
        if (!pending.ok) return;
        if (pending.value === undefined) throw new Error('Expected a submitted frame receipt');
        expect(pending.value.barrelDistortion).toMatchObject({
          width: 1280,
          height: 720,
        });
        expect(pending.value.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
        expect(
          postProcessUboInputs.some(
            ([strength, centerX, centerY, radiusSquared]) =>
              Math.abs(strength - 0.2) < 1e-6 &&
              centerX === 0.5 &&
              centerY === 0.5 &&
              Math.abs(radiusSquared - 4.160493827160494) < 1e-5,
          ),
        ).toBe(true);
      } finally {
        compileSpy.mockRestore();
      }

      const disabled = renderer.draw(frameInput);
      expect(disabled.ok).toBe(true);
      if (!disabled.ok) return;
      if (disabled.value === undefined) throw new Error('Expected a submitted frame receipt');
      expect(disabled.value.barrelDistortion).toMatchObject({
        width: 1280,
        height: 720,
        strength: 0,
      });
      expect(renderer.perFramePassNames).not.toContain('barrel-distortion');
    } finally {
      await renderer.dispose();
    }
  });
});
