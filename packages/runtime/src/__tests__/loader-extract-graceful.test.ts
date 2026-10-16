// loader-extract-graceful.test.ts -- M4 / w24 integration test for the
// paramSchema-driven loader/extract handoff.
//
// feat-20260613-material-paramschema-driven-binding M4 / w24.
//
// Decision anchors (plan-strategy section 2 + section 5.3):
//   - D-5  loader does not pre-filter texture fields by hardcoded name; the
//          paramSchema-derived textureFieldNames is the SSOT. Cross-worktree
//          shader-late-register falls back to "try every int paramValue"
//          gracefully; the extract layer's paramSchema validation catches
//          misclassifications and routes through MISSING_TEXTURE_HANDLE.
//   - R-4  shader-late-register risk: material loaded before its shader is
//          registered. The graceful fallback keeps the load path live.
//
// Four scenarios (plan-strategy section 5.3 acceptance), updated for
// feat-20260614 M8 (D-19): the loader no longer resolves a texture-typed
// paramValue to a runtime handle. It maps the refs[] index to the embedded
// sub-asset GUID string; the ECS/render side resolves GUID -> column handle
// at use time (world.allocSharedRef). `LoadContext.resolveRefSync` is gone.
//   (1) shader registered + texture-typed paramValue + valid refs[] index
//       -> loader rewrites the field to the refs[] GUID string.
//   (2) shader registered + texture-typed paramValue + index out of range
//       -> loader drops the field; record stage falls back to MISSING_TEXTURE_HANDLE.
//   (3) shader NOT registered yet (cross-worktree R-4) + int paramValue
//       -> graceful fallback resolves every in-range int to its refs[] GUID.
//   (4) shader registered + scalar-typed paramValue (metallic = 0) whose
//       value happens to land in [0, refs.length) -> paramSchema-aware path
//       skips it; the field stays as the original int.

import { materialLoader } from '@forgeax/engine-assets-runtime';
import type { LoadContext, ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function makeCtx(opts: {
  shaderTextureFieldNames?: (shaderId: string) => ReadonlySet<string> | undefined;
}): LoadContext {
  const ctx: LoadContext = {
    fetchBinary: async () => ({ ok: false as const, error: new Error('no binary') }),
    resolveRef: async () => ({ ok: false as const, error: new Error('no ref') }),
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
  if (opts.shaderTextureFieldNames) {
    ctx.getMaterialShaderTextureFieldNames = opts.shaderTextureFieldNames;
  }
  return ctx;
}

const standardPbrSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

describe('loader-extract graceful handoff (M4 w24)', () => {
  it('(1) shader registered + valid texture refs[] index resolves to a structured texture value', () => {
    const textureFields = derive(standardPbrSchema).textureFieldNames;
    const ctx = makeCtx({
      shaderTextureFieldNames: (id) =>
        id === 'forgeax::default-standard-pbr' ? textureFields : undefined,
    });
    const out = materialLoader.load(
      {
        passes: [{ program: { module: 'forgeax::default-standard-pbr' } }],
        values: { baseColorTexture: 0, metallic: 0.5 },
      },
      ['tex-bc-guid'],
      ctx,
    );
    expect(out).toMatchObject({ kind: 'material' });
    const pv = (out as { values: Record<string, unknown> }).values;
    // D-19: texture field rewritten to the structured asset value (not a handle).
    expect(pv.baseColorTexture).toEqual({ texture: 'tex-bc-guid' });
    // Scalar field unchanged.
    expect(pv.metallic).toBe(0.5);
  });

  it('(2) shader registered + texture refs[] index out of range -> field dropped', () => {
    const textureFields = derive(standardPbrSchema).textureFieldNames;
    const ctx = makeCtx({
      shaderTextureFieldNames: (id) =>
        id === 'forgeax::default-standard-pbr' ? textureFields : undefined,
    });
    const out = materialLoader.load(
      {
        passes: [{ program: { module: 'forgeax::default-standard-pbr' } }],
        // index 5 is out of range for refs.length=1 -> dropped.
        values: { baseColorTexture: 5 },
      },
      ['tex-bc-guid'],
      ctx,
    );
    expect(out).toMatchObject({ kind: 'material' });
    const pv = (out as { values: Record<string, unknown> }).values;
    // Loader drops the field; record stage falls back to MISSING_TEXTURE_HANDLE.
    expect('baseColorTexture' in pv).toBe(false);
  });

  it('(3) shader NOT registered (R-4 cross-worktree) -> graceful structured texture fallback', () => {
    // No paramSchema lookup is available, so the loader cannot classify bare
    // integers as texture refs. Explicit structured texture values remain
    // resolvable across worktrees without guessing at scalar fields.
    const ctx = makeCtx({
      shaderTextureFieldNames: () => undefined,
    });
    const out = materialLoader.load(
      {
        passes: [{ program: { module: 'forgeax::user-defined' } }],
        values: { customTexture: { texture: 0 } },
      },
      ['tex-guid'],
      ctx,
    );
    expect(out).toMatchObject({ kind: 'material' });
    const pv = (out as { values: Record<string, unknown> }).values;
    // Explicit structured refs resolve to the enclosing refs[] GUID.
    expect(pv.customTexture).toEqual({ texture: 'tex-guid' });
  });

  it('(4) shader registered + scalar paramValue with refs[] index in range -> NOT misclassified', () => {
    const textureFields = derive(standardPbrSchema).textureFieldNames;
    const ctx = makeCtx({
      shaderTextureFieldNames: (id) =>
        id === 'forgeax::default-standard-pbr' ? textureFields : undefined,
    });
    const out = materialLoader.load(
      {
        passes: [{ program: { module: 'forgeax::default-standard-pbr' } }],
        // metallic = 0 is an int in [0, refs.length=1) — would misclassify
        // under a naive "try every int" loader. paramSchema-aware path
        // declares metallic as 'f32', so it skips resolution.
        values: { baseColorTexture: 0, metallic: 0 },
      },
      ['tex-bc-guid'],
      ctx,
    );
    expect(out).toMatchObject({ kind: 'material' });
    const pv = (out as { values: Record<string, unknown> }).values;
    // Texture field still resolves to the structured asset value.
    expect(pv.baseColorTexture).toEqual({ texture: 'tex-bc-guid' });
    // Scalar field unchanged: metallic stays 0.
    expect(pv.metallic).toBe(0);
  });
});
