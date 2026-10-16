// w4 type-level - RhiRenderPassEncoder spec method-set alignment (research F-2 /
// plan-strategy D-S4: 17 spec stable + 1 setBindGroup overload + 1 unavailable public entry).
//
// Asserts (RED until w5 lands the impl):
//   - 17 spec stable methods exist on RhiRenderPassEncoder
//   - setBindGroup has both overloads (a) array form (b) Uint32Array form
//   - executeBundles is the one unavailable public entry; begin/end occlusion
//     query are real stateful operations. All three methods return
//     Result<void, RhiError> (so AI users can route structured failure at
//     runtime; charter proposition 4 explicit failure).
//   - setImmediates (PROPOSED) is NOT exposed (per D-S4 explicit non-receipt;
//     charter proposition 4: untested features hide behind caps, not surfaces).
//
// Method NAMES align byte-for-byte with `@webgpu/types`
// GPURenderPassEncoder + GPURenderCommandsMixin + GPUBindingCommandsMixin +
// GPUDebugCommandsMixin (research F-2).
//
// Charter mapping: proposition 1 (progressive disclosure: AI sees the full
// spec surface in one read) + proposition 5 (consistent abstraction: spec
// stable methods land here regardless of capability).

import { describe, expectTypeOf, it } from 'vitest';
import type {
  BindGroup,
  Buffer,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  Result,
  RhiError,
  RhiRenderPassEncoder,
  Texture,
  TextureView,
} from '../index';

describe('w4 - RhiRenderPassEncoder spec method set (17 stable + 1 overload + 1 unavailable entry)', () => {
  // 7 already-shipped methods (Round 1 baseline; locked in this closure):
  it('keeps existing setPipeline / setIndexBuffer / setVertexBuffer', () => {
    expectTypeOf<RhiRenderPassEncoder['setPipeline']>().toBeFunction();
    expectTypeOf<RhiRenderPassEncoder['setIndexBuffer']>().toBeFunction();
    expectTypeOf<RhiRenderPassEncoder['setVertexBuffer']>().toBeFunction();
  });

  it('keeps existing draw / drawIndexed / end', () => {
    expectTypeOf<RhiRenderPassEncoder['draw']>().toBeFunction();
    expectTypeOf<RhiRenderPassEncoder['drawIndexed']>().toBeFunction();
    expectTypeOf<RhiRenderPassEncoder['end']>().toBeFunction();
  });

  // 10 new spec stable methods (research F-2; D-S4 IN list):
  it('exposes setViewport(x, y, w, h, minDepth, maxDepth)', () => {
    expectTypeOf<RhiRenderPassEncoder['setViewport']>().toBeFunction();
    type Expected = (
      x: number,
      y: number,
      w: number,
      h: number,
      minDepth: number,
      maxDepth: number,
    ) => void;
    expectTypeOf<Expected>().toMatchTypeOf<RhiRenderPassEncoder['setViewport']>();
  });

  it('exposes setScissorRect(x, y, w, h)', () => {
    expectTypeOf<RhiRenderPassEncoder['setScissorRect']>().toBeFunction();
  });

  it('exposes setBlendConstant(color)', () => {
    expectTypeOf<RhiRenderPassEncoder['setBlendConstant']>().toBeFunction();
  });

  it('exposes setStencilReference(reference)', () => {
    expectTypeOf<RhiRenderPassEncoder['setStencilReference']>().toBeFunction();
  });

  it('exposes drawIndirect(buffer, offset)', () => {
    expectTypeOf<RhiRenderPassEncoder['drawIndirect']>().toBeFunction();
  });

  it('exposes drawIndexedIndirect(buffer, offset)', () => {
    expectTypeOf<RhiRenderPassEncoder['drawIndexedIndirect']>().toBeFunction();
  });

  it('exposes pushDebugGroup / popDebugGroup / insertDebugMarker (DebugCommandsMixin)', () => {
    expectTypeOf<RhiRenderPassEncoder['pushDebugGroup']>().toBeFunction();
    expectTypeOf<RhiRenderPassEncoder['popDebugGroup']>().toBeFunction();
    expectTypeOf<RhiRenderPassEncoder['insertDebugMarker']>().toBeFunction();
  });

  // setBindGroup has 2 overloads per spec:
  it('setBindGroup overload (a): array form (existing)', () => {
    type ArrayForm = (
      index: number,
      bindGroup: BindGroup,
      dynamicOffsets?: readonly number[] | undefined,
    ) => void;
    type HasArrayOverload = RhiRenderPassEncoder['setBindGroup'] extends ArrayForm ? true : false;
    expectTypeOf<HasArrayOverload>().toEqualTypeOf<true>();
  });

  it('setBindGroup overload (b): Uint32Array slice form (new in this closure)', () => {
    type SliceForm = (
      index: number,
      bindGroup: BindGroup,
      dynamicOffsetsData: Uint32Array,
      dynamicOffsetsDataStart: number,
      dynamicOffsetsDataLength: number,
    ) => void;
    type HasSliceOverload = RhiRenderPassEncoder['setBindGroup'] extends SliceForm ? true : false;
    expectTypeOf<HasSliceOverload>().toEqualTypeOf<true>();
  });

  // The unavailable public entry keeps a typed Result so callers can branch on
  // the structured rhi-not-available error until RenderBundle is constructible.
  it('exposes executeBundles (unavailable until RenderBundle is constructible)', () => {
    type Method = RhiRenderPassEncoder['executeBundles'];
    expectTypeOf<Method>().toBeFunction();
    expectTypeOf<Method>().returns.toEqualTypeOf<Result<void, RhiError>>();
  });

  it('exposes beginOcclusionQuery (stateful occlusion-query operation)', () => {
    type Method = RhiRenderPassEncoder['beginOcclusionQuery'];
    expectTypeOf<Method>().toBeFunction();
    expectTypeOf<Method>().returns.toEqualTypeOf<Result<void, RhiError>>();
  });

  it('exposes endOcclusionQuery (stateful occlusion-query operation)', () => {
    type Method = RhiRenderPassEncoder['endOcclusionQuery'];
    expectTypeOf<Method>().toBeFunction();
    expectTypeOf<Method>().returns.toEqualTypeOf<Result<void, RhiError>>();
  });

  it('does NOT expose setImmediates (PROPOSED; D-S4 explicit non-receipt)', () => {
    // Type-level guard: the field must NOT exist on the interface so that
    // AI users see a tsc red signal if they attempt to call it.
    type HasSetImmediates = 'setImmediates' extends keyof RhiRenderPassEncoder ? true : false;
    expectTypeOf<HasSetImmediates>().toEqualTypeOf<false>();
  });

  // Buffer reference smoke (sanity: arg types use forgeax opaque handles).
  it('drawIndirect uses forgeax Buffer (opaque handle, not raw GPUBuffer)', () => {
    type Method = RhiRenderPassEncoder['drawIndirect'];
    type Expected = (indirectBuffer: Buffer, indirectOffset: number) => void;
    expectTypeOf<Expected>().toMatchTypeOf<Method>();
  });
});

// w14 - view narrow Path X breakage point #1 (requirements IN-2 / AC-02 /
// research 8.2): the 4 view fields move from `Texture` (D-S5 temporary
// tightening) to `TextureView` (the spec-aligned target after M1 shipped
// `device.createTextureView`).
//
// Field count breakdown (research 8.2 IMPORTANT box):
//   - 1 direct: RenderPassColorAttachment.view
//   - 1 direct: RenderPassColorAttachment.resolveTarget?
//   - 1 direct: RenderPassDepthStencilAttachment.view
//   - 1 indirect: RenderPassDescriptor.colorAttachments[N].view propagates
//     through the element type of RenderPassColorAttachment (covered by the
//     direct assertion on RenderPassColorAttachment.view).
//
// Red expected state: this block fails tsc -b before w15 lands the narrow
//   (current types are `Texture`; `expectAssignable<TextureView>` fails because
//   Texture and TextureView are disjoint brand types).
// Green expected state (after w15 commit): all expectTypeOf assertions pass.
//
// Charter mapping: proposition 4 (explicit failure: AI users get a tsc red
// signal at the call site instead of a runtime swap) + proposition 5
// (consistent abstraction: the field type matches what `createTextureView`
// returns).
describe('w14 - view narrow Path X (breakage point #1): RenderPassColorAttachment.view / .resolveTarget / RenderPassDepthStencilAttachment.view = TextureView', () => {
  it('RenderPassColorAttachment.view is TextureView (not Texture)', () => {
    type ViewField = RenderPassColorAttachment['view'];
    expectTypeOf<ViewField>().toEqualTypeOf<TextureView>();
  });

  it('RenderPassColorAttachment.view rejects Texture brand', () => {
    type ViewField = RenderPassColorAttachment['view'];
    type TextureAssignsToView = Texture extends ViewField ? true : false;
    expectTypeOf<TextureAssignsToView>().toEqualTypeOf<false>();
  });

  it('RenderPassColorAttachment.resolveTarget is TextureView | undefined (not Texture | undefined)', () => {
    type ResolveTargetField = RenderPassColorAttachment['resolveTarget'];
    expectTypeOf<ResolveTargetField>().toEqualTypeOf<TextureView | undefined>();
  });

  it('RenderPassColorAttachment.resolveTarget rejects Texture brand', () => {
    type ResolveTargetField = NonNullable<RenderPassColorAttachment['resolveTarget']>;
    type TextureAssignsToResolveTarget = Texture extends ResolveTargetField ? true : false;
    expectTypeOf<TextureAssignsToResolveTarget>().toEqualTypeOf<false>();
  });

  it('RenderPassDepthStencilAttachment.view is TextureView (not Texture)', () => {
    type ViewField = RenderPassDepthStencilAttachment['view'];
    expectTypeOf<ViewField>().toEqualTypeOf<TextureView>();
  });

  it('RenderPassDepthStencilAttachment.view rejects Texture brand', () => {
    type ViewField = RenderPassDepthStencilAttachment['view'];
    type TextureAssignsToView = Texture extends ViewField ? true : false;
    expectTypeOf<TextureAssignsToView>().toEqualTypeOf<false>();
  });
});
