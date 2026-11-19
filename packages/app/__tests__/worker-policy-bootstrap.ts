import { Update } from '@forgeax/engine-ecs';
import { defineSharedKernel } from '@forgeax/engine-ecs/shared';
import type { RenderFeature } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';
import baseEntry from './render-worker-bootstrap';
import kernelModule, { WorkerCounter } from './worker-policy-kernel';

const entry: ExecutionBootstrapEntry = async (data) => {
  const base = await baseEntry(1);
  let counter = () => 0;
  let port: MessagePort | undefined;
  const feature: RenderFeature<number> = {
    identity: 'worker-policy-counter',
    extract: () => {
      const value = counter();
      port?.postMessage({ kind: 'kernel-sealed', value });
      return ok(value);
    },
    plan: (value) =>
      ok({ work: [{ scope: 'frame', resources: [], passes: [] }], sourceFeedback: value }),
    onSourceFrameSubmitted: (_data, value) => port?.postMessage({ kind: 'kernel-feedback', value }),
  };
  return {
    ...base,
    features: [feature as RenderFeature<unknown>],
    plugins: [
      ...(base.plugins ?? []),
      {
        name: 'worker-policy-counter',
        inject: ['world', 'executionBootstrapHost'],
        apply(ctx) {
          port = ctx.executionBootstrapHost.port;
          const entities = Array.from({ length: 8192 }, () =>
            ctx.world.spawn({ component: WorkerCounter, data: { value: 0, fail: 0 } }).unwrap(),
          );
          const first = entities[0];
          if (first === undefined) throw new Error('counter fixture is empty');
          counter = () => ctx.world.get(first, WorkerCounter).unwrap().value;
          const moduleUrl =
            data === 'invalid-kernel'
              ? 'data:text/javascript,export default {}'
              : new URL(
                  data === 'delayed-kernel'
                    ? './worker-policy-delayed-kernel.ts'
                    : './worker-policy-kernel.ts',
                  import.meta.url,
                ).href;
          const kernel = defineSharedKernel(moduleUrl, {
            ...kernelModule,
            name: 'worker-policy-counter',
            minimumRows: 1,
          });
          ctx.world.addSystem(Update, kernel).unwrap();
          const receive = (event: MessageEvent) => {
            if (event.data === 'poison-kernel')
              ctx.world.set(first, WorkerCounter, { fail: 1 }).unwrap();
          };
          port?.addEventListener('message', receive);
          return () => {
            port?.removeEventListener('message', receive);
            ctx.world.removeSystem(Update, kernel).unwrap();
            for (const entity of entities) ctx.world.despawn(entity).unwrap();
          };
        },
      },
    ],
  };
};
export default entry;
