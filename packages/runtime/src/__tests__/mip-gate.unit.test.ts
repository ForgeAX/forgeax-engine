// w30 -- mip gate unit tests (AC-09 / D-9).
//
// `deriveRenderDataTexture` is the fail-fast projection layer (F-6). A
// block-compressed texture cannot have its mip chain GPU-generated (the mipmap
// blit pipeline renders into a color attachment; compressed formats are not
// render targets -- F-7), so a POD that carries a compressed `format` AND
// requests runtime mip generation (`mipmap:true` WITHOUT an offline mip chain,
// i.e. `mipLevelCount` unset or 1) must fail fast with a structured error whose
// `.hint` tells the AI user how to self-recover (bake offline, or set
// `compressionMode:'none'`).
//
// The gate distinguishes "please GENERATE mips at runtime" (blocked) from
// "offline mips are ALREADY in `data`" (normal): a compressed POD with
// `mipLevelCount > 1` carries a KTX2-baked chain and uploads without a gate hit.
//
// This is TDD-RED before w35 -- the gate does not exist yet.
//
// Constraints (plan-tasks w30):
//   - no GPU mip-gen execution (pure unit on deriveRenderDataTexture)
//   - reuse the AssetError code system (D-9); the new code is
//     'mipgen-unsupported-compressed-format'

import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { deriveRenderDataTexture } from '../../../render/src/render-data';

function tex(overrides: Partial<TextureAsset>): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
    format: 'rgba8unorm',
    data: new Uint8Array(8 * 8 * 4),
    colorSpace: 'linear',
    mips: { kind: 'none' },
    ...overrides,
  };
}

describe('deriveRenderDataTexture -- mip gate on compressed formats (w30, AC-09)', () => {
  it('compressed format + mipmap:true (runtime mip-gen requested) -> error', () => {
    const res = deriveRenderDataTexture(
      tex({ format: 'bc7-rgba-unorm', mips: { kind: 'generate' } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('mipgen-unsupported-compressed-format');
      // hint must guide offline baking + the sidecar self-recovery.
      expect(res.error.hint).toMatch(/bake|offline/i);
      expect(res.error.hint).toMatch(/mipmap|compressionMode/i);
    }
  });

  it('mip-gate error fires for an ETC2 compressed format too', () => {
    const res = deriveRenderDataTexture(
      tex({ format: 'etc2-rgba8unorm', mips: { kind: 'generate' } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('mipgen-unsupported-compressed-format');
  });

  it('compressed format + mipmap:true but offline chain present (mipLevelCount>1) -> ok', () => {
    // The KTX2 loader baked the mip chain offline; this is the normal
    // compressed-upload path and must NOT trip the runtime-mip-gen gate.
    const res = deriveRenderDataTexture(
      tex({ format: 'bc7-rgba-unorm', mips: { kind: 'packed', levelCount: 4 } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.mipLevelCount).toBe(4);
  });

  it('compressed format + mipmap:false -> ok (single level)', () => {
    const res = deriveRenderDataTexture(tex({ format: 'bc7-rgba-unorm', mips: { kind: 'none' } }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.mipLevelCount).toBe(1);
  });

  it('uncompressed format + mipmap:true -> ok (existing runtime mip-gen path unchanged)', () => {
    const res = deriveRenderDataTexture(tex({ format: 'rgba8unorm', mips: { kind: 'generate' } }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.mipLevelCount).toBeGreaterThan(1);
  });
});
