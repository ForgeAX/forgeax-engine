import { AssetOutputProducerRegistry, buildScriptablePackWorklist } from '@forgeax/engine/import';
import { AssetGuid, definePack, PackageId } from '@forgeax/engine/pack/source';
import { loadScriptablePack } from '@forgeax/engine/pack/source-node';
import { err, ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { codeOf } from './support/fixture';

function id(value: string) {
  const parsed = PackageId.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

const FIRST = id('019f1a00-0000-7000-8000-0000000001c1');
const SECOND = id('019f1a00-0000-7000-8000-0000000001c2');
const LONE = id('019f1a00-0000-7000-8000-0000000001c3');

function producers(): AssetOutputProducerRegistry {
  const registry = new AssetOutputProducerRegistry();
  registry.register({
    kind: 'scene',
    version: 'lab',
    produce: ({ asset }) => ok({ payload: asset as never, refs: [], artifacts: {} }),
  });
  return registry;
}

const scene = () => ({ kind: 'scene' as const, entities: {} });

function reading(
  packageId: typeof FIRST,
  key: string,
  dependency?: ReturnType<typeof AssetGuid.derive>,
) {
  return definePack({
    schemaVersion: '2.0.0',
    packageId,
    build: async ({ readByGuid }) => {
      if (dependency !== undefined) {
        const read = await readByGuid(dependency);
        if (!read.ok) return err(read.error);
      }
      return ok({ [key]: scene() });
    },
  });
}

export default defineFeature({
  title: 'Import cycle/timeout detection',
  catalog: 'Import cycle/timeout detection',
  kind: 'headless',
  summary:
    'buildScriptablePackWorklist retries content reads until the worklist stops making progress, then reports a structured stall; loadScriptablePack bounds module load and build time and returns a structured timeout.',
  expect:
    'A forward read settles on the second pass; a two-Pack content-read cycle and a read of a GUID no subject produces are pack-content-dependency-stalled; a module that never loads and a build that never returns are pack-parameter-invalid with reason "timeout" and the phase.',
  async run(checks) {
    const forward = await buildScriptablePackWorklist({
      subjects: [
        {
          definition: reading(SECOND, 'scene/second', AssetGuid.derive(FIRST, 'scene/first')),
          sourcePath: 'assets/a-second.pack.ts',
        },
        { definition: reading(FIRST, 'scene/first'), sourcePath: 'assets/z-first.pack.ts' },
      ],
      outputs: producers(),
    });
    checks.ok('forward read settles', forward.ok, forward.ok ? undefined : codeOf(forward.error));
    if (forward.ok) checks.equal('forward read takes two passes', forward.value.iterations, 2);

    const cycle = await buildScriptablePackWorklist({
      subjects: [
        {
          definition: reading(FIRST, 'scene/first', AssetGuid.derive(SECOND, 'scene/second')),
          sourcePath: 'assets/first.pack.ts',
        },
        {
          definition: reading(SECOND, 'scene/second', AssetGuid.derive(FIRST, 'scene/first')),
          sourcePath: 'assets/second.pack.ts',
        },
      ],
      outputs: producers(),
    });
    checks.equal(
      'content-read cycle code',
      cycle.ok ? 'ok' : codeOf(cycle.error),
      'pack-content-dependency-stalled',
    );

    const orphan = await buildScriptablePackWorklist({
      subjects: [
        {
          definition: reading(LONE, 'scene/lone', AssetGuid.derive(FIRST, 'scene/nowhere')),
          sourcePath: 'assets/lone.pack.ts',
        },
      ],
      outputs: producers(),
    });
    checks.equal(
      'unsatisfiable read code',
      orphan.ok ? 'ok' : codeOf(orphan.error),
      'pack-content-dependency-stalled',
    );

    const disposed: string[] = [];
    const hung = await loadScriptablePack('assets/hung.pack.ts', {
      timeoutMs: 50,
      executor: {
        load: () => new Promise(() => {}),
        dispose: (reason: string) => void disposed.push(reason),
      },
    });
    const hungDetail = hung.ok
      ? undefined
      : (hung.error as { detail?: { reason?: string; phase?: string } }).detail;
    checks.equal(
      'hung module load code',
      hung.ok ? 'ok' : codeOf(hung.error),
      'pack-parameter-invalid',
    );
    checks.equal(
      'hung module load reason/phase',
      [hungDetail?.reason, hungDetail?.phase],
      ['timeout', 'module-load'],
    );
    checks.equal('timed-out executor disposed as timeout', disposed, ['timeout']);

    const slow = await loadScriptablePack('assets/slow.pack.ts', {
      buildTimeoutMs: 50,
      executor: {
        load: async () => ({
          default: definePack({
            schemaVersion: '2.0.0',
            packageId: LONE,
            build: () => new Promise(() => {}),
          }),
        }),
      },
    });
    checks.ok('slow module loads', slow.ok, slow.ok ? undefined : codeOf(slow.error));
    if (slow.ok) {
      const built = await (
        slow.value.build as (context: unknown) => Promise<{ ok: boolean; error?: unknown }>
      )({
        packageId: LONE,
        readByGuid: async () => err({ code: 'unused' }),
      });
      const detail = (built.error as { detail?: { reason?: string; phase?: string } } | undefined)
        ?.detail;
      checks.equal(
        'hung build code',
        built.ok ? 'ok' : codeOf(built.error),
        'pack-parameter-invalid',
      );
      checks.equal(
        'hung build reason/phase',
        [detail?.reason, detail?.phase],
        ['timeout', 'build'],
      );
    }
  },
});
