import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  PostProcessError,
  type PostProcessErrorCode,
  type PostProcessErrorDetail,
  type PostProcessErrorDetailFor,
  type PostProcessError as PostProcessErrorType,
} from '../post-process-errors';

const expectedCodes = [
  'post-process-already-registered',
  'post-process-not-found',
  'fullscreen-input-not-found',
  'ssao-radius-non-positive',
  'ssao-bias-negative',
  'ssao-parameter-invalid',
  'params-size-mismatch',
  'params-update-size-mismatch',
] as const satisfies readonly PostProcessErrorCode[];

type ExpectedCodeUnion = (typeof expectedCodes)[number];

const evidence = [
  {
    code: 'post-process-already-registered',
    error: new PostProcessError({
      code: 'post-process-already-registered',
      detail: { id: 'pkg::duplicate' },
    }),
    expected: 'each post-process id is registered at most once',
    hint: "post-process id 'pkg::duplicate' is already registered; same-id re-register is forbidden. Pick a distinct id (engine builtins use the forgeax:: prefix; user passes use <package>::<id>).",
    message:
      "post-process: post-process-already-registered (post-process id 'pkg::duplicate' is already registered; same-id re-register is forbidden. Pick a distinct id (engine builtins use the forgeax:: prefix; user passes use <package>::<id>).)",
  },
  {
    code: 'post-process-not-found',
    error: new PostProcessError({
      code: 'post-process-not-found',
      detail: { id: 'pkg::missing' },
    }),
    expected: 'typed fullscreen plan references a registered post-process id',
    hint: "no post-process is registered for id 'pkg::missing'. For Engine-owned effects, rebuild the shader manifest with that Engine entry enabled. For custom effects, register 'pkg::missing' with the feature host ({source, reads?}), then reference it from a typed fullscreen RenderFeaturePlan.",
    message:
      "post-process: post-process-not-found (no post-process is registered for id 'pkg::missing'. For Engine-owned effects, rebuild the shader manifest with that Engine entry enabled. For custom effects, register 'pkg::missing' with the feature host ({source, reads?}), then reference it from a typed fullscreen RenderFeaturePlan.)",
  },
  {
    code: 'fullscreen-input-not-found',
    error: new PostProcessError({
      code: 'fullscreen-input-not-found',
      detail: { readsKey: 'hdrColor', passName: 'post-pass' },
    }),
    expected: 'reads key must be a graph-declared colorTarget with TEXTURE_BINDING',
    hint: "fullscreen pass 'post-pass' references reads key 'hdrColor' but that key is not declared as a graph color target, or the target is not sampleable as a texture. First declare graph color target 'hdrColor' with its format and size (or check spelling) before the typed fullscreen pass 'post-pass' reads it. If 'hdrColor' is a depth target, ensure it has TEXTURE_BINDING usage (0x04) and is declared via graph.addColorTarget. Consider switching pipeline if your pipeline does not expose a sampleable depth target.",
    message:
      "post-process: fullscreen-input-not-found (fullscreen pass 'post-pass' references reads key 'hdrColor' but that key is not declared as a graph color target, or the target is not sampleable as a texture. First declare graph color target 'hdrColor' with its format and size (or check spelling) before the typed fullscreen pass 'post-pass' reads it. If 'hdrColor' is a depth target, ensure it has TEXTURE_BINDING usage (0x04) and is declared via graph.addColorTarget. Consider switching pipeline if your pipeline does not expose a sampleable depth target.)",
  },
  {
    code: 'ssao-radius-non-positive',
    error: new PostProcessError({
      code: 'ssao-radius-non-positive',
      detail: { paramName: 'radius', value: -0.25 },
    }),
    expected: 'SSAO radius must be > 0',
    hint: "SSAO parameter 'radius' is -0.25, must be greater than 0. Set config.ssao.radius to a positive value (default 0.5) or disable SSAO with config.ssao.enabled = false.",
    message:
      "post-process: ssao-radius-non-positive (SSAO parameter 'radius' is -0.25, must be greater than 0. Set config.ssao.radius to a positive value (default 0.5) or disable SSAO with config.ssao.enabled = false.)",
  },
  {
    code: 'ssao-bias-negative',
    error: new PostProcessError({
      code: 'ssao-bias-negative',
      detail: { paramName: 'bias', value: -0.1 },
    }),
    expected: 'SSAO bias must be >= 0',
    hint: "SSAO parameter 'bias' is -0.1, must be >= 0. Set config.ssao.bias to a non-negative value (default 0.025) or disable SSAO.",
    message:
      "post-process: ssao-bias-negative (SSAO parameter 'bias' is -0.1, must be >= 0. Set config.ssao.bias to a non-negative value (default 0.025) or disable SSAO.)",
  },
  {
    code: 'params-size-mismatch',
    error: new PostProcessError({
      code: 'params-size-mismatch',
      detail: { byteSize: 8, actualLength: 4 },
    }),
    expected: 'params.byteSize >= 16 and defaultValue.length === byteSize',
    hint: 'params.byteSize is 8 but defaultValue.length is 4. The UBO byteSize must be >= 16 B and defaultValue.length must equal byteSize. Pass a defaultValue Uint8Array whose .length matches byteSize exactly.',
    message:
      'post-process: params-size-mismatch (params.byteSize is 8 but defaultValue.length is 4. The UBO byteSize must be >= 16 B and defaultValue.length must equal byteSize. Pass a defaultValue Uint8Array whose .length matches byteSize exactly.)',
  },
  {
    code: 'params-update-size-mismatch',
    error: new PostProcessError({
      code: 'params-update-size-mismatch',
      detail: { byteSize: 16, actualLength: 12 },
    }),
    expected: 'PostProcessParams.data byteLength === registered params.byteSize',
    hint: 'PostProcessParams.data byteLength is 12 but the registered params.byteSize is 16. The per-frame data-driven write must match the registered byteSize exactly; check the PostProcessParams.data you assign each frame.',
    message:
      'post-process: params-update-size-mismatch (PostProcessParams.data byteLength is 12 but the registered params.byteSize is 16. The per-frame data-driven write must match the registered byteSize exactly; check the PostProcessParams.data you assign each frame.)',
  },
];

describe('PostProcessError policy ownership', () => {
  it('preserves the closed parameter-validation vocabulary owned by this policy', () => {
    expect(expectedCodes).toHaveLength(8);
    expect(new Set(expectedCodes).size).toBe(8);
    expectTypeOf<PostProcessErrorCode>().toEqualTypeOf<ExpectedCodeUnion>();
    expectTypeOf<ExpectedCodeUnion>().toEqualTypeOf<PostProcessErrorCode>();
    const acceptsCode = (code: PostProcessErrorCode): PostProcessErrorCode => code;
    // @ts-expect-error -- the policy-derived closed union rejects unknown codes.
    acceptsCode('post-process-not-real');
  });

  it('preserves every expected value, dynamic hint, and message byte-for-byte', () => {
    for (const { code, error, expected, hint, message } of evidence) {
      expect(error.code).toBe(code);
      expect(error.expected).toBe(expected);
      expect(error.hint).toBe(hint);
      expect(error.message).toBe(message);
    }
  });

  it('preserves correlated constructor inference for representative details', () => {
    const previouslyRegistered = new PostProcessError({
      code: 'post-process-already-registered',
      detail: { id: 'pkg::duplicate' },
    });
    expectTypeOf(previouslyRegistered).toEqualTypeOf<
      Extract<PostProcessErrorType, { readonly code: 'post-process-already-registered' }>
    >();
    expectTypeOf(previouslyRegistered.detail).toEqualTypeOf<
      Extract<PostProcessErrorType, { readonly code: 'post-process-already-registered' }>['detail']
    >();

    const depthInput = new PostProcessError({
      code: 'fullscreen-input-not-found',
      detail: { readsKey: 'depth', passName: 'post-dof' },
    });
    expectTypeOf(depthInput).toEqualTypeOf<
      Extract<PostProcessErrorType, { readonly code: 'fullscreen-input-not-found' }>
    >();
    expectTypeOf(depthInput.detail).toEqualTypeOf<
      Extract<PostProcessErrorType, { readonly code: 'fullscreen-input-not-found' }>['detail']
    >();
    expectTypeOf<PostProcessErrorDetail>().toEqualTypeOf<
      PostProcessErrorDetailFor<PostProcessErrorCode>
    >();

    const readDetail = (error: PostProcessErrorType): string => {
      if (error.code === 'fullscreen-input-not-found') {
        expectTypeOf(error.detail).toEqualTypeOf<
          Extract<PostProcessErrorType, { readonly code: 'fullscreen-input-not-found' }>['detail']
        >();
        return `${error.detail.passName}:${error.detail.readsKey}`;
      }
      if (error.code === 'params-update-size-mismatch') {
        expectTypeOf(error.detail).toEqualTypeOf<
          Extract<PostProcessErrorType, { readonly code: 'params-update-size-mismatch' }>['detail']
        >();
        return `${error.detail.byteSize}:${error.detail.actualLength}`;
      }
      return error.code;
    };

    expect(readDetail(depthInput)).toBe('post-dof:depth');
    expect(
      readDetail(
        new PostProcessError({
          code: 'params-update-size-mismatch',
          detail: { byteSize: 16, actualLength: 12 },
        }),
      ),
    ).toBe('16:12');
  });

  it('preserves Error behavior, own-field order, and descriptors', () => {
    const error = new PostProcessError({
      code: 'params-update-size-mismatch',
      detail: { byteSize: 16, actualLength: 12 },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PostProcessError');
    expect(error.stack).toContain('PostProcessError');
    expect(error.stack).toContain(error.message);
    expect(Object.keys(error)).toEqual(['code', 'expected', 'hint', 'detail', 'name']);

    for (const field of ['name', 'code', 'expected', 'hint', 'detail'] as const) {
      expect(Object.getOwnPropertyDescriptor(error, field)).toMatchObject({
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    expect(Object.getOwnPropertyDescriptor(error, 'stack')).toMatchObject({
      configurable: true,
      enumerable: false,
    });
    expect(typeof Object.getOwnPropertyDescriptor(error, 'stack')?.get).toBe('function');
    expect(typeof Object.getOwnPropertyDescriptor(error, 'stack')?.set).toBe('function');
  });
});
