// w2 type-level - RhiCommandEncoder spec method-set alignment with
// `@webgpu/types` GPUCommandEncoder (research F-1 / plan-strategy D-S4).
//
// Asserts (will be RED until w3 lands the impl):
// - 12 spec methods (9 direct + 3 GPUDebugCommandsMixin) plus one ForgeaX
//   compound operation exist on RhiCommandEncoder
// - `copyBufferToBuffer` exposes both spec overloads (3-arg shorthand + 5-arg full form)
// - `finish()` returns Result<CommandBuffer, RhiError>
// - method NAMES align byte-for-byte with `@webgpu/types` GPUCommandEncoder
//
// Charter mapping: proposition 1 (progressive disclosure) + proposition 3
// (machine-readable union > prose) + proposition 5 (consistent abstraction).

import { describe, expectTypeOf, it } from 'vitest';
import type {
  Buffer,
  CommandBuffer,
  ComputePassDescriptor,
  QuerySet,
  Result,
  RhiCommandEncoder,
  RhiError,
} from '../index';

describe('w2 - RhiCommandEncoder spec method set (12 spec + 1 compound)', () => {
  it('exposes beginRenderPass(desc): RhiRenderPassEncoder', () => {
    expectTypeOf<RhiCommandEncoder['beginRenderPass']>().toBeFunction();
  });

  it('exposes beginComputePass(desc?): RhiComputePassEncoder', () => {
    expectTypeOf<RhiCommandEncoder['beginComputePass']>().toBeFunction();
  });

  it('exposes encodeEmptyComputePass(desc): void as a ForgeaX compound operation', () => {
    type Expected = (desc: ComputePassDescriptor) => void;
    expectTypeOf<RhiCommandEncoder['encodeEmptyComputePass']>().toMatchTypeOf<Expected>();
  });

  it('exposes copyBufferToBuffer (5-arg full form per spec)', () => {
    // 5-arg overload must be callable (research F-1 finding):
    //   copyBufferToBuffer(src, srcOffset, dst, dstOffset, size): void
    type FullForm = (
      source: Buffer,
      sourceOffset: number,
      destination: Buffer,
      destinationOffset: number,
      size: number,
    ) => void;
    type CallSignature5 = RhiCommandEncoder['copyBufferToBuffer'] extends FullForm ? true : false;
    expectTypeOf<CallSignature5>().toEqualTypeOf<true>();
  });

  it('exposes copyBufferToBuffer (3-arg shorthand overload per spec)', () => {
    // 3-arg overload (size optional):
    //   copyBufferToBuffer(src, dst, size?): void
    type Shorthand = (source: Buffer, destination: Buffer, size?: number | undefined) => void;
    type CallSignature3 = RhiCommandEncoder['copyBufferToBuffer'] extends Shorthand ? true : false;
    expectTypeOf<CallSignature3>().toEqualTypeOf<true>();
  });

  it('exposes copyBufferToTexture(source, destination, copySize)', () => {
    expectTypeOf<RhiCommandEncoder['copyBufferToTexture']>().toBeFunction();
  });

  it('exposes copyTextureToBuffer(source, destination, copySize)', () => {
    expectTypeOf<RhiCommandEncoder['copyTextureToBuffer']>().toBeFunction();
  });

  it('exposes copyTextureToTexture(source, destination, copySize)', () => {
    expectTypeOf<RhiCommandEncoder['copyTextureToTexture']>().toBeFunction();
  });

  it('exposes clearBuffer(buffer, offset?, size?)', () => {
    type Method = RhiCommandEncoder['clearBuffer'];
    expectTypeOf<Method>().toBeFunction();
    type Expected = (
      buffer: Buffer,
      offset?: number | undefined,
      size?: number | undefined,
    ) => void;
    expectTypeOf<Expected>().toMatchTypeOf<Method>();
  });

  it('exposes resolveQuerySet (capability-gated placeholder per D-S4)', () => {
    type Method = RhiCommandEncoder['resolveQuerySet'];
    expectTypeOf<Method>().toBeFunction();
    type Expected = (
      querySet: QuerySet,
      firstQuery: number,
      queryCount: number,
      destination: Buffer,
      destinationOffset: number,
    ) => Result<void, RhiError>;
    expectTypeOf<Expected>().toMatchTypeOf<Method>();
  });

  it('exposes pushDebugGroup(label) (GPUDebugCommandsMixin)', () => {
    expectTypeOf<RhiCommandEncoder['pushDebugGroup']>().toBeFunction();
  });

  it('exposes popDebugGroup() (GPUDebugCommandsMixin)', () => {
    expectTypeOf<RhiCommandEncoder['popDebugGroup']>().toBeFunction();
  });

  it('exposes insertDebugMarker(label) (GPUDebugCommandsMixin)', () => {
    expectTypeOf<RhiCommandEncoder['insertDebugMarker']>().toBeFunction();
  });

  it('finish() returns Result<CommandBuffer, RhiError>', () => {
    expectTypeOf<RhiCommandEncoder['finish']>().returns.toEqualTypeOf<
      Result<CommandBuffer, RhiError>
    >();
  });
});
