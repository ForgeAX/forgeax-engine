import { describe, expect, it, vi } from 'vitest';
import { createToolRuntime, defineTool, isSerializableValue } from '../src/index.js';
import { validateMigrationPayload } from '../src/migration.js';

async function terminal(value: unknown) {
  const schema = { parse: (input: unknown) => ({ ok: true as const, value: input }) };
  const tool = defineTool({
    id: 'test.json', title: 'JSON', summary: 'Return portable data', realm: 'host',
    argsSchema: schema, resultSchema: schema, evidence: [],
  }, async () => ({ ok: true as const, value }));
  return createToolRuntime([tool]).run(tool, null).terminal;
}

describe('portable tool JSON admission', () => {
  it('accepts repeated acyclic data through terminal and migration boundaries', async () => {
    const child = { value: 1 };
    const value = { first: child, second: child, items: [child, child] };
    expect(isSerializableValue(value)).toBe(true);
    expect(validateMigrationPayload(value)).toEqual({ ok: true });
    expect(await terminal(value)).toMatchObject({ outcome: 'succeeded', result: value });
  });

  it('does not evaluate accessors at any portable value boundary', async () => {
    const getter = vi.fn(() => 'hidden execution');
    const value = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    expect(isSerializableValue(value)).toBe(false);
    expect(validateMigrationPayload(value).ok).toBe(false);
    expect(await terminal(value)).toMatchObject({
      outcome: 'failed', failure: { detail: { code: 'terminal-not-serializable' } },
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['sparse array', () => new Array(2)],
    ['array properties', () => Object.assign([1], { extra: 2 })],
    ['symbol properties', () => ({ [Symbol('hidden')]: 1 })],
    ['hidden properties', () => Object.defineProperty({}, 'value', { value: 1 })],
    ['cyclic record', () => { const value: { self?: unknown } = {}; value.self = value; return value; }],
    ['non-finite value', () => ({ value: Number.NaN })],
    ['class instance', () => new Date(0)],
  ])('rejects %s before terminal publication', async (_label, make) => {
    const value = make();
    expect(isSerializableValue(value)).toBe(false);
    expect(await terminal(value)).toMatchObject({ outcome: 'failed' });
  });

  it('admits null-prototype JSON records', async () => {
    const value = Object.assign(Object.create(null), { key: 'value' });
    expect(isSerializableValue(value)).toBe(true);
    expect(await terminal(value)).toMatchObject({ outcome: 'succeeded', result: { key: 'value' } });
  });
});
