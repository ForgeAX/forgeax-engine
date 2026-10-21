import { describe, expect, it } from 'vitest';
import {
  emit_reflection,
  parse,
  parseReflectionWire,
  specializeComputeEntries,
  validate,
} from '../index.js';

describe('Naga compute entry closure', () => {
  const source = `
    const count: u32 = 4u;
    @group(0) @binding(0) var<storage, read_write> data: array<u32>;
    @group(0) @binding(1) var<storage, read_write> unused: array<u32>;
    fn helper(v: u32) -> u32 { return v * 7u; }
    @compute @workgroup_size(8) fn scan(@builtin(global_invocation_id) id: vec3u) {
      data[id.x] = helper(count);
    }
    @compute @workgroup_size(1) fn effect() { unused[0] = 89u; }
  `;
  it('retains reachable helpers, constants, bindings and workgroup size while removing other entries', async () => {
    const projected = await specializeComputeEntries(source, ['scan']);
    if (!projected.ok) throw projected.error;
    const entry = projected.value[0];
    expect(entry?.entryPoint).toBe('scan');
    const code = entry?.source ?? '';
    expect(code).toContain('helper');
    expect(code).toContain('const count');
    expect(code).toContain('@workgroup_size(8, 1, 1)');
    expect(code).not.toContain('effect');
    expect(code).not.toContain('unused');
    const parsed = await parse(code);
    if (!parsed.ok) throw parsed.error;
    const checked = await validate(parsed.value);
    if (!checked.ok) throw checked.error;
    try {
      const reflected = await emit_reflection(checked.value, '{}');
      if (!reflected.ok) throw reflected.error;
      const wire = parseReflectionWire(reflected.value);
      expect(wire.boundGlobals).toHaveLength(1);
      expect(wire.boundGlobals[0]).toMatchObject({ group: 0, binding: 0 });
    } finally {
      checked.value.free();
    }
  });
  it('keeps exact source for override contracts, including dynamic workgroup sizes and unused constants', async () => {
    const original =
      source
        .replace('const count', 'override count')
        .replace('@workgroup_size(8)', '@workgroup_size(count)') +
      '\noverride unusedConstant: u32 = 5u;';
    const result = await specializeComputeEntries(original, ['scan']);
    if (!result.ok) throw result.error;
    expect(result.value).toEqual([{ entryPoint: 'scan', source: original }]);
  });
  it('rejects missing entries and does not project a graphics entry as compute', async () => {
    expect((await specializeComputeEntries(source, ['missing'])).ok).toBe(false);
    expect(
      (
        await specializeComputeEntries(
          '@vertex fn main()->@builtin(position)vec4f{return vec4f();}',
          ['main'],
        )
      ).ok,
    ).toBe(false);
    expect((await specializeComputeEntries('invalid WGSL', ['scan'])).ok).toBe(false);
  });
});
