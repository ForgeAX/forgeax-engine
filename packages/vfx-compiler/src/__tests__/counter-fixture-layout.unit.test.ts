import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PARTICLE_MANAGED_RUNTIME_V3 } from '../code-program.js';

const counterBody = /struct ForgeaxVfxCounters \{([\s\S]*?)\n\}/.exec(
  PARTICLE_MANAGED_RUNTIME_V3,
)?.[1];
if (counterBody === undefined) throw new Error('Missing managed counter ABI');
const counterFields = [...counterBody.matchAll(/(\w+): atomic<u32>,/g)].map((match) => match[1]);
const requiredBytes = counterFields.length * Uint32Array.BYTES_PER_ELEMENT;

function fixture(file: string): ts.SourceFile {
  const path = fileURLToPath(new URL(file, import.meta.url));
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function findExpression(
  source: ts.SourceFile,
  select: (node: ts.Node) => ts.Expression | undefined,
): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    const candidate = select(node);
    if (candidate !== undefined) {
      if (found !== undefined) throw new Error('Ambiguous fixture counter expression');
      found = candidate;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found === undefined) throw new Error('Missing fixture counter expression');
  return found;
}

function evaluate(source: ts.SourceFile, expression: ts.Expression, count = 0): Uint32Array {
  const text = expression.getText(source);
  if (!ts.isNewExpression(expression) || expression.expression.getText(source) !== 'Uint32Array')
    throw new Error('Expected the actual Uint32Array counter initializer');
  return new Function('count', `return ${text};`)(count) as Uint32Array;
}

function expectCounterData(data: Uint32Array, aliveCount: number): void {
  expect(data.byteLength, `Complete managed ABI: ${counterFields.join(', ')}`).toBe(requiredBytes);
  expect(data[0]).toBe(aliveCount);
  expect([...data.slice(1)]).toEqual(new Array(counterFields.length - 1).fill(0));
}

function checkEventCounterReadback(
  counterReadback: readonly number[],
  accepted: number,
  previousEvents: number,
): void {
  const source = fixture('event-capacity.dawn.test.ts');
  const statements: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'counts') {
      const initializer = node.initializer?.getText(source);
      statements.push(
        `const counts = ${initializer === 'await read(at(3))' ? 'counterReadback' : initializer};`,
      );
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      let expression: ts.Expression = node.expression;
      while (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression)) {
        if (
          ts.isCallExpression(expression) &&
          expression.expression.getText(source) === 'expect' &&
          /^(counts|counterReadback)(\[|$)/.test(expression.arguments[0]?.getText(source) ?? '')
        )
          statements.push(node.getText(source));
        expression = expression.expression;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  new Function('expect', 'counterReadback', 'accepted', 'previousEvents', statements.join('\n'))(
    expect,
    counterReadback,
    accepted,
    previousEvents,
  );
}

describe('real Dawn fixture counter bindings', () => {
  it('binds the complete counter buffer for the sort working set', () => {
    const source = fixture('sort-key-working-set.dawn.test.ts');
    const expression = findExpression(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'counters' &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer)
      )
        return node.initializer.arguments[0];
      return undefined;
    });
    expectCounterData(evaluate(source, expression), 0);
    expect(source.text).toContain('[3, counters]');
  });

  it('binds the complete counter buffer with the original trail alive count', () => {
    const source = fixture('trail-history.dawn.test.ts');
    const expression = findExpression(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'resources' &&
        node.initializer !== undefined &&
        ts.isAsExpression(node.initializer) &&
        ts.isArrayLiteralExpression(node.initializer.expression)
      ) {
        const counter = node.initializer.expression.elements[3];
        if (counter !== undefined && ts.isCallExpression(counter)) return counter.arguments[0];
      }
      return undefined;
    });
    expectCounterData(evaluate(source, expression), 1);
  });

  it.each([
    0, 1, 3, 32, 257,
  ])('resets every counter while preserving sort aliveCount %i', (count) => {
    const source = fixture('sort-key-working-set.dawn.test.ts');
    const expression = findExpression(source, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'device.queue.writeBuffer' &&
        node.arguments[0]?.getText(source) === 'counters'
      )
        return node.arguments[2];
      return undefined;
    });
    expectCounterData(evaluate(source, expression, count), count);
  });

  it('rejects the old six-word allocation against the current managed ABI', () => {
    expect(counterFields).toContain('gridEmissionCount');
    expect(new Uint32Array(6).byteLength).toBeLessThan(requiredBytes);
  });

  it('zero extending the old data preserves all counters and initializes the ABI tail', () => {
    const original = new Uint32Array([1, 2, 3, 4, 5, 6]);
    const complete = new Uint32Array(counterFields.length);
    complete.set(original);
    expect(complete.byteLength).toBe(requiredBytes);
    expect([...complete.slice(0, original.length)]).toEqual([...original]);
    expect([...complete.slice(original.length)]).toEqual([0]);
  });

  it('matches the production resource owner allocation', () => {
    const path = fileURLToPath(
      new URL('../../../vfx-render/src/feature/plan-declarations.ts', import.meta.url),
    );
    const source = readFileSync(path, 'utf8');
    const allocation = /export const COUNTERS_BYTES = (\d+);/.exec(source)?.[1];
    expect(Number(allocation)).toBe(requiredBytes);
  });

  it.each([
    0, 100,
  ])('binds the complete event counter ABI preserving previousEvents %i', (previousEvents) => {
    const source = fixture('event-capacity.dawn.test.ts');
    const expression = findExpression(source, (node) => {
      if (
        ts.isArrayLiteralExpression(node) &&
        node.elements[0]?.getText(source) === '3' &&
        node.elements[1] !== undefined &&
        ts.isCallExpression(node.elements[1]) &&
        node.elements[1].expression.getText(source) === 'make'
      )
        return node.elements[1].arguments[0];
      return undefined;
    });
    const data = new Function('previousEvents', `return ${expression.getText(source)};`)(
      previousEvents,
    ) as Uint32Array;
    expect(data.byteLength).toBe(requiredBytes);
    expect([...data.slice(0, 6)]).toEqual([1, 0, previousEvents, previousEvents, 0, 0]);
    expect([...data.slice(6)]).toEqual([0]);
  });

  it.each([
    { accepted: 2, previousEvents: 0 },
    { accepted: 2, previousEvents: 100 },
    { accepted: 0, previousEvents: 0 },
  ])('checks the actual event readback projection and its grid counter ($accepted, $previousEvents)', ({
    accepted,
    previousEvents,
  }) => {
    expect(counterFields[6]).toBe('gridEmissionCount');
    const data = [
      1 + accepted,
      0,
      previousEvents + accepted,
      previousEvents + accepted,
      accepted ? 1 : 2,
      accepted ? 1 : 2,
      0,
    ];
    checkEventCounterReadback(data, accepted, previousEvents);
    expect(() => checkEventCounterReadback(data.slice(0, 6), accepted, previousEvents)).toThrow();
    expect(() => checkEventCounterReadback([...data, 0], accepted, previousEvents)).toThrow();
    expect(() =>
      checkEventCounterReadback([...data.slice(0, 6), 1], accepted, previousEvents),
    ).toThrow();
    expect(() =>
      checkEventCounterReadback([99, ...data.slice(1)], accepted, previousEvents),
    ).toThrow();
  });
});
