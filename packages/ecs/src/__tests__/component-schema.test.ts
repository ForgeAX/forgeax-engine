import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { assertComponentStorage, componentDefinition, deepFreeze } from '../component-schema';

describe('component schema contract', () => {
  it('deep freezes nested field facts and owner defaults', () => {
    const component = defineComponent('SchemaFreeze', {
      mode: { type: 'enum', default: 1, labels: { idle: 0, run: 1 } },
      payload: { type: 'array<f32, 2>', default: [1, 2] as never },
    });

    expect(Object.isFrozen(component.fields)).toBe(true);
    expect(Object.isFrozen(component.fields.mode)).toBe(true);
    expect(Object.isFrozen(component.fields.mode?.labels)).toBe(true);
    const defaults = componentDefinition(component).defaults;
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults?.payload)).toBe(true);
  });

  it('keeps the public token surface to name, fields, and storage', () => {
    const component = defineComponent('ComponentSurface', { value: 'f32' });
    expect(Object.keys(component)).toEqual(['name', 'fields', 'storage']);
    expect(Reflect.ownKeys(component)).toEqual(['name', 'fields', 'storage']);
    expect(Object.getPrototypeOf(component)).toBe(Object.prototype);
    expect('schema' in component).toBe(false);
    expect('id' in component).toBe(false);
    expect('defaults' in component).toBe(false);
    expect('toSchemaJSON' in component).toBe(false);
  });

  it('accepts only the closed table/sparse storage vocabulary', () => {
    expect(() => assertComponentStorage('table')).not.toThrow();
    expect(() => assertComponentStorage('sparse')).not.toThrow();
    expect(() => assertComponentStorage('columnar')).toThrow(/Expected 'table' or 'sparse'/);
    expect(deepFreeze({ nested: { value: 1 } }).nested).toEqual({ value: 1 });
  });

  it('treats typed arrays and ArrayBuffer as immutable leaf projections', () => {
    const values = new Float32Array([1, 2]);
    const buffer = new ArrayBuffer(8);

    const projected = deepFreeze({ values, buffer });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(values)).toBe(false);
    expect(Object.isFrozen(buffer)).toBe(false);
    expect(values[0]).toBe(1);
    expect(buffer.byteLength).toBe(8);
  });

  it('rejects an invalid runtime storage value before registration', () => {
    expect(() => defineComponent('InvalidStorage', {}, { storage: 'columnar' as 'table' })).toThrow(
      /Expected 'table' or 'sparse'/,
    );
  });
});
