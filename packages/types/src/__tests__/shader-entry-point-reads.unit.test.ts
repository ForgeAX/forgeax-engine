import { describe, expect, it } from 'vitest';
import { isShaderEntryPointReads } from '../runtime-contracts.js';

const table = () => [
  {
    name: 'fs_main',
    stage: 'fragment',
    bindings: [
      { group: 0, binding: 1, fields: ['color'] },
      { group: 1, binding: 0 },
    ],
  },
];

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

describe('isShaderEntryPointReads', () => {
  it('accepts a shared frozen table on every check', () => {
    const shared = deepFreeze(table());
    expect(isShaderEntryPointReads(shared)).toBe(true);
    expect(isShaderEntryPointReads(shared)).toBe(true);
  });

  it('rechecks a mutable table that changed after it was accepted', () => {
    const mutable = table();
    expect(isShaderEntryPointReads(mutable)).toBe(true);
    (mutable[0]?.bindings as unknown[]).push({ group: 0, binding: 1 });
    expect(isShaderEntryPointReads(mutable)).toBe(false);
    // A frozen table whose nested fields stay writable is rechecked as well.
    const shallow = table();
    Object.freeze(shallow);
    Object.freeze(shallow[0]);
    expect(isShaderEntryPointReads(shallow)).toBe(true);
    shallow[0]?.bindings[0]?.fields?.push('color');
    expect(isShaderEntryPointReads(shallow)).toBe(false);
  });

  it('rejects an invalid frozen table on every check', () => {
    const invalid = deepFreeze([{ name: 'main', stage: 'geometry', bindings: [] }]);
    expect(isShaderEntryPointReads(invalid)).toBe(false);
    expect(isShaderEntryPointReads(invalid)).toBe(false);
  });
});
