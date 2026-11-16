import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import type { App } from '@forgeax/engine/app';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { Time } from '@forgeax/engine/ecs';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle, WaterZoneAsset } from '@forgeax/engine/types';
import { cookWaterAsset, WaterQueryFlags, type WaterSystem } from '@forgeax/engine/water';
import { demoWaveSetSource } from './demo-wave-set';
import { runtimeForm, runtimeObjectFields } from './runtime-form';

export function mountR2Observatory(
  app: App,
  parent: HTMLElement,
  input: {
    zone: AssetHandle<'water-zone'>;
    waveSet: AssetHandle<'water-wave-set'>;
    bodies: readonly { handle: AssetHandle<'water-body'>; entity: EntityHandle }[];
  },
) {
  const assets = app.assets;
  if (!assets) throw new Error('R2 requires the App asset owner');
  const section = document.createElement('section');
  section.className = 'water-runtime-panel';
  const heading = document.createElement('h2');
  heading.textContent = 'R2 · 水面数据观察';
  section.append(heading);
  const source = demoWaveSetSource();
  if (source.waveSource.kind !== 'generated') throw new Error('Expected generated wave source');
  const generated = source.waveSource;
  let generator: Record<string, unknown> = { ...source.waveSource.generatorConfig };
  const forms = [
    runtimeForm(
      section,
      'Gerstner 波谱 · 固定随机种子 731',
      runtimeObjectFields(
        () => ({ ...generator }),
        (values) => {
          const next = { ...source, waveSource: { ...generated, generatorConfig: values } };
          const cooked = cookWaterAsset(next).unwrap();
          if (cooked.kind !== 'water-wave-set') throw new Error('Expected cooked WaveSet');
          assets.replace(input.waveSet, cooked).unwrap();
          generator = { ...values };
        },
      ),
    ),
    runtimeForm(
      section,
      'WaterInfo 与网格负载',
      runtimeObjectFields(
        () => ({ ...assets.read(input.zone).unwrap() }),
        (values) => {
          assets.replace(input.zone, values as unknown as WaterZoneAsset).unwrap();
        },
        { 'waterInfo.format': ['rgba16f', 'rgba32f'] },
      ),
    ),
  ];
  const controls = {
    x: 0,
    y: -1,
    z: 0,
    depth: true,
    immersion: true,
    normal: true,
    velocity: true,
    waves: true,
    simple: false,
    ignoreExclusions: false,
  };
  forms.push(
    runtimeForm(
      section,
      'CPU 查询位置与字段',
      runtimeObjectFields(
        () => ({ ...controls }),
        (values) => {
          Object.assign(controls, values);
        },
      ),
    ),
  );
  const body = document.createElement('select');
  body.id = 'r2-query-body';
  input.bodies.forEach((entry, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = assets.read(entry.handle).unwrap().type;
    body.append(option);
  });
  section.append(body);
  const facts = document.createElement('details'),
    summary = document.createElement('summary'),
    output = document.createElement('pre');
  summary.textContent = 'CPU 查询与 WaterInfo 已接纳输出';
  facts.append(summary, output);
  section.append(facts);
  const sample = () => {
    const entry = input.bodies[Number(body.value)];
    if (entry === undefined) return;
    const water = app.world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
    const snapshot = water.snapshot(`scene-entity:${entry.entity}`);
    if (!snapshot) return;
    const transform = app.world.get(entry.entity, Transform).unwrap();
    const flags =
      WaterQueryFlags.ComputeLocation |
      (controls.normal ? WaterQueryFlags.ComputeNormal : 0) |
      (controls.depth ? WaterQueryFlags.ComputeDepth : 0) |
      (controls.immersion ? WaterQueryFlags.ComputeImmersionDepth : 0) |
      (controls.velocity ? WaterQueryFlags.ComputeVelocity : 0) |
      (controls.waves ? WaterQueryFlags.IncludeWaves : 0) |
      (controls.simple ? WaterQueryFlags.SimpleWaves : 0) |
      (controls.ignoreExclusions ? WaterQueryFlags.IgnoreExclusionVolumes : 0);
    const query = water.queryBody(snapshot.guid, {
      positionM: [
        (transform.pos[0] ?? 0) + controls.x,
        (transform.pos[1] ?? 0) + controls.y,
        (transform.pos[2] ?? 0) + controls.z,
      ],
      timeSeconds: app.world.getResource(Time).elapsed,
      expectedBodyGeneration: snapshot.sceneGeneration,
      flags,
    });
    const inspection = app.renderer.inspect();
    output.textContent = JSON.stringify(
      {
        query,
        body: snapshot.guid,
        generation: snapshot.sceneGeneration,
        waterInfo: inspection.waterGraph?.waterInfo,
        mesh: inspection.waterGraph,
      },
      (_key, value) => (value instanceof Set ? [...value] : value),
      2,
    );
  };
  let last = 0;
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed.then((result) => {
      if (!result.ok || performance.now() - last < 250) return;
      last = performance.now();
      for (const form of forms) form.refresh();
      if (facts.open) sample();
    });
  });
  app.pluginContext.effect(() => unsubscribe);
  parent.append(section);
  return { sample, section };
}
