// @ts-nocheck — node:fs / node:path / node:url imports outside @types/node
// coverage in runtime tsconfig (mirrors pipeline.unit.test.ts header).
// shadow-caster-surface-schema.test.ts -- shared Surface shadow contract.
//
// feat-20260613-material-paramschema-driven-binding M4 / w21.
//
// Decision anchors (plan-strategy §2 + §3.4):
//   - derive([]) remains a valid generic empty-schema path.
//   - the shadow-caster module has no authored sidecar; its generated
//           MaterialParameters contract is the Standard pipeline schema.
//
// What this test asserts:
//   (a) derive([]) produces all-empty / zero output -- the graceful path.
//   (b) The shadow_caster source is present without a sidecar schema.
//   (c) appendInjection over the empty user-region starts injected
//       bindings at binding 0 (covered also in append-injection.test.ts;
//       this test pins the empty-schema path explicitly).
//   (d) The runtime fallback registers `forgeax::default-shadow-caster` with
//       the shared Standard pipeline schema.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { appendInjection } from '../../../render/src/pbr-pipeline';

const repoRoot = (() => {
  // packages/runtime/src/__tests__/<this file>.ts -> repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', '..');
})();

describe('shadow_caster shared Surface schema', () => {
  it('(a) derive([]) returns all-empty/zero output (D-12 graceful path)', () => {
    const out = derive([]);
    expect(out.bglEntries.length).toBe(0);
    expect(out.uboLayout.entries.length).toBe(0);
    expect(out.uboLayout.totalBytes).toBe(0);
    expect(out.textureFieldNames.size).toBe(0);
    expect(out.samplerForTexture.size).toBe(0);
    expect(out.userRegionBindingEnd).toBe(0);
  });

  it('(b) shadow_caster has no material sidecar', () => {
    const sourcePath = join(repoRoot, 'packages', 'shader', 'src', 'shadow_caster.wgsl');
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).toContain('#define_import_path forgeax::default-shadow-caster');
    expect(source).toContain('#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}');
    expect(existsSync(`${sourcePath}.meta.json`)).toBe(false);
  });

  it('(c) appendInjection on empty user-region starts at binding 0', () => {
    const out = derive([]);
    // derive returns the forgeax-shim BindGroupLayoutEntry (?: undefined);
    // appendInjection consumes @webgpu/types GPUBindGroupLayoutEntry. Use
    // the explicit two-step `as unknown as` cast (RHI gate j exempts this
    // form as an opt-in to a known-unsafe assertion — same pattern as
    // builtin-shader-register-e2e.test.ts).
    const userBgl = [...out.bglEntries] as unknown as readonly GPUBindGroupLayoutEntry[];
    const injected = appendInjection(userBgl, 'shadow');
    expect(injected.length).toBeGreaterThan(0);
    expect(injected[0]?.binding).toBe(0);
  });

  it('(d) shadow_caster fallback register call carries the Standard schema', () => {
    const createRendererPath = join(
      repoRoot,
      'packages',
      'render',
      'src',
      'assembly',
      'material-shader-policy.ts',
    );
    const src = readFileSync(createRendererPath, 'utf8');
    const re =
      /registry\.installMaterialArtifact\(\s*shadowCasterIdentifier\s*,\s*\{[^}]*paramSchema\s*:\s*STANDARD_PIPELINE_PARAM_SCHEMA\b/s;
    expect(src).toMatch(re);
    expect(STANDARD_PIPELINE_PARAM_SCHEMA.length).toBeGreaterThan(0);
  });
});
