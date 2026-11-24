import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compileShader } from '@forgeax/engine-shader-compiler';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';

it('publishes one cached Generate closure beside the ordinary cache-free Screen program', async () => {
  const entries = await loadEngineShaderEntries(async (path) => {
    const suffix = path.replaceAll('\\', '/').split('/shader/src/')[1];
    if (suffix === undefined) throw new Error('Expected the owning Shader source');
    return readFile(new URL(`../../../shader/src/${suffix}`, import.meta.url), 'utf8');
  });
  const ordinary = entries.rayScreenProbe;
  const generate = entries.rayScreenProbeGenerate;
  expect(generate.source).toBe(ordinary.source);
  expect(generate.id).toBe(`${ordinary.id}?generate-visibility-cache`);
  expect(ordinary.defines?.IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE).toBe(false);
  expect(generate.defines?.IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE).toBe(true);
  const compile = (entry: typeof ordinary) =>
    compileShader(entry.source, {
      id: entry.id,
      imports: entries.imports,
      ...(entry.defines === undefined ? {} : { defines: entry.defines }),
    });
  const main = (await compile(ordinary)).unwrap();
  const cached = (await compile(generate)).unwrap();
  const mainEntries = main.reflection.entryPoints;
  const cachedEntries = cached.reflection.entryPoints;
  if (mainEntries === undefined || cachedEntries === undefined)
    throw new Error('Actual selected-entry reflection required');
  expect(cachedEntries.map((entry) => entry.name)).toEqual([
    'generateCachedProbeRays',
    'generateHistoryProbeRays',
  ]);
  expect(mainEntries.some((entry) => entry.name === 'integrateScreenProbes')).toBe(true);
  expect(main.wgsl).not.toContain('fieldProbeCacheEnabled');
  expect(cached.wgsl).toContain('fieldProbeCacheEnabled');
  expect(cachedEntries[0]?.bindings).toEqual(
    mainEntries.find((entry) => entry.name === 'generateProbeRays')?.bindings,
  );
  const guide = cachedEntries.find((entry) => entry.name === 'generateHistoryProbeRays');
  expect(
    guide?.bindings
      .filter((binding) => binding.group === 0)
      .map((binding) => binding.binding)
      .sort((a, b) => a - b),
  ).toEqual([0, 7, 9, 12, 16, 26, 35]);
  const hash = (code: string) => createHash('sha256').update(code).digest('hex');
  expect(hash(cached.wgsl)).not.toBe(hash(main.wgsl));
});

it('routes the private recipe through both maintained Engine publication paths', async () => {
  const text = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  const recipes: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(source) === 'eng' &&
      node.name.text === 'rayScreenProbeGenerate'
    )
      recipes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(recipes).toHaveLength(2);
  expect(recipes.some((node) => ts.isArrayLiteralExpression(node.parent))).toBe(true);
  expect(
    recipes.some(
      (node) =>
        ts.isCallExpression(node.parent) &&
        node.parent.expression.getText(source) === 'compileEngineEntry',
    ),
  ).toBe(true);
});
