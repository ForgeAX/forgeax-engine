import type { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { EngineContent } from '@forgeax/engine/content';
import type { EntityHandle, World } from '@forgeax/engine/ecs';
import {
  WATER_SCENE_STATUS_RESOURCE,
  type WaterSceneStatus,
  waterSceneSnapshot,
  waterSceneZoneSnapshot,
} from '@forgeax/engine/runtime';
import type {
  AssetHandle,
  MaterialAsset,
  MaterialValue,
  WaterBodyAsset,
} from '@forgeax/engine/types';
import type { WaterMaterialFamilyKey, WaterSystem } from '@forgeax/engine/water';
import { CLEAR_WATER_MATERIAL_KEYS } from './material-presets';

type BodyType = WaterBodyAsset['type'];
type SelectedBody = {
  type: BodyType;
  handle: AssetHandle<'water-body'>;
  entity: EntityHandle;
  guid: string;
};
const slotFields = {
  surface: 'surfaceMaterialGuid',
  lod: 'lodMaterialGuid',
  info: 'waterInfoMaterialGuid',
  underwater: 'underwaterPostProcessMaterialGuid',
  lakeTransition: 'riverToLakeTransitionMaterialGuid',
  oceanTransition: 'riverToOceanTransitionMaterialGuid',
} as const;
type Slot = keyof typeof slotFields | 'far';
const labels: Record<WaterMaterialFamilyKey, string> = {
  root: '共享根材质',
  instance: '共享实例',
  river: '河流',
  lake: '湖泊',
  ocean: '海洋',
  custom: '自定义水面',
  'river-to-lake': '河流 → 湖泊',
  'river-to-ocean': '河流 → 海洋',
  'river-lod': '河流远景',
  'lake-lod': '湖泊远景',
  'ocean-lod': '海洋远景',
  'custom-lod': '自定义远景',
  far: '海平面远景',
  hlod: '海平面层级远景',
  'water-info': '水体信息',
  underwater: '水下',
  'custom-underwater': '自定义水下',
};

const node = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};
const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : String(error);
const sameGuid = (left: string | undefined, right: string | undefined) =>
  left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();

export async function createMaterialPanel(input: {
  assets: AssetRegistry;
  world: World;
  selectedBody: () => SelectedBody;
  zone: AssetHandle<'water-zone'>;
  zoneGuid: string;
  water: () => WaterSystem;
  guid: (key: string) => string;
}) {
  const { assets } = input;
  const materials = await Promise.all(
    Object.entries(EngineContent.water.materials).map(async ([key, guid]) => ({
      label: labels[key as WaterMaterialFamilyKey],
      guid,
      handle: (await assets.load(guid, 'material')).unwrap(),
    })),
  );
  const independent = await Promise.all(
    (['lake', 'river', 'ocean', 'custom'] as const).map(async (type) => {
      const guid = input.guid(`material/independent/${type}`);
      return {
        type,
        label: `${labels[type]} · 独立实例`,
        guid,
        handle: (await assets.load(guid, 'material')).unwrap(),
      };
    }),
  );
  const clear = await Promise.all(
    CLEAR_WATER_MATERIAL_KEYS.map(async (key) => ({
      label: `${labels[key]} · 清澈`,
      guid: input.guid(`material/clear/${key}`),
      handle: (await assets.load(input.guid(`material/clear/${key}`), 'material')).unwrap(),
    })),
  );
  const extra = (
    [
      ['standard-surface', '标准表面'],
      ['medium-surface', '单层介质'],
      ['custom-baked', '自定义 · 烘焙流场'],
      ['custom-baked-underwater', '自定义水下 · 烘焙流场'],
    ] as const
  ).map(([key, label]) => ({ label, guid: input.guid(`material/${key}`) }));
  const all = [...materials, ...independent, ...clear];
  const textures = await Promise.all(
    (['normal', 'river-normal'] as const).map(async (key) => ({
      key,
      guid: EngineContent.water.textures[key],
      handle: (await assets.load(EngineContent.water.textures[key], 'texture')).unwrap(),
    })),
  );
  const originals = new Map(
    all.map((entry) => [entry.handle, assets.snapshot(entry.handle).unwrap()]),
  );
  const choice = node<HTMLSelectElement>('material-choice');
  const appearance = node<HTMLSelectElement>('water-appearance');
  for (const material of [...all, ...extra]) choice.add(new Option(material.label, material.guid));
  const slot = node<HTMLSelectElement>('material-slot');
  const controls = node<HTMLFieldSetElement>('material-controls');
  const status = node('material-action');
  const operations: {
    ok: boolean;
    message: string;
    target: { bodyEntity: number; bodyGuid: string; slot: Slot; materialGuid: string | undefined };
    choiceGuid: string;
    assetRevision?: number;
    error?: unknown;
  }[] = [];
  const diagnostics: { total: number; errorCount: number; lastError?: unknown } = {
    total: 0,
    errorCount: 0,
  };
  let pending = false;
  let disposed = false;
  let selectionKey = '';
  const findMaterial = (guid: string | undefined) =>
    all.find((entry) => sameGuid(entry.guid, guid));
  const captureTarget = (selectedSlot: Slot = slot.value as Slot) => {
    const body = { ...input.selectedBody() };
    const bodyAsset = assets.read(body.handle).unwrap();
    const zoneAsset = selectedSlot === 'far' ? assets.read(input.zone).unwrap() : undefined;
    const guid =
      selectedSlot === 'far' ? zoneAsset?.farMaterialGuid : bodyAsset[slotFields[selectedSlot]];
    const entry = findMaterial(guid);
    return {
      body,
      slot: selectedSlot,
      slotLabel:
        [...slot.options].find((option) => option.value === selectedSlot)?.textContent ??
        selectedSlot,
      guid,
      entry,
      bodyAsset,
      zoneAsset,
      bindingRevision: assets.revision(selectedSlot === 'far' ? input.zone : body.handle).unwrap(),
      materialRevision: entry === undefined ? undefined : assets.revision(entry.handle).unwrap(),
    };
  };
  type Target = ReturnType<typeof captureTarget>;
  const readAdmission = (target: Target) => {
    const body = waterSceneSnapshot(input.world, Number(target.body.entity));
    const zone =
      target.slot === 'far' ? waterSceneZoneSnapshot(input.world, input.zoneGuid) : undefined;
    const acceptedGuid =
      target.slot === 'far' ? zone?.asset.farMaterialGuid : body?.asset[slotFields[target.slot]];
    const generation = target.slot === 'far' ? zone?.generation : body?.sceneGeneration;
    const owner = input.world.hasResource(WATER_SCENE_STATUS_RESOURCE)
      ? input.world.getResource<WaterSceneStatus>(WATER_SCENE_STATUS_RESOURCE)
      : undefined;
    const failure = owner?.waterDependencyFailures.find((entry) => {
      if (!sameGuid(entry.guid, target.guid) && !sameGuid(entry.guid, acceptedGuid)) return false;
      const failureBody =
        typeof entry.detail === 'object' && entry.detail !== null && 'bodyGuid' in entry.detail
          ? entry.detail.bodyGuid
          : undefined;
      return (
        failureBody === undefined || failureBody === body?.guid || failureBody === target.body.guid
      );
    });
    return {
      requestedGuid: target.guid,
      acceptedGuid,
      generation,
      failure,
      state: failure
        ? 'rejected'
        : target.guid === undefined
          ? 'unbound'
          : sameGuid(target.guid, acceptedGuid)
            ? 'accepted-slot'
            : 'pending',
      materialContent: 'unverified',
    } as const;
  };
  const report = (
    result: { readonly ok: boolean; readonly error?: unknown },
    message: string,
    target: Target,
    choiceGuid: string,
  ) => {
    if (disposed) return;
    const error =
      result.error instanceof Error
        ? {
            ...result.error,
            name: result.error.name,
            message: result.error.message,
            stack: result.error.stack,
          }
        : result.error;
    diagnostics.total++;
    if (!result.ok) {
      diagnostics.errorCount++;
      diagnostics.lastError = error;
    }
    const revision = target.entry === undefined ? undefined : assets.revision(target.entry.handle);
    operations.push({
      ok: result.ok,
      message,
      target: {
        bodyEntity: Number(target.body.entity),
        bodyGuid: target.body.guid,
        slot: target.slot,
        materialGuid: target.guid,
      },
      choiceGuid,
      ...(revision?.ok ? { assetRevision: revision.value } : {}),
      ...(result.ok ? {} : { error }),
    });
    if (operations.length > 64) operations.shift();
    status.textContent = `${labels[target.body.type]} · ${target.slotLabel}：${result.ok ? '资产变更已提交，待接纳' : errorCode(result.error)}`;
    status.dataset.state = result.ok ? 'pending' : 'rejected';
  };
  const loadChoice = async (guid: string) => {
    const loaded = findMaterial(guid);
    if (loaded) return loaded;
    const candidate = extra.find((entry) => sameGuid(entry.guid, guid));
    if (!candidate) return undefined;
    const result = await assets.load(candidate.guid, 'material');
    if (!result.ok) throw result.error;
    if (disposed) {
      assets.release(result.value).unwrap();
      return undefined;
    }
    const original = assets.snapshot(result.value);
    if (!original.ok) {
      assets.release(result.value).unwrap();
      throw original.error;
    }
    const entry = { ...candidate, handle: result.value };
    all.push(entry);
    originals.set(entry.handle, original.value);
    return entry;
  };
  const bind = (target: Target, guid: string) => {
    if (target.slot === 'far') {
      if (!target.zoneAsset) throw new Error('Missing captured WaterZone material target');
      return assets.replaceAtRevision(input.zone, target.bindingRevision, {
        ...target.zoneAsset,
        farMaterialGuid: guid,
      });
    }
    return assets.replaceAtRevision(target.body.handle, target.bindingRevision, {
      ...target.bodyAsset,
      [slotFields[target.slot]]: guid,
    });
  };
  const run = async (
    message: string,
    action: (target: Target, choiceGuid: string) => void | Promise<void>,
    targetSlot?: Slot,
  ) => {
    if (pending || disposed) return;
    const target = captureTarget(targetSlot);
    const choiceGuid = choice.value;
    pending = true;
    status.textContent = `${labels[target.body.type]} · ${target.slotLabel}：处理中`;
    status.dataset.state = 'pending';
    refresh();
    try {
      await action(target, choiceGuid);
    } catch (error) {
      report({ ok: false, error }, message, target, choiceGuid);
    } finally {
      pending = false;
      if (!disposed) refresh();
    }
  };
  const value = (material: MaterialAsset, name: string): MaterialValue | undefined =>
    material.values?.[name] ??
    material.parameters?.find((parameter) => parameter.name === name)?.default;
  const editedName = (key: string, material: MaterialAsset) => {
    if (key === 'absorption')
      return material.parameters?.some((parameter) => parameter.name === 'underwaterAbsorptionPerM')
        ? 'underwaterAbsorptionPerM'
        : 'absorptionPerM';
    return key === 'scattering'
      ? 'scatteringPerM'
      : key === 'normal'
        ? 'normalStrength'
        : key === 'phase'
          ? material.parameters?.some((parameter) => parameter.name === 'underwaterPhaseG')
            ? 'underwaterPhaseG'
            : 'phaseG'
          : key;
  };
  function refresh() {
    const selected = input.selectedBody();
    for (const option of slot.options)
      option.disabled =
        (option.value === 'lakeTransition' || option.value === 'oceanTransition') &&
        selected.type !== 'river';
    if (slot.selectedOptions[0]?.disabled) slot.value = 'surface';
    const target = captureTarget();
    const entry = target.entry;
    const material = entry === undefined ? undefined : assets.read(entry.handle).unwrap();
    const admission = readAdmission(target);
    const effective = findMaterial(admission.acceptedGuid);
    const nextSelection = `${Number(selected.entity)}:${target.slot}:${target.guid ?? ''}`;
    if (selectionKey !== nextSelection) {
      selectionKey = nextSelection;
      choice.value = target.guid ?? '';
    }
    controls.disabled = pending;
    controls.setAttribute('aria-busy', String(pending));
    const surfaceGuid = target.bodyAsset.surfaceMaterialGuid;
    const refreshMaterialAdmission = () => {
      appearance.value = sameGuid(surfaceGuid, EngineContent.water.materials[selected.type])
        ? 'native'
        : sameGuid(surfaceGuid, input.guid(`material/clear/${selected.type}`))
          ? 'clear'
          : 'custom';
      node('material-name').textContent =
        effective?.label ?? (admission.acceptedGuid ? '已接纳材质' : '尚未接纳材质');
      node('material-guid').textContent = admission.acceptedGuid ?? '—';
      node('material-requested').textContent = `请求：${entry?.label ?? target.guid ?? '未绑定'}`;
      const admissionNode = node('material-admission');
      admissionNode.textContent = admission.failure
        ? `拒绝 · ${admission.failure.code}`
        : admission.state === 'accepted-slot'
          ? `槽位已接纳 · 场景代 ${admission.generation}`
          : admission.state === 'unbound'
            ? '未绑定'
            : `待接纳${admission.generation === undefined ? '' : ` · 保留代 ${admission.generation}`}`;
      admissionNode.dataset.state = admission.state === 'accepted-slot' ? 'ready' : admission.state;
      node('material-verification').textContent = '内容版本待核验 · GPU 待核验';
      node('material-consumers').textContent = String(
        entry === undefined ? 0 : input.water().materialSourceBodies(entry.guid).length,
      );
      node<HTMLButtonElement>('independent-material').disabled = target.slot !== 'surface';
      node<HTMLButtonElement>('restore-material').disabled = entry === undefined;
      node<HTMLButtonElement>('replace-material').disabled = entry === undefined;
      node<HTMLButtonElement>('bind-material').disabled = choice.value === '';
    };
    refreshMaterialAdmission();
    const refreshMaterialControls = () => {
      for (const key of [
        'absorption',
        'scattering',
        'roughness',
        'normal',
        'phase',
        'refractionPixelNormalStrength',
        'distantRefractionPixelNormalStrength',
        'refractionBottomAmount',
        'lipRefraction',
        'refractionDepthBias',
        'criticalAngleDot',
      ]) {
        const name = material === undefined ? undefined : editedName(key, material);
        const field =
          material === undefined || name === undefined ? undefined : value(material, name);
        for (const control of document.querySelectorAll<HTMLInputElement>(
          `[data-material-value="${key}"]`,
        )) {
          const lane = Number(control.dataset.lane ?? 0);
          const number =
            typeof field === 'number' ? field : Array.isArray(field) ? field[lane] : undefined;
          control.disabled = typeof number !== 'number';
          control.value = typeof number === 'number' ? String(number) : '';
          const output = document.querySelector<HTMLOutputElement>(`output[for="${control.id}"]`);
          if (output) output.value = typeof number === 'number' ? number.toFixed(3) : '—';
        }
      }
      for (const control of document.querySelectorAll<HTMLInputElement>('[data-material-switch]')) {
        const key = control.dataset.materialSwitch as keyof NonNullable<
          MaterialAsset['staticSwitches']
        >;
        control.disabled = material?.staticSwitches?.[key] === undefined;
        control.checked = material?.staticSwitches?.[key] === true;
      }
      const normalTexture = node<HTMLSelectElement>('normal-texture');
      normalTexture.disabled =
        material === undefined ||
        !material.parameters?.some((parameter) => parameter.name === 'waterNormalTexture');
      const reference = material === undefined ? undefined : value(material, 'waterNormalTexture');
      const texture =
        typeof reference === 'object' && reference !== null && 'texture' in reference
          ? reference.texture
          : reference;
      normalTexture.value =
        textures.find((entry) => texture === entry.handle || texture === entry.guid)?.key ?? '';
    };
    refreshMaterialControls();
  }
  appearance.addEventListener('change', () => {
    const preset = appearance.value;
    if (preset !== 'native' && preset !== 'clear') return;
    void run(
      '切换水体外观',
      async (target) => {
        const keys: readonly WaterMaterialFamilyKey[] = [
          target.body.type,
          `${target.body.type}-lod`,
          ...(target.body.type === 'river' ? (['river-to-lake', 'river-to-ocean'] as const) : []),
        ];
        const guidFor = (key: WaterMaterialFamilyKey) =>
          preset === 'native'
            ? EngineContent.water.materials[key]
            : input.guid(`material/clear/${key}`);
        const loaded = await Promise.all(keys.map((key) => loadChoice(guidFor(key))));
        if (loaded.some((entry) => entry === undefined))
          throw new Error('Missing Water appearance material');
        if (disposed) return;
        const surfaceMaterialGuid = guidFor(target.body.type);
        report(
          assets.replaceAtRevision(target.body.handle, target.bindingRevision, {
            ...target.bodyAsset,
            surfaceMaterialGuid,
            lodMaterialGuid: guidFor(`${target.body.type}-lod`),
            ...(target.body.type === 'river'
              ? {
                  riverToLakeTransitionMaterialGuid: guidFor('river-to-lake'),
                  riverToOceanTransitionMaterialGuid: guidFor('river-to-ocean'),
                }
              : {}),
          }),
          '切换水体外观',
          target,
          surfaceMaterialGuid,
        );
      },
      'surface',
    );
  });
  node('bind-material').addEventListener('click', () => {
    void run('绑定材质', async (target, choiceGuid) => {
      const candidate = await loadChoice(choiceGuid);
      if (candidate && !disposed)
        report(bind(target, candidate.guid), '绑定材质', target, choiceGuid);
    });
  });
  node('replace-material').addEventListener('click', () => {
    void run('替换内容', async (target, choiceGuid) => {
      if (target.entry === undefined || target.materialRevision === undefined) return;
      const candidate = await loadChoice(choiceGuid);
      if (candidate && !disposed)
        report(
          assets.replaceAtRevision(
            target.entry.handle,
            target.materialRevision,
            assets.read(candidate.handle).unwrap(),
          ),
          '替换内容',
          target,
          choiceGuid,
        );
    });
  });
  node('independent-material').addEventListener('click', () => {
    void run('绑定独立实例', (target, choiceGuid) => {
      const entry = independent.find((entry) => entry.type === target.body.type);
      if (entry) report(bind(target, entry.guid), '绑定独立实例', target, choiceGuid);
    });
  });
  node('restore-material').addEventListener('click', () => {
    void run('恢复内容', (target, choiceGuid) => {
      const original = target.entry && originals.get(target.entry.handle);
      if (target.entry && original && target.materialRevision !== undefined)
        report(
          assets.replaceAtRevision(
            target.entry.handle,
            target.materialRevision,
            original.read<MaterialAsset>(target.entry.handle).unwrap(),
          ),
          '恢复内容',
          target,
          choiceGuid,
        );
    });
  });
  slot.addEventListener('change', refresh);
  choice.addEventListener('change', refresh);
  for (const control of document.querySelectorAll<HTMLInputElement>('[data-material-value]'))
    control.addEventListener('input', () => {
      const number = Number(control.value);
      if (!Number.isFinite(number) || !control.validity.valid) return;
      void run('更新参数', (target, choiceGuid) => {
        if (!target.entry) return;
        const material = assets.read(target.entry.handle).unwrap();
        const name = editedName(control.dataset.materialValue ?? '', material);
        const previous = value(material, name);
        const next = Array.isArray(previous)
          ? previous.map((entry, lane) => (lane === Number(control.dataset.lane) ? number : entry))
          : number;
        report(
          assets.update(target.entry.handle, { values: { [name]: next } }),
          '更新参数',
          target,
          choiceGuid,
        );
      });
    });
  for (const control of document.querySelectorAll<HTMLInputElement>('[data-material-switch]'))
    control.addEventListener('change', () => {
      const key = control.dataset.materialSwitch ?? '';
      const checked = control.checked;
      void run('更新静态分支', (target, choiceGuid) => {
        if (!target.entry) return;
        const material = assets.read(target.entry.handle).unwrap();
        report(
          assets.update(target.entry.handle, {
            staticSwitches: { ...material.staticSwitches, [key]: checked },
          }),
          '更新静态分支',
          target,
          choiceGuid,
        );
      });
    });
  node<HTMLSelectElement>('normal-texture').addEventListener('change', (event) => {
    const name = (event.currentTarget as HTMLSelectElement).value;
    const texture = textures.find((entry) => entry.key === name);
    if (!texture) return;
    void run('更新法线纹理', (target, choiceGuid) => {
      if (target.entry)
        report(
          assets.update(target.entry.handle, { values: { waterNormalTexture: texture.handle } }),
          '更新法线纹理',
          target,
          choiceGuid,
        );
    });
  });
  refresh();
  return {
    refresh,
    operations,
    diagnostics,
    readState: () => ({ ...readAdmission(captureTarget()), pending, diagnostics }),
    dispose: () => {
      disposed = true;
      for (const original of originals.values()) original.dispose();
      for (const entry of [...all, ...textures]) assets.release(entry.handle).unwrap();
    },
  };
}
