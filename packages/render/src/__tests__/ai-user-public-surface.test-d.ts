import {
  ANTIALIAS_TAA,
  Atmosphere,
  Camera,
  type EnvironmentFrame,
  Fog,
  type FramePlan,
  type FrameReceipt,
  type RenderError,
  type Renderer,
  type TemporalView,
} from '@forgeax/engine-render';
import { expectTypeOf } from 'vitest';

void ANTIALIAS_TAA;
void Atmosphere;
void Camera;
void Fog;

declare const renderer: Renderer;
declare const receipt: FrameReceipt;
declare const environment: EnvironmentFrame;
declare const temporal: TemporalView;
declare const plan: FramePlan;
void renderer;
void receipt;
void environment;
void temporal;
void plan;

expectTypeOf<FrameReceipt['frameId']>().toEqualTypeOf<number>();
expectTypeOf<EnvironmentFrame['source']['kind']>().toEqualTypeOf<'none' | 'image' | 'atmosphere'>();
expectTypeOf<TemporalView['historyVersion']>().toEqualTypeOf<number>();
expectTypeOf<
  Extract<RenderError, { code: 'environment-source-conflict' }>['detail']
>().toEqualTypeOf<{
  readonly owners: readonly {
    readonly kind: 'image' | 'atmosphere';
    readonly entityKey: number;
    readonly sourceKey: string;
  }[];
}>();
expectTypeOf<Extract<RenderError, { code: 'fog-cardinality' }>['detail']>().toEqualTypeOf<{
  readonly count: number;
}>();
