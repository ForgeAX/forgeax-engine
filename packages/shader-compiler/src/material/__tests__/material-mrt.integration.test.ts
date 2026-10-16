import type { MaterialColorOutput } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook';
import { buildMaterialSourceCatalog } from '../source-catalog';

const source = `#define_import_path test::mrt
struct Outputs { @location(0) color: vec4<f32>, @location(1) id: u32, @location(2) mask: vec4<f32> }
@vertex fn vs_main(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(p, 1.0); }
@fragment fn fs_main() -> Outputs { return Outputs(vec4<f32>(1.0), 123456789u, vec4<f32>(0.5)); }
`;
const outputs = [
  { name: 'color', format: 'rgba16float' },
  { name: 'objectId', format: 'r32uint' },
  { name: 'mask', format: 'rgba8unorm', writeMask: 1 },
] as const satisfies readonly MaterialColorOutput[];
const sources = buildMaterialSourceCatalog({ engine: [], project: [{ path: 'mrt.wgsl', source }] });
if (!sources.ok) throw sources.error;
const cook = (declaration: readonly MaterialColorOutput[] = outputs, name = 'Forward') =>
  cookMaterialAsset({
    material: 'mrt',
    table: {
      mrt: {
        kind: 'material',
        passes: [{ name, program: { module: 'test::mrt' }, outputs: declaration }],
      },
    },
    sources: sources.value,
  });
describe('public MRT material cooking', () => {
  it('refuses color outputs when the selected pass has no fragment entry', async () => {
    expect((await cook(outputs, 'Depth')).ok).toBe(false);
  });
  it('preserves named mixed-format outputs in the cooked contract', async () => {
    const cooked = await cook();
    if (!cooked.ok) throw cooked.error;
    const result = cooked.value;
    expect(result.resolved.asset.passes?.[0]?.outputs).toEqual(outputs);
  });
  it.each([
    outputs.slice(0, 2),
    [outputs[0], { name: 'objectId', format: 'r32float' }, outputs[2]],
    [
      outputs[0],
      {
        name: 'objectId',
        format: 'r32uint',
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
      },
      outputs[2],
    ],
    [outputs[0], { ...outputs[1], name: 'color' }, outputs[2]],
  ] as readonly (readonly MaterialColorOutput[])[])('refuses an incompatible declaration %j', async (...declaration) => {
    // Vitest spreads each array case into positional arguments.
    expect((await cook(declaration as readonly MaterialColorOutput[])).ok).toBe(false);
  });
});
