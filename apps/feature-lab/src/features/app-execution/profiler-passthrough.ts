import { createProfiler, validateProfileCapture } from '@forgeax/engine/profiler';
import { CheckList, defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const allocationReport = { profilerEventObjectAllocations: 0 };
const profiler = createProfiler({ allocationReport });

export default defineFeature({
  title: 'Optional CPU profiler passthrough',
  catalog: 'Optional CPU profiler passthrough',
  kind: 'probe',
  appOptions: { profiler },
  summary:
    'createApp(canvas, { profiler }) records App and Render phases only while a bounded capture is active; idle frames allocate nothing.',
  expect:
    'All checks pass: zero allocations before capture, a 6-frame capture finishes complete, validates, and contains app + render phase records; tiny eventLimit reports overflow.',
  setup({ world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.3, 0.5, 0.95, 1] }), {
      pos: [0, 0.5, 0],
    });
    let memo: Promise<readonly FeatureCheck[]> | undefined;
    return {
      checks() {
        memo ??= (async () => {
          const c = new CheckList();
          await frames(5);
          c.equal(
            'no profiler allocations while idle',
            allocationReport.profilerEventObjectAllocations,
            0,
          );
          const bad = profiler.startCapture({ frameLimit: 0, eventLimit: 10 });
          c.equal(
            'invalid limits rejected',
            bad.ok ? 'ok' : bad.error.code,
            'capture-boundary-invalid',
          );
          const started = profiler.startCapture({ frameLimit: 6, eventLimit: 4096 });
          c.ok('startCapture ok', started.ok);
          if (!started.ok) return c.items;
          await frames(10);
          const finished = started.value.finish();
          c.ok('finish ok', finished.ok);
          if (!finished.ok) return c.items;
          const capture = finished.value;
          c.equal('completeness', capture.completeness.status, 'complete');
          c.ok(
            'validateProfileCapture ok',
            validateProfileCapture(JSON.parse(JSON.stringify(capture))).ok,
          );
          const frameIds = new Set(capture.records.map((r) => (r as { frameId?: number }).frameId));
          c.ok('frames bounded by frameLimit', frameIds.size <= 6, `frames=${frameIds.size}`);
          const phases = new Set(
            capture.records.map(
              (r) => `${(r as { source?: string }).source}:${(r as { phase?: string }).phase}`,
            ),
          );
          c.ok('app frame-total recorded', phases.has('app:frame-total'), [...phases].join(' '));
          c.ok('app renderer-draw recorded', phases.has('app:renderer-draw'));
          c.ok(
            'render phases recorded',
            [...phases].some((p) => p.startsWith('render:')),
          );
          c.ok('phaseCatalog forwarded', capture.phaseCatalog.app.includes('world-update-primary'));
          const tiny = profiler.startCapture({ frameLimit: 4, eventLimit: 2 });
          if (tiny.ok) {
            await frames(6);
            const small = tiny.value.finish();
            c.equal(
              'tiny eventLimit -> overflow',
              small.ok ? small.value.completeness.status : small.error.code,
              'overflow',
            );
          } else c.ok('tiny capture started', false, tiny.error.code);
          return c.items;
        })();
        return memo;
      },
    };
  },
});
