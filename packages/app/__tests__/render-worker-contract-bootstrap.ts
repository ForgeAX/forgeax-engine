import { Update } from '@forgeax/engine-ecs';
import type { RenderFeature } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';
import baseEntry from './render-worker-bootstrap';

const entry: ExecutionBootstrapEntry = async (data) => {
  const options = data as { stallMs?: number; cleanupMs?: number; cleanupChannel?: string; fail?: boolean; holdFirstCompletion?: boolean };
  const base = await baseEntry(1);
  let tick = 0;
  let marker = 0;
  const frameData = { tick: 0, marker: 0 };
  let port: MessagePort | undefined;
  const feature: RenderFeature<{ tick: number; marker: number }> = {
    identity: 'frame-contract-witness',
    extract: () => {
      const value = Object.assign(frameData, { tick, marker });
      port?.postMessage({ kind: 'sealed', ...value });
      return ok(value);
    },
    plan: (value) => ok({ work: [{ scope: 'frame', resources: [], passes: [] }], sourceFeedback: value }),
    onSourceFrameSubmitted: (_data, feedback) => port?.postMessage({ kind: 'feedback', value: feedback }),
  };
  return {
    ...base,
    features: [feature as RenderFeature<unknown>],
    configureRenderer(renderer) {
      const draw = renderer.draw.bind(renderer);
      const witness = options.holdFirstCompletion ? new BroadcastChannel(options.cleanupChannel!) : undefined;
      let releaseFirst: (() => void) | undefined;
      const firstCompletion = new Promise<void>((resolve) => { releaseFirst = resolve; });
      if (witness !== undefined) {
        witness.onmessage = (event) => {
          if (event.data.kind === 'release-first-frame') releaseFirst?.();
        };
        const dispose = renderer.dispose.bind(renderer);
        renderer.dispose = () => { witness.close(); return dispose(); };
      }
      let first = true;
      renderer.draw = (request) => {
        if (options.fail) throw Object.assign(new Error('Injected deterministic producer failure'), {
          code: 'fixture-contract-invalid', expected: 'valid fixture data', hint: 'repair the fixture producer', detail: { subject: 'fixture' },
        });
        const result = draw(request);
        if (!result.ok) return result;
        const receipt = result.value;
        if (witness !== undefined) void receipt.completed.then((completion) => {
          witness.postMessage({ kind: completion.ok ? 'gpu-completed' : 'gpu-failed', tick: receipt.frameId });
        });
        if (!first || (!options.stallMs && !options.holdFirstCompletion)) return result;
        first = false;
        const gate = options.holdFirstCompletion ? firstCompletion : new Promise((resolve) => setTimeout(resolve, options.stallMs));
        const completed = Promise.all([receipt.completed, gate]).then(([result]) => result);
        return ok({ ...result.value, completed });
      };
    },
    plugins: [...(base.plugins ?? []), {
      name: 'frame-contract-witness', inject: ['world', 'executionBootstrapHost'],
      apply(ctx) {
        port = ctx.executionBootstrapHost.port;
        const witness = new BroadcastChannel(options.cleanupChannel ?? 'missing-cleanup-witness');
        ctx.world.addSystem(Update, { name: 'contract-tick', queries: [], fn: () => { marker = ++tick; } }).unwrap();
        const receive = (event: MessageEvent) => {
          if (event.data === 'mutate-sealed-source') {
            // Cross an await exactly like an admitted asynchronous inspection.
            void Promise.resolve().then(() => { marker = frameData.marker = 999; port?.postMessage({ kind: 'mutated', tick, marker }); });
          }
        };
        port?.addEventListener('message', receive);
        return async () => {
          witness.postMessage({ kind: 'cleanup-started' });
          await new Promise((resolve) => setTimeout(resolve, options.cleanupMs ?? 25));
          ctx.world.removeSystem(Update, 'contract-tick').unwrap();
          port?.removeEventListener('message', receive);
          witness.postMessage({ kind: 'cleanup-completed' });
          witness.close();
        };
      },
    }],
  };
};
export default entry;
