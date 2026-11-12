import { ShaderRegistry } from '@forgeax/engine-shader';
import { ShaderSource } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  declaredFragmentEntry,
  declaresStandardOpaqueEntry,
  type ForwardFragmentEntryInput,
  lacksSurfaceDataEntry,
  materialProgramSource,
  STANDARD_OPAQUE_FRAGMENT_ENTRY,
  selectForwardFragmentEntry,
  selectStandardForwardScreenEntry,
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

it('keeps the opaque screen-data entry explicit and falls back for unlit or older programs', () => {
  const entry = 'fs_forward_screen';
  expect(selectForwardFragmentEntry({ ...OPAQUE, fragmentEntry: entry })).toBe(entry);
  expect(declaredFragmentEntry(entry, '@fragment fn fs_forward_screen() {}')).toBe(entry);
  expect(declaredFragmentEntry(entry, '@fragment fn fs_main() {}')).toBeUndefined();
  expect(declaredFragmentEntry('fs_custom', '@fragment fn fs_main() {}')).toBe('fs_custom');
});

it('keeps authored fragment entries when admitting the Standard screen receiver', () => {
  expect(selectStandardForwardScreenEntry('fs_forward_screen', 'fs_custom')).toBe('fs_custom');
  expect(selectStandardForwardScreenEntry('fs_forward_screen', 'fs_main')).toBe(
    'fs_forward_screen',
  );
  expect(selectStandardForwardScreenEntry('fs_forward_screen', undefined)).toBe(
    'fs_forward_screen',
  );
  expect(selectStandardForwardScreenEntry(undefined, 'fs_custom')).toBe('fs_custom');
});

describe('lacksSurfaceDataEntry', () => {
  const program = (source: string) =>
    ({ source }) as unknown as Parameters<typeof lacksSurfaceDataEntry>[2];

  it('keeps hand-written WGSL without fs_ao_input out of the surface-data prepass', () => {
    const custom = program('@vertex fn vs_main() {}\n@fragment fn fs_main() {}');
    expect(lacksSurfaceDataEntry('fs_ao_input', 'app::parallax', custom, false)).toBe(true);
    expect(lacksSurfaceDataEntry('fs_ao_input', 'app::parallax', undefined, false)).toBe(true);
  });

  it('admits programs that declare the entry and built-ins without an artifact', () => {
    const cooked = program('@fragment fn fs_ao_input() {}');
    expect(lacksSurfaceDataEntry('fs_ao_input', 'app::surface', cooked, false)).toBe(false);
    expect(lacksSurfaceDataEntry('fs_ao_input', 'forgeax::default-unlit', undefined, true)).toBe(
      false,
    );
    expect(lacksSurfaceDataEntry('fs_ao_input', undefined, undefined, true)).toBe(false);
  });

  it('only gates the surface-data entry', () => {
    const custom = program('@fragment fn fs_main() {}');
    expect(lacksSurfaceDataEntry('fs_main', 'app::parallax', custom, false)).toBe(false);
    expect(lacksSurfaceDataEntry(undefined, 'app::parallax', undefined, false)).toBe(false);
  });
});
