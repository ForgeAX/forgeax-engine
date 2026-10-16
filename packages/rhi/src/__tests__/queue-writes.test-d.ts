// AC-08 (Q5) — RhiQueue.writeTexture + copyExternalImageToTexture Pick<spec>
// narrow type-layer assertions.
//
// D-P5 (plan-strategy §spec-rename) — the spec evolved field-info wrappers;
// pre-rename names (authored Jan 2024, retired Apr 2026) are no longer
// present in @webgpu/types 0.1.69 and the rhi interface now uses the
// authoritative new names (GPUCopyExternalImageSourceInfo +
// GPUCopyExternalImageDestInfo per W3C WebGPU CR Apr 2026); any regression
// would surface as TS2304 at type lookup. Historical rename context lives
// in .forgeax-harness/forgeax-loop/feat-20260511-asset-system-v1/research.md
// D-P5 + requirements research Finding 1(a) + Finding 3(a); the pre-rename
// names are deliberately NOT quoted here so the `GPUImg*` grep gate
// (feat-20260511-asset-system-v1 / w32) returns 0 hits repo-wide.
//
// w17 contract:
//   (a) writeTexture(destination, data, dataLayout, size) where:
//       destination is Pick<GPUTexelCopyTextureInfo, ...> (NOT verbatim spec);
//       dataLayout is Pick<GPUTexelCopyBufferLayout, ...>.
//   (b) copyExternalImageToTexture(source, destination, copySize) where:
//       source is Pick<GPUCopyExternalImageSourceInfo, ...> (spec rename);
//       destination is the opaque-handle ExternalImageTextureDestination.
//   (c) r12-lint Pick<GPU*Descriptor count >= 20 follow-on (verified by w22
//       gate, not this test-d).
//
// Charter: proposition 4 (explicit failure - excess fields trip TS2375 at the
// call site) + proposition 5 (consistent abstraction - dual backends mirror
// the same Pick<> narrowing). Anchors: requirements AC-08; research R-04
// §4.1-§4.3; plan-strategy D-P5 spec rename critical fact.

/// <reference types="@webgpu/types" />

import { describe, expectTypeOf, it } from 'vitest';
import type {
  Buffer,
  ExternalImageTextureDestination,
  Result,
  RhiError,
  RhiQueue,
  Texture,
  TextureView,
  TextureWriteDestination,
} from '../index';

/** Strict structural equality helper. */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe('AC-08 — RhiQueue.writeTexture Pick<spec> narrow', () => {
  it('writeTexture method exists on RhiQueue', () => {
    type Method = RhiQueue['writeTexture'];
    expectTypeOf<Method>().toBeFunction();
  });

  it('writeTexture destination keeps the opaque Texture resource boundary', () => {
    type DestParam = Parameters<RhiQueue['writeTexture']>[0];
    type ExpectedShape = TextureWriteDestination;
    // Strict equality — the descriptor has exactly the four spec fields, but
    // its resource is the RHI-opaque Texture rather than GPUTexture.
    type IsExact = Equals<DestParam, ExpectedShape>;
    expectTypeOf<IsExact>().toEqualTypeOf<true>();
  });

  it('writeTexture dataLayout param strictly equals Pick<GPUTexelCopyBufferLayout, ...>', () => {
    type LayoutParam = Parameters<RhiQueue['writeTexture']>[2];
    type ExpectedShape = Pick<GPUTexelCopyBufferLayout, 'offset' | 'bytesPerRow' | 'rowsPerImage'>;
    type IsExact = Equals<LayoutParam, ExpectedShape>;
    expectTypeOf<IsExact>().toEqualTypeOf<true>();
  });

  it('writeTexture returns Result<void, RhiError>', () => {
    type Ret = ReturnType<RhiQueue['writeTexture']>;
    type IsResult = Equals<Ret, Result<void, RhiError>>;
    expectTypeOf<IsResult>().toEqualTypeOf<true>();
  });
});

describe('AC-08 — RhiQueue.copyExternalImageToTexture Pick<spec> narrow + spec rename', () => {
  it('copyExternalImageToTexture method exists on RhiQueue', () => {
    type Method = RhiQueue['copyExternalImageToTexture'];
    expectTypeOf<Method>().toBeFunction();
  });

  it('source param strictly equals Pick<GPUCopyExternalImageSourceInfo, ...> (spec rename D-P5)', () => {
    type SourceParam = Parameters<RhiQueue['copyExternalImageToTexture']>[0];
    type ExpectedShape = Pick<GPUCopyExternalImageSourceInfo, 'source' | 'origin' | 'flipY'>;
    type IsExact = Equals<SourceParam, ExpectedShape>;
    expectTypeOf<IsExact>().toEqualTypeOf<true>();
  });

  it('destination param keeps the RHI Texture opaque (D-P5)', () => {
    type DestParam = Parameters<RhiQueue['copyExternalImageToTexture']>[1];
    type IsExact = Equals<DestParam, ExternalImageTextureDestination>;
    expectTypeOf<IsExact>().toEqualTypeOf<true>();
  });

  it('copyExternalImageToTexture returns Result<void, RhiError>', () => {
    type Ret = ReturnType<RhiQueue['copyExternalImageToTexture']>;
    type IsResult = Equals<Ret, Result<void, RhiError>>;
    expectTypeOf<IsResult>().toEqualTypeOf<true>();
  });
});

// Sanity peg — keep Buffer / Texture / TextureView in scope so they don't get
// stripped by tree-shake import elision (the rhi entry rolls these up so
// downstream consumers can grep on the forgeax handle names).
type _Peg = { b: Buffer; t: Texture; tv: TextureView };
declare const _peg: _Peg;
void _peg;
