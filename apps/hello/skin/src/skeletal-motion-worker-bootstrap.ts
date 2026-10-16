import { createPrograms } from 'virtual:forgeax/plugin-programs/engine';
import { skeletalMotionPlugin } from '@forgeax/engine/animation/skeletal-motion';
import type { ExecutionBootstrapEntry } from '@forgeax/engine/app';
import { FixedUpdate, Update } from '@forgeax/engine/ecs';
import { physicsPlugin } from '@forgeax/engine/physics';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { loadSkeletalMotionScene } from './skeletal-motion-scene';

const entry: ExecutionBootstrapEntry = (data) => {
  if (
    data === null ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('channel' in data) ||
    typeof data.channel !== 'string'
  )
    throw new Error('skeletal motion Worker requires a channel');
  const channelName = data.channel;
  return {
    pluginPrograms: createPrograms(crypto.randomUUID(), 'skeletal-motion-worker', 1),
    configureRenderer(renderer) {
      const channel = new BroadcastChannel(channelName);
      let completedFrames = 0;
      let disposed = false;
      const nativeLosses: { reason: string; message: string }[] = [];
      const native = renderer.nativeDevice();
      if (!native.ok) throw native.error;
      void native.value.lost.then((info) => {
        nativeLosses.push({ reason: info.reason, message: info.message });
        if (disposed) return;
        channel.postMessage({
          kind: 'skeletal-motion-native-loss',
          rendererTimeOrigin: performance.timeOrigin,
          reason: info.reason,
          message: info.message,
        });
      });
      const unsubscribe = renderer.subscribe((event) => {
        if (event.kind === 'frame-submitted')
          void event.receipt.completed.then((result) => {
            if (result.ok) completedFrames++;
          });
      });
      channel.onmessage = async ({ data: message }) => {
        if (typeof message?.id !== 'string') return;
        if (message.command === 'recover') {
          try {
            await native.value.lost;
            const recovered = await renderer.recover();
            if (!recovered.ok) throw recovered.error;
          } catch (error) {
            channel.postMessage({ id: message.id, ok: false, error: String(error) });
            return;
          }
        }
        channel.postMessage({
          id: message.id,
          value: {
            completedFrames,
            state: renderer.state(),
            inspection: renderer.inspect(),
            nativeLosses,
            rendererTimeOrigin: performance.timeOrigin,
          },
        });
      };
      const dispose = renderer.dispose.bind(renderer);
      renderer.dispose = () => {
        disposed = true;
        unsubscribe();
        channel.close();
        return dispose();
      };
    },
    plugins: [
      skinningPlugin(),
      physicsPlugin('rapier-3d'),
      skeletalMotionPlugin({ physics: true }),
      {
        name: 'skeletal-motion-worker-scene',
        inject: ['world', 'assets', 'pluginPrograms', 'executionBootstrapHost'],
        async apply(ctx) {
          const subjects = await loadSkeletalMotionScene(ctx, 960 / 640).catch((error) => {
            console.error(
              'skeletal-motion-scene-bootstrap',
              JSON.stringify(
                error instanceof Error ? { message: error.message, stack: error.stack } : error,
              ),
            );
            throw error;
          });
          const port = ctx.executionBootstrapHost.port;
          if (port === undefined)
            throw new Error('skeletal motion Worker requires its session port');
          ctx.world.insertResource('SkeletalMotionProofPort', port);
          ctx.effect(() => () => ctx.world.removeResource('SkeletalMotionProofPort'));
          let pulse: string | undefined;
          ctx.world
            .addSystem(Update, {
              name: 'skeletal-motion-proof-pulse',
              queries: [],
              after: ['propagateTransforms'],
              fn() {
                if (pulse !== undefined) {
                  port.postMessage({ kind: 'skeletal-motion-pulse', id: pulse });
                  pulse = undefined;
                }
              },
            })
            .unwrap();
          const receive = ({ data: message }: MessageEvent) => {
            if (typeof message?.id !== 'string') return;
            try {
              if (message.command === 'pulse') pulse = message.id;
              else if (message.command === 'simulate') {
                subjects.controls.binding
                  .simulate(subjects.definition.physical?.bones.map((bone) => bone.target) ?? [])
                  .unwrap();
              } else if (message.command === 'rebind') subjects.restart();
              else if (message.command === 'poison')
                ctx.world
                  .addSystem(FixedUpdate, {
                    name: 'skeletal-motion-proof-failure',
                    queries: [],
                    after: ['composeSkeletalMotion'],
                    fn() {
                      throw new Error(
                        'skeletal motion proof requests the ordinary World rebuild boundary',
                      );
                    },
                  })
                  .unwrap();
              // Mutating commands acknowledge their intent. A fresh binding becomes
              // native-ready through the ordinary next FixedUpdate, not this message.
              port.postMessage({
                id: message.id,
                ok: true,
                value: message.command === 'snapshot' ? subjects.snapshot() : undefined,
              });
            } catch (error) {
              port.postMessage({ id: message.id, ok: false, error: String(error) });
            }
          };
          port.addEventListener('message', receive);
          port.start();
          ctx.effect(() => () => {
            port.removeEventListener('message', receive);
            ctx.world.removeSystem(Update, 'skeletal-motion-proof-pulse').unwrap();
          });
        },
      },
    ],
  };
};
export default entry;
