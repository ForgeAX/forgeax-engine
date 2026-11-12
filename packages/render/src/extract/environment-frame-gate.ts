import type { World } from '@forgeax/engine-ecs';
import type { mergeEnvironment, WorldEnvironmentPart } from '../render-system-extract-tail';
import { EnvironmentGate } from './environment-gate';
import type { WorldLightingPart } from './world-environment';

export interface EnvironmentLightingReader {
  readLighting(
    world: World,
    worldId: number,
    extract: Parameters<EnvironmentGate<WorldLightingPart>['read']>[2],
  ): WorldLightingPart;
}

/** One source owns its complete publication and its independent light projection. */
export class EnvironmentFrameGate
  extends EnvironmentGate<WorldEnvironmentPart, ReturnType<typeof mergeEnvironment>>
  implements EnvironmentLightingReader
{
  private readonly lighting = new EnvironmentGate<WorldLightingPart>(true);

  constructor() {
    super(true);
  }

  readLighting(
    world: World,
    worldId: number,
    extract: Parameters<EnvironmentGate<WorldLightingPart>['read']>[2],
  ): WorldLightingPart {
    this.lighting.assetsChanged = this.assetsChanged;
    return this.lighting.read(world, String(worldId), extract);
  }
}
