import { createProfiler, type Profiler, validateProfileCapture } from '@forgeax/engine/profiler';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const allocationReport = { profilerEventObjectAllocations: 0 };
let profiler: Profiler | undefined;

function sharedProfiler(): Profiler {
  profiler ??= createProfiler({ allocationReport });
  return profiler;
}

export default defineFeature({
  title: 'Bounded CPU Profiler',
  catalog: 'Bounded CPU Profiler',
  kind: 'probe',
  summary:
    'createProfiler passed to createApp records App and Render CPU phases inside frame and event limits.',
  expect:
    'A bounded capture is schema-valid with app/render phases; a tiny eventLimit reports overflow instead of complete.',
  get appOptions() {
    return { profiler: sharedProfiler() };
  },
  async setup({ world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.9, 0.3, 0.1, 1] }), {
      pos: [0, 0.6, 0],
    });
    const active = sharedProfiler();
    await frames(2);
    const started = active.startCapture({ frameLimit: 6, eventLimit: 4096 });
    await frames(10);
    const finished = started.ok ? started.value.finish() : undefined;
    const latestId = active.latestCapture()?.captureId;
    const overflowStart = active.startCapture({ frameLimit: 6, eventLimit: 4 });
    await frames(4);
    const overflow = overflowStart.ok ? overflowStart.value.finish() : undefined;
    return {
      checks() {
        const items = [];
        items.push({
          name: 'startCapture ok',
          ok: started.ok,
          detail: started.ok ? '' : started.error.code,
        });
        if (finished === undefined || !finished.ok) {
          items.push({
            name: 'finish ok',
            ok: false,
            detail: finished?.error.code ?? 'no session',
          });
          return items;
        }
        const capture = finished.value;
        const phases = capture.records.filter((record) => record.kind === 'phase');
        const frameIds = new Set(capture.records.map((record) => record.frameId));
        items.push({
          name: 'capture validates against schema',
          ok: validateProfileCapture(capture).ok,
        });
        items.push({
          name: 'app frame-total recorded',
          ok: phases.some((r) => r.source === 'app' && r.phase === 'frame-total'),
        });
        items.push({
          name: 'render record phase recorded',
          ok: phases.some((r) => r.source === 'render' && r.phase === 'record'),
        });
        items.push({
          name: 'frames bounded by frameLimit 6',
          ok: frameIds.size > 0 && frameIds.size <= 6,
          detail: `frames=${frameIds.size}`,
        });
        items.push({
          name: 'complete capture reports status complete',
          ok: capture.completeness.status === 'complete',
          detail: capture.completeness.status,
        });
        items.push({
          name: 'latestCapture is the finished artifact',
          ok: latestId === capture.captureId,
          detail: String(latestId),
        });
        items.push({
          name: 'no active session after finish',
          ok: active.activeSession() === undefined,
        });
        const overflowCapture = overflow?.ok ? overflow.value : undefined;
        items.push({
          name: 'eventLimit 4 reports overflow with dropped events',
          ok:
            overflowCapture?.completeness.status === 'overflow' &&
            overflowCapture.completeness.droppedEventCount > 0,
          detail:
            overflowCapture === undefined
              ? 'no overflow capture'
              : JSON.stringify(overflowCapture.completeness),
        });
        return items;
      },
    };
  },
});
