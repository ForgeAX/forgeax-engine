import { Time } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_TAA,
  Camera,
  CameraView,
  Materials,
  MeshFilter,
  MeshRenderer,
  type RenderFeature,
  type CameraViewInspection,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';
import { rendererCrashProbe } from './render-worker-recovery-fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing worker fixture resource');
  return value;
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

const entry: ExecutionBootstrapEntry = (data) => {
  const channelName = String(data);
  const crash = rendererCrashProbe();
  const createWitness = (): RenderFeature<{ time: number }> => ({
    identity: 'multi-camera.source-receipt',
    extract: ({ worlds }) => ok({ time: required(worlds[0]).getResource(Time).elapsed }),
    plan: (frame) => ok({ work: [{ scope: 'frame', resources: [], passes: [] }], sourceFeedback: frame }),
    onSourceFrameSubmitted(frame, feedback) {
      if (frame.time !== (feedback as { time: number }).time)
        throw new Error('Camera composition acknowledged a different source frame');
    },
  });
  const witness = createWitness();
  return {
    features: [witness as RenderFeature<unknown>],
    configureRenderer(renderer) {
      const channel = new BroadcastChannel(channelName);
      let pending: number | undefined;
      let cut: readonly CameraViewInspection[] | undefined;
      let collecting = false;
      const pictures = new Map<number, Promise<object>>();
      channel.onmessage = (event) => {
        const { id, kind, frameId } = event.data;
        if (kind === 'observe') pending = id;
        if (kind === 'begin-capture') {
          pictures.clear();
          collecting = true;
          channel.postMessage({ id });
        }
        if (kind === 'pin-capture') {
          collecting = false;
          const picture = pictures.get(frameId);
          pictures.clear();
          if (picture === undefined)
            channel.postMessage({ id, error: { missingFrame: frameId } });
          else {
            pictures.set(frameId, picture);
            channel.postMessage({ id });
          }
        }
        if (kind === 'capture-picture') {
          collecting = false;
          const picture = pictures.get(frameId);
          if (picture === undefined)
            channel.postMessage({
              id,
              error: { missingFrame: frameId, retained: [...pictures.keys()] },
            });
          else
            void picture.then((result) => {
              channel.postMessage({ ...result, id });
              pictures.clear();
            });
        }
      };
      const draw = renderer.draw.bind(renderer);
      renderer.draw = (request) => {
        const id = pending;
        pending = undefined;
        const observe = collecting || id !== undefined;
        if (observe) {
          if (renderer.requestObservation === undefined)
            throw new Error('Missing Renderer observation');
          value(renderer.requestObservation(['final-display']));
        }
        const result = draw(request);
        const views = renderer.inspect().views ?? [];
        if (views.some((view) => view.temporal.resetReason === 'history-version')) cut = views;
        if (observe) {
          if (!result.ok) channel.postMessage({ id, error: result.error });
          else {
            const picture = renderer
              .observe(result.value, { include: ['final-display'] })
              .then((observation) =>
                observation.ok
                  ? {
                      frameId: result.value.frameId,
                      views,
                      cut,
                      observation: observation.value.observations?.find(
                        (row) => row.domain === 'final-display',
                      ),
                    }
                  : { error: observation.error },
              );
            // Keep a bounded rolling window until the capture owner pins the
            // tape's exact receipt, before its bytes cross the inspection bridge.
            if (collecting) {
              pictures.set(result.value.frameId, picture);
              if (pictures.size > 256) pictures.delete(pictures.keys().next().value!);
            }
            if (id !== undefined)
              void picture.then((value) => channel.postMessage({ ...value, id }));
          }
        }
        return result;
      };
      const dispose = renderer.dispose.bind(renderer);
      renderer.dispose = () => {
        channel.close();
        pictures.clear();
        return dispose();
      };
    },
    plugins: [
      {
        name: 'multi-camera-worker-fixture',
        inject: ['world', 'executionBootstrapHost'],
        apply(ctx) {
          const world = ctx.world;
          const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(2, 2, 2).unwrap());
          const models = [-5, 5].map((x, index) =>
            world
              .spawn(
                { component: Transform, data: { pos: [x, 0, -5] } },
                { component: MeshFilter, data: { assetHandle: mesh } },
                {
                  component: MeshRenderer,
                  data: {
                    materials: [
                      world.allocSharedRef(
                        'MaterialAsset',
                        Materials.unlit(index === 0 ? [1, 0.02, 0.01, 1] : [0.01, 1, 0.02, 1]),
                      ),
                    ],
                  },
                },
              )
              .unwrap(),
          );
          const cameras = [-5, 5].map((x, index) =>
            world
              .spawn(
                { component: Transform, data: { pos: [x, 0, 0] } },
                {
                  component: Camera,
                  data: {
                    fov: Math.PI / 3,
                    near: 0.1,
                    far: 30,
                    antialias: ANTIALIAS_TAA,
                    tonemap: 1,
                    clearColor: [0.02, 0.025, 0.04, 1],
                  },
                },
                {
                  component: CameraView,
                  data: { viewport: [index * 0.5, 0, 0.5, 1], order: index },
                },
              )
              .unwrap(),
          );
          const port = ctx.executionBootstrapHost.port;
          const receive = (event: MessageEvent<{ id: number; kind: string }>) => {
            const { id, kind } = event.data;
            if (kind === 'crash') crash();
            else if (kind === 'map')
              cameras.push(
                world
                  .spawn(
                    {
                      component: Transform,
                      data: { pos: [0, 10, -5], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
                    },
                    {
                      component: Camera,
                      data: {
                        projection: 1,
                        left: -8,
                        right: 8,
                        top: 4,
                        bottom: -4,
                        near: 0.1,
                        far: 30,
                      },
                    },
                    {
                      component: CameraView,
                      data: {
                        viewport: [0.75, 0, 0.25, 0.25],
                        order: 10,
                        resolutionScale: 0.5,
                        updateInterval: 4,
                      },
                    },
                  )
                  .unwrap(),
              );
            else if (kind === 'move')
              world.set(required(models[0]), Transform, { pos: [-5, 0, -7] }).unwrap();
            else if (kind === 'cut') world.set(required(cameras[0]), Camera, { historyVersion: 1 }).unwrap();
            else if (kind === 'disable' || kind === 'enable')
              world.set(required(cameras[0]), CameraView, { enabled: kind === 'enable' }).unwrap();
            else if (kind === 'monitor') {
              for (const camera of cameras)
                world.set(camera, CameraView, { enabled: false }).unwrap();
              world.set(required(cameras[1]), CameraView, { enabled: true }).unwrap();
              const targets = required(ctx.executionBootstrapHost.renderTargets);
              const target = value(
                targets.createRenderTarget({
                  shape: '2d',
                  width: 32,
                  height: 32,
                  format: 'rgba8unorm',
                  mipLevels: 1,
                  sampleCount: 1,
                  sampled: true,
                  readback: true,
                }),
              );
              const source = value(
                targets.createRenderTargetTextureSource(target, {
                  aspect: 'color',
                  dimension: '2d',
                  mipLevel: 0,
                }),
              );
              const texture = world.allocSharedRef('RenderTargetTextureSource', source);
              world
                .spawn(
                  { component: Transform, data: { pos: [5, 0, -3] } },
                  { component: MeshFilter, data: { assetHandle: mesh } },
                  {
                    component: MeshRenderer,
                    data: {
                      materials: [
                        world.allocSharedRef(
                          'MaterialAsset',
                          Materials.unlit([1, 1, 1, 1], { baseColorTexture: texture }),
                        ),
                      ],
                    },
                  },
                )
                .unwrap();
              cameras.push(
                world
                  .spawn(
                    { component: Transform, data: { pos: [-5, 0, 0] } },
                    {
                      component: Camera,
                      data: {
                        fov: Math.PI / 3,
                        near: 0.1,
                        far: 30,
                        target: world.allocSharedRef('RenderTarget', target),
                      },
                    },
                    { component: CameraView, data: { order: -10, updateInterval: 2 } },
                  )
                  .unwrap(),
              );
            }
            port?.postMessage({ id, kind, worldIdentity: world.identity });
          };
          port?.addEventListener('message', receive);
          port?.start();
          return () => port?.removeEventListener('message', receive);
        },
      },
    ],
  };
};
export default entry;
