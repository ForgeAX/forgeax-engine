import { APP_PHASE_CATALOG } from '../../packages/app/dist/index.mjs';
import { createProfiler } from '../../packages/profiler/dist/index.mjs';
import { RENDER_PHASE_CATALOG } from '../../packages/render/dist/index.mjs';

function arraysEqual(expected, actual) {
  return (
    expected.length === actual.length && expected.every((phase, index) => phase === actual[index])
  );
}

function sourceDifference(source, expected, actual) {
  return {
    source,
    expected: [...expected],
    actual: [...actual],
  };
}

export function comparePhaseCatalogs(expected, actual) {
  const differences = [];
  for (const source of ['app', 'render']) {
    const expectedPhases = expected[source];
    const actualPhases = actual[source];
    if (!arraysEqual(expectedPhases, actualPhases)) {
      differences.push(sourceDifference(source, expectedPhases, actualPhases));
    }
  }
  return {
    status: differences.length === 0 ? 'pass' : 'fail',
    source: 'AppPhaseCatalog + RenderPhaseCatalog',
    expected,
    actual,
    differences,
  };
}

export function readPhaseCatalogRelation() {
  const expected = {
    app: [...APP_PHASE_CATALOG],
    render: [...RENDER_PHASE_CATALOG],
  };
  const profiler = createProfiler();
  const appRegistration = profiler.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  const renderRegistration = profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG);
  const duplicateRegistration = profiler.registerPhaseCatalog('app', APP_PHASE_CATALOG);
  const relation = comparePhaseCatalogs(expected, profiler.phaseCatalog);
  if (appRegistration.ok && renderRegistration.ok && !duplicateRegistration.ok) return relation;
  return {
    ...relation,
    status: 'fail',
    differences: [
      ...relation.differences,
      {
        source: 'profiler',
        expected: ['single owner registration'],
        actual: ['duplicate accepted'],
      },
    ],
  };
}

export function formatRelationReport(relation) {
  return {
    benchmark: 'profiler-phase-catalog',
    relation,
    verdict: relation.status === 'pass' ? 'pass' : 'fail',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const relation = readPhaseCatalogRelation();
  process.stdout.write(`${JSON.stringify(formatRelationReport(relation))}\n`);
  if (relation.status !== 'pass') process.exitCode = 1;
}
