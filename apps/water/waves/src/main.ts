import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { Time } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine/render';
import { Transform, WaterBodyInstance, WaterZoneInstance } from '@forgeax/engine/scene';
import type { AssetHandle, WaterWaveSetAsset } from '@forgeax/engine/types';
import { cookWaterWaveSetSource, WaterQueryFlags, type WaterSystem } from '@forgeax/engine/water';
import { demoWaveSetSource } from '../../demo-wave-set';
import { WAVES_PACKAGE_NAMESPACE } from './identity';
import './style.css';

function startupFailureDetails(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const source = value as { name?: string; message?: string; code?: string; expected?: string; hint?: string; detail?: unknown; cause?: unknown };
  return {
    name: source.name,
    message: source.message,
    code: source.code,
    expected: source.expected,
    hint: source.hint,
    detail: source.detail,
    ...(depth < 5 && source.cause !== undefined ? { cause: startupFailureDetails(source.cause, seen, depth + 1) } : {}),
  };
}

const element = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const canvas = element<HTMLCanvasElement>('#scene');
const resize = () => { canvas.width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio)); canvas.height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio)); };
resize();

const main = async () => {
  const app = (await createApp(canvas, { ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}) }, { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) })).unwrap();
  const assets = app.assets;
  if (!assets) throw new Error('App asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WAVES_PACKAGE_NAMESPACE, key));
  const zoneHandle = (await assets.load(guid('zone/ocean'), 'water-zone')).unwrap();
  const bodyHandle: AssetHandle<'water-body'> = (await assets.load(guid('body/ocean'), 'water-body')).unwrap();
  const waveSetHandle = (await assets.load(guid('waves/seed-731-v1'), 'water-wave-set')).unwrap();
  const sourceWaveSet = demoWaveSetSource();
  if (sourceWaveSet.waveSource.kind !== 'generated') throw new Error('Expected generated demo WaveSet');
  const sourceGenerator = sourceWaveSet.waveSource;
  let waveCount = (assets.read(waveSetHandle).unwrap() as WaterWaveSetAsset).waves.length;
  const waveOrigin: [number, number, number] = [31453.28, 0, 10484.76];
  const zone = world.spawn({ component: Transform, data: { pos: waveOrigin } }, { component: WaterZoneInstance, data: { zone: zoneHandle } }).unwrap();
  const bodyEntity = world.spawn({ component: Transform, data: { pos: waveOrigin } }, { component: WaterBodyInstance, data: { body: bodyHandle } }).unwrap();
  world.spawn({ component: DirectionalLight, data: { direction: [-0.45, -0.85, -0.3], color: [1, 0.98, 0.93], intensity: 2.6, castShadow: true } }).unwrap();
  const eye: [number, number, number] = [waveOrigin[0] + 44, 36, waveOrigin[2] + 52];
  const motionWorldPoint: [number, number, number] = [waveOrigin[0] + 16, 0, waveOrigin[2] + 12];
  const cameraEntity = world.spawn({ component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, waveOrigin, [0, 1, 0]) } }, { component: Camera, data: { ...perspective({ fov: 0.84, aspect: canvas.width / canvas.height, near: 0.1, far: 500 }), clearColor: [0.82, 0.9, 0.87, 1] } }).unwrap();
  const probeColumnMesh = assets.create(createBoxGeometry(0.1, 1, 0.1).unwrap()).unwrap();
  const probeMarkerMesh = assets.create(createBoxGeometry(0.5, 0.5, 0.5).unwrap()).unwrap();
  const probeMaterial = assets.create(Materials.unlit('#f0bc49')).unwrap();
  const probeColumn = world.spawn({ component: Transform, data: { pos: waveOrigin, scale: [1, 0.04, 1] } }, { component: MeshFilter, data: { assetHandle: probeColumnMesh } }, { component: MeshRenderer, data: { materials: [probeMaterial] } }).unwrap();
  const probeMarker = world.spawn({ component: Transform, data: { pos: waveOrigin } }, { component: MeshFilter, data: { assetHandle: probeMarkerMesh } }, { component: MeshRenderer, data: { materials: [probeMaterial] } }).unwrap();

  const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const owner = `scene-entity:${bodyEntity}`;
  const depthInput = element<HTMLInputElement>('#depth');
  const strengthInput = element<HTMLInputElement>('#strength');
  let submittedTimeSeconds = 0;
  let submittedFrames = 0;
  const rendererErrors: unknown[] = [];
  let mode: 'full' | 'simple' = 'full';
  const update = (time = submittedTimeSeconds) => {
    const depth = Number(depthInput.value);
    element('#depth-value').textContent = `${depth.toFixed(1)} m`;
    const currentSnapshot = water.snapshot(owner);
    if (!currentSnapshot) { element('#trace').textContent = '等待水体代次提交'; return; }
    const flags = WaterQueryFlags.ComputeLocation | WaterQueryFlags.ComputeNormal | WaterQueryFlags.ComputeDepth | WaterQueryFlags.IncludeWaves | (mode === 'simple' ? WaterQueryFlags.SimpleWaves : 0);
    const result = water.queryBody(owner, { positionM: [waveOrigin[0], -depth, waveOrigin[2]], flags, timeSeconds: time, splineKey: depth / 4, expectedBodyGeneration: currentSnapshot.sceneGeneration });
    if (!result.ok) { element('#trace').textContent = `查询失败：${result.error.code} · ${result.error.expected}`; return; }
    const sample = result.value;
    const surfaceY = sample.surfaceM?.[1] ?? -depth;
    const pillarHeight = Math.max(Math.abs(surfaceY + depth), 0.04);
    world.set(probeColumn, Transform, { pos: [waveOrigin[0], (surfaceY - depth) * 0.5, waveOrigin[2]], scale: [1, pillarHeight, 1] }).unwrap();
    world.set(probeMarker, Transform, { pos: [waveOrigin[0], surfaceY, waveOrigin[2]], scale: [1, 1, 1] }).unwrap();
    element('#surface').textContent = `${sample.surfaceM?.[1]?.toFixed(3) ?? '—'} m`;
    element('#wave-height').textContent = `${sample.waveInfo?.heightM.toFixed(3) ?? '—'} m`;
    element('#normal').textContent = sample.waveInfo?.normalYUp.map((v) => v.toFixed(3)).join(', ') ?? sample.normalYUp?.map((v) => v.toFixed(3)).join(', ') ?? '—';
    element('#attenuation').textContent = sample.waveInfo?.attenuation.toFixed(3) ?? '—';
    element('#time-readout').textContent = `${time.toFixed(3)} s`;
    element('#generation').textContent = String(sample.bodyGeneration);
    element('#trace').textContent = `波集 ${currentSnapshot.sourceAssetGuid ?? sample.bodyGuid} · 标志 0x${sample.adjustedFlags.toString(16)} · 固定 XZ (${waveOrigin[0].toFixed(2)}, ${waveOrigin[2].toFixed(2)}) · LWC 瓦片边界`;
  };
  strengthInput.addEventListener('input', () => {
    const strength = Number(strengthInput.value);
    element('#strength-value').textContent = `${strength.toFixed(1)} ×`;
    const cooked = cookWaterWaveSetSource({
      ...sourceWaveSet,
      waveSource: {
        ...sourceGenerator,
        generatorConfig: {
          ...sourceGenerator.generatorConfig,
          amplitudeMinM: 0.12 * strength,
          amplitudeMaxM: 0.42 * strength,
        },
      },
    });
    if (!cooked.ok) { element('#status').textContent = `波集更新失败：${cooked.error.code}`; return; }
    const replaced = assets.replace(waveSetHandle, cooked.value);
    if (!replaced.ok) { element('#status').textContent = `资源更新失败：${replaced.error.code}`; return; }
    waveCount = cooked.value.waves.length;
    element('#wave-count').textContent = `${waveCount} / 731`;
    element('#status').textContent = `波浪强度 ${strength.toFixed(1)} × · 等待 GPU 更新`;
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) button.addEventListener('click', () => {
    mode = button.dataset.mode === 'simple' ? 'simple' : 'full';
    for (const candidate of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) candidate.setAttribute('aria-pressed', String(candidate === button));
    update();
  });
  depthInput.addEventListener('input', () => update());
  update();
  element('#render-state').textContent = '引擎运行中';
  element('#wave-count').textContent = `${waveCount} / 731`;
  document.documentElement.dataset.ready = 'true';
  app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      const error = event.error as unknown as { code?: string; message?: string; expected?: string; hint?: string; detail?: unknown };
      rendererErrors.push({ code: error.code, message: error.message, expected: error.expected, hint: error.hint, detail: error.detail });
      document.body.dataset.rendererErrorCount = String(rendererErrors.length);
      element('#render-state').textContent = `渲染错误：${event.error.code}`;
      return;
    }
    if (event.kind !== 'frame-submitted') return;
    const frameTimeSeconds = Math.max(0, world.getResource(Time).elapsed);
    void event.receipt.completed.then((result) => {
      if (!result.ok || event.receipt.presentation !== 'ready') return;
      submittedFrames++;
      submittedTimeSeconds = frameTimeSeconds;
      element('#frame-count').textContent = String(submittedFrames);
      element('#time-readout').textContent = `${submittedTimeSeconds.toFixed(3)} s`;
      const snapshot = water.snapshot(owner);
      element('#status').textContent = snapshot?.asset.waveSetGuid ? `波集已接入 · ${waveCount} 个波 · GPU/CPU 同步于 ${submittedTimeSeconds.toFixed(3)} s` : '等待当前水体快照';
      element('#gpu-state').textContent = snapshot?.binding.kind === 'bound' ? '位移 / 法线 / 速度' : '区域未接入';
      update(submittedTimeSeconds);
    });
  });
  window.addEventListener('resize', () => { resize(); const aspect = canvas.width / canvas.height; world.set(cameraEntity, Camera, { aspect }).unwrap(); });
  if (new URLSearchParams(location.search).has('smoke')) Object.assign(window, { __waterWavesDemo: { app, world, water, bodyEntity, zone, owner, waveSetHandle, rendererErrors, query: update, probeMarker, probeColumn, probeWorldPoint: waveOrigin, motionWorldPoint, cameraView: { eye, target: waveOrigin, fov: 0.84 } } });
  app.start().unwrap();
};
void main().catch((error: unknown) => {
  if (new URLSearchParams(location.search).has('smoke')) Object.assign(window, { __waterWavesStartupError: startupFailureDetails(error) });
  document.body.dataset.startupError = 'true';
  element('#status').textContent = error instanceof Error ? error.message : String(error);
  element('#render-state').textContent = '启动失败';
});
