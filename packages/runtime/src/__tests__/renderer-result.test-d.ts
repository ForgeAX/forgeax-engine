// w23 — Renderer.draw / ready Result<void, RhiError> shape assertions.
//
// Charter: proposition 4 (explicit failure - Result.err over reject /
// fan-out-only) + proposition 5 (consistent abstraction - draw / ready
// both expose the same .ok discriminator).
//
// Anchors: requirements AC-13 (Renderer.draw/ready Result form);
//          plan-strategy D-P7 break-point #4; w23 test SSOT.

import type {
  FrameReceipt,
  PublishedRenderFrameInput,
  RenderError,
  Renderer,
  RenderFrameInput,
  RenderResult,
  RenderWorldLease,
} from '@forgeax/engine-render';
import { describe, expectTypeOf, it } from 'vitest';

describe('M6 — Renderer.draw returns Result<FrameReceipt, RenderError>', () => {
  it('Renderer.draw(request) return type is Result<FrameReceipt, RenderError>', () => {
    type RetType = ReturnType<Renderer['draw']>;
    expectTypeOf<RetType>().toEqualTypeOf<RenderResult<FrameReceipt, RenderError>>();
  });
});

describe('M6 — Renderer.attach returns a lease and draw consumes it', () => {
  it('Renderer.attach returns RenderWorldLease and draw consumes RenderFrameInput', () => {
    type AttachType = Renderer['attach'];
    type DrawArg = Parameters<Renderer['draw']>[0];
    expectTypeOf<AttachType>().returns.toEqualTypeOf<
      RenderResult<RenderWorldLease, import('@forgeax/engine-render').RenderError>
    >();
    expectTypeOf<DrawArg>().toEqualTypeOf<RenderFrameInput | PublishedRenderFrameInput>();
  });
});
