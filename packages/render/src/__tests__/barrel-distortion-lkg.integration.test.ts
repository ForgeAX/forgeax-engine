import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
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
import { rejectMainViewBinding } from './graph-compile.fixture';
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
vi.spyOn(helpers, 'computeViewMatrix').mockImplementation((camera, out) => {
  cameraInputs.push([...camera.position]);
  return realComputeViewMatrix(camera, out);
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
    let fault: ReturnType<typeof rejectMainViewBinding> | undefined;
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
                    kind: 'graph-texture' as const,
                    name: 'retained-camera.candidate-color',
                    allocationKey: 'retained-camera.candidate-color',
                    descriptor: {
                      format: 'rgba8unorm' as const,
                      size: { width: 64, height: 64, depthOrArrayLayers: 1 },
                    },
                  },
                ],
                passes: [
                  {
                    kind: 'raster' as const,
                    name: 'retained-camera.candidate-pass',
                    colorAttachments: [
                      {
                        target: 'retained-camera.candidate-color',
                        loadOp: 'clear' as const,
                        storeOp: 'store' as const,
                      },
                    ],
                    draws: [],
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
      const rendererErrors: unknown[] = [];
      renderer.onError((error) => rendererErrors.push(error));
      const initialized = await renderer.initialization;
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      renderer.setGtaoExecutionOverrideForConformance('fragment');
      const world = new World({ assets: renderer.assetRegistry });
      const cube = renderer.assetRegistry.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
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
          { component: MeshFilter, data: { assetHandle: cube } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      expect(world.update().ok).toBe(true);
      const frameInput = { source: attached.value };
      const initial = await drawReadyFrame(renderer, frameInput);
      expect(initial.barrelDistortion).toMatchObject({
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
      fault = rejectMainViewBinding();
      const candidate = renderer.draw(frameInput);
      expect(candidate.ok, JSON.stringify({ candidate, rendererErrors })).toBe(true);
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
      expect(fault.count).toBeGreaterThan(0);
      expect(renderer.perFramePassNames).toEqual(lastKnownGoodPasses);
      expect(
        renderer
          .inspect()
          .featureDiagnostics.find((diagnostic) => diagnostic.identity === feature.identity),
      ).toMatchObject({
        identity: 'synthetic.retained-camera',
        status: 'active',
      });
    } finally {
      fault?.restore();
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
    const rendererErrors: unknown[] = [];
    renderer.onError((error) => rendererErrors.push(error));
    try {
      const initialized = await renderer.initialization;
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      renderer.setGtaoExecutionOverrideForConformance('fragment');
      const world = new World({ assets: renderer.assetRegistry });
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
      const frameInput = { source: attached.value };
      const initial = await drawReadyFrame(renderer, frameInput);
      expect(initial.barrelDistortion?.strength).toBeCloseTo(0.2, 6);

      canvas.width = 1280;
      canvas.height = 720;
      // Adopt the resized lighting topology before testing a same-topology failed disable.
      const resized = await drawReadyFrame(renderer, frameInput);
      expect(resized.barrelDistortion).toMatchObject({ width: 1280, height: 720 });
      expect(resized.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      world.removeComponent(cameraEntity, BarrelDistortion).unwrap();
      expect(world.update().ok).toBe(true);
      const fault = rejectMainViewBinding();
      try {
        const candidate = renderer.draw(frameInput);
        expect(candidate.ok, JSON.stringify({ candidate, rendererErrors })).toBe(true);
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
        fault.restore();
      }

      const disabled = await drawReadyFrame(renderer, frameInput);
      expect(disabled.barrelDistortion).toMatchObject({
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
