import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { rayShaderTestImports } from './ray-shader-imports.fixture';

function property(node: ts.Node, name: string): ts.Expression {
  if (!ts.isObjectLiteralExpression(node)) throw new Error(`Expected object for ${name}`);
  const value = node.properties.find(
    (item) => ts.isPropertyAssignment(item) && item.name.getText() === name,
  );
  if (!value || !ts.isPropertyAssignment(value)) throw new Error(`Missing ${name}`);
  return value.initializer;
}

function actualCosineConsumer() {
  const path = new URL('screen-probe-sample-cosine.dawn.test.ts', import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const variables = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer)
      variables.set(node.name.getText(source), node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const template = variables.get('source');
  const groups = variables.get('consumerGroups');
  if (
    !template ||
    !ts.isTemplateExpression(template) ||
    !groups ||
    !ts.isArrayLiteralExpression(groups)
  )
    throw new Error('Actual cosine shader or consumer group is missing');
  expect(template.templateSpans).toHaveLength(1);
  expect(template.templateSpans[0]?.expression.getText(source)).toBe("read('ray-screen-probe')");
  const group = groups.elements[0];
  if (!group || !ts.isCallExpression(group) || !group.arguments[0])
    throw new Error('Missing actual group0');
  const entries = property(group.arguments[0], 'entries');
  if (!ts.isArrayLiteralExpression(entries)) throw new Error('Missing group0 entries');
  return {
    suffix: template.templateSpans[0]?.literal.text ?? '',
    bindings: entries.elements.map((entry) => Number(property(entry, 'binding').getText(source))),
  };
}

it('binds every actual Naga-active input of the controlled cosine query', async () => {
  const fixture = actualCosineConsumer();
  const raw = readFileSync(
    new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
    'utf8',
  );
  const result = (
    await compileShader(raw + fixture.suffix, {
      id: 'actual-cosine-query-layout',
      computeEntry: 'verifyActualCosines',
      imports: await rayShaderTestImports(),
    })
  ).unwrap();
  const active = result.reflection.boundGlobals.filter(
    (item) => item.group === 0 && (item.visibility & 4) !== 0,
  );
  expect(fixture.bindings).toEqual(active.map((item) => item.binding));
  expect(active.find((item) => item.binding === 0)?.span).toBe(SCREEN_PROBE_FRAME_BYTES);
  expect(active.find((item) => item.binding === 7)?.elementStride).toBe(SCREEN_PROBE_RECORD_BYTES);
});
