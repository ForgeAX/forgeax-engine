import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { EngineContent } from '@forgeax/engine/content';
import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { Visibility, VisibilityStateValue } from '@forgeax/engine/render';
import { waterSceneSnapshot } from '@forgeax/engine/runtime';
import { Transform, WaterExclusionMode, WaterExclusionVolume } from '@forgeax/engine/scene';
import type { AssetHandle, WaterBodyAsset } from '@forgeax/engine/types';
import type { WaterSystem } from '@forgeax/engine/water';

const node = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

export function createSceneControls(input: {
  assets: AssetRegistry;
  world: World;
  zone: AssetHandle<'water-zone'>;
  selectedBody: () => { handle: AssetHandle<'water-body'>; entity: EntityHandle; guid: string };
  water: () => WaterSystem;
  eye: () => readonly [number, number, number];
}) {
  const { assets, world } = input;
  const exclusion = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
  const status = node('selection-action');
  const selectedSnapshot = () => waterSceneSnapshot(world, Number(input.selectedBody().entity));
  const diagnostics: { total: number; errorCount: number; lastError?: unknown } = {
    total: 0,
    errorCount: 0,
  };
  const report = (
    result: { readonly ok: boolean; readonly error?: unknown },
    success = '变更已提交，待接纳',
  ) => {
    diagnostics.total++;
    if (!result.ok) {
      diagnostics.errorCount++;
      diagnostics.lastError = result.error;
    }
    status.textContent = result.ok
      ? success
      : String((result.error as { code?: string })?.code ?? result.error);
    status.dataset.state = result.ok ? 'pending' : 'rejected';
    refresh();
  };
  const updateBody = (patch: Partial<WaterBodyAsset>) =>
    report(assets.update(input.selectedBody().handle, patch));
  const updateExclusion = () => {
    const enabled = node<HTMLInputElement>('exclusion').checked;
    const present = world.hasComponent(exclusion, WaterExclusionVolume);
    if (!enabled) {
      if (present) world.removeComponent(exclusion, WaterExclusionVolume).unwrap();
      return;
    }
    const data = {
      mode: WaterExclusionMode.addListedBodiesToExclusion,
      waterBodies: [input.selectedBody().entity],
      centerM: [...input.eye()],
      halfExtentsM: [3, 3, 3],
    };
    if (present) world.set(exclusion, WaterExclusionVolume, data).unwrap();
    else world.addComponent(exclusion, { component: WaterExclusionVolume, data }).unwrap();
  };
  const updateFar = () => {
    const {
      farExtentM: _extent,
      farWaterLevelM: _height,
      farOwnerBodyGuid: _owner,
      ...zone
    } = assets.read(input.zone).unwrap();
    const enabled = node<HTMLInputElement>('far-mesh').checked;
    report(
      assets.replace(input.zone, {
        ...zone,
        ...(enabled
          ? {
              farExtentM: { spanXM: 240, spanZM: 240 },
              farWaterLevelM: 0,
              farOwnerBodyGuid: input.selectedBody().guid,
              farMaterialGuid: zone.farMaterialGuid ?? EngineContent.water.materials.far,
            }
          : {}),
      }),
    );
  };
  const refresh = () => {
    const body = assets.read(input.selectedBody().handle).unwrap();
    const entity = input.selectedBody().entity;
    node<HTMLInputElement>('body-visible').checked =
      !world.hasComponent(entity, Visibility) ||
      world.get(entity, Visibility).unwrap().state !== VisibilityStateValue.hidden;
    node<HTMLInputElement>('water-mesh').checked = body.flags.affectsWaterMesh;
    node<HTMLInputElement>('far-mesh').checked =
      assets.read(input.zone).unwrap().farExtentM !== undefined;
    node<HTMLInputElement>('priority').value = String(body.overlapPriority);
    node<HTMLSelectElement>('collision-group').value = String(
      body.collision.collisionGroups ?? 0x0001_0001,
    );
    node<HTMLSelectElement>('trace-group').value = String(
      input.water().underwaterTraceFilterMask(),
    );
    const snapshot = selectedSnapshot();
    node('selection-admission').textContent =
      snapshot === undefined
        ? '尚未接纳'
        : `代 ${snapshot.sceneGeneration} · 优先级 ${snapshot.asset.overlapPriority}`;
    node<HTMLInputElement>('baked-data').disabled = snapshot === undefined;
    node<HTMLInputElement>('baked-data').checked =
      snapshot !== undefined &&
      input.water().hasBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration);
  };
  node<HTMLInputElement>('body-visible').addEventListener('change', (event) => {
    const entity = input.selectedBody().entity;
    const data = {
      state: (event.currentTarget as HTMLInputElement).checked
        ? VisibilityStateValue.visible
        : VisibilityStateValue.hidden,
    };
    report(
      world.hasComponent(entity, Visibility)
        ? world.set(entity, Visibility, data)
        : world.addComponent(entity, { component: Visibility, data }),
    );
  });
  node<HTMLInputElement>('water-mesh').addEventListener('change', (event) => {
    const body = assets.read(input.selectedBody().handle).unwrap();
    updateBody({
      flags: { ...body.flags, affectsWaterMesh: (event.currentTarget as HTMLInputElement).checked },
    });
  });
  node('far-mesh').addEventListener('change', updateFar);
  node<HTMLInputElement>('priority').addEventListener('change', (event) => {
    updateBody({ overlapPriority: Number((event.currentTarget as HTMLInputElement).value) });
  });
  node<HTMLSelectElement>('collision-group').addEventListener('change', (event) => {
    const body = assets.read(input.selectedBody().handle).unwrap();
    updateBody({
      collision: {
        ...body.collision,
        collisionGroups: Number((event.currentTarget as HTMLSelectElement).value),
      },
    });
  });
  node<HTMLSelectElement>('trace-group').addEventListener('change', (event) =>
    report(
      input
        .water()
        .setUnderwaterTraceFilterMask(Number((event.currentTarget as HTMLSelectElement).value)),
    ),
  );
  node('exclusion').addEventListener('change', updateExclusion);
  node<HTMLInputElement>('baked-data').addEventListener('change', (event) => {
    const snapshot = selectedSnapshot();
    if (!snapshot) return;
    if (!(event.currentTarget as HTMLInputElement).checked) {
      report(
        input.water().clearBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration),
        '已移除烘焙数据',
      );
      return;
    }
    // A fixed authored fixture, independent of live waves, terrain and scene time.
    const samples = new Float32Array(9 * 9 * 4);
    for (let index = 0; index < 81; index++) samples.set([0.6, 2.4, 1.2, -0.4], index * 4);
    report(
      input.water().publishBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration, {
        kind: 'live-capture',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid: {
          originXZ: [
            Number(snapshot.worldMatrixM[12]) - 40,
            Number(snapshot.worldMatrixM[14]) - 40,
          ],
          originY: 0,
          spacingXZ: [10, 10],
          width: 9,
          height: 9,
          samples,
        },
      }),
      '已发布烘焙数据',
    );
  });
  refresh();
  return {
    refresh,
    updateExclusion,
    diagnostics,
    selectedChanged: () => {
      updateExclusion();
      refresh();
    },
  };
}
