// types-m2.test-d.ts -- compile-time assertions for M2 / TASK-009.
//
// feat-20260608-create-app-param-surface-trim / M2 covers three interface
// reshapes simultaneously, and AC-13 requires that they all be visible to
// AI users at compile time:
//
//   AC-06: RendererOptions does NOT carry `shaderManifestUrl`. After M2,
//          shader-manifest injection lives on the third-arg BundlerOptions.
//   AC-07: CreateAppOptions is self-describing -- it does NOT carry
//          `clearColor` (M1 already deleted that on RendererOptions, and
//          M2 stops `extends RendererOptions`) and does NOT carry
//          `shaderManifestUrl` (it routes through the third arg).
//   AC-13: BundlerOptions['shaderManifestUrl'] is the canonical optional
//          string slot for the manifest URL.
//
// charter awareness:
//   F1 + P1: AI users discover the contract via tsc, not docs. A
//            misplaced field surfaces as a TS2353 excess-property error
//            with a precise file:line, not as a silent runtime no-op.
//   P3 explicit failure: structured compile-time diagnostics; no
//            string-message contract.

import type { RendererOptions } from '@forgeax/engine-render';
import { describe, expectTypeOf, it } from 'vitest';
import type { BundlerOptions, CreateAppOptions } from '../index';

describe('RendererOptions surface after M2 (AC-06)', () => {
  it('RendererOptions does not carry `shaderManifestUrl`', () => {
    type Keys = keyof RendererOptions;
    type HasField = 'shaderManifestUrl' extends Keys ? true : false;
    expectTypeOf<HasField>().toEqualTypeOf<false>();
  });

  it('passing `shaderManifestUrl` as a RendererOptions object literal is a TS2353 error', () => {
    // @ts-expect-error -- 'shaderManifestUrl' is no longer assignable to RendererOptions
    const opts: RendererOptions = { shaderManifestUrl: '/shaders/manifest.json' };
    void opts;
  });
});

describe('BundlerOptions surface (AC-13)', () => {
  it('BundlerOptions exposes `shaderManifestUrl?: string`', () => {
    expectTypeOf<BundlerOptions['shaderManifestUrl']>().toEqualTypeOf<string | undefined>();
  });

  it('BundlerOptions accepts a populated literal at the call site', () => {
    const bundler: BundlerOptions = { shaderManifestUrl: '/shaders/manifest.json' };
    void bundler;
  });

  it('BundlerOptions accepts the empty literal (all fields optional)', () => {
    const bundler: BundlerOptions = {};
    void bundler;
  });
});

describe('CreateAppOptions self-describing surface (AC-07)', () => {
  it('CreateAppOptions does not carry `clearColor`', () => {
    type Keys = keyof CreateAppOptions;
    type HasField = 'clearColor' extends Keys ? true : false;
    expectTypeOf<HasField>().toEqualTypeOf<false>();
  });

  it('CreateAppOptions does not carry `shaderManifestUrl`', () => {
    type Keys = keyof CreateAppOptions;
    type HasField = 'shaderManifestUrl' extends Keys ? true : false;
    expectTypeOf<HasField>().toEqualTypeOf<false>();
  });

  it('passing `clearColor` to CreateAppOptions is a TS2353 error', () => {
    // @ts-expect-error -- 'clearColor' is no longer assignable to CreateAppOptions
    const opts: CreateAppOptions = { clearColor: [0, 0, 0, 1] };
    void opts;
  });

  it('passing `shaderManifestUrl` to CreateAppOptions is a TS2353 error', () => {
    // @ts-expect-error -- 'shaderManifestUrl' belongs to BundlerOptions, not CreateAppOptions
    const opts: CreateAppOptions = { shaderManifestUrl: '/shaders/manifest.json' };
    void opts;
  });
});
