import { InteractiveGroup as OriginalInteractiveGroup } from 'three/examples/jsm/interactive/InteractiveGroup.js';
import type { Camera, Group, Raycaster } from 'three/src/Three.Core.js';

/** Pointer picking only consumes the host element, not a WebGL renderer. */
export interface InteractiveGroup extends Group {
  raycaster: Raycaster;
  element: HTMLElement | null;
  camera: Camera | null;
  controllers: Group[];
  listenToPointerEvents(host: { domElement: HTMLElement }, camera: Camera): void;
  onPointerEvent(event: MouseEvent): void;
  listenToXRControllerEvents(controller: Group): void;
  onXRControllerEvent(event: {
    type: 'move' | 'select' | 'selectstart' | 'selectend';
    target: Group;
  }): void;
  disconnectionPointerEvents(): void;
  disconnectXrControllerEvents(): void;
  disconnect(): void;
}
export const InteractiveGroup = OriginalInteractiveGroup as unknown as Omit<
  typeof OriginalInteractiveGroup,
  'prototype'
> & {
  new (): InteractiveGroup;
  readonly prototype: InteractiveGroup;
};
