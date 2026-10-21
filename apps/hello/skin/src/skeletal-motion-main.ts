import { createBrowserPlatform } from '@forgeax/engine/platform-browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrograms } from 'virtual:forgeax/plugin-programs/engine';
import {
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { replayCapturedFrameInBrowser } from '@forgeax/apps-shared/rhi-debug-browser-replay';
import { animationPlugin } from '@forgeax/engine/animation';
import {
  PREPARE_SKELETAL_MOTION_JOINTS,
  type SkeletalMotionBinding,
  skeletalMotionPlugin,
} from '@forgeax/engine/animation/skeletal-motion';
import { createApp } from '@forgeax/engine/app';
import { type EntityHandle, FixedTime, FixedUpdate, World } from '@forgeax/engine/ecs';
import { physicsPlugin } from '@forgeax/engine/physics';
import { renderComponentsPlugin } from '@forgeax/engine/render';
import { err, RhiError } from '@forgeax/engine/rhi';
import { attachRecorder, decodeImage, toRgba8 } from '@forgeax/engine/rhi-debug';
import * as backend from '@forgeax/engine/rhi-webgpu';
import { constructRuntimeRendererHost } from '@forgeax/engine/runtime/internal/renderer-host';
import { scenePlugin, Transform } from '@forgeax/engine/scene';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { loadSkeletalMotionScene } from './skeletal-motion-scene';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('canvas missing');
const output = document.querySelector<HTMLOutputElement>('#status');

async function start(target: HTMLCanvasElement) {
  const attachment = attachRecorder(backend).unwrap();
  let boundary = attachment.frameBoundary();
  const bundler = import.meta.env.DEV
    ? {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      }
    : forgeaxBundlerAdapter();
  const assembled = await constructRuntimeRendererHost(
    target,
    {
      rhi: attachment.backend.rhi,
      rhiInstrumentation: {
        resolveSurfaceDevice: (device) => {
          const resolved = attachment.backend.unwrapDeviceForSurface(device);
          if (resolved.ok) return resolved;
          return err(
            new RhiError({
              code: 'rhi-not-available',
              expected: 'recorder surface device',
              hint: resolved.error.hint,
            }),
          );
        },
        onFrameBoundary: () => {
          boundary = attachment.frameBoundary();
        },
        onDeviceLost: () => attachment.deviceLost(),
      },
      captureGpuTimings: true,
    },
    bundler,
  );
  if (!assembled.ok) throw assembled.error;
  const host = assembled.value;
  const world = new World({
    assets: host.assets,
    time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 },
  });
  const platform = createBrowserPlatform(target).unwrap();
  const app = (
    await createApp({
      platform,
      world,
      renderer: host.renderer,
      assets: host.assets,
      ...(runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding }),
      pluginPrograms: createPrograms(crypto.randomUUID(), 'skeletal-motion', 1),
      plugins: [
        {
          name: 'browser-platform',
          apply(ctx) {
            ctx.effect(() => () => platform.dispose());
          },
        },
        scenePlugin(),
        renderComponentsPlugin(),
        skinningPlugin(),
        animationPlugin({ cadence: 'fixed' }),
        physicsPlugin('rapier-3d'),
        skeletalMotionPlugin({ physics: true }),
      ],
    })
  ).unwrap();
  const runtimeErrors: { code: string; detail: unknown }[] = [];
  app.onError((error) => {
    runtimeErrors.push({ code: error.code, detail: 'detail' in error ? error.detail : undefined });
  });
  const subjects = await loadSkeletalMotionScene(app.pluginContext, target.width / target.height);
  const { player, definition, physics, controls, skinEntity } = subjects;
  let binding: SkeletalMotionBinding = controls.binding;
  const getBinding = () => controls.binding;
  const inFlight = new Set<Promise<unknown>>();
  const unsubscribe = host.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted') return;
    const completed = event.receipt.completed;
    inFlight.add(completed);
    void completed.then(() => inFlight.delete(completed));
  });
  const drain = async () => {
    await Promise.all([...inFlight]);
  };
  const step = async (delta: number) => {
    await drain();
    app.stepFrame(delta).unwrap();
    (await boundary).unwrap();
    await drain();
  };
  let impact = false;
  app.pluginContext.effect(() => {
    world
      .addSystem(FixedUpdate, {
        name: 'skeletal-motion-example-impact',
        queries: [],
        after: [PREPARE_SKELETAL_MOTION_JOINTS],
        before: ['physicsStepSimulation'],
        fn: () => {
          const body = binding.bodyEntities[3];
          if (impact && body !== undefined && binding.status === 'active') {
            if (!physics.applyBodyImpulse) throw new Error('body impulse capability missing');
            physics.applyBodyImpulse(body, [0, 1.2, 0]).unwrap();
            impact = false;
          }
        },
      })
      .unwrap();
    return () => {
      world.removeSystem(FixedUpdate, 'skeletal-motion-example-impact').unwrap();
    };
  });
  let springWeight = 1;
  const updateStatus = () => {
    if (output)
      output.value = `${binding.status} · tick ${world.getResource(FixedTime).tick} · ${physics.getBodyCount()} bodies · ${physics.getJointCount?.()} joints${binding.failure ? ` · ${binding.failure.code}: ${binding.failure.detail.reason}` : ''}`;
  };
  document.querySelector('#spring')?.addEventListener('click', () => {
    springWeight = 1 - springWeight;
    binding.setSpringWeight(0, springWeight).unwrap();
  });
  document.querySelector('#full')?.addEventListener('click', () => {
    binding.simulate(definition.physical?.bones.map((bone) => bone.target) ?? []).unwrap();
  });
  document.querySelector('#partial')?.addEventListener('click', () => {
    binding
      .simulate(definition.physical?.bones.slice(2, 4).map((bone) => bone.target) ?? [])
      .unwrap();
    impact = true;
  });
  document.querySelector('#stop')?.addEventListener('click', () => {
    binding.simulate([]).unwrap();
    binding.reset();
  });
  document.querySelector('#reset')?.addEventListener('click', () => {
    world.set(player as EntityHandle, Transform, { pos: [1.5, 1, 0] }).unwrap();
    binding.reset();
  });
  document.querySelector('#weight')?.addEventListener('change', (event) => {
    binding.setPhysicsWeight(Number((event.target as HTMLSelectElement).value)).unwrap();
  });
  document.querySelector('#rebind')?.addEventListener('click', () => {
    controls.rebind();
    binding = getBinding();
  });
  app.pluginContext.effect(() => {
    const statusTimer = setInterval(updateStatus, 200);
    return () => clearInterval(statusTimer);
  });
  window.addEventListener('pagehide', () => {
    unsubscribe();
    void app.dispose();
  });
  app.start().unwrap();
  Object.assign(globalThis, {
    __skeletalMotion: {
      app,
      world,
      physics,
      runtimeErrors,
      definition,
      skinEntity,
      get binding() {
        return binding;
      },
      async advance(count: number, delta = 1 / 60) {
        app.pause().unwrap();
        (await boundary).unwrap();
        for (let i = 0; i < count; i++) await step(delta);
      },
      restart() {
        subjects.restart();
        binding = getBinding();
      },
      snapshot: () => subjects.snapshot(),
      rendererSnapshot: () => host.renderer.inspect(),
      async prepareDeviceLoss() {
        app.pause().unwrap();
        (await boundary).unwrap();
        await drain();
        return { before: host.renderer.inspect(), tick: world.getResource(FixedTime).tick };
      },
      async recoverDeviceLoss() {
        const phase = (name: string) => {
          const { state, frame, recovery } = host.renderer.inspect();
          console.debug(
            'skeletal-motion-recovery',
            name,
            JSON.stringify({ state, frame, recovery }),
          );
        };
        phase('await-native-loss');
        const native = host.renderer.nativeDevice();
        if (!native.ok) throw native.error;
        const loss = await Promise.race([
          native.value.lost,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('native unexpected loss deadline exceeded')), 60000),
          ),
        ]);
        if (loss.reason === 'destroyed')
          throw new Error('intentional device teardown does not exercise unexpected recovery');
        phase('native-loss-observed');
        const deadline = performance.now() + 60000;
        while (host.renderer.state() === 'alive') {
          if (performance.now() > deadline) throw new Error('native device loss was not observed');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        phase('recover-renderer');
        const recovered = await host.renderer.recover();
        if (!recovered.ok) throw recovered.error;
        phase('renderer-recovered');
        for (let frame = 0; frame < 60; frame++) {
          await step(1 / 60);
          if ((frame + 1) % 20 === 0) phase(`completed-${frame + 1}`);
        }
        app.resume().unwrap();
        return {
          loss: { reason: loss.reason, message: loss.message },
          after: host.renderer.inspect(),
          completedRecoveryFrames: 60,
          runtimeErrors,
        };
      },
      async capture() {
        app.pause().unwrap();
        try {
          const phase = (name: string) => console.debug('skeletal-motion-capture', name);
          phase('drain-boundary');
          (await boundary).unwrap();
          const tick = world.getResource(FixedTime).tick;
          const pending = attachment.captureFrame({ signal: AbortSignal.timeout(60000) });
          phase('snapshot-step');
          await step(0);
          phase('record-step');
          await step(0);
          phase('assemble');
          const tape = (await pending).unwrap();
          phase('live-readback');
          const snapshot = this.snapshot();
          const live = await captureCanvasPixels(target);
          if (!live.ok) throw live.error;
          phase('browser-replay');
          const replay = await replayCapturedFrameInBrowser(tape.bytes);
          phase('decode-replay');
          const decoded = decodeImage(replay.pixels, {
            format: replay.format,
            width: replay.width,
            height: replay.height,
          });
          if (!decoded.ok) throw decoded.error;
          return {
            tick,
            snapshot,
            width: target.width,
            height: target.height,
            livePixels: live.value,
            replayPixels: toRgba8(decoded.value),
            replayWorkIndex: replay.workIndex,
            bytes: tape.bytes,
            digest: tape.digest,
            renderer: host.renderer.inspect(),
          };
        } finally {
          app.resume().unwrap();
        }
      },
    },
  });
}
start(canvas).catch((cause) => {
  console.error(cause);
  if (output) output.value = String(cause);
});
