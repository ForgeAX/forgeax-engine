import { expect, it, vi } from 'vitest';
import { derive } from '../derive-paramschema';
import type { ParamSchemaEntry } from '../index';

it('preserves the three pre-entry length observations on an unadmitted cache hit', () => {
  const entry = { name: 'before', type: 'f32' as const };
  let armed = false;
  let reads = 0;
  const schema = new Proxy([entry], {
    get(target, key, receiver) {
      if (armed && key === 'length' && ++reads === 3) entry.name = 'after';
      return Reflect.get(target, key, receiver);
    },
  });
  const first = derive(schema);
  armed = true;
  const next = derive(schema);
  expect(entry.name).toBe('after');
  expect(next).not.toBe(first);
  expect(next.uboLayout.entries.map((field) => field.name)).toEqual(['after']);
});

it('does not observe entries before a third-length failure on a warm schema', () => {
  const events: string[] = [];
  let armed = false;
  let lengthReads = 0;
  const failure = new Error('third length read');
  const entry: ParamSchemaEntry = {
    get name() {
      if (armed) events.push('name');
      return 'value';
    },
    type: 'f32',
  };
  const schema = new Proxy([entry], {
    get(target, key, receiver) {
      if (armed && key === 'length') {
        events.push('length');
        if (++lengthReads === 3) throw failure;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  derive(schema);
  armed = true;
  expect(() => derive(schema)).toThrow(failure);
  expect(events).toEqual(['length', 'length', 'length']);
});

it('preserves independent evidence capacities and cache equality for a varying-length Proxy', () => {
  let armed = false;
  let reads = 0;
  const schema = new Proxy([{ name: 'value', type: 'f32' as const }], {
    get(target, key, receiver) {
      if (armed && key === 'length' && ++reads === 2) return 2;
      return Reflect.get(target, key, receiver);
    },
  });
  const previous = derive(schema);
  armed = true;
  expect(derive(schema)).toBe(previous);
});

it('rejects an invalid second capacity before reading the third length or entries', () => {
  let armed = false;
  let reads = 0;
  const events: string[] = [];
  const schema = new Proxy([{ name: 'value', type: 'f32' as const }], {
    get(target, key, receiver) {
      if (armed) {
        events.push(String(key));
        if (key === 'length' && ++reads === 2) return 0.5;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  derive(schema);
  armed = true;
  expect(() => derive(schema)).toThrow(RangeError);
  expect(events).toEqual(['length', 'length']);
});

it('preserves rejection after a shrink at the third pre-entry length read', () => {
  let armed = false;
  let reads = 0;
  const schema = new Proxy([{ name: 'value', type: 'f32' as const }], {
    get(target, key, receiver) {
      if (armed && key === 'length' && ++reads === 3) target.length = 0;
      return Reflect.get(target, key, receiver);
    },
  });
  const previous = derive(schema);
  armed = true;
  expect(previous.uboLayout.entries).toHaveLength(1);
  expect(() => derive(schema)).toThrow(TypeError);
});

it('retains allocation-free detached evidence on an ordinary unchanged schema', () => {
  const schema: ParamSchemaEntry[] = [{ name: 'value', type: 'f32' }];
  const previous = derive(schema);
  const freeze = vi.spyOn(Object, 'freeze');
  try {
    expect(derive(schema)).toBe(previous);
    expect(freeze).not.toHaveBeenCalled();
  } finally {
    freeze.mockRestore();
  }
});
