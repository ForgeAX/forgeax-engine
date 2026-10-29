import { ShaderRegistry } from '@forgeax/engine-shader';
import { ShaderSource } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  declaredFragmentEntry,
  declaresStandardOpaqueEntry,
  type ForwardFragmentEntryInput,
  materialProgramSource,
  STANDARD_OPAQUE_FRAGMENT_ENTRY,
  selectForwardFragmentEntry,
} from '../standard-opaque-entry';
import { translucentViewOffset } from '../view-ubo';

const OPAQUE: ForwardFragmentEntryInput = {
  passKind: 'forward',
  fragmentEntry: undefined,
  oitAccumulate: false,
  viewOffset: 0,
  atmosphereCapture: false,
};

describe('selectForwardFragmentEntry', () => {
  it('selects fs_opaque for forward draws on the unfogged base View slot', () => {
    expect(selectForwardFragmentEntry(OPAQUE)).toBe(STANDARD_OPAQUE_FRAGMENT_ENTRY);
    expect(selectForwardFragmentEntry({ ...OPAQUE, fragmentEntry: 'fs_main' })).toBe('fs_opaque');
  });

  it('keeps fs_main where translucent fog can change the output', () => {
    for (const composition of ['straight', 'premultiplied', 'additive'] as const) {
      expect(
        selectForwardFragmentEntry({ ...OPAQUE, viewOffset: translucentViewOffset(composition) }),
      ).toBeUndefined();
    }
    // Atmosphere captures write fogHeightOpacity.z = 1 into their base slot.
    expect(selectForwardFragmentEntry({ ...OPAQUE, atmosphereCapture: true })).toBeUndefined();
    expect(
      selectForwardFragmentEntry({ ...OPAQUE, fragmentEntry: 'fs_main', atmosphereCapture: true }),
    ).toBe('fs_main');
  });

  it('never rewrites OIT, authored, or non-forward entries', () => {
    expect(
      selectForwardFragmentEntry({ ...OPAQUE, oitAccumulate: true, fragmentEntry: 'fs_oit' }),
    ).toBe('fs_oit');
    expect(selectForwardFragmentEntry({ ...OPAQUE, fragmentEntry: 'fs_custom' })).toBe('fs_custom');
    for (const passKind of ['deferred', 'temporal', 'shadow-caster']) {
      expect(selectForwardFragmentEntry({ ...OPAQUE, passKind })).toBeUndefined();
    }
  });
});

describe('declaresStandardOpaqueEntry', () => {
  it('keeps ordinary entry queries and repeated opaque queries off the source body', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    registry.installMaterialArtifact('test::opaque', {
      source: '@fragment fn fs_opaque() {}',
      paramSchema: [],
    });
    const lookup = registry.findMaterialArtifact('test::opaque');
    const read = vi.spyOn(ShaderSource.prototype, 'read');
    try {
      expect(declaredFragmentEntry('fs_main', materialProgramSource(lookup))).toBe('fs_main');
      expect(read).not.toHaveBeenCalled();
      expect(declaredFragmentEntry('fs_opaque', materialProgramSource(lookup))).toBe('fs_opaque');
      read.mockClear();
      expect(declaredFragmentEntry('fs_opaque', materialProgramSource(lookup))).toBe('fs_opaque');
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('requires a declared fs_opaque function', () => {
    expect(declaresStandardOpaqueEntry('@fragment\nfn fs_opaque(in : VsOut) {}')).toBe(true);
    expect(declaresStandardOpaqueEntry('@fragment\nfn fs_main(in : VsOut) {}')).toBe(false);
    expect(declaresStandardOpaqueEntry('// calls fs_opaque elsewhere')).toBe(false);
    expect(declaresStandardOpaqueEntry(undefined)).toBe(false);
  });
});
