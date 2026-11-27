import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { parse } from 'yaml';
import { workspaceDependencyNames, workspacePackages } from '../../../../scripts/build-task-cache.mjs';
import { buildPackageSelection } from '../../../../scripts/lib/build-package-selection.mjs';
import { prepareWorldParity, worldParityPreparationPlan } from '../prepare-world-parity-fixtures.mjs';

test('prepares ordinary public inputs and only the exact CPU Rust exporter', () => {
  const root = resolve(tmpdir(), 'parity-source');
  const plan = worldParityPreparationPlan(root, resolve(tmpdir(), 'parity-evidence'));
  assert.deepEqual(plan.commands[0].slice(1), ['scripts/build-packages.mjs',
    '--target=@forgeax/engine-geometry', '--target=@forgeax/engine-shader',
    '--target=@forgeax/engine-assets-runtime']);
  assert.deepEqual(plan.commands[1], ['cargo', 'test', '--locked', '--manifest-path',
    'packages/rhi-wgpu-native/Cargo.toml', '--features', 'conformance,reference', '--lib',
    'world_traversal_parity::export_authored_world_parity_inputs_for_this_host',
    '--', '--exact', '--test-threads', '1']);
});

test('clean-checkout canonical scene projection imports belong to the planned build closure', () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const plan = worldParityPreparationPlan(root, resolve(tmpdir(), 'parity-evidence'));
  const packages = workspacePackages(root);
  const known = new Set(packages.map((entry) => entry.manifest.name));
  const dependencies = new Map(packages.map((entry) => [entry.manifest.name,
    workspaceDependencyNames(entry.manifest, known)]));
  const selected = new Set(buildPackageSelection(packages, dependencies,
    plan.commands[0].slice(2)).map((entry) => entry.manifest.name));
  const path = resolve(root, 'packages/render/src/raytracing/scene-field-projection.ts');
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
  const required = source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly
      || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)
      && bindings.elements.every((entry) => entry.isTypeOnly)) return [];
    const name = statement.moduleSpecifier.text;
    return name.startsWith('@forgeax/') ? [name.split('/').slice(0, 2).join('/')] : [];
  });
  assert(required.includes('@forgeax/engine-assets-runtime'), 'Use the actual projection import');
  for (const name of required) assert(selected.has(name), `Clean parity input is not built: ${name}`);
  assert(!selected.has('@forgeax/engine-render'), 'Do not replace the narrow producer with full Render');
});

test('rejects an output inside the source checkout before any child', () => {
  const root = resolve(tmpdir(), 'parity-source');
  assert.throws(() => worldParityPreparationPlan(root, join(root, 'artifacts')), /outside/);
});

test('missing same-host paths fail before build, export or device creation', async () => {
  await assert.rejects(prepareWorldParity(resolve(tmpdir()), {}), /Provide both/);
});

test('rejects a linked output parent without touching the linked source', async () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'native-parity-path-'));
  const root = join(base, 'source');
  const parent = join(base, 'owned');
  mkdirSync(root);
  mkdirSync(parent);
  const alias = join(base, 'alias');
  symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const output = join(alias, 'attempt');
    await assert.rejects(prepareWorldParity(root, {
      FORGEAX_NATIVE_WORLD_PARITY_INPUTS: join(output, 'inputs.json'),
      FORGEAX_NATIVE_WORLD_PARITY_PAYLOAD: join(output, 'payload.json'),
    }), /canonical owned output parent/);
    assert.deepEqual(realpathSync(alias), realpathSync(parent));
  } finally {
    const absolute = realpathSync(base);
    assert(absolute.startsWith(`${realpathSync(tmpdir())}${sep}`));
    rmSync(absolute, { recursive: true });
  }
});

test('Native contract prepares same-host canonical inputs before the unchanged GPU owner', () => {
  const workflow = parse(readFileSync(new URL('../../../../.github/workflows/native-ray-query.yml',
    import.meta.url), 'utf8'));
  const owner = workflow.jobs['native-ray-query-contract'];
  assert.equal(owner['timeout-minutes'], 30);
  assert.equal(owner.strategy, undefined);
  const names = owner.steps.map((step) => step.name);
  const install = names.indexOf('Install workspace dependencies');
  const codec = names.indexOf('Prepare current Codec input for the canonical fixture producer');
  const prepare = names.indexOf('Prepare canonical World parity on this host before any device');
  const gpu = names.indexOf('Test native owner');
  assert(install >= 0 && install < codec && codec < prepare && prepare < gpu);
  assert.equal(owner.steps[codec].uses, './.github/actions/prepare-codec-wasm');
  assert.match(owner.steps[prepare].run,
    /pnpm exec node packages\/rhi-wgpu-native\/scripts\/prepare-world-parity-fixtures\.mjs\n?$/);
  assert.match(owner.steps[prepare].run, /FORGEAX_NATIVE_WORLD_PARITY_INPUTS=.*GITHUB_ENV/);
  for (const index of [codec, prepare])
    assert.equal(owner.steps[index].if, "steps.ci-repair.outputs.reused != 'true'");
  assert.match(owner.steps[gpu].run, /FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1/);
  assert.match(owner.steps[gpu].run,
    /--all-targets --features conformance,reference -- --test-threads 1/);
  for (const key of ['INPUTS', 'PAYLOAD'])
    assert(owner.steps[prepare].env[`FORGEAX_NATIVE_WORLD_PARITY_${key}`]
      .startsWith('${{ runner.temp }}/'));
  const main = parse(readFileSync(new URL('../../../../.github/workflows/ci.yml',
    import.meta.url), 'utf8'));
  const primary = Object.values(main.jobs).find((job) => job.name === 'primary-pnpm');
  const node = primary.steps.find((step) => step.run?.includes('native-wasm-admission.test.mjs'));
  assert(node.run.includes('packages/rhi-wgpu-native/scripts/__tests__/prepare-world-parity-fixtures.test.mjs'));
  assert(node.run.includes('scripts/lib/__tests__/git-http-environment.test.mjs'));
});
