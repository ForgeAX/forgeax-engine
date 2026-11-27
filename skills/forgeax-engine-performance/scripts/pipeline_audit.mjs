import { readFileSync } from 'node:fs';

function readSnapshot(path) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const evaluation = document.command === 'dev eval' ? document.value?.result : document;
  const result = typeof evaluation === 'string' ? JSON.parse(evaluation) : evaluation;
  const inspection = result?.ok === true ? result.value : result;
  if (
    typeof inspection !== 'object' ||
    inspection === null ||
    result?.ok === false ||
    (!('pipelineLibrary' in inspection) && !('shaderTemplates' in inspection))
  ) {
    throw new Error(`Expected Renderer inspection with pipeline or template evidence in ${path}`);
  }
  return { revision: document.value?.revision, inspection };
}

function counters(snapshot) {
  const { pipelineLibrary: library, shaderTemplates, engineShaderTemplates } = snapshot.inspection;
  return {
    templates: shaderTemplates?.templates,
    templateSelections: shaderTemplates?.selections,
    templateRequests: shaderTemplates?.requests,
    templateHits: shaderTemplates?.cacheHits,
    templateCompileMs: shaderTemplates?.compileMs,
    sourceMaterialCompiles: shaderTemplates?.sourceMaterialCompiles,
    engineSourceMaterialCompiles: engineShaderTemplates?.sourceMaterialCompiles,
    shaders: library?.shaders,
    renderPipelines: library?.renderPipelines,
    computePipelines: library?.computePipelines,
    pipelineHits: library?.pipelineHits,
    synchronousCreations: library?.synchronousCreations,
    asynchronousCreations: library?.asynchronousCreations,
    compilationCompleted: library?.compilationCompleted,
    failures: library?.failures,
  };
}

function requestWindow(before, after) {
  const earlier = before.inspection.pipelineLibrary?.runtimeRequests;
  const later = after.inspection.pipelineLibrary?.runtimeRequests;
  if (earlier === undefined || later === undefined) return { status: 'unavailable' };
  if (
    before.revision !== after.revision ||
    before.inspection.frame?.deviceGeneration !== after.inspection.frame?.deviceGeneration ||
    earlier.libraryId !== later.libraryId ||
    earlier.latestSequence > later.latestSequence ||
    earlier.observedAtMs > later.observedAtMs
  ) {
    return { status: 'different-device-or-session' };
  }
  const requests = later.requests.filter(({ sequence }) => sequence > earlier.latestSequence);
  const expected = later.latestSequence - earlier.latestSequence;
  const unidentified = requests.filter(({ pipeline }) => pipeline === null).length;
  return {
    status: requests.length === expected && unidentified === 0 ? 'complete' : 'partial',
    libraryId: later.libraryId,
    afterSequence: earlier.latestSequence,
    throughSequence: later.latestSequence,
    overwritten: later.overwritten,
    missingRequests: expected - requests.length,
    unidentified,
    requests,
  };
}

function selectedPrograms(snapshot) {
  return snapshot.inspection.shaderTemplates?.programs;
}

function compare(before, after) {
  const history = requestWindow(before, after);
  const baseline = counters(before);
  const current = counters(after);
  const earliestPrograms = selectedPrograms(before);
  const latestPrograms = selectedPrograms(after);
  const programKey = ({ identifier, definesKey }) => JSON.stringify([identifier, definesKey]);
  const oldKeys = new Set(earliestPrograms?.map(programKey));
  return {
    before: baseline,
    after: current,
    // Native counter deltas require the same library. Template cache lifetimes
    // are independent, so display its snapshots and selections separately.
    nativeDelta:
      history.libraryId === undefined
        ? undefined
        : Object.fromEntries(
            Object.keys(current)
              .filter(
                (name) =>
                  !name.startsWith('template') &&
                  typeof current[name] === 'number' &&
                  typeof baseline[name] === 'number',
              )
              .map((name) => [name, current[name] - baseline[name]]),
          ),
    newTemplateSelections:
      before.revision !== after.revision ||
      earliestPrograms === undefined ||
      latestPrograms === undefined
        ? undefined
        : latestPrograms.filter((program) => !oldKeys.has(programKey(program))),
    history,
    rasterPassRequests: after.inspection.rasterPassRequests,
  };
}

async function variantRoster(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.library?.schemaVersion !== 'shader-template-library/1')
    throw new Error('Expected a source-template shader manifest');
  const { supportedVariantDefines } = await import('../../../packages/shader/dist/index.mjs');
  return manifest.materialShaders.map(({ identifier, program }) => {
    const { axes } = manifest.library.programs[program];
    let legalSelections = 0;
    let coverageSelections = 0;
    for (const selection of supportedVariantDefines(axes)) {
      legalSelections++;
      if (selection.COVERAGE_ONLY === true) coverageSelections++;
    }
    return { identifier, axes, legalSelections, coverageSelections };
  });
}

const paths = process.argv.slice(2);
if (paths.length !== 2) {
  process.stderr.write(
    'Usage: node pipeline_audit.mjs <before.json> <after.json> | --roster <shader-manifest.json>\n',
  );
  process.exitCode = 1;
} else {
  try {
    const result =
      paths[0] === '--roster' ? await variantRoster(paths[1]) : compare(...paths.map(readSnapshot));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
