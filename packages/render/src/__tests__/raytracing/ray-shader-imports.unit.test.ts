import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { FIELD_VISIBILITY_BOUNDS_WGSL } from '../../../../shader/src/field-visibility-wgsl';
import { compileShader } from '../../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { worldTraversalWgsl } from '../../raytracing/world-traversal';
import { FIELD_SEGMENT_TEST_WGSL, rayShaderTestImports } from './ray-shader-imports.fixture';

it('uses the production import authority at every historical missing-import call site', () => {
  let count = 0;
  for (const [owner, expected] of [
    ['history', 1],
    ['interpolation', 1],
    ['order', 3],
    ['radiance-history', 1],
    ['ray-sequence', 1],
    ['reconstruction', 1],
    ['sample-cosine', 2],
    ['screen-origin', 1],
  ] as const) {
    const path = `screen-probe-${owner}.dawn.test.ts`;
    const source = ts.createSourceFile(
      path,
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
    );
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'compileShader'
      )
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls, path).toHaveLength(expected);
    for (const call of calls) {
      const options = call.arguments[1];
      expect(options && ts.isObjectLiteralExpression(options), path).toBe(true);
      if (!options || !ts.isObjectLiteralExpression(options)) throw new Error(path);
      const imports = options.properties.find(
        (value): value is ts.PropertyAssignment =>
          ts.isPropertyAssignment(value) && value.name.getText(source) === 'imports',
      );
      expect(imports?.initializer.getText(source), path).toBe('await rayShaderTestImports()');
      count++;
    }
  }
  expect(count).toBe(11);
});

it('matches the entire actual World receiver and hint prefix without accepting the obsolete seam', () => {
  const fixture = readFileSync(
    new URL('screen-probe-card-facing.dawn.test.ts', import.meta.url),
    'utf8',
  );
  expect(fixture).toMatch(/controlledCardFacingSource\(exact\)/);
  for (const traversal of ['global-sdf', 'ray-query'] as const) {
    const sw = traversal === 'global-sdf';
    const source = screenProbeWorldWgsl(traversal);
    const prefix = worldTraversalWgsl(traversal, false, sw, sw);
    expect(source.slice(0, prefix.length)).toBe(prefix);
    if (sw) expect(source.startsWith(worldTraversalWgsl(traversal))).toBe(false);
  }
});

it('fails closed when any required Screen composition module is absent', async () => {
  const builtin = await loadEngineShaderEntries();
  for (const missing of [
    'forgeax_view::common',
    'forgeax_pbr::gbuffer',
    'forgeax_depth_pyramid::sample',
    'forgeax_ray::irradiance_field_sample',
    'forgeax_ray::screen_candidate',
    'forgeax_ray::field_visibility',
  ]) {
    const imports: Record<string, string> = { ...(await rayShaderTestImports()) };
    delete imports[missing];
    const result = await compileShader(builtin.rayScreenProbe.source, {
      id: `screen-required-import-${missing}`,
      imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    });
    expect(result.ok, missing).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(missing);
  }
});

it('composes both real Field visibility controls through the production import authority', async () => {
  const imports = await rayShaderTestImports();
  expect(imports['forgeax_ray::field_visibility']).toBe(FIELD_VISIBILITY_BOUNDS_WGSL);
  for (const visibility of [true, false]) {
    const compiled = await compileShader(FIELD_SEGMENT_TEST_WGSL, {
      id: `field-segment-${visibility}`,
      imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
    });
    expect(compiled.ok, compiled.ok ? undefined : compiled.error.message).toBe(true);
  }
});

it('composes the actual Screen source and all its entries with either visibility mode', async () => {
  const builtin = await loadEngineShaderEntries();
  const imports = await rayShaderTestImports();
  expect(imports['forgeax_ray::screen_candidate']).toBe(
    builtin.imports['forgeax_ray::screen_candidate'],
  );
  for (const visibility of [true, false]) {
    const compiled = await compileShader(builtin.rayScreenProbe.source, {
      id: `screen-probe-imports-${visibility}`,
      imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
    });
    expect(compiled.ok, compiled.ok ? undefined : compiled.error.message).toBe(true);
  }
});

it('rejects the historical Field import closure before any device is requested', async () => {
  const imports = await rayShaderTestImports();
  const stale: Record<string, string> = { ...imports };
  delete stale['forgeax_ray::field_visibility'];
  const result = await compileShader(FIELD_SEGMENT_TEST_WGSL, {
    id: 'field-segment-missing-visibility-control',
    imports: stale,
    defines: { IRRADIANCE_FIELD_VISIBILITY: true },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain('forgeax_ray::field_visibility');
});

it('rejects the historical Screen import closure before any device is requested', async () => {
  const builtin = await loadEngineShaderEntries();
  const imports = await rayShaderTestImports();
  const stale: Record<string, string> = { ...imports };
  delete stale['forgeax_ray::screen_candidate'];
  const result = await compileShader(builtin.rayScreenProbe.source, {
    id: 'screen-probe-missing-candidate-control',
    imports: stale,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain('forgeax_ray::screen_candidate');
});
