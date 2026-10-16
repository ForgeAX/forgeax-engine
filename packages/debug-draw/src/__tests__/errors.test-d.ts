import { expectTypeOf } from 'vitest';
import type {
  BufferAllocationFailedDetail,
  DebugDrawError,
  DebugDrawErrorCode,
  DebugDrawErrorDetail,
  FlushedAfterDestroyDetail,
  PipelineCreateFailedDetail,
  ViewProjRequiredDetail,
} from '../errors';

const pipelineCreateFailed: DebugDrawError = {
  code: 'pipeline-create-failed',
  expected: 'expected',
  hint: 'hint',
  detail: { rhiError: 'shader compile failed' },
};
const bufferAllocationFailed: DebugDrawError = {
  code: 'buffer-allocation-failed',
  expected: 'expected',
  hint: 'hint',
  detail: { rhiError: 'out of memory' },
};
const flushedAfterDestroy: DebugDrawError = {
  code: 'flushed-after-destroy',
  expected: 'expected',
  hint: 'hint',
  detail: {},
};
const viewProjRequired: DebugDrawError = {
  code: 'viewProj-required',
  expected: 'expected',
  hint: 'hint',
  detail: {},
};

// @ts-expect-error -- this outer code requires its RHI failure payload.
const missingPayload: DebugDrawError = {
  code: 'pipeline-create-failed',
  expected: 'expected',
  hint: 'hint',
  detail: {},
};
const phantomCode: DebugDrawError = {
  code: 'flushed-after-destroy',
  expected: 'expected',
  hint: 'hint',
  // @ts-expect-error -- empty details cannot repeat the outer discriminator.
  detail: { code: 'flushed-after-destroy' },
};

void [
  pipelineCreateFailed,
  bufferAllocationFailed,
  flushedAfterDestroy,
  viewProjRequired,
  missingPayload,
  phantomCode,
];

expectTypeOf<DebugDrawErrorCode>().toEqualTypeOf<
  | 'pipeline-create-failed'
  | 'buffer-allocation-failed'
  | 'flushed-after-destroy'
  | 'viewProj-required'
>();

expectTypeOf<DebugDrawErrorDetail>().toEqualTypeOf<
  | PipelineCreateFailedDetail
  | BufferAllocationFailedDetail
  | FlushedAfterDestroyDetail
  | ViewProjRequiredDetail
>();

function describeError(error: DebugDrawError): string {
  switch (error.code) {
    case 'pipeline-create-failed':
      expectTypeOf(error.detail).toEqualTypeOf<PipelineCreateFailedDetail>();
      expectTypeOf(error.detail.rhiError).toEqualTypeOf<string>();
      return `pipeline:${error.detail.rhiError}`;
    case 'buffer-allocation-failed':
      expectTypeOf(error.detail).toEqualTypeOf<BufferAllocationFailedDetail>();
      expectTypeOf(error.detail.rhiError).toEqualTypeOf<string>();
      return `buffer:${error.detail.rhiError}`;
    case 'flushed-after-destroy':
      expectTypeOf(error.detail).toEqualTypeOf<FlushedAfterDestroyDetail>();
      return error.code;
    case 'viewProj-required':
      expectTypeOf(error.detail).toEqualTypeOf<ViewProjRequiredDetail>();
      return error.code;
  }

  const unreachable: never = error;
  return unreachable;
}

expectTypeOf(describeError).returns.toEqualTypeOf<string>();
