import { expectTypeOf, test } from 'vitest';
import type { ComponentNotDefinedError, EcsErrorCode, EcsErrorDetail } from '../errors';
import type { EcsError } from '../world';

test('every World failure code belongs to the public error code union', () => {
  expectTypeOf<EcsError['code']>().toExtend<EcsErrorCode>();
});

test('error detail projections preserve the declaring class payload', () => {
  type Detail = Extract<EcsErrorDetail, { code: 'component-not-defined' }>;
  expectTypeOf<Detail>().toExtend<ComponentNotDefinedError['detail']>();
  expectTypeOf<ComponentNotDefinedError['detail']>().toExtend<Omit<Detail, 'code'>>();
});
