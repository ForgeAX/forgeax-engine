import type { AmbientOcclusionData } from '@forgeax/engine-render';

import type { Pass } from './addons/postprocessing/Pass';
import type { ThreeFullscreenPass } from './fullscreen-pass';

export const renderThreePostProcessing = Symbol('renderThreePostProcessing');
export const threeFullscreenPass = Symbol('threeFullscreenPass');

export function isThreeFullscreenPass(pass: Pass): pass is ThreeFullscreenPass {
  return threeFullscreenPass in pass;
}

export interface ThreePostProcessing {
  readonly fullscreen?: ThreeFullscreenPass;
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
