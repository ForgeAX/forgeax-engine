// Name component (built-in, runtime-owned) — schema literal + identity +
// AC-13 invariant + spawn/set fallback. Migrated from
// packages/ecs/src/__tests__/hierarchy.unit.test.ts (name-component +
// name-mutation paragraphs) by tweak-20260612-ecs-concept-compression: Name's
// authoritative location is now @forgeax/engine-runtime, not the ECS framework.

import { type SchemaOf, World } from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { Name } from '@forgeax/engine-scene';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('Name component --- schema literal (w2, AC-03 a/d)', () => {
  it('componentSchema(Name) deep-equals { value: "string" } (KD-4 single field)', () => {
    expect(componentSchema(Name)).toEqual({ value: 'string' });
    expect(Object.keys(componentSchema(Name))).toEqual(['value']);
  });

  it('componentSchema(Name).value preserved as literal "string", not widened', () => {
    type ValueField = SchemaOf<typeof Name>['value'];
    expectTypeOf<ValueField>().toEqualTypeOf<'string'>();
  });
});

describe('Name component --- identity (w2, AC-03 b)', () => {
  it('Name.name === "Name" (no Component suffix per AGENTS.md naming)', () => {
    expect(Name.name).toBe('Name');
  });
});

describe('Name component --- single-import surface (w2, AC-03 c / AC-11)', () => {
  it('Name resolves through the runtime barrel re-export', () => {
    expect(Name).toBeDefined();
    expect(typeof Name).toBe('object');
  });
});

describe('Name component --- AC-13 schema invariant (w20)', () => {
  it("componentSchema(Name)['value'] is the literal 'string'", () => {
    expect(componentSchema(Name).value).toBe('string');
    type ValueField = SchemaOf<typeof Name>['value'];
    expectTypeOf<ValueField>().toEqualTypeOf<'string'>();
  });

  it('world.get(e, Name).unwrap().value returns a native JS string at runtime', () => {
    const w = new World();
    const e = w.spawn({ component: Name, data: { value: 'Hero' } }).unwrap();
    const value = w.get(e, Name).unwrap().value;
    expect(typeof value).toBe('string');
    expect(value).toBe('Hero');
  });

  it('world.get(e, Name).unwrap().value infers as string at the type level', () => {
    const w = new World();
    const e = w.spawn({ component: Name, data: { value: 'X' } }).unwrap();
    const value = w.get(e, Name).unwrap().value;
    expectTypeOf(value).toEqualTypeOf<string>();
  });
});

describe('w10 --- Name spawn + read (AC-04 a)', () => {
  it('spawn with { value: "Player" } -> get returns native string "Player"', () => {
    const w = new World();
    const e = w.spawn({ component: Name, data: { value: 'Player' } }).unwrap();
    const got = w.get(e, Name);
    if (!got.ok) throw new Error('expected ok');
    expect(got.value.value).toBe('Player');
    expect(typeof got.value.value).toBe('string');
  });
});

describe('w10 --- Name rename via world.set (AC-04 b)', () => {
  it('world.set overwrites value; subsequent get returns the new string', () => {
    const w = new World();
    const e = w.spawn({ component: Name, data: { value: 'Player' } }).unwrap();
    w.set(e, Name, { value: 'Boss' }).unwrap();
    const got = w.get(e, Name);
    if (!got.ok) throw new Error('expected ok');
    expect(got.value.value).toBe('Boss');
    expect(typeof got.value.value).toBe('string');
  });

  it('successive sets each show through to the next read', () => {
    const w = new World();
    const e = w.spawn({ component: Name, data: { value: 'a' } }).unwrap();
    w.set(e, Name, { value: 'bb' }).unwrap();
    expect(w.get(e, Name).unwrap().value).toBe('bb');
    w.set(e, Name, { value: 'ccc' }).unwrap();
    expect(w.get(e, Name).unwrap().value).toBe('ccc');
  });
});

describe('w10 --- AC-06 spawn fallback (raw=undefined / null / number -> "")', () => {
  it('spawn with no data field reads as empty string', () => {
    const w = new World();
    const e = w.spawn({ component: Name, data: {} }).unwrap();
    const got = w.get(e, Name);
    if (!got.ok) throw new Error('expected ok');
    expect(got.value.value).toBe('');
    expect(typeof got.value.value).toBe('string');
  });

  it('spawn with data.value=null reads as empty string', () => {
    const w = new World();
    // @ts-expect-error AC-09 strict signature rejects null; runtime
    // fallback (AC-06) coerces null to '' — testing that runtime path.
    const e = w.spawn({ component: Name, data: { value: null } }).unwrap();
    const got = w.get(e, Name);
    if (!got.ok) throw new Error('expected ok');
    expect(got.value.value).toBe('');
    expect(typeof got.value.value).toBe('string');
  });

  it('spawn with data.value=<number> reads as empty string', () => {
    const w = new World();
    // @ts-expect-error AC-09 strict signature rejects number for `string` field;
    // runtime fallback (AC-06) coerces non-string to '' — testing that runtime path.
    const e = w.spawn({ component: Name, data: { value: 42 } }).unwrap();
    const got = w.get(e, Name);
    if (!got.ok) throw new Error('expected ok');
    expect(got.value.value).toBe('');
    expect(typeof got.value.value).toBe('string');
  });
});
