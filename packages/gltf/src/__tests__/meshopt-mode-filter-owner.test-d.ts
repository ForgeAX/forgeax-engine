/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  GLTF_MESHOPT_FILTERS,
  GLTF_MESHOPT_MODES,
  GltfMeshoptDecodeFailedDetail,
  GltfMeshoptFilter,
  GltfMeshoptMode,
} from '../errors.js';
import type { GltfBufferViewDecodeCapability, MeshoptCompressionJson } from '../meshopt-decode.js';

const errorsSource = readFileSync(new URL('../errors.ts', import.meta.url), 'utf8');
const meshoptSource = readFileSync(new URL('../meshopt-decode.ts', import.meta.url), 'utf8');

type DecodedMode = Parameters<GltfBufferViewDecodeCapability['decode']>[0]['mode'];
type DecodedFilter = Parameters<GltfBufferViewDecodeCapability['decode']>[0]['filter'];

describe('glTF Meshopt mode/filter owner', () => {
  it('keeps tuple order and derives every Meshopt vocabulary projection', () => {
    expectTypeOf<typeof GLTF_MESHOPT_MODES>().toEqualTypeOf<
      readonly ['ATTRIBUTES', 'TRIANGLES', 'INDICES']
    >();
    expectTypeOf<typeof GLTF_MESHOPT_FILTERS>().toEqualTypeOf<
      readonly ['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL']
    >();

    expectTypeOf<GltfMeshoptMode>().toEqualTypeOf<(typeof GLTF_MESHOPT_MODES)[number]>();
    expectTypeOf<(typeof GLTF_MESHOPT_MODES)[number]>().toEqualTypeOf<GltfMeshoptMode>();
    expectTypeOf<GltfMeshoptFilter>().toEqualTypeOf<(typeof GLTF_MESHOPT_FILTERS)[number]>();
    expectTypeOf<(typeof GLTF_MESHOPT_FILTERS)[number]>().toEqualTypeOf<GltfMeshoptFilter>();

    expectTypeOf<MeshoptCompressionJson['mode']>().toEqualTypeOf<GltfMeshoptMode>();
    expectTypeOf<MeshoptCompressionJson['filter']>().toEqualTypeOf<GltfMeshoptFilter | undefined>();
    expectTypeOf<DecodedMode>().toEqualTypeOf<GltfMeshoptMode>();
    expectTypeOf<DecodedFilter>().toEqualTypeOf<GltfMeshoptFilter>();
    expectTypeOf<GltfMeshoptDecodeFailedDetail['mode']>().toEqualTypeOf<GltfMeshoptMode>();
    expectTypeOf<GltfMeshoptDecodeFailedDetail['filter']>().toEqualTypeOf<GltfMeshoptFilter>();
  });

  it('keeps the owner declarations and tuple-driven validation single-sourced', () => {
    expect(errorsSource).toContain(
      'export type GltfMeshoptMode = (typeof GLTF_MESHOPT_MODES)[number];',
    );
    expect(errorsSource).toContain(
      'export type GltfMeshoptFilter = (typeof GLTF_MESHOPT_FILTERS)[number];',
    );
    expect(errorsSource).toContain('readonly mode: GltfMeshoptMode;');
    expect(errorsSource).toContain('readonly filter: GltfMeshoptFilter;');
    expect(meshoptSource).not.toContain('export type MeshoptMode');
    expect(meshoptSource).not.toContain('export type MeshoptFilter');
    expect(meshoptSource).toContain(
      'return GLTF_MESHOPT_MODES.some((candidate) => candidate === mode);',
    );
    expect(meshoptSource).toContain(
      'return GLTF_MESHOPT_FILTERS.some((candidate) => candidate === filter);',
    );
    expect(meshoptSource).not.toContain(
      "export type MeshoptMode = 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';",
    );
    expect(meshoptSource).not.toContain(
      "export type MeshoptFilter = 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';",
    );
    expect(errorsSource).not.toContain("readonly mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES';");
    expect(errorsSource).not.toContain(
      "readonly filter: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL';",
    );
  });
});
