import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const buildSource = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');

test('Engine build uses direct Node spawning and preserves declaration stages', () => {
  const runStageStart = buildSource.indexOf('function runStage(');
  const runStageEnd = buildSource.indexOf('\n}', runStageStart);
  assert.ok(runStageStart >= 0 && runStageEnd > runStageStart);
  assert.match(buildSource.slice(runStageStart, runStageEnd), /shell: false/);

  const typesStart = buildSource.indexOf('async function buildTypes() {');
  const typesEnd = buildSource.indexOf('\n}', typesStart);
  assert.ok(typesStart >= 0 && typesEnd > typesStart);
  const typesBody = buildSource.slice(typesStart, typesEnd);
  const preflightAt = typesBody.indexOf("runStage('types-preflight'");
  const declarationsAt = typesBody.indexOf("runStage('types'");
  assert.ok(preflightAt >= 0 && declarationsAt > preflightAt);
  assert.match(
    typesBody,
    /runStage\('types', process\.execPath,\s*\[\s*resolve\(root, 'node_modules\/typescript\/bin\/tsc'\),\s*'-b',?\s*\]\)/,
  );

  assert.match(
    buildSource,
    /runStage\('producer', process\.execPath, \['scripts\/build-shared-inputs\.mjs'/,
  );
  assert.match(
    buildSource,
    /await \(engineTypes \?\? buildTypes\(\)\);\s*await writeEngineBuildProvenance\(\);/,
  );
});
