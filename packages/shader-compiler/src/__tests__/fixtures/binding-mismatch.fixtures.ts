// binding-mismatch.fixtures.ts -- positive + negative fixtures for the w6/w7
// single-direction superset check (plan-strategy D-9 / D-10).
//
// Each fixture pairs a paramSchema with an "actual reflected BGL" (as if
// emitted by naga reflection on the user's WGSL) and the expected verdict.
// Negative fixtures must trigger the new 'material-shader-binding-mismatch'
// code; positive fixtures must pass even when the actual BGL has extra
// bindings beyond what derive(schema) requires (engine-injection placeholder).

import type {
  BindGroupLayoutDescriptor,
  BindGroupLayoutEntry,
  ParamSchemaEntry,
} from '@forgeax/engine-types';

const FRAGMENT = 0x2 as GPUShaderStageFlags;

function uboEntry(binding: number): BindGroupLayoutEntry {
  return {
    binding,
    visibility: FRAGMENT,
    buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
  };
}

function tex2dEntry(binding: number): BindGroupLayoutEntry {
  return {
    binding,
    visibility: FRAGMENT,
    texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
  };
}

function textureEntry(binding: number, viewDimension: '2d-array' | '3d'): BindGroupLayoutEntry {
  return {
    binding,
    visibility: FRAGMENT,
    texture: { sampleType: 'float', viewDimension, multisampled: false },
  };
}

function filteringSamplerEntry(binding: number): BindGroupLayoutEntry {
  return {
    binding,
    visibility: FRAGMENT,
    sampler: { type: 'filtering' },
  };
}

export interface BindingMismatchFixture {
  readonly name: string;
  readonly schema: readonly ParamSchemaEntry[];
  readonly actualBgls: readonly BindGroupLayoutDescriptor[];
  readonly verdict: 'ok' | 'mismatch';
  /** When verdict='mismatch', the binding number that the error should reference. */
  readonly mismatchBinding?: number;
  /** When verdict='mismatch', the schema entry name that the error should reference. */
  readonly mismatchParam?: string;
}

export const DIMENSION_BINDING_FIXTURES: readonly BindingMismatchFixture[] = [
  {
    name: 'pos-2d-array-exact-match',
    schema: [{ name: 'layers', type: 'texture2d_array' }],
    actualBgls: [{ entries: [uboEntry(0), filteringSamplerEntry(1), textureEntry(2, '2d-array')] }],
    verdict: 'ok',
  },
  {
    name: 'pos-3d-exact-match',
    schema: [{ name: 'volume', type: 'texture3d' }],
    actualBgls: [{ entries: [uboEntry(0), filteringSamplerEntry(1), textureEntry(2, '3d')] }],
    verdict: 'ok',
  },
];

// ---- Positive: exact match (schema yields exactly the actual BGL) ------------

const POS_EXACT_MATCH: BindingMismatchFixture = {
  name: 'pos-exact-match',
  schema: [
    { name: 'tint', type: 'color' },
    { name: 'mainTex', type: 'texture2d' },
  ],
  // Sampler-first per §D-4: derive yields [UBO@0, sampler@1, tex@2].
  actualBgls: [
    {
      label: '@group(1)',
      entries: [uboEntry(0), filteringSamplerEntry(1), tex2dEntry(2)],
    },
  ],
  verdict: 'ok',
};

// ---- Positive: extra binding tolerated (engine-injection placeholder) --------
// derive(schema=[tint:color]) yields BGL [UBO@0]; WGSL author left an extra
// texture@1 reserved for future engine injection. Single-direction superset
// (actual ⊇ derive) accepts this.

const POS_EXTRA_BINDING_TOLERATED: BindingMismatchFixture = {
  name: 'pos-extra-binding-tolerated',
  schema: [{ name: 'tint', type: 'color' }],
  actualBgls: [
    {
      label: '@group(1)',
      entries: [uboEntry(0), tex2dEntry(1)],
    },
  ],
  verdict: 'ok',
};

// ---- Negative: binding misnumbered ------------------------------------------
// derive([{name:'mainTex', type:'texture2d'}]) -> UBO@0, sampler@1 + tex@2.
// Actual WGSL has sampler@2 + tex@3 (off-by-two). Missing entries at @0 and @1.

const NEG_BINDING_MISNUMBERED: BindingMismatchFixture = {
  name: 'neg-binding-misnumbered',
  schema: [{ name: 'mainTex', type: 'texture2d' }],
  actualBgls: [
    {
      label: '@group(1)',
      entries: [filteringSamplerEntry(2), tex2dEntry(3)],
    },
  ],
  verdict: 'mismatch',
  // Missing bindings are legal; the sampler at texture binding 2 is not.
  mismatchBinding: 2,
  mismatchParam: 'mainTex',
};

// ---- Negative: missing binding ----------------------------------------------
// derive([{tint:color},{mainTex:texture2d}]) -> UBO@0, sampler@1, tex@2 (sampler-first).
// Actual WGSL only has UBO@0 (forgot to declare sampler+texture).

const NEG_MISSING_BINDING: BindingMismatchFixture = {
  name: 'neg-missing-binding',
  schema: [
    { name: 'tint', type: 'color' },
    { name: 'mainTex', type: 'texture2d' },
  ],
  actualBgls: [
    {
      label: '@group(1)',
      entries: [uboEntry(0)],
    },
  ],
  verdict: 'ok',
  // First missing expected binding is @1 (the auto-paired sampler).
  mismatchBinding: 1,
  mismatchParam: 'mainTex_sampler',
};

// ---- Negative: type mismatch ------------------------------------------------
// derive([{mainTex:texture2d}]) -> UBO@0, sampler@1, tex@2.
// Actual WGSL declares UBO@0 and tex@1; binding 1 has the wrong resource kind
// for the derived auto-paired sampler.

const NEG_TYPE_MISMATCH: BindingMismatchFixture = {
  name: 'neg-type-mismatch',
  schema: [{ name: 'mainTex', type: 'texture2d' }],
  actualBgls: [
    {
      label: '@group(1)',
      entries: [uboEntry(0), tex2dEntry(1)],
    },
  ],
  verdict: 'mismatch',
  mismatchBinding: 1,
  mismatchParam: 'mainTex_sampler',
};

export const BINDING_MISMATCH_FIXTURES: readonly BindingMismatchFixture[] = [
  POS_EXACT_MATCH,
  POS_EXTRA_BINDING_TOLERATED,
  NEG_BINDING_MISNUMBERED,
  NEG_MISSING_BINDING,
  NEG_TYPE_MISMATCH,
];
