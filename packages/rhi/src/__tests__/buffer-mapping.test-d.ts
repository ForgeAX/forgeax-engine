// RhiBuffer mapAsync / mapState surface + MappedBuffer brand method form.
//
// K-1 decision (plan-strategy §2): mapAsync mode parameter is the raw
// GPUMapModeFlags bitmask (NOT a closed union 'read' | 'write'). spec mirror
// stance (research §4.2 + W3C WebGPU §buffer-mapping spec anchor).
//
// D-P2 #6 (feat-20260511-rhi-spec-realign-aggressive M1): mapAsync resolves
// to `Promise<Result<MappedBuffer, RhiError>>`; `getMappedRange` and `unmap`
// migrated from `Buffer` -> `MappedBuffer` method form (this: MappedBuffer
// implicit guard). The previous top-level Buffer.getMappedRange / Buffer.unmap
// are removed.
//
// Charter: proposition 1 (progressive disclosure - one read shows the buffer
// surface) + proposition 3 (machine-readable union > prose) + proposition 4
// (explicit failure - state mismatch surfaces TS2339 at the call site, not
// runtime panic).
//
// Anchors: requirements AC-11 (MappedBuffer brand) + research §4.1 / §4.2 /
//          §4.4; plan-strategy §7.1 + D-P2 #6; plan-decisions OQ-5 (unmap +
//          re-mapAsync re-attach path).

/// <reference types="@webgpu/types" />

import { describe, expectTypeOf, it } from 'vitest';
import type { Buffer, MappedBuffer, Result, RhiError } from '../index';

/** Strict structural equality helper. */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

describe('Buffer mapAsync surface + MappedBuffer brand methods', () => {
  it('mapAsync(mode: GPUMapModeFlags, offset?, size?) returns Promise<Result<MappedBuffer, RhiError>>', () => {
    type Method = Buffer['mapAsync'];
    expectTypeOf<Method>().toBeFunction();
    type Expected = (
      mode: GPUMapModeFlags,
      offset?: number | undefined,
      size?: number | undefined,
    ) => Promise<Result<MappedBuffer, RhiError>>;
    expectTypeOf<Expected>().toMatchTypeOf<Method>();
  });

  it('mapAsync mode parameter is the raw GPUMapModeFlags bitmask (K-1 decision)', () => {
    type ModeArg = Parameters<Buffer['mapAsync']>[0];
    expectTypeOf<ModeArg>().toEqualTypeOf<GPUMapModeFlags>();
    type ClosedUnion = 'read' | 'write';
    type IsClosedUnion = ModeArg extends ClosedUnion ? true : false;
    expectTypeOf<IsClosedUnion>().toEqualTypeOf<false>();
  });

  it('MappedBuffer.getMappedRange returns Result<ArrayBuffer, RhiError>', () => {
    type Method = MappedBuffer['getMappedRange'];
    expectTypeOf<Method>().toBeFunction();
    type Expected = (
      offset?: number | undefined,
      size?: number | undefined,
    ) => Result<ArrayBuffer, RhiError>;
    expectTypeOf<Expected>().toMatchTypeOf<Method>();
  });

  it('MappedBuffer.unmap returns void (spec silent no-op)', () => {
    type Method = MappedBuffer['unmap'];
    expectTypeOf<Method>().toBeFunction();
    type Expected = () => void;
    expectTypeOf<Expected>().toMatchTypeOf<Method>();
    type IsResultShape =
      ReturnType<MappedBuffer['unmap']> extends Result<unknown, unknown> ? true : false;
    expectTypeOf<IsResultShape>().toEqualTypeOf<false>();
  });

  it("mapState getter exposes the closed union 'unmapped' | 'pending' | 'mapped'", () => {
    expectTypeOf<Buffer['mapState']>().toEqualTypeOf<'unmapped' | 'pending' | 'mapped'>();
  });

  it('mapState writes are rejected at compile time (readonly)', () => {
    type Writable<T> = { -readonly [K in keyof T]: T[K] };
    type IsReadonlyMapState = Equals<Buffer, Writable<Buffer>>;
    expectTypeOf<IsReadonlyMapState>().toEqualTypeOf<false>();
  });

  it('MappedBuffer is a structural superset of Buffer (D-P2 #6 brand)', () => {
    expectTypeOf<MappedBuffer>().toMatchTypeOf<Buffer>();
  });
});
