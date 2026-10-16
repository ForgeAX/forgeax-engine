// wgsl-entrypoints.test.ts — extract @vertex/@fragment/@compute entry fn names.
//
// The Pipeline panel shows the WHOLE shader module source, which can bundle
// several entry points (e.g. fs_main forward + fs_gbuffer deferred). Listing them
// lets the UI mark which one the selected draw actually runs, so the unused
// gbuffer entry does not read as "this draw outputs a gbuffer".

import { describe, expect, it } from 'vitest';
import { findWgslEntryPoints } from '../components/wgsl-entrypoints';

describe('findWgslEntryPoints', () => {
  it('finds a single fragment entry', () => {
    const src = '@fragment\nfn fs_main() -> @location(0) vec4<f32> { return vec4(1.0); }';
    expect(findWgslEntryPoints(src)).toEqual([{ stage: 'fragment', name: 'fs_main' }]);
  });

  it('finds multiple entries in one module (forward + gbuffer)', () => {
    const src = `
@fragment fn fs_main(in: VsOut) -> @location(0) vec4<f32> { return vec4(1.0); }
@fragment fn fs_gbuffer(in: VsOut) -> GBufferOutput { var o: GBufferOutput; return o; }
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4(0.0); }`;
    expect(findWgslEntryPoints(src)).toEqual([
      { stage: 'fragment', name: 'fs_main' },
      { stage: 'fragment', name: 'fs_gbuffer' },
      { stage: 'vertex', name: 'vs_main' },
    ]);
  });

  it('handles the attribute and fn on separate lines with extra whitespace', () => {
    const src = '@compute  @workgroup_size(8)\n  fn  main () {}';
    expect(findWgslEntryPoints(src)).toEqual([{ stage: 'compute', name: 'main' }]);
  });

  it('returns empty for source with no entry points', () => {
    expect(findWgslEntryPoints('fn helper() -> f32 { return 1.0; }')).toEqual([]);
  });
});
