// append-injection.test.ts -- M3 / w11 (b) integration test for the
// `appendInjection(bgl, kind)` API.
//
// feat-20260613-material-paramschema-driven-binding M3 / w11.
//
// Decision anchors (plan-strategy §2):
//   - D-6  appendInjection(bgl, kind) — engine injection ('shadow' | 'ibl' |
//          'transmission') starts at derive(...).userRegionBindingEnd, no
//          hardcoded emissive/AO start-binding (=14) leak.
//   - R-1  the 14-slot user-region assumption breaks once D-3 merges UBO;
//          appendInjection threads userRegionBindingEnd from derive output.
//
// What this test asserts (M3 scope):
//   (a) appendInjection accepts the 3 injection kinds and produces BGL
//       entries whose `.binding` values start exactly at the user-region
//       end (the size of the input BGL list).
//   (b) appendInjection on an empty user-region (shadow-caster) starts
//       injection at binding 0.
//   (c) Calling appendInjection twice (e.g. shadow + ibl) chains correctly:
//       the second call's bindings start after the first's last binding.

import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { appendInjection } from '../../../render/src/pbr-pipeline';

const standardPbrSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

describe('appendInjection (M3 w15) — engine injection BGL appending', () => {
  it('(a) shadow injection bindings start at userRegionBindingEnd (non-empty user region)', () => {
    const out = derive(standardPbrSchema);
    // derive returns the forgeax-shim BindGroupLayoutEntry (?: undefined);
    // appendInjection consumes @webgpu/types GPUBindGroupLayoutEntry. Use
    // the explicit two-step `as unknown as` cast (RHI gate j exempts this
    // form as an opt-in to a known-unsafe assertion — the same pattern is
    // used in builtin-shader-register-e2e.test.ts for the same shim surface
    // mismatch).
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];
    const start = out.userRegionBindingEnd;
    const injected = appendInjection(userBgl, 'shadow');
    // The first injected entry's binding equals start (the exact value
    // returned by derive — no hardcoded 14).
    expect(injected[0]?.binding).toBe(start);
    // All injected bindings are dense from start onward.
    for (let i = 0; i < injected.length; i++) {
      const entry = injected[i];
      if (entry === undefined) continue;
      expect(entry.binding).toBe(start + i);
    }
  });

  it('(a/ibl) ibl injection starts at userRegionBindingEnd', () => {
    const out = derive(standardPbrSchema);
    // See `(a)` for the cast rationale (forgeax shim → @webgpu/types via
    // explicit two-step `as unknown as`, exempt from RHI gate j).
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];
    const start = out.userRegionBindingEnd;
    const injected = appendInjection(userBgl, 'ibl');
    expect(injected[0]?.binding).toBe(start);
  });

  it('(a/transmission) transmission injection starts at userRegionBindingEnd', () => {
    const out = derive(standardPbrSchema);
    // See `(a)` for the cast rationale (forgeax shim → @webgpu/types via
    // explicit two-step `as unknown as`, exempt from RHI gate j).
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];
    const start = out.userRegionBindingEnd;
    const injected = appendInjection(userBgl, 'transmission');
    expect(injected[0]?.binding).toBe(start);
  });

  it('(b) empty user region (shadow-caster) injects starting at binding 0', () => {
    const out = derive([] as readonly ParamSchemaEntry[]);
    expect(out.userRegionBindingEnd).toBe(0);
    const userBgl: GPUBindGroupLayoutEntry[] = [];
    const injected = appendInjection(userBgl, 'shadow');
    expect(injected[0]?.binding).toBe(0);
  });

  it('(c) chained injections (shadow then ibl) produce dense, non-overlapping bindings', () => {
    const out = derive(standardPbrSchema);
    // See `(a)` for the cast rationale (forgeax shim → @webgpu/types via
    // explicit two-step `as unknown as`, exempt from RHI gate j).
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];
    const start = out.userRegionBindingEnd;
    const afterShadow = appendInjection(userBgl, 'shadow');
    // Build the merged list (user + shadow) then chain ibl.
    const merged = [...userBgl, ...afterShadow];
    const afterIbl = appendInjection(merged, 'ibl');
    // ibl's first binding is `merged.length`, which is start + afterShadow.length.
    expect(afterIbl[0]?.binding).toBe(start + afterShadow.length);
    // All ibl bindings are unique and after every shadow binding.
    const shadowBindings = new Set(afterShadow.map((e) => e.binding));
    for (const e of afterIbl) {
      expect(shadowBindings.has(e.binding)).toBe(false);
      expect(e.binding).toBeGreaterThan(start + afterShadow.length - 1);
    }
  });
});
