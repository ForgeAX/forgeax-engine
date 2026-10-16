import { expectTypeOf } from 'vitest';
import type { GpuDrivenPreparationError } from '../errors/gpu-driven.js';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw.js';
import type { GpuDrivenPreparationFailureInspection } from '../inspection-types.js';

declare const prepared: PreparedGpuDrivenDraw;
expectTypeOf(prepared.identity).toMatchTypeOf<{
  readonly material: string;
  readonly geometry: string;
  readonly deformation: 'rigid' | 'skin';
}>();
expectTypeOf(prepared.receiptGeneration).toEqualTypeOf<number>();
expectTypeOf(prepared.resourceSlots).toMatchTypeOf<readonly object[]>();

declare const failure: GpuDrivenPreparationError;
expectTypeOf(failure.code).toMatchTypeOf<string>();
expectTypeOf(failure.expected).toEqualTypeOf<string>();
expectTypeOf(failure.hint).toEqualTypeOf<string>();
expectTypeOf(failure.detail.reason).toMatchTypeOf<string>();
expectTypeOf(failure.detail.recovery).toMatchTypeOf<string | undefined>();

declare const inspectionFailure: GpuDrivenPreparationFailureInspection;
expectTypeOf(inspectionFailure.code).toEqualTypeOf(failure.code);
expectTypeOf(inspectionFailure.expected).toEqualTypeOf<string>();
expectTypeOf(inspectionFailure.detail.owner).toMatchTypeOf<
  'material' | 'geometry' | 'skin' | 'generation' | 'shadow'
>();

void prepared;
void failure;
void inspectionFailure;
