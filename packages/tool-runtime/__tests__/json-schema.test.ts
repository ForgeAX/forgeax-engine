import { expect, it } from 'vitest';
import { parseToolJsonSchema, toolJsonSchema } from '../src/json-schema.js';

it('enforces serialized array bounds before admitting nested items', () => {
  const schema = toolJsonSchema(JSON.parse('{"type":"object","properties":{"reads":{"type":"array","minItems":1,"maxItems":2,"items":{"type":"integer"}}}}'));
  expect(schema.parse({ reads: [1, 2] }).ok).toBe(true);
  expect(schema.parse({ reads: [] }).ok).toBe(false);
  expect(schema.parse({ reads: [1, 2, 3] })).toEqual({ ok: false, error: '$.reads: must contain at most 2 items' });
  expect(schema.parse({ reads: [1, '2'] }).ok).toBe(false);
});

it('compares JSON values by content for uniqueness, enums and constants', () => {
  const unique = toolJsonSchema(JSON.parse('{"type":"array","uniqueItems":true}'));
  expect(unique.parse(['first', 'second']).ok).toBe(true);
  expect(unique.parse(['first', 'first']).ok).toBe(false);
  expect(unique.parse([{ a: 1, b: [2] }, { b: [2], a: 1 }]).ok).toBe(false);
  expect(unique.parse([{ a: 1 }, { a: '1' }]).ok).toBe(true);
  expect(toolJsonSchema({ enum: [{ a: 1, b: [2] }] }).parse({ b: [2], a: 1 }).ok).toBe(true);
  expect(toolJsonSchema({ const: { a: 1, b: [2] } }).parse({ b: [2], a: 1 }).ok).toBe(true);
});


it('retains one serialized schema for description and parsing after author mutation', () => {
  const child = { type: 'integer' as const, minimum: 2 };
  const allowed = { count: 3 };
  const source = { type: 'object' as const, properties: { count: child }, required: ['count'], enum: [allowed] };
  const schema = toolJsonSchema(source);
  child.minimum = 10;
  source.required.length = 0;
  allowed.count = 9;
  for (const input of [{}, { count: 2 }, { count: 3 }, { count: 9 }]) {
    expect(schema.parse(input)).toEqual(parseToolJsonSchema(input, JSON.parse(schema.describe!)));
  }
  const numeric = { type: 'number' as const, minimum: 2 };
  const numberSchema = toolJsonSchema(numeric);
  numeric.minimum = 10;
  expect(numberSchema.parse(3).ok).toBe(true);
  expect(numberSchema.parse(1).ok).toBe(false);
});
