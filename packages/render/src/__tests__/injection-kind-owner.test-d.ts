import { expectTypeOf, it } from 'vitest';

import { appendInjection, INJECTION_KIND_LENGTHS, type InjectionKind } from '../pbr-pipeline';

it('derives InjectionKind from the public length-map keys', () => {
  expectTypeOf<InjectionKind>().toEqualTypeOf<keyof typeof INJECTION_KIND_LENGTHS>();
  expectTypeOf<InjectionKind>().toEqualTypeOf<'shadow' | 'ibl' | 'transmission'>();
  expectTypeOf<'unknown'>().not.toExtend<InjectionKind>();
});

it('keeps the public map assignability and appendInjection narrowing', () => {
  expectTypeOf(INJECTION_KIND_LENGTHS).toMatchTypeOf<Readonly<Record<InjectionKind, number>>>();
  expectTypeOf(appendInjection).parameter(1).toEqualTypeOf<InjectionKind>();
  expectTypeOf(appendInjection([], 'transmission')).toEqualTypeOf<GPUBindGroupLayoutEntry[]>();
});
