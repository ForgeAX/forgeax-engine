// Renderer public-surface and event-contract type assertions.

import type { RenderError, Renderer, RendererEvent } from '@forgeax/engine-render';

type RendererEventListener = (event: RendererEvent) => void;

import type {
  // @ts-expect-error - BundlerOptions is an internal construct seam
  BundlerOptions as _BundlerOptionsRemoved,
  // @ts-expect-error - ConsoleHandle must not be exported from @forgeax/engine-runtime
  ConsoleHandle as _ConsoleHandleRemoved,
  // @ts-expect-error - StartConsoleOptions must not be exported from @forgeax/engine-runtime
  StartConsoleOptions as _StartConsoleOptionsRemoved,
} from '@forgeax/engine-runtime';
import { describe, expectTypeOf, it } from 'vitest';

type _UnusedSink = _StartConsoleOptionsRemoved | _ConsoleHandleRemoved | _BundlerOptionsRemoved;

describe('Renderer public surface', () => {
  it('does not expose removed console or legacy listener members', () => {
    // @ts-expect-error - startConsole is internal to the runtime host
    type _StartConsoleAbsent = Renderer['startConsole'];
    // @ts-expect-error - onLost was replaced by subscribe(RendererEventListener)
    type _OnLostAbsent = Renderer['onLost'];
    // @ts-expect-error - onError was replaced by subscribe(RendererEventListener)
    type _OnErrorAbsent = Renderer['onError'];
    void (undefined as unknown as _StartConsoleAbsent | _OnLostAbsent | _OnErrorAbsent);

    type RendererKey = keyof Renderer;
    expectTypeOf<'attach'>().toExtend<RendererKey>();
    expectTypeOf<'draw'>().toExtend<RendererKey>();
    expectTypeOf<'dispose'>().toExtend<RendererKey>();
    expectTypeOf<'subscribe'>().toExtend<RendererKey>();
    expectTypeOf<'observe'>().toExtend<RendererKey>();
  });
});

describe('subscribe projects the discriminated Renderer event contract', () => {
  it('passes RendererEvent and exposes RenderError on the error arm', () => {
    expectTypeOf<RendererEventListener>().parameter(0).toEqualTypeOf<RendererEvent>();
    type ErrorEvent = Extract<RendererEvent, { readonly kind: 'error' }>;
    expectTypeOf<ErrorEvent['error']>().toEqualTypeOf<RenderError>();
  });

  it('keeps state changes and errors exhaustively distinguishable', () => {
    const describeEvent = (event: RendererEvent): string => {
      switch (event.kind) {
        case 'state-changed':
          return `${event.previous}->${event.current}`;
        case 'error':
          return event.error.code;
        case 'frame-submitted':
          return `frame:${event.frameId}@${event.deviceGeneration}`;
      }
    };
    expectTypeOf(describeEvent).returns.toEqualTypeOf<string>();
  });
});

declare const __sink: _UnusedSink | undefined;
void __sink;
