import type { AmbientOcclusionData } from '@forgeax/engine-render';

export const renderThreePostProcessing = Symbol('renderThreePostProcessing');

export interface ThreePostProcessing {
  readonly ao?: Omit<Partial<AmbientOcclusionData>, 'quality'> & {
    readonly samples: number | undefined;
    readonly downsample?: boolean;
  };
  readonly bloom?: {
    readonly intensity: number;
    readonly radius: number;
    readonly threshold: number;
  };
}
