import { FlyControls as OriginalFlyControls } from 'three/examples/jsm/controls/FlyControls.js';
import type { Camera } from 'three/src/Three.Core.js';

export type * from 'three/examples/jsm/controls/FlyControls.js';
/** The original update performs time-scaled movement and requires caller delta. */
export interface FlyControls extends Omit<OriginalFlyControls, 'update'> {
  update(delta: number): void;
}
export const FlyControls = OriginalFlyControls as unknown as Omit<
  typeof OriginalFlyControls,
  'prototype'
> & {
  new (object: Camera, domElement?: HTMLElement | SVGElement | null): FlyControls;
  readonly prototype: FlyControls;
};
