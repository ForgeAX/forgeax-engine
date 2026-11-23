import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import { forEachLightAsset } from '../publication/dependencies';
import type { CameraSnapshot } from '../render-contract';
import type { LightRoster } from '../render-system-extract';
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
  private readonly lighting = new EnvironmentGate<WorldLightingPart, LightRoster>(true);
  private readonly localAssets = new WeakMap<
    World,
    {
      readonly owner: AssetRegistry;
      revision: number;
      dependencies?: ReadonlyMap<number, number>;
    }
  >();

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
    return this.lighting.read(world, 'lighting', (routedError) => {
      const result = extract(routedError);
      const local = this.localAssets.get(world);
      if (local !== undefined) {
        const records = runtimeAssets(local.owner);
        const dependencies = new Map<number, number>();
        forEachLightAsset(result.value.lights, (handle) => {
          if (!handle || dependencies.has(handle)) return;
          const version = records.version(handle);
          if (version.ok) dependencies.set(handle, version.value);
          else routedError();
        });
        local.dependencies = dependencies;
      }
      return result;
    });
  }

  /** Compare light resources only after the asset owner's content revision changes. */
  useLocalLightAssets(world: World, assets: AssetRegistry): void {
    const records = runtimeAssets(assets);
    const revision = records.currentRevision;
    const local = this.localAssets.get(world);
    if (local?.owner !== assets) {
      this.localAssets.set(world, { owner: assets, revision });
      this.assetsChanged = true;
      return;
    }
    this.assetsChanged = local.dependencies === undefined;
    if (this.assetsChanged || revision === local.revision) return;
    local.revision = revision;
    for (const [handle, previous] of local.dependencies ?? []) {
      const version = records.version(handle);
      if (version.ok && version.value === previous) continue;
      this.assetsChanged = true;
      return;
    }
  }

  finalizeLighting(world: World, build: (routedError: () => void) => LightRoster): LightRoster {
    return this.lighting.finalize(world, 'lighting', build);
  }
}
