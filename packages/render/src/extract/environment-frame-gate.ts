import type { World } from '@forgeax/engine-ecs';
import type { CameraSnapshot } from '../render-contract';
import type { sourceEnvironment, WorldEnvironmentPart } from '../render-system-extract-tail';
import { EnvironmentGate } from './environment-gate';
import type { WorldLightingPart } from './world-environment';

export interface EnvironmentCameraReader {
  readCameras(world: World, extract: () => CameraSnapshot[], key?: string): CameraSnapshot[];
}

export interface EnvironmentLightingReader extends EnvironmentCameraReader {
  readLighting(
    world: World,
    extract: Parameters<EnvironmentGate<WorldLightingPart>['read']>[2],
  ): WorldLightingPart;
}

/** One source owns its complete publication and its independent light projection. */
export class EnvironmentFrameGate
  extends EnvironmentGate<WorldEnvironmentPart, ReturnType<typeof sourceEnvironment>>
  implements EnvironmentLightingReader
{
  private readonly cameras = new EnvironmentGate<CameraSnapshot[]>(true);
  private readonly lighting = new EnvironmentGate<WorldLightingPart>(true);

  constructor() {
    super(true);
  }

  readCameras(world: World, extract: () => CameraSnapshot[], key = 'cameras'): CameraSnapshot[] {
    this.cameras.assetsChanged = this.assetsChanged;
    return this.cameras.read(world, key, () => ({ value: extract(), timeDependent: false }));
  }

  readLighting(
    world: World,
    extract: Parameters<EnvironmentGate<WorldLightingPart>['read']>[2],
  ): WorldLightingPart {
    this.lighting.assetsChanged = this.assetsChanged;
    return this.lighting.read(world, 'lighting', extract);
  }
}
