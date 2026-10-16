import { KNOWN_PASS_KINDS, type PassKind, type VertexAttributeMap } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET } from '../../../render/src/pbr-pipeline';
import { cacheKeyOf, type PipelineSpec } from '../../../render/src/pipeline-spec';

/*
 * feat-20260615-pipeline-spec-ssot M2-T2: cache key axis tests migrated from
 * materialShaderPipelineCacheKey to cacheKeyOf(spec).
 *
 * Post-migration: cacheKeyOf covers all 4 PipelineSpec axes (shader /
 * attachments / geometry / renderState). The old 8-segment string construction
 * is deleted. These tests verify equivalent cache-key semantics.
 */

const DEFAULT_VERTEX_LAYOUT: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
};

function specOf(
  id: string,
  isHdr: boolean,
  passKind: string = 'forward',
  topology = 'triangle-list' as const,
  variantSet?: string,
  sampleCount: 1 | 4 = 1,
): PipelineSpec {
  const colorFormat: GPUTextureFormat = isHdr
    ? ('rgba16float' as unknown as GPUTextureFormat)
    : ('bgra8unorm-srgb' as unknown as GPUTextureFormat);
  const depthFormat: GPUTextureFormat =
    passKind === 'shadow-caster'
      ? ('depth32float' as unknown as GPUTextureFormat)
      : ('depth24plus-stencil8' as unknown as GPUTextureFormat);

  return {
    shader: { id, passKind, variantSet },
    attachments: {
      colorFormats: passKind === 'shadow-caster' ? [] : [colorFormat],
      depthFormat,
      sampleCount,
    },
    geometry: {
      topology,
      vertexLayout: DEFAULT_VERTEX_LAYOUT,
    },
    renderState: undefined,
  };
}

describe('cacheKeyOf passKind dimension', () => {
  const SHADER_ID = 'forgeax::default-unlit';

  it('separates authored entry selections within one published module', () => {
    const base = specOf('custom::two-entries', false);
    const first = {
      ...base,
      shader: { ...base.shader, vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
    };
    const second = { ...base, shader: { ...first.shader, fragmentEntry: 'fs_readability' } };
    const shadow = { ...base, shader: { ...first.shader, vertexEntry: 'vs_shadow' } };
    expect(new Set([first, second, shadow].map(cacheKeyOf)).size).toBe(3);
    expect(cacheKeyOf({ ...first })).toBe(cacheKeyOf(first));
  });

  it('same shaderId + entries produce different keys for forward vs shadow-caster', () => {
    const forwardKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward'));
    const shadowKey = cacheKeyOf(specOf(SHADER_ID, false, 'shadow-caster'));

    expect(forwardKey).not.toBe(shadowKey);
  });

  it('same passKind + entries produce identical keys', () => {
    const key1 = cacheKeyOf(specOf(SHADER_ID, true, 'forward'));
    const key2 = cacheKeyOf(specOf(SHADER_ID, true, 'forward'));

    expect(key1).toBe(key2);
  });

  it('default passKind is forward (backward compatibility)', () => {
    const explicitKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward'));
    const defaultKey = cacheKeyOf(specOf(SHADER_ID, false));

    expect(defaultKey).toBe(explicitKey);
  });

  it('HDR variant + passKind both distinguish keys', () => {
    const ldrForward = cacheKeyOf(specOf(SHADER_ID, false, 'forward'));
    const hdrForward = cacheKeyOf(specOf(SHADER_ID, true, 'forward'));
    const ldrShadow = cacheKeyOf(specOf(SHADER_ID, false, 'shadow-caster'));

    const unique = new Set([ldrForward, hdrForward, ldrShadow]);
    expect(unique.size).toBe(3);
  });

  it('different shaderId + same passKind produce different keys', () => {
    const key1 = cacheKeyOf(specOf('forgeax::default-unlit', false, 'forward'));
    const key2 = cacheKeyOf(specOf('forgeax::default-standard-pbr', false, 'forward'));

    expect(key1).not.toBe(key2);
  });

  it('variantSet and passKind are orthogonal cache dimensions', () => {
    const urpForward = cacheKeyOf(
      specOf(
        SHADER_ID,
        false,
        'forward',
        'triangle-list',
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
      ),
    );
    const hdrpForward = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', ''));
    const urpShadow = cacheKeyOf(
      specOf(
        SHADER_ID,
        false,
        'shadow-caster',
        'triangle-list',
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
      ),
    );
    const hdrpShadow = cacheKeyOf(specOf(SHADER_ID, false, 'shadow-caster', 'triangle-list', ''));
    const unique = new Set([urpForward, hdrpForward, urpShadow, hdrpShadow]);
    expect(unique.size).toBe(4);
  });
});

/*
 * feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w1:
 * PassKind 4-value closed union narrow test.
 *
 * AC-03: PassKind = 'forward' | 'deferred' | 'lighting' | 'shadow-caster'.
 * The union is closed; TS exhaustive-switch without default must compile.
 * The pre-rename value 'shadow-depth-only' must NOT be a member of the union (backwards-assert).
 */
describe('PassKind open string + KNOWN_PASS_KINDS (feat-20260615 D-10)', () => {
  // M2-T4 expanded KNOWN_PASS_KINDS from 4 to 6 entries by adding 'post-process'
  // and 'skybox'; point-shadow-caster is the engine's depth-only point-light
  // pass and is part of the discoverable catalogue as well. M3-T4 adds the
  // Standard temporal producer to the shipped pass catalogue.
  it('KNOWN_PASS_KINDS has exactly 8 entries', () => {
    expect(KNOWN_PASS_KINDS).toHaveLength(8);
  });

  it('KNOWN_PASS_KINDS contains the 8 engine-shipped pass kinds', () => {
    expect(KNOWN_PASS_KINDS).toContain('forward');
    expect(KNOWN_PASS_KINDS).toContain('deferred');
    expect(KNOWN_PASS_KINDS).toContain('temporal');
    expect(KNOWN_PASS_KINDS).toContain('lighting');
    expect(KNOWN_PASS_KINDS).toContain('shadow-caster');
    expect(KNOWN_PASS_KINDS).toContain('point-shadow-caster');
    expect(KNOWN_PASS_KINDS).toContain('post-process');
    expect(KNOWN_PASS_KINDS).toContain('skybox');
  });

  it('shadow-caster is a valid PassKind value', () => {
    const pk: PassKind = 'shadow-caster';
    expect(pk).toBe('shadow-caster');
  });

  it('deferred and lighting are valid PassKind values', () => {
    const pk1: PassKind = 'deferred';
    const pk2: PassKind = 'lighting';
    expect(pk1).toBe('deferred');
    expect(pk2).toBe('lighting');
  });

  it('PassKind is an open string (assignable from any string)', () => {
    expectTypeOf<PassKind>().toEqualTypeOf<string>();
  });

  it('PassKind accepts unknown custom strings', () => {
    const pk: PassKind = 'custom-user-pass';
    expect(typeof pk).toBe('string');
  });
});

/*
 * bug-20260615-msaa-silently-disables-custom-material-shaders M1 + M2 / m2-1:
 * sampleCount cache-key axis (migrated to cacheKeyOf).
 *
 * sampleCount is part of the attachments axis in PipelineSpec.
 * spec.sampleCount: 1 | 4 — distinct values produce distinct cache keys.
 */
describe('cacheKeyOf sampleCount axis', () => {
  const SHADER_ID = 'forgeax::default-unlit';

  it('sampleCount=1 produces stable key', () => {
    const key1 = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 1));
    const key2 = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 1));
    expect(key1).toBe(key2);
  });

  it('sampleCount=4 produces a key distinct from count=1 (MSAA-variant slot)', () => {
    const keyCount1 = cacheKeyOf(
      specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 1),
    );
    const keyCount4 = cacheKeyOf(
      specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 4),
    );
    expect(keyCount1).not.toBe(keyCount4);
  });

  it('sampleCount interacts correctly with existing axes (hdr + variantSet + passKind)', () => {
    const key1 = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 1));
    const key2 = cacheKeyOf(specOf(SHADER_ID, true, 'forward', 'triangle-list', undefined, 1));
    const key3 = cacheKeyOf(
      specOf(
        SHADER_ID,
        false,
        'forward',
        'triangle-list',
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
        1,
      ),
    );
    const key4 = cacheKeyOf(
      specOf(SHADER_ID, false, 'shadow-caster', 'triangle-list', undefined, 1),
    );
    const unique = new Set([key1, key2, key3, key4]);
    expect(unique.size).toBe(4);
  });
});

/*
 * bug-20260708 M2 (b) AC-02: `cacheKeyOf` sentinel `~` distinguishes
 * `variantSet=undefined` from canonical all-true key `''`.
 *
 * Before the sentinel `?? ''` collapsed both into the same segment,
 * causing character (no SpriteInstances, variantSet=undefined) and
 * terrain-fold (SpriteInstances batch,
 * `SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET === ''`) requests to hit
 * the same pipeline cache slot — the first-cached PSO wins, and both end
 * up with the same shader module (research R-11 / R-12 flow rebuild).
 *
 * These assertions are the reverse falsifier for the sentinel:
 *   1. undefined vs canonical '' (all-true) MUST produce distinct keys.
 *   2. undefined vs an explicit `'PER_INSTANCE_REGION=true'`-style key
 *      MUST produce distinct keys (sentinel keeps `undefined` separate
 *      from any concrete variantSet string).
 *   3. `''` vs an explicit `'PER_INSTANCE_REGION=true'`-style key MUST
 *      produce distinct keys (unchanged axis discipline, sanity check
 *      the sentinel doesn't collapse other values by accident).
 */
describe('cacheKeyOf variantSet sentinel (bug-20260708 AC-02)', () => {
  const SHADER_ID = 'forgeax::sprite';

  it('cacheKeyOf(variantSet=undefined) !== cacheKeyOf(variantSet="") — sentinel decouples undefined from canonical all-true', () => {
    const undefKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined));
    const emptyKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', ''));
    expect(undefKey).not.toBe(emptyKey);
  });

  it('cacheKeyOf(variantSet=undefined) !== cacheKeyOf(variantSet="PER_INSTANCE_REGION=true")', () => {
    const undefKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined));
    const namedKey = cacheKeyOf(
      specOf(SHADER_ID, false, 'forward', 'triangle-list', 'PER_INSTANCE_REGION=true'),
    );
    expect(undefKey).not.toBe(namedKey);
  });

  it('cacheKeyOf(variantSet="") !== cacheKeyOf(variantSet="PER_INSTANCE_REGION=true")', () => {
    const emptyKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', ''));
    const namedKey = cacheKeyOf(
      specOf(SHADER_ID, false, 'forward', 'triangle-list', 'PER_INSTANCE_REGION=true'),
    );
    expect(emptyKey).not.toBe(namedKey);
  });

  it("sentinel `~` reserved: no legitimate variantSet literal in the codebase contains `~` (reverse falsifier for R-2')", () => {
    // The sentinel `~` (ASCII 0x7E) is reserved for the `variantSet=undefined`
    // branch of `cacheKeyOf`. This assertion pins the reserved status by
    // enumerating known variantSet literals used by the runtime: none may
    // contain the sentinel char. Future axis additions must not introduce
    // `~` into any variantSet string (a new axis using `~` collides with
    // the sentinel and re-opens the R-11 undefined-vs-empty collapse).
    const knownVariantSets: readonly (string | undefined)[] = [
      undefined,
      '',
      'PER_INSTANCE_REGION=true',
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
      'STORAGE_BUFFER_AVAILABLE=true',
      SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET,
    ];
    for (const vs of knownVariantSets) {
      if (vs !== undefined) {
        expect(vs).not.toContain('~');
      }
    }
  });
});

/*
 * bug-20260708 M2 (c) AC-05: `SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET`
 * is aligned with the canonical variant key so `findVariantByKey` on the
 * sprite manifest returns the PIR=true+SBA=true (all-true) variant WGSL.
 * Verifies the constant's cacheKey participates in the cache-slot space
 * distinct from `variantSet=undefined` (per AC-02 sentinel).
 */
describe('SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET (bug-20260708 AC-05)', () => {
  const SHADER_ID = 'forgeax::sprite';

  it('constant equals canonical all-true key `""` (findVariantByKey resolves to PIR=true+SBA=true variant)', () => {
    // Canonical all-true key semantics per @forgeax/engine-shader:
    // "Empty key `""` denotes the default variant (all axes `true`)".
    // Sprite variants are keyed as `""` for PIR=true+SBA=true.
    expect(SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET).toBe('');
  });

  it('cacheKeyOf(spec with SPRITE_PASS_...VARIANT_SET) !== cacheKeyOf(spec with variantSet=undefined) — sentinel gate', () => {
    const spritePassKey = cacheKeyOf(
      specOf(
        SHADER_ID,
        false,
        'forward',
        'triangle-list',
        SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET,
      ),
    );
    const undefKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined));
    expect(spritePassKey).not.toBe(undefKey);
  });
});
