import { describe, expect, it } from 'vitest';
import { compileShader } from '../index.js';

describe('selected compute shader publication', () => {
  const source = `
    @group(0) @binding(0) var<storage, read_write> selectedData: array<u32>;
    @group(0) @binding(1) var<storage, read_write> unusedData: array<u32>;
    fn sharedValue(value: u32) -> u32 { return value * 7u; }
    @compute @workgroup_size(8, 1, 1)
    fn selected(@builtin(global_invocation_id) id: vec3<u32>) {
      selectedData[id.x] = sharedValue(6u);
    }
    @compute @workgroup_size(1, 1, 1)
    fn unselected() { unusedData[0] = 89u; }
  `;

  it('publishes only the selected entry and its reachable resources', async () => {
    const compiled = await compileShader(source, {
      id: 'forgeax_test::portable_compute',
      computeEntry: 'selected',
    });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.wgsl).toContain('fn selected(');
    expect(compiled.value.wgsl).toContain('sharedValue');
    expect(compiled.value.wgsl).not.toContain('unselected');
    expect(compiled.value.wgsl).not.toContain('unusedData');
    expect(compiled.value.bindings).toHaveLength(1);
    expect(compiled.value.manifestEntry.entryPoints).toEqual([
      { name: 'selected', stage: 'compute', bindings: [{ group: 0, binding: 0 }] },
    ]);
    expect(compiled.value.manifestEntry.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects a missing or non-compute entry before publication', async () => {
    const missing = await compileShader(source, {
      id: 'forgeax_test::missing_compute',
      computeEntry: 'missing',
    });
    expect(missing.ok).toBe(false);

    const graphics = await compileShader(
      '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
      { id: 'forgeax_test::graphics_as_compute', computeEntry: 'main' },
    );
    expect(graphics.ok).toBe(false);
  });

  it('rejects a mixed compute and graphics publication request', async () => {
    const compiled = await compileShader(source, {
      id: 'forgeax_test::mixed_stages',
      computeEntry: 'selected',
      renderEntries: { vertex: 'selected' },
    });
    expect(compiled.ok).toBe(false);
  });
});
