import { createProfiler, type Profiler } from '@forgeax/engine/profiler';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const CHILDREN = ['plan', 'filter', 'shadow-views'].map(
  (child) => `record/gpu-driven-prepare/${child}`,
);
let profiler: Profiler | undefined;

function sharedProfiler(): Profiler {
  profiler ??= createProfiler();
  return profiler;
}

export default defineFeature({
  title: 'GPU-driven prepare profiling',
  catalog: 'GPU-driven prepare profiling',
  kind: 'probe',
  summary:
    'At passes detail the renderer records record/gpu-driven-prepare under record, with plan/filter/shadow-views children (#3462; #3479 retired instances).',
  expect:
    'The render phase catalog lists the four phases; a passes capture records gpu-driven-prepare nested under record while owner detail omits it.',
  get appOptions() {
    return { profiler: sharedProfiler() };
  },
  async setup({ app, world, frames }) {
    spawnStage(world);
    for (let i = 0; i < 6; i++) {
      spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.5 + i * 0.08, 0.9, 1] }), {
        pos: [i - 2.5, 0.5, 0],
        scale: [0.6, 0.6, 0.6],
      });
    }
    const active = sharedProfiler();
    await frames(3);
    const passes = active.startCapture({ frameLimit: 4, eventLimit: 8192, detail: 'passes' });
    await frames(6);
    const passesCapture = passes.ok ? passes.value.finish() : undefined;
    const owner = active.startCapture({ frameLimit: 4, eventLimit: 8192 });
    await frames(6);
    const ownerCapture = owner.ok ? owner.value.finish() : undefined;
    const gpuDriven = app.renderer.inspect().renderScene.gpuDriven;
    return {
      checks() {
        const catalog = active.phaseCatalog.render;
        const items: FeatureCheck[] = [
          {
            name: 'catalog lists record/gpu-driven-prepare',
            ok: catalog.includes('record/gpu-driven-prepare'),
          },
          {
            name: 'catalog lists the three children',
            ok: CHILDREN.every((phase) => catalog.includes(phase)),
          },
        ];
        if (
          passesCapture === undefined ||
          !passesCapture.ok ||
          ownerCapture === undefined ||
          !ownerCapture.ok
        ) {
          items.push({ name: 'passes and owner captures finish', ok: false });
          return items;
        }
        const prepare = passesCapture.value.records.filter(
          (r) => r.kind === 'phase' && r.phase === 'record/gpu-driven-prepare',
        );
        items.push({
          name: 'passes detail records gpu-driven-prepare',
          ok: prepare.length > 0,
          detail: `records=${prepare.length} gpuDriven=${JSON.stringify(gpuDriven).slice(0, 160)}`,
        });
        items.push({
          name: 'gpu-driven-prepare nests under render/record',
          ok:
            prepare.length > 0 &&
            prepare.every(
              (r) =>
                r.kind === 'phase' && r.parentSource === 'render' && r.parentPhase === 'record',
            ),
        });
        items.push({
          name: 'owner detail omits gpu-driven-prepare',
          ok: !ownerCapture.value.records.some((r) =>
            r.phase.startsWith('record/gpu-driven-prepare'),
          ),
        });
        return items;
      },
    };
  },
});
