import { testPlatform } from './platform-fixture';
// create-app.test-d.ts -- compile-time assertions for w2 acceptanceCheck.
//
// Anchors:
// - createApp(canvas, opts?) returns
//   Promise<Result<App, AppError | RhiError | EngineEnvironmentError>>
//   per AC-01 (canvas thin wrapper widens the error union with
//   EngineEnvironmentError; M2 plugin-system-unify D-7 widens it with
//   AppError for Cordis activation failures).
// - createApp({ renderer, world }) returns
//   Promise<Result<App, AppError | RhiError>>
//   per AC-02 (assemble form excludes EngineEnvironmentError -- renderer
//   host-managed).
// - 'tagName' in arg dispatch lands the right overload at the call site
//   (HTMLCanvasElement -> canvas form; AppAssembleArgs -> assemble form).
//
// charter awareness:
// - P3 explicit failure: Result envelope shape is type-level (no message strings).
// - P4 consistent abstraction: both routes return the same App handle.

import type { World } from '@forgeax/engine-ecs';
import type { RenderError, Renderer, RendererOptions } from '@forgeax/engine-render';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import { createRenderer, type EngineEnvironmentError } from '@forgeax/engine-runtime';
import type { Result } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { AssetRuntimeAssemblyError } from '../assets-runtime-assembly';
import { createApp as createBrowserApp } from '../browser';
import { type App, type AppError, createApp } from '../index';

describe('createApp double-SSOT entry signatures (w2 acceptanceCheck)', () => {
  it('canvas form returns the App boundary error union', () => {
    const canvas = null as unknown as HTMLCanvasElement;
    const ret = createBrowserApp(canvas);
    expectTypeOf(ret).toEqualTypeOf<
      Promise<Result<App, AppError | RhiError | EngineEnvironmentError | AssetRuntimeAssemblyError>>
    >();
  });

  it('assemble form returns the App boundary error union', () => {
    const renderer = null as unknown as Renderer;
    const world = null as unknown as World;
    const ret = createApp({ platform: testPlatform(), renderer, world });
    expectTypeOf(ret).toEqualTypeOf<
      Promise<Result<App, AppError | RhiError | AssetRuntimeAssemblyError>>
    >();
  });

  it('app.renderer / app.world are reference-equal types at the call site (AC-09)', async () => {
    const renderer = null as unknown as Renderer;
    const world = null as unknown as World;
    const result = await createApp({ platform: testPlatform(), renderer, world });
    if (result.ok) {
      expectTypeOf(result.value.renderer).toEqualTypeOf<Renderer>();
      expectTypeOf(result.value.world).toEqualTypeOf<World>();
    }
  });
});

describe('Runtime createRenderer Result boundary (AC-11)', () => {
  it('requires callers to narrow the construction Result', () => {
    const canvas = null as unknown as HTMLCanvasElement;
    const expected = null as unknown as Promise<
      Result<Renderer, EngineEnvironmentError | RenderError>
    >;
    expectTypeOf(createRenderer(canvas)).toEqualTypeOf(expected);
  });
});

// feat-20260608-create-app-param-surface-trim / M1 / AC-02 + TASK-006:
// `RendererOptions.clearColor` was deleted in this feat. AI users that
// pass `{ clearColor: ... }` to `createRenderer` / `createApp` get a
// TS2353 excess-property error at compile time (no shim, no
// deprecation window per AGENTS.md §Change stance).
describe('RendererOptions.clearColor removal (AC-02 + TASK-006)', () => {
  it('RendererOptions does not carry a `clearColor` field', () => {
    // The keyof of RendererOptions must not include 'clearColor'.
    type Keys = keyof RendererOptions;
    type HasClearColor = 'clearColor' extends Keys ? true : false;
    expectTypeOf<HasClearColor>().toEqualTypeOf<false>();
  });

  it('passing `clearColor` as an object literal is a compile-time error (TS2353)', () => {
    // @ts-expect-error -- 'clearColor' is not assignable to RendererOptions
    const opts: RendererOptions = { clearColor: [0, 0, 0, 1] };
    void opts;
  });
});
