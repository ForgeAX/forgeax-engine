// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=6):
//   - packages/rhi/src/__tests__/caps-backend-kind.test.ts
//   - packages/rhi/src/__tests__/createBindGroup.test.ts
//   - packages/rhi/src/__tests__/createPipelineLayout.test.ts
//   - packages/rhi/src/__tests__/error-codes-exhaustive.test.ts
//   - packages/rhi/src/__tests__/errors.test.ts
//   - packages/rhi/src/__tests__/limit-exceeded-detail.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Note: merged from src/__tests__/ into __tests__/; import paths adjusted (../ → ../src/).

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type BindGroup,
  type BindGroupDescriptor,
  type BindGroupLayout,
  type LimitExceededDetail,
  type PipelineLayout,
  type PipelineLayoutDescriptor,
  type RenderPipeline,
  type Result,
  type RhiDevice,
  type RhiErrorCode,
  err,
  ok,
  RhiError,
} from '../src/errors';
import type { RhiCaps } from '../src/index';

{
  // ─── from caps-backend-kind.test.ts ───

  describe('caps-backend-kind.test.ts', () => {
    describe('RhiCaps.backendKind — 4-member closed union', () => {
      it('backendKind is a string-literal union of exactly 4 members', () => {
        expectTypeOf<RhiCaps['backendKind']>().toEqualTypeOf<
          'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null'
        >();
      });

      it('backendKind is readonly (exactOptionalPropertyTypes enforces fill)', () => {
        expectTypeOf<(caps: RhiCaps) => typeof caps.backendKind>().toBeCallableWith({} as RhiCaps);
      });

      it('exhaustive switch over backendKind compiles without default', () => {
        function handleBackend(kind: RhiCaps['backendKind']): string {
          switch (kind) {
            case 'webgpu':
              return 'spec-managed barriers';
            case 'wgpu-native':
              return 'explicit barriers';
            case 'wgpu-webgl2':
              return 'GL implicit sync, no barriers';
            case 'null':
              return 'headless no-op backend';
          }
        }
        expect(handleBackend('webgpu')).toBe('spec-managed barriers');
        expect(handleBackend('wgpu-native')).toBe('explicit barriers');
        expect(handleBackend('wgpu-webgl2')).toBe('GL implicit sync, no barriers');
        expect(handleBackend('null')).toBe('headless no-op backend');
      });
    });
  });
}

{
  // ─── from createBindGroup.test.ts ───

  describe('createBindGroup.test.ts', () => {
    describe('w2 type-level - BindGroupDescriptor field set === Pick<GPUBindGroupDescriptor, ...>', () => {
      it('has exactly the keys label / layout / entries', () => {
        type ExpectedKeys = 'label' | 'layout' | 'entries';
        expectTypeOf<keyof BindGroupDescriptor>().toEqualTypeOf<ExpectedKeys>();
      });

      it('label field type aligns with spec (string | undefined)', () => {
        type LabelForgeaX = NonNullable<BindGroupDescriptor['label']>;
        type LabelSpec = NonNullable<GPUBindGroupDescriptor['label']>;
        expectTypeOf<LabelForgeaX>().toEqualTypeOf<LabelSpec>();
      });

      it('layout field type aligns with forgeax BindGroupLayout opaque handle', () => {
        type LayoutForgeaX = NonNullable<BindGroupDescriptor['layout']>;
        expectTypeOf<LayoutForgeaX>().toEqualTypeOf<BindGroupLayout>();
      });

      it('entries field is iterable per forgeax BindGroupEntry (D-P2 #5 tagged union)', () => {
        type EntriesForgeaX = NonNullable<BindGroupDescriptor['entries']>;
        type EntriesElem = EntriesForgeaX extends Iterable<infer T> ? T : never;
        expectTypeOf<EntriesElem>().toMatchTypeOf<{ binding: number; resource: { kind: string } }>();
      });

      it('S-7 optional shape: label uses `?: T | undefined`', () => {
        const layoutHandle = {} as unknown as BindGroupLayout;
        const entries: BindGroupDescriptor['entries'] = [];
        const _omitted: BindGroupDescriptor = { layout: layoutHandle, entries };
        const _explicit: BindGroupDescriptor = {
          label: undefined,
          layout: layoutHandle,
          entries,
        };
        void _omitted;
        void _explicit;
      });
    });

    describe('w2 type-level - RhiDevice.createBindGroup signature', () => {
      it('returns Result<BindGroup, RhiError>', () => {
        type Sig = RhiDevice['createBindGroup'];
        type Ret = ReturnType<Sig>;
        expectTypeOf<Ret>().toEqualTypeOf<Result<BindGroup, RhiError>>();
      });

      it('takes a BindGroupDescriptor as the sole parameter', () => {
        type Sig = RhiDevice['createBindGroup'];
        type Params = Parameters<Sig>;
        expectTypeOf<Params>().toEqualTypeOf<[BindGroupDescriptor]>();
      });
    });

    describe('w2 runtime - Result<BindGroup, RhiError> err paths use existing 3 codes', () => {
      it("'feature-not-enabled' err is constructible without introducing new code", () => {
        const e: Result<BindGroup, RhiError> = err(
          new RhiError({
            code: 'feature-not-enabled',
            expected: `feature \${name} to be enabled`,
            hint: `verify device.features.\${name} before calling createBindGroup`,
          }),
        );
        expect(e.ok).toBe(false);
        if (e.ok) return;
        expect(e.error.code).toBe('feature-not-enabled');
      });

      it("'limit-exceeded' err is constructible (e.g. maxBindingsPerBindGroup overrun)", () => {
        const e: Result<BindGroup, RhiError> = err(
          new RhiError({
            code: 'limit-exceeded',
            expected: 'entries.length to be within device.limits.maxBindingsPerBindGroup',
            hint: 'verify device.limits.maxBindingsPerBindGroup before populating entries',
          }),
        );
        expect(e.ok).toBe(false);
        if (e.ok) return;
        expect(e.error.code).toBe('limit-exceeded');
      });

      it("'webgpu-runtime-error' err is constructible (silent-skip fan-out root)", () => {
        const e: Result<BindGroup, RhiError> = err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'underlying device.createBindGroup to succeed',
            hint: 'check chromium WebGPU flags / lavapipe Vulkan ICD; see plan-strategy K-9',
          }),
        );
        expect(e.ok).toBe(false);
        if (e.ok) return;
        expect(e.error.code).toBe('webgpu-runtime-error');
      });

      it('Result.ok branch carries an opaque BindGroup handle (no internal GPU fields exposed)', () => {
        const handle = {} as unknown as BindGroup;
        const r: Result<BindGroup, RhiError> = ok(handle);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toBe(handle);
      });
    });

    describe('w2 sanity - createBindGroup distinct from createBindGroupLayout / createPipelineLayout / createRenderPipeline', () => {
      it('createBindGroupLayout / createPipelineLayout / createRenderPipeline still exist on RhiDevice', () => {
        type BglRet = ReturnType<RhiDevice['createBindGroupLayout']>;
        type PlRet = ReturnType<RhiDevice['createPipelineLayout']>;
        type RppRet = ReturnType<RhiDevice['createRenderPipeline']>;
        expectTypeOf<BglRet>().toEqualTypeOf<Result<BindGroupLayout, RhiError>>();
        expectTypeOf<PlRet>().toEqualTypeOf<Result<PipelineLayout, RhiError>>();
        expectTypeOf<RppRet>().toEqualTypeOf<Result<RenderPipeline, RhiError>>();
      });
    });
  });
}

{
  // ─── from createPipelineLayout.test.ts ───

  describe('createPipelineLayout.test.ts', () => {
    describe('w2 type-level - PipelineLayoutDescriptor field set === Pick<GPUPipelineLayoutDescriptor, ...>', () => {
      it('has exactly the keys label / bindGroupLayouts', () => {
        type ExpectedKeys = 'label' | 'bindGroupLayouts';
        expectTypeOf<keyof PipelineLayoutDescriptor>().toEqualTypeOf<ExpectedKeys>();
      });

      it('label field type aligns with spec (string | undefined)', () => {
        type LabelForgeaX = NonNullable<PipelineLayoutDescriptor['label']>;
        type LabelSpec = NonNullable<GPUPipelineLayoutDescriptor['label']>;
        expectTypeOf<LabelForgeaX>().toEqualTypeOf<LabelSpec>();
      });

      it('bindGroupLayouts is an iterable of forgeax BindGroupLayout opaque handles', () => {
        type Bgls = NonNullable<PipelineLayoutDescriptor['bindGroupLayouts']>;
        const sample: BindGroupLayout[] = [];
        expectTypeOf(sample).toMatchTypeOf<Bgls>();
      });

      it('S-7 optional shape: label uses `?: T | undefined`', () => {
        const _omitted: PipelineLayoutDescriptor = { bindGroupLayouts: [] };
        const _explicit: PipelineLayoutDescriptor = {
          label: undefined,
          bindGroupLayouts: [],
        };
        void _omitted;
        void _explicit;
      });
    });

    describe('w2 type-level - RhiDevice.createPipelineLayout signature', () => {
      it('returns Result<PipelineLayout, RhiError>', () => {
        type Sig = RhiDevice['createPipelineLayout'];
        type Ret = ReturnType<Sig>;
        expectTypeOf<Ret>().toEqualTypeOf<Result<PipelineLayout, RhiError>>();
      });

      it('takes a PipelineLayoutDescriptor as the sole parameter', () => {
        type Sig = RhiDevice['createPipelineLayout'];
        type Params = Parameters<Sig>;
        expectTypeOf<Params>().toEqualTypeOf<[PipelineLayoutDescriptor]>();
      });
    });

    describe('w2 runtime - Result<PipelineLayout, RhiError> err paths use existing 3 codes', () => {
      it("'feature-not-enabled' err is constructible without introducing new code", () => {
        const e: Result<PipelineLayout, RhiError> = err(
          new RhiError({
            code: 'feature-not-enabled',
            expected: `feature \${name} to be enabled`,
            hint: `verify device.features.\${name} before calling createPipelineLayout`,
          }),
        );
        expect(e.ok).toBe(false);
        if (e.ok) return;
        expect(e.error.code).toBe('feature-not-enabled');
      });

      it("'limit-exceeded' err is constructible (e.g. maxBindGroups overrun)", () => {
        const e: Result<PipelineLayout, RhiError> = err(
          new RhiError({
            code: 'limit-exceeded',
            expected: 'bindGroupLayouts.length to be within device.limits.maxBindGroups',
            hint: 'verify device.limits.maxBindGroups before composing layouts',
          }),
        );
        expect(e.ok).toBe(false);
        if (e.ok) return;
        expect(e.error.code).toBe('limit-exceeded');
      });

      it("'webgpu-runtime-error' err is constructible (silent-skip fan-out root)", () => {
        const e: Result<PipelineLayout, RhiError> = err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'underlying device.createPipelineLayout to succeed',
            hint: 'check chromium WebGPU flags / lavapipe Vulkan ICD; see plan-strategy K-9',
          }),
        );
        expect(e.ok).toBe(false);
        if (e.ok) return;
        expect(e.error.code).toBe('webgpu-runtime-error');
      });

      it('Result.ok branch carries an opaque PipelineLayout handle (brand-only)', () => {
        const handle = {} as unknown as PipelineLayout;
        const r: Result<PipelineLayout, RhiError> = ok(handle);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toBe(handle);
      });
    });
  });
}

{
  // ─── from error-codes-exhaustive.test.ts ───

  const RHI_ERROR_CODES_18: ReadonlySet<RhiErrorCode> = new Set([
    'adapter-unavailable',
    'feature-not-enabled',
    'limit-exceeded',
    'shader-compile-failed',
    'rhi-not-available',
    'webgpu-runtime-error',
    'command-encoder-finished',
    'render-pass-not-ended',
    'queue-submit-failed',
    'queue-write-buffer-out-of-bounds',
    'render-system-no-camera',
    'render-system-multi-camera',
    'render-system-multi-light',
    'asset-not-registered',
    'device-lost',
    'oom',
    'internal-error',
    'hierarchy-broken',
  ]);

  describe('error-codes-exhaustive.test.ts', () => {
    describe('type-level — RhiErrorCode 18 members closed union', () => {
      it('contains command-encoder-finished (D-S3 new member)', () => {
        expectTypeOf<'command-encoder-finished'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('contains render-pass-not-ended (D-S3 new member)', () => {
        expectTypeOf<'render-pass-not-ended'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('contains queue-submit-failed (D-S3 new member)', () => {
        expectTypeOf<'queue-submit-failed'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('contains queue-write-buffer-out-of-bounds (D-S3 new member)', () => {
        expectTypeOf<'queue-write-buffer-out-of-bounds'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('contains render-system-no-camera (D-S7 new member)', () => {
        expectTypeOf<'render-system-no-camera'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('contains render-system-multi-camera (D-S7 new member)', () => {
        expectTypeOf<'render-system-multi-camera'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('contains render-system-multi-light (D-S7 new member)', () => {
        expectTypeOf<'render-system-multi-light'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('contains asset-not-registered (D-S7 new member)', () => {
        expectTypeOf<'asset-not-registered'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('contains hierarchy-broken (w4 asset-system-v1 D-P2 new member)', () => {
        expectTypeOf<'hierarchy-broken'>().toMatchTypeOf<RhiErrorCode>();
      });

      it('union remains closed: rejects non-member literal', () => {
        // @ts-expect-error closed union — 'not-a-real-code' is not a member.
        const _bogus: RhiErrorCode = 'not-a-real-code';
        void _bogus;
      });

      it('exhaustive switch with no default fallback compiles for all 18 members', () => {
        function describeCode(code: RhiErrorCode): string {
          switch (code) {
            case 'adapter-unavailable':
              return 'adapter';
            case 'feature-not-enabled':
              return 'feature';
            case 'limit-exceeded':
              return 'limit';
            case 'shader-compile-failed':
              return 'shader';
            case 'rhi-not-available':
              return 'reserved';
            case 'webgpu-runtime-error':
              return 'webgpu-runtime';
            case 'command-encoder-finished':
              return 'encoder-finished';
            case 'render-pass-not-ended':
              return 'pass-not-ended';
            case 'queue-submit-failed':
              return 'queue-submit';
            case 'queue-write-buffer-out-of-bounds':
              return 'queue-bounds';
            case 'render-system-no-camera':
              return 'no-camera';
            case 'render-system-multi-camera':
              return 'multi-camera';
            case 'render-system-multi-light':
              return 'multi-light';
            case 'asset-not-registered':
              return 'asset-miss';
            case 'device-lost':
              return 'device-lost';
            case 'oom':
              return 'oom';
            case 'internal-error':
              return 'internal-error';
            case 'hierarchy-broken':
              return 'hierarchy-broken';
          }
        }
        expectTypeOf(describeCode).returns.toEqualTypeOf<string>();
      });
    });

    describe('runtime — RhiError instantiation across 18 members', () => {
      it('all 18 members instantiate as RhiError with three readonly fields', () => {
        for (const code of RHI_ERROR_CODES_18) {
          const e = new RhiError({
            code,
            expected: `expected for ${code}`,
            hint: `hint for ${code}`,
          });
          expect(e).toBeInstanceOf(RhiError);
          expect(e.code).toBe(code);
          expect(e.expected.length).toBeGreaterThan(0);
          expect(e.hint.length).toBeGreaterThan(0);
          expect(e.detail).toBeUndefined();
        }
        expect(RHI_ERROR_CODES_18.size).toBe(18);
      });
    });
  });
}

{
  // ─── from errors.test.ts ───

  const RHI_ERROR_CODES_14: ReadonlySet<RhiErrorCode> = new Set([
    'adapter-unavailable',
    'feature-not-enabled',
    'limit-exceeded',
    'shader-compile-failed',
    'rhi-not-available',
    'webgpu-runtime-error',
    'command-encoder-finished',
    'render-pass-not-ended',
    'queue-submit-failed',
    'queue-write-buffer-out-of-bounds',
    'render-system-no-camera',
    'render-system-multi-camera',
    'render-system-multi-light',
    'asset-not-registered',
  ]);

  const D_S3_TEMPLATES = {
    'command-encoder-finished': {
      expected: 'command encoder must not be finished before recording new commands',
      hint: 'create a new command encoder via device.createCommandEncoder() for each frame; do not reuse a finished encoder',
    },
    'render-pass-not-ended': {
      expected:
        'previous render pass must be ended before beginning a new pass or finishing the encoder',
      hint: 'call pass.end() before beginRenderPass() or encoder.finish()',
    },
    'queue-submit-failed': {
      expected:
        'command buffer references must be valid at submit time (not destroyed; not from a different device)',
      hint: 'check if any referenced buffer / pipeline / texture has been destroyed before submit',
    },
    'queue-write-buffer-out-of-bounds': {
      expected:
        'writeBuffer offset + data.byteLength must be <= buffer.size; offset must be 4-byte aligned',
      hint: 'verify offset alignment and bounds: offset (got 8) + data.byteLength (got 32) must be <= buffer.size (got 16)',
    },
  } as const satisfies Record<
    Extract<
      RhiErrorCode,
      | 'command-encoder-finished'
      | 'render-pass-not-ended'
      | 'queue-submit-failed'
      | 'queue-write-buffer-out-of-bounds'
    >,
    { readonly expected: string; readonly hint: string }
  >;

  const D_S7_TEMPLATES = {
    'render-system-no-camera': {
      expected: 'world has at least one entity with Transform + Camera',
      hint: 'world.spawn({ component: Transform, data: { pos: [x, y, z], quat: [x, y, z, w], scale: [x, y, z] } }, { component: Camera, data: { fov, aspect, near, far } }) before renderer.draw(world)',
    },
    'render-system-multi-camera': {
      expected: 'world has exactly one entity with Transform + Camera',
      hint: 'remove duplicate Camera entities or wait for feat-future-multi-viewport',
    },
    'render-system-multi-light': {
      expected: 'DirectionalLight: at most 1 entity; PointLight / SpotLight use the shared Cluster corpus',
      hint: 'keep one DirectionalLight; local lights are admitted through the Cluster transport',
    },
    'asset-not-registered': {
      expected: 'MeshFilter.assetHandle in AssetRegistry',
      hint: 'use HANDLE_CUBE / HANDLE_TRIANGLE imports; custom mesh register path: feat-future-asset-system',
    },
  } as const satisfies Record<
    Extract<
      RhiErrorCode,
      | 'render-system-no-camera'
      | 'render-system-multi-camera'
      | 'render-system-multi-light'
      | 'asset-not-registered'
    >,
    { readonly expected: string; readonly hint: string }
  >;

  describe('errors.test.ts', () => {
    describe('RhiErrorCode runtime - closed union 14 members', () => {
      it('all 14 members instantiate with three readonly string fields', () => {
        for (const code of RHI_ERROR_CODES_14) {
          const e = new RhiError({
            code,
            expected: `expected for ${code}`,
            hint: `hint for ${code}`,
          });
          expect(e).toBeInstanceOf(RhiError);
          expect(e.code).toBe(code);
          expect(typeof e.expected).toBe('string');
          expect(typeof e.hint).toBe('string');
          expect(e.expected.length).toBeGreaterThan(0);
          expect(e.hint.length).toBeGreaterThan(0);
        }
        expect(RHI_ERROR_CODES_14.size).toBe(14);
      });

      it("'webgpu-runtime-error' instantiation + property access (K-9 fan-out double channel root)", () => {
        const e = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'webgpu backend runtime to succeed',
          hint: 'check chromium WebGPU flags / lavapipe Vulkan ICD; see plan-strategy K-7',
        });
        expect(e.code).toBe('webgpu-runtime-error');
        expect(e.detail).toBeUndefined();
        expect(e.message).toContain('webgpu-runtime-error');
        expect(e.name).toBe('RhiError');
      });

      it('AI-user consumption contract: read .code / .expected / .hint properties (no .message string parsing)', () => {
        const e = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'context.configure to succeed',
          hint: 'lavapipe headless cannot configure swap chain; this is a known dev-time skip',
        });
        expect(e.code).toBe('webgpu-runtime-error');
        expect(e.expected).toBe('context.configure to succeed');
        expect(e.hint).toBe(
          'lavapipe headless cannot configure swap chain; this is a known dev-time skip',
        );
      });
    });

    describe('D-S3 4 new members - .expected / .hint template instantiation', () => {
      it("'command-encoder-finished' template generates the locked .expected / .hint copy", () => {
        const t = D_S3_TEMPLATES['command-encoder-finished'];
        const e = new RhiError({
          code: 'command-encoder-finished',
          expected: t.expected,
          hint: t.hint,
        });
        expect(e.code).toBe('command-encoder-finished');
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.message).toContain('command-encoder-finished');
        expect(e.message).toContain(t.expected);
        expect(e.message).toContain(t.hint);
        expect(e.detail).toBeUndefined();
      });

      it("'render-pass-not-ended' template generates the locked .expected / .hint copy", () => {
        const t = D_S3_TEMPLATES['render-pass-not-ended'];
        const e = new RhiError({
          code: 'render-pass-not-ended',
          expected: t.expected,
          hint: t.hint,
        });
        expect(e.code).toBe('render-pass-not-ended');
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.message).toContain('render-pass-not-ended');
        expect(e.detail).toBeUndefined();
      });

      it("'queue-submit-failed' template generates the locked .expected / .hint copy", () => {
        const t = D_S3_TEMPLATES['queue-submit-failed'];
        const e = new RhiError({
          code: 'queue-submit-failed',
          expected: t.expected,
          hint: t.hint,
        });
        expect(e.code).toBe('queue-submit-failed');
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.detail).toBeUndefined();
      });

      it("'queue-write-buffer-out-of-bounds' template generates the locked .expected / .hint copy with dynamic interpolation surface", () => {
        const t = D_S3_TEMPLATES['queue-write-buffer-out-of-bounds'];
        const e = new RhiError({
          code: 'queue-write-buffer-out-of-bounds',
          expected: t.expected,
          hint: t.hint,
        });
        expect(e.code).toBe('queue-write-buffer-out-of-bounds');
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.hint).toContain('offset (got 8)');
        expect(e.hint).toContain('data.byteLength (got 32)');
        expect(e.hint).toContain('buffer.size (got 16)');
        expect(e.detail).toBeUndefined();
      });
    });

    describe('D-S7 4 new members - .expected / .hint template instantiation', () => {
      it("'render-system-no-camera' template generates the locked .expected / .hint copy", () => {
        const t = D_S7_TEMPLATES['render-system-no-camera'];
        const e = new RhiError({
          code: 'render-system-no-camera',
          expected: t.expected,
          hint: t.hint,
        });
        expect(e.code).toBe('render-system-no-camera');
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.message).toContain('render-system-no-camera');
        expect(e.detail).toBeUndefined();
      });

      it("'render-system-multi-camera' template generates the locked .expected / .hint copy", () => {
        const t = D_S7_TEMPLATES['render-system-multi-camera'];
        const e = new RhiError({
          code: 'render-system-multi-camera',
          expected: t.expected,
          hint: t.hint,
        });
        expect(e.code).toBe('render-system-multi-camera');
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.detail).toBeUndefined();
      });

      it("'render-system-multi-light' template documents the remaining directional cardinality rule", () => {
        const t = D_S7_TEMPLATES['render-system-multi-light'];
        const e = new RhiError({
          code: 'render-system-multi-light',
          expected: t.expected,
          hint: t.hint,
        });
        expect(e.code).toBe('render-system-multi-light');
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.detail).toBeUndefined();
        expect(e.expected).toContain('DirectionalLight: at most 1 entity');
        expect(e.expected).toContain('PointLight / SpotLight use the shared Cluster corpus');
        expect(e.hint).toContain('Cluster transport');
      });

      it("'asset-not-registered' template generates the locked .expected / .hint copy", () => {
        const t = D_S7_TEMPLATES['asset-not-registered'];
        const e = new RhiError({
          code: 'asset-not-registered',
          expected: t.expected,
          hint: t.hint,
        });
        expect(e.code).toBe('asset-not-registered');
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.detail).toBeUndefined();
      });
    });

    describe('Round 3 F-P0-1: Result `.unwrap()` / `.unwrapOr()` method chain', () => {
      it('ok(v).unwrap() returns the wrapped value', () => {
        const r = ok(42);
        expect(r.ok).toBe(true);
        expect(r.value).toBe(42);
        expect(r.unwrap()).toBe(42);
      });

      it('ok(v).unwrapOr(default) returns the wrapped value (default ignored)', () => {
        const r = ok(7);
        expect(r.unwrapOr(100)).toBe(7);
      });

      it('err(e).unwrap() throws the underlying error (preserves .code / .expected / .hint)', () => {
        const e = new RhiError({
          code: 'adapter-unavailable',
          expected: 'navigator.gpu.requestAdapter() to return non-null',
          hint: 'check WebGPU flags / lavapipe Vulkan ICD',
        });
        const r = err(e);
        expect(r.ok).toBe(false);
        expect(r.error).toBe(e);
        expect(() => r.unwrap()).toThrow(e);
        try {
          r.unwrap();
          throw new Error('unwrap() should have thrown');
        } catch (caught) {
          expect(caught).toBe(e);
          expect((caught as RhiError).code).toBe('adapter-unavailable');
          expect((caught as RhiError).expected).toBe(
            'navigator.gpu.requestAdapter() to return non-null',
          );
        }
      });

      it('err(e).unwrapOr(default) returns the supplied default (error silently dropped)', () => {
        const e = new RhiError({
          code: 'feature-not-enabled',
          expected: 'caps.timestampQuery === true',
          hint: 'check device.caps.timestampQuery before creating timestamp QuerySets',
          hint: 'check device.caps.timestampQuery before creating timestamp QuerySets or timestamp-enabled pass writes',
        });
        const r = err(e);
        expect(r.unwrapOr(999)).toBe(999);
        expect(r.error).toBe(e);
      });

      it('plain field access (`.ok` / `.value` / `.error`) coexists with method chain', () => {
        const okR = ok('hello');
        const errR = err(new RhiError({ code: 'rhi-not-available', expected: 'x', hint: 'y' }));

        if (okR.ok) expect(okR.value).toBe('hello');
        if (!errR.ok) expect(errR.error.code).toBe('rhi-not-available');

        expect(okR.unwrap()).toBe('hello');
        expect(() => errR.unwrap()).toThrow();
      });
    });

    describe('D-S6 / D-S8 .detail field structure (F-3 contract surface)', () => {
      it("'asset-not-registered' carries .detail = { assetHandle: number }", () => {
        const e = new RhiError({
          code: 'asset-not-registered',
          expected: D_S7_TEMPLATES['asset-not-registered'].expected,
          hint: D_S7_TEMPLATES['asset-not-registered'].hint,
          detail: { assetHandle: 42 },
        });
        expect(e.code).toBe('asset-not-registered');
        expect(e.detail).toBeDefined();
        expect(e.detail).toEqual({ assetHandle: 42 });
        if (e.detail !== undefined && 'assetHandle' in e.detail) {
          expect(typeof e.detail.assetHandle).toBe('number');
        }
      });

      it("'webgpu-runtime-error' carries .detail = { error: RhiError | fallback }", () => {
        const e = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'RenderSystem completes without runtime exception',
          hint: 'check Camera/Material/DirectionalLight values for NaN; report to engine team if persistent',
          detail: { error: { code: 'unknown', message: 'mat4 inversion produced NaN' } },
        });
        expect(e.code).toBe('webgpu-runtime-error');
        expect(e.detail).toBeDefined();
        expect(e.detail).toEqual({
          error: { code: 'unknown', message: 'mat4 inversion produced NaN' },
        });
        if (e.detail !== undefined && 'error' in e.detail) {
          expect(typeof e.detail.error).toBe('object');
          expect('code' in e.detail.error).toBe(true);
          expect('message' in e.detail.error).toBe(true);
        }
      });

      it("preserves nested producer detail on a webgpu-runtime-error fallback", () => {
        const e = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'Renderer initialization preserves pipeline-spec diagnostics',
          hint: 'inspect detail.error.detail.cause',
          detail: {
            error: {
              name: 'PipelineSpecError',
              code: 'pipeline-build-failed',
              message: 'pipeline build failed',
              detail: { cause: { code: 'webgpu-runtime-error' } },
            },
          },
        });
        expect(e.detail).toEqual({
          error: {
            name: 'PipelineSpecError',
            code: 'pipeline-build-failed',
            message: 'pipeline build failed',
            detail: { cause: { code: 'webgpu-runtime-error' } },
          },
        });
      });
    });

    describe("w4 'hierarchy-broken' (18th RhiErrorCode member)", () => {
      it('RhiErrorCode union now contains hierarchy-broken', () => {
        const code: RhiErrorCode = 'hierarchy-broken';
        expect(code).toBe('hierarchy-broken');
      });

      it('RhiError instantiates with code hierarchy-broken + three-field surface', () => {
        const e = new RhiError({
          code: 'hierarchy-broken',
          expected: 'ChildOf component references a live entity in the world',
          hint: 'remove the stale ChildOf via world.removeComponent(entity, ChildOf) before destroying the referenced ancestor',
        });
        expect(e).toBeInstanceOf(RhiError);
        expect(e.code).toBe('hierarchy-broken');
        expect(e.expected).toBe('ChildOf component references a live entity in the world');
        expect(e.hint).toContain('world.removeComponent');
        expect(e.detail).toBeUndefined();
        expect(e.name).toBe('RhiError');
        expect(e.message).toContain('hierarchy-broken');
      });

      it('hierarchy-broken is grep-able in the 18-member closed union', () => {
        const codes: readonly RhiErrorCode[] = [
          'adapter-unavailable',
          'feature-not-enabled',
          'limit-exceeded',
          'shader-compile-failed',
          'rhi-not-available',
          'webgpu-runtime-error',
          'command-encoder-finished',
          'render-pass-not-ended',
          'queue-submit-failed',
          'queue-write-buffer-out-of-bounds',
          'render-system-no-camera',
          'render-system-multi-camera',
          'render-system-multi-light',
          'asset-not-registered',
          'device-lost',
          'oom',
          'internal-error',
          'hierarchy-broken',
        ];
        expect(codes).toHaveLength(18);
        expect(codes).toContain('hierarchy-broken');
        expect(codes[codes.length - 1]).toBe('hierarchy-broken');
      });
    });
  });
}

{
  // ─── from limit-exceeded-detail.test.ts ───

  describe('limit-exceeded-detail.test.ts', () => {
    describe('feat-20260513-instanced-mesh T-M5-2 LimitExceededDetail field reshape (runtime)', () => {
      it('LimitExceededDetail carries { maxStorageBufferBindingSize, requestedBytes } numeric pair', () => {
        const detail: LimitExceededDetail = {
          maxStorageBufferBindingSize: 1024,
          requestedBytes: 65536,
        };
        expect(detail.maxStorageBufferBindingSize).toBe(1024);
        expect(detail.requestedBytes).toBe(65536);
      });

      it('RhiError exposes the new detail field pair via typed property access', () => {
        const detail: LimitExceededDetail = {
          maxStorageBufferBindingSize: 1024,
          requestedBytes: 65536,
        };
        const err = new RhiError({
          code: 'limit-exceeded',
          expected: 'requestedBytes <= maxStorageBufferBindingSize',
          hint: 'reduce instance count or split transforms across multiple Instances entries',
          detail,
        });
        expect(err.code).toBe('limit-exceeded');
        expect(err.detail).toBeDefined();
        const narrowed = err.detail as LimitExceededDetail;
        expect(narrowed.maxStorageBufferBindingSize).toBe(1024);
        expect(narrowed.requestedBytes).toBe(65536);
      });

      it('boundary: maxStorageBufferBindingSize === requestedBytes is a legitimate detail snapshot', () => {
        const detail: LimitExceededDetail = {
          maxStorageBufferBindingSize: 4096,
          requestedBytes: 4096,
        };
        expect(detail.maxStorageBufferBindingSize).toBe(detail.requestedBytes);
      });
    });
  });
}
