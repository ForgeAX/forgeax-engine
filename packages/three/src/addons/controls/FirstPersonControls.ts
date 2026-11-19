import { FirstPersonControls as OriginalFirstPersonControls } from 'three/examples/jsm/controls/FirstPersonControls.js';
import type { Camera } from 'three/src/Three.Core.js';

export type * from 'three/examples/jsm/controls/FirstPersonControls.js';
/** The original update performs time-scaled movement and requires caller delta. */
export interface FirstPersonControls extends Omit<OriginalFirstPersonControls, 'update'> {
  update(delta: number): void;
}
export const FirstPersonControls = OriginalFirstPersonControls as unknown as Omit<
  typeof OriginalFirstPersonControls,
  'prototype'
> & {
  new (object: Camera, domElement?: HTMLElement | SVGElement | null): FirstPersonControls;
  readonly prototype: FirstPersonControls;
};
