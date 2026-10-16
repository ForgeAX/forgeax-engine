import {
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionCapabilities,
  type ExecutionCapabilityName,
  probeExecutionCapabilities,
  selectExecutionWorkers,
} from '@forgeax/engine/app';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';

function caps(missing: readonly ExecutionCapabilityName[]): ExecutionCapabilities {
  const out = {} as Record<ExecutionCapabilityName, { available: boolean; reason: string }>;
  for (const name of EXECUTION_CAPABILITY_NAMES) {
    const available = !missing.includes(name);
    out[name] = { available, reason: available ? 'fl synthetic present' : 'fl synthetic missing' };
  }
  return out;
}

export default defineFeature({
  title: 'Auto tier selection',
  catalog: 'Auto tier selection',
  kind: 'probe',
  summary:
    'selectExecutionWorkers maps real or synthetic capability facts to per-Worker decisions; only `auto` downgrades, `true` fails with app-execution-worker-unavailable.',
  expect:
    'All checks pass: full capabilities enable all three Workers, missing facts downgrade auto with missingCapabilities, explicit true fails closed, and the real browser probe is consistent.',
  async setup({ world, canvas }) {
    spawnStage(world);
    const real = await probeExecutionCapabilities(canvas);
    return {
      checks() {
        const c = new CheckList();
        const all = selectExecutionWorkers({ capabilities: caps([]) });
        c.ok('all capabilities -> ok', all.ok);
        if (all.ok)
          c.ok(
            'all three enabled',
            all.value.engine.enabled && all.value.render.enabled && all.value.kernels.enabled,
          );
        const noGpu = selectExecutionWorkers({ capabilities: caps(['workerWebGpu']) });
        if (noGpu.ok) {
          c.equal('auto engine downgrades', noGpu.value.engine, {
            requested: 'auto',
            enabled: false,
            reason: 'capability-unavailable',
            missingCapabilities: ['workerWebGpu'],
          });
          c.equal('render follows engine', noGpu.value.render.reason, 'engine-disabled');
          c.equal('kernels follow engine', noGpu.value.kernels.reason, 'engine-disabled');
        } else c.ok('auto never errors', false, noGpu.error.code);
        const forced = selectExecutionWorkers({
          workers: { engine: true },
          capabilities: caps(['offscreenCanvas']),
        });
        c.equal(
          'explicit true fails closed',
          forced.ok ? 'ok' : forced.error.code,
          'app-execution-worker-unavailable',
        );
        if (!forced.ok) {
          const detail = forced.error.detail as {
            worker?: string;
            missingCapabilities?: readonly string[];
          };
          c.equal('failure names worker', detail.worker, 'engine');
          c.equal('failure names missing capability', detail.missingCapabilities, [
            'offscreenCanvas',
          ]);
        }
        const child = selectExecutionWorkers({
          workers: { engine: false, render: true },
          capabilities: caps([]),
        });
        c.equal(
          'render=true with engine=false fails',
          child.ok ? 'ok' : child.error.code,
          'app-execution-worker-unavailable',
        );
        const off = selectExecutionWorkers({ workers: { kernels: false }, capabilities: caps([]) });
        if (off.ok) c.equal('explicit false -> disabled', off.value.kernels.reason, 'disabled');
        const noIso = selectExecutionWorkers({ capabilities: caps(['crossOriginIsolated']) });
        if (noIso.ok) {
          c.ok(
            'non-isolated keeps engine+render',
            noIso.value.engine.enabled && noIso.value.render.enabled,
          );
          c.equal('non-isolated drops kernels', noIso.value.kernels.missingCapabilities, [
            'crossOriginIsolated',
          ]);
        }
        c.equal(
          'real probe covers every capability',
          Object.keys(real).sort(),
          [...EXECUTION_CAPABILITY_NAMES].sort(),
        );
        const live = selectExecutionWorkers({ capabilities: real });
        c.ok('real auto selection never errors', live.ok);
        if (live.ok) {
          const summary = EXECUTION_CAPABILITY_NAMES.map((n) => `${n}=${real[n].available}`).join(
            ' ',
          );
          c.ok(
            'real decisions consistent with facts',
            live.value.engine.enabled ===
              (real.worker.available &&
                real.offscreenCanvas.available &&
                real.workerWebGpu.available),
            `${summary} engine=${live.value.engine.reason}`,
          );
        }
        return c.items;
      },
    };
  },
});
