import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readShader(name: string): Promise<string> {
  return readFile(new URL(`../${name}`, import.meta.url), 'utf8');
}

describe('DirectLightSlot WGSL ABI', () => {
  it('declares the canonical six-row 96-byte slot', async () => {
    const common = await readShader('common.wgsl');
    const match = common.match(/struct DirectLightSlot\s*\{([\s\S]*?)\};/);

    expect(match).not.toBeNull();
    const struct = match?.[1] ?? '';
    expect(struct.match(/vec4<f32>/g)).toHaveLength(4);
    expect(struct.match(/vec4<u32>/g)).toHaveLength(2);
    expect(struct).toContain('row0');
    expect(struct).toContain('row1');
    expect(struct).toContain('row2');
    expect(struct).toContain('row3');
    expect(struct).toContain('metadata : vec4<u32>');
    expect(common).not.toContain('struct DirectLightArray');
    expect(common).not.toContain('array<DirectLightSlot, 4>');
    expect(common).toContain('@group(0) @binding(0)');
  });

  it('keeps the slot type owned by the unified Cluster shader consumer', async () => {
    const common = await readShader('common.wgsl');
    const standard = await readShader('standard-surface.wgsl');
    const clustered = await readShader('standard-cluster.wgsl');

    expect(common).toContain('struct DirectLightSlot');
    expect(standard).not.toContain('DirectLightSlot');
    expect(standard).not.toContain('pointLightsBuffer');
    expect(standard).not.toContain('spotLightsBuffer');
    expect(clustered).toContain('DirectLightSlot');
    expect(clustered).toContain('array<DirectLightSlot, 256>');
    expect(clustered).not.toContain('struct LightSlot');
  });
});
