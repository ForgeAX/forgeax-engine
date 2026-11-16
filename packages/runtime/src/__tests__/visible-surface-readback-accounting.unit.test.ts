import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('validates four unread receipts independently from completed physical readbacks', () => {
  const source = readFileSync(
    new URL('visible-surface-replay.fixture.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const gate = parsed.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'verifyUnreadObservationAllocation',
  );
  if (gate === undefined) throw new Error('Missing original four-unread resource gate');
  const validate = new Function(
    'before',
    'unread',
    'expect',
    ts.transpile(gate.getText(parsed), { target: ts.ScriptTarget.ES2022 }) +
      '\nverifyUnreadObservationAllocation(before, unread);',
  );
  const before = {
    allocationCount: 10,
    liveCount: 0,
    liveByteLength: 0,
    mapCount: 10,
    readbackCount: 10,
  };
  const check = (readbackCount: number, overrides = {}) =>
    validate(
      before,
      {
        ...before,
        allocationCount: 14,
        readbackCount: 10 + readbackCount,
        mapCount: 10 + readbackCount,
        liveCount: 4 - readbackCount,
        liveByteLength: (4 - readbackCount) * 65536,
        ...overrides,
      },
      expect,
    );
  for (const completed of [0, 1, 2, 3, 4]) expect(() => check(completed)).not.toThrow();
  expect(() => check(3, { allocationCount: 13 })).toThrow();
  expect(() => check(3, { liveCount: 2 })).toThrow();
  expect(() => check(3, { liveByteLength: 0 })).toThrow();
  expect(() => check(5)).toThrow();
});
