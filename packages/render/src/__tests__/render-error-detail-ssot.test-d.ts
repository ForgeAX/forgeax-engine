import { describe, expectTypeOf, it } from 'vitest';
import type { RenderError } from '../errors/render';
import type {
  AutoExposureError,
  AutoExposureErrorCode,
  AutoExposureErrorDetail,
} from '../pipeline/standard-output/auto-exposure/inspection';
import type {
  FullscreenInputNotFoundDetail,
  PostProcessErrorCode,
  PostProcessErrorDetail,
  PostProcessErrorDetailFor,
  PostProcessError as PostProcessErrorType,
  PostProcessNotFoundDetail,
  PostProcessParamsSizeMismatchDetail,
  PostProcessParamsUpdateSizeMismatchDetail,
  PostProcessPreviouslyRegisteredDetail,
  SsaoBiasNegativeDetail,
  SsaoRadiusNonPositiveDetail,
} from '../post-process-errors';
import { PostProcessError } from '../post-process-errors';

type ExpectedAutoExposureCodes =
  | 'auto-exposure-invalid-parameter'
  | 'auto-exposure-capability-unavailable'
  | 'auto-exposure-stale-generation'
  | 'auto-exposure-stage-failed';
type AutoExposureDetailFor<C extends AutoExposureErrorCode> = Extract<
  AutoExposureError,
  { readonly code: C }
>['detail'];

type ExpectedPostProcessDetails = {
  readonly 'post-process-already-registered': PostProcessPreviouslyRegisteredDetail;
  readonly 'post-process-not-found': PostProcessNotFoundDetail;
  readonly 'fullscreen-input-not-found': FullscreenInputNotFoundDetail;
  readonly 'ssao-radius-non-positive': SsaoRadiusNonPositiveDetail;
  readonly 'ssao-bias-negative': SsaoBiasNegativeDetail;
  readonly 'ssao-parameter-invalid': { readonly paramName: string; readonly value: unknown };
  readonly 'params-size-mismatch': PostProcessParamsSizeMismatchDetail;
  readonly 'params-update-size-mismatch': PostProcessParamsUpdateSizeMismatchDetail;
};

type ExpectedPostProcessCodes = keyof ExpectedPostProcessDetails;
type DetailFor<C extends PostProcessErrorCode> = Extract<
  PostProcessErrorType,
  { readonly code: C }
>['detail'];

describe('render error detail aliases derive from their code resolvers', () => {
  it('keeps auto-exposure error codes and code/detail correlation closed', () => {
    expectTypeOf<AutoExposureErrorCode>().toEqualTypeOf<ExpectedAutoExposureCodes>();
    expectTypeOf<AutoExposureErrorCode>().toEqualTypeOf<AutoExposureError['code']>();
    expectTypeOf<AutoExposureErrorDetail>().toEqualTypeOf<
      AutoExposureDetailFor<AutoExposureErrorCode>
    >();
  });
  it('preserves the complete post-process detail union', () => {
    expectTypeOf<PostProcessErrorDetail>().toEqualTypeOf<
      PostProcessErrorDetailFor<PostProcessErrorCode>
    >();
  });

  it('keeps the closed parameter-validation vocabulary and derives the public code view', () => {
    expectTypeOf<PostProcessErrorCode>().toEqualTypeOf<ExpectedPostProcessCodes>();
    expectTypeOf<ExpectedPostProcessCodes>().toEqualTypeOf<PostProcessErrorCode>();
    expectTypeOf<PostProcessErrorType['code']>().toEqualTypeOf<PostProcessErrorCode>();
    expectTypeOf<PostProcessErrorCode>().toEqualTypeOf<PostProcessErrorType['code']>();
  });

  it('preserves every code/detail correlation in the mapped error view', () => {
    expectTypeOf<DetailFor<'post-process-already-registered'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['post-process-already-registered']
    >();
    expectTypeOf<DetailFor<'post-process-not-found'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['post-process-not-found']
    >();
    expectTypeOf<DetailFor<'fullscreen-input-not-found'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['fullscreen-input-not-found']
    >();
    expectTypeOf<DetailFor<'ssao-radius-non-positive'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['ssao-radius-non-positive']
    >();
    expectTypeOf<DetailFor<'ssao-bias-negative'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['ssao-bias-negative']
    >();
    expectTypeOf<DetailFor<'params-size-mismatch'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['params-size-mismatch']
    >();
    expectTypeOf<DetailFor<'params-update-size-mismatch'>>().toMatchTypeOf<
      ExpectedPostProcessDetails['params-update-size-mismatch']
    >();
  });

  it('rejects unknown codes and mismatched code/detail pairs', () => {
    // @ts-expect-error unknown literals are outside the closed code view.
    const invalidCode: PostProcessErrorCode = 'post-process-not-real';
    void invalidCode;

    new PostProcessError({
      code: 'post-process-not-found',
      // @ts-expect-error the detail must match the selected code.
      detail: { readsKey: 'hdrColor', passName: 'output-transform' },
    });
  });

  it('preserves generic constructor inference for each selected variant', () => {
    const previouslyRegistered = new PostProcessError({
      code: 'post-process-already-registered',
      detail: { id: 'output-transform' },
    });
    expectTypeOf(previouslyRegistered).toEqualTypeOf<
      Extract<PostProcessErrorType, { readonly code: 'post-process-already-registered' }>
    >();
    expectTypeOf(previouslyRegistered.detail.id).toEqualTypeOf<string>();

    const notFound = new PostProcessError({
      code: 'post-process-not-found',
      detail: { id: 'missing' },
    });
    expectTypeOf(notFound).toEqualTypeOf<
      Extract<PostProcessErrorType, { readonly code: 'post-process-not-found' }>
    >();
    expectTypeOf(notFound.detail.id).toEqualTypeOf<string>();
  });

  it('supports exhaustive narrowing across every mapped variant', () => {
    const describe = (error: PostProcessErrorType): string => {
      switch (error.code) {
        case 'post-process-already-registered':
          expectTypeOf(error.detail.id).toEqualTypeOf<string>();
          return error.detail.id;
        case 'post-process-not-found':
          expectTypeOf(error.detail.id).toEqualTypeOf<string>();
          return error.detail.id;
        case 'fullscreen-input-not-found':
          expectTypeOf(error.detail.readsKey).toEqualTypeOf<string>();
          expectTypeOf(error.detail.passName).toEqualTypeOf<string>();
          return `${error.detail.readsKey}:${error.detail.passName}`;
        case 'ssao-radius-non-positive':
          expectTypeOf(error.detail.paramName).toEqualTypeOf<string>();
          expectTypeOf(error.detail.value).toEqualTypeOf<number>();
          return `${error.detail.paramName}:${error.detail.value}`;
        case 'ssao-parameter-invalid':
          expectTypeOf(error.detail.value).toEqualTypeOf<unknown>();
          return error.detail.paramName;
        case 'ssao-bias-negative':
          expectTypeOf(error.detail.paramName).toEqualTypeOf<string>();
          expectTypeOf(error.detail.value).toEqualTypeOf<number>();
          return `${error.detail.paramName}:${error.detail.value}`;
        case 'params-size-mismatch':
          expectTypeOf(error.detail.byteSize).toEqualTypeOf<number>();
          expectTypeOf(error.detail.actualLength).toEqualTypeOf<number>();
          return `${error.detail.byteSize}:${error.detail.actualLength}`;
        case 'params-update-size-mismatch':
          expectTypeOf(error.detail.byteSize).toEqualTypeOf<number>();
          expectTypeOf(error.detail.actualLength).toEqualTypeOf<number>();
          return `${error.detail.byteSize}:${error.detail.actualLength}`;
      }
      const exhaustive: never = error;
      return exhaustive;
    };

    expectTypeOf(describe).returns.toEqualTypeOf<string>();
  });
  it('gives environment and temporal failures detached recovery detail', () => {
    type EnvironmentError = Extract<RenderError, { readonly code: 'environment-source-conflict' }>;
    type FogError = Extract<RenderError, { readonly code: 'fog-cardinality' }>;
    type TemporalError = Extract<RenderError, { readonly code: 'taa-caps-insufficient' }>;
    expectTypeOf<EnvironmentError['detail']>().toHaveProperty('owners');
    expectTypeOf<FogError['detail']>().toHaveProperty('count');
    expectTypeOf<TemporalError['detail']>().toHaveProperty('required');
  });
});
