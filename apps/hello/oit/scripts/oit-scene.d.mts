import type { Entity, World } from '@forgeax/engine-ecs';

export type Rgb = [number, number, number];
export interface OitProbe {
  readonly name: 'left' | 'right' | 'background' | 'occluded';
  readonly x: number;
  readonly y: number;
}
export const CAMERA_Z: number;
export const BACKGROUND: readonly [number, number, number];
export const OCCLUDER: readonly [number, number, number];
export const OIT_LAYERS: readonly {
  readonly name: 'red' | 'green' | 'blue';
  readonly color: readonly [number, number, number];
  readonly alpha: number;
  readonly tilt: number;
}[];
export const OIT_PROBES: readonly OitProbe[];
export function probePixel(
  probe: OitProbe,
  size: number,
): { readonly px: number; readonly py: number; readonly x: number; readonly y: number };
export function probeReference(
  probe: OitProbe,
  size: number,
): { readonly weighted: Rgb; readonly exact: Rgb };
export function spawnOitScene(
  world: World,
  options?: { readonly order?: readonly number[] },
): {
  readonly camera: Entity;
  spawnLayers(order: readonly number[]): void;
  setTransparency(mode: 'sorted' | 'weighted-blended'): void;
};
