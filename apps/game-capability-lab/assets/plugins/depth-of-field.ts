import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Camera, DepthOfField, DepthOfFieldQualityValue, DepthOfFieldSideValue } from '@forgeax/engine-render';

/** The game example exercises the Engine-owned camera feature directly. */
export const DEPTH_OF_FIELD_ID = 'forgeax.depth-of-field';

export type DepthOfFieldPreset = 'off' | 'near' | 'far' | 'both';

export interface DepthOfFieldControls {
  readonly focusDistance: number;
  readonly fStop: number;
  readonly sensorHeight: number;
  readonly maxRadiusPixels: number;
  readonly quality: 'low' | 'medium' | 'high';
  readonly blurSide: 'near' | 'far' | 'both';
}

export interface DepthOfFieldSnapshot {
  readonly enabled: boolean;
  readonly mode: 'off' | 'bokeh';
  readonly preset: DepthOfFieldPreset;
  readonly focalDistance: number;
  readonly aperture: number;
  readonly focalLength: number;
  readonly controls: DepthOfFieldControls;
  readonly effect: string;
}

export interface DepthOfFieldHandle {
  /** Compatibility name for the camera entity that owns the component. */
  readonly paramsEntity: EntityHandle;
  readonly installed: boolean;
  readonly error?: string;
  setEnabled(enabled: boolean): void;
  setPreset(preset: DepthOfFieldPreset): void;
  setControls(controls: Partial<DepthOfFieldControls>): void;
  /** Reconcile presence after the example changes camera projection. */
  refresh(): void;
  reset(): void;
  dispose(): void;
  snapshot(): DepthOfFieldSnapshot;
}

const DEFAULT_CONTROLS: DepthOfFieldControls = Object.freeze({
  focusDistance: 7,
  fStop: 1.4,
  sensorHeight: 0.024,
  maxRadiusPixels: 16,
  quality: 'medium',
  blurSide: 'both',
});

function componentData(controls: DepthOfFieldControls) {
  return {
    focusDistance: controls.focusDistance,
    fStop: controls.fStop,
    sensorHeight: controls.sensorHeight,
    maxRadiusPixels: controls.maxRadiusPixels,
    quality: DepthOfFieldQualityValue[controls.quality],
    blurSide: DepthOfFieldSideValue[controls.blurSide],
  } as const;
}

/** Install the ordinary-mesh example through the public Camera component seam. */
export function installDepthOfField(
  world: World,
  camera: EntityHandle,
  initialEnabled: boolean,
): DepthOfFieldHandle {
  let enabled = initialEnabled;
  let controls: DepthOfFieldControls = { ...DEFAULT_CONTROLS };
  const initialControls = { ...controls };
  const sync = (): void => {
    const cameraData = world.get(camera, Camera);
    const canUsePerspective = cameraData.ok && cameraData.value.projection === 0;
    const existing = world.get(camera, DepthOfField);
    if (enabled && canUsePerspective) {
      const data = componentData(controls);
      if (existing.ok) world.set(camera, DepthOfField, data);
      else world.addComponent(camera, { component: DepthOfField, data });
    } else if (existing.ok) {
      world.removeComponent(camera, DepthOfField);
    }
  };
  sync();
  return {
    paramsEntity: camera,
    installed: true,
    setEnabled(next: boolean): void {
      enabled = next;
      sync();
    },
    setPreset(preset: DepthOfFieldPreset): void {
      if (preset === 'off') {
        enabled = false;
      } else {
        enabled = true;
        controls = { ...controls, blurSide: preset };
      }
      sync();
    },
    setControls(next: Partial<DepthOfFieldControls>): void {
      controls = { ...controls, ...next };
      sync();
    },
    refresh: sync,
    reset(): void {
      enabled = initialEnabled;
      controls = { ...initialControls };
      sync();
    },
    dispose(): void {
      if (world.get(camera, DepthOfField).ok) world.removeComponent(camera, DepthOfField);
    },
    snapshot(): DepthOfFieldSnapshot {
      const cameraData = world.get(camera, Camera);
      const active =
        enabled &&
        cameraData.ok &&
        cameraData.value.projection === 0 &&
        world.get(camera, DepthOfField).ok;
      const fov = cameraData.ok && cameraData.value.projection === 0 ? cameraData.value.fov : 0;
      const focalLength =
        fov > 0 ? controls.sensorHeight / (2 * Math.tan(fov / 2)) : 0;
      const preset: DepthOfFieldPreset = active ? controls.blurSide : 'off';
      return {
        enabled: active,
        mode: active ? 'bokeh' : 'off',
        preset,
        focalDistance: controls.focusDistance,
        aperture: controls.fStop,
        focalLength,
        controls: { ...controls },
        effect: DEPTH_OF_FIELD_ID,
      };
    },
  };
}
