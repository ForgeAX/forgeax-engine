import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { World } from '@forgeax/engine/ecs';
import { RigidBody } from '@forgeax/engine/physics';
import { Camera, ScreenSpaceReflection } from '@forgeax/engine/render';
import { WaterPontoonSet } from '@forgeax/engine/scene';
import { buildWaterMaterialFamily } from '@forgeax/engine/water';
import { afterEach, expect, it, vi } from 'vitest';
import { refreshRuntimeForms, runtimeForm, runtimeObjectFields } from '../../../runtime-form';
import { waterEntrySplashDefaults } from '../../assets/entry-splash';
import { coastLocalWaterRecipe } from '../../assets/local-water';
import { mountCoastControls } from '../control-panel';
import { WATER_R8_PACKAGE } from '../identity';
import { WATER_QUALITY_PRESETS } from '../quality-presets';
import { DEFAULT_SHIP_HANDLING } from '../ship-handling';

const { JSDOM } = createRequire(
  new URL('../../../../rhi-debug-viewer/package.json', import.meta.url),
)('jsdom');
const doms: { window: { close(): void } }[] = [];
afterEach(async () => {
  // Flush native details toggle events while their DOM constructors are still installed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const dom of doms.splice(0)) dom.window.close();
  vi.unstubAllGlobals();
});

function mountedControls() {
  const dom = new JSDOM(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'));
  doms.push(dom);
  for (const key of [
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLDetailsElement',
    'Event',
  ])
    vi.stubGlobal(key, dom.window[key]);
  const advanced = document.getElementById('advanced-controls');
  if (!advanced) throw new Error('Missing Advanced container');
  const forms: ReturnType<typeof runtimeForm>[] = [];
  const sources: ReturnType<typeof runtimeForm>[] = [];
  const states = new Map<string, Record<string, unknown>>();
  const owner = (title: string, initial: Record<string, unknown>, readonly: string[] = []) => {
    states.set(title, initial);
    sources.push(
      runtimeForm(
        advanced,
        title,
        runtimeObjectFields(
          () => states.get(title) ?? {},
          (next) => {
            states.set(title, next);
          },
          {},
          readonly,
        ),
      ),
    );
  };
  const world = new World();
  const entity = world
    .spawn(
      { component: WaterPontoonSet, data: {} },
      { component: RigidBody, data: {} },
      { component: Camera, data: {} },
      { component: ScreenSpaceReflection, data: {} },
    )
    .unwrap();
  owner('质量负载与探针数量', { ...WATER_QUALITY_PRESETS.high });
  owner('原生浮力与阻尼', { ...world.get(entity, WaterPontoonSet).unwrap() });
  owner('船体刚体：质量与原生阻尼', { ...world.get(entity, RigidBody).unwrap() });
  owner('摄影机与光学', { ...world.get(entity, Camera).unwrap() });
  owner('屏幕空间反射', { ...world.get(entity, ScreenSpaceReflection).unwrap() });
  owner('局部水波与泡沫配方', structuredClone(coastLocalWaterRecipe));
  owner('动力与舵效', { ...DEFAULT_SHIP_HANDLING });
  const family = buildWaterMaterialFamily(WATER_R8_PACKAGE);
  const root = family.outputs['material/water/root'];
  if (!root || root.kind !== 'material') throw new Error('Missing Water family root');
  owner('当前海面观感', {
    ...Object.fromEntries((root.parameters ?? []).map((p) => [p.name, p.default])),
    clarityPercent: 70,
  });
  owner('风浪方向', {
    windDirectionDegrees: 30,
    wavelengthScale: 1,
    directionSpreadDegrees: 40,
    spectrumRandomness: 0.5,
  });
  owner('船体探针尺度', { pontoonRadiusM: 1.5, contactRadiusM: 0.3 });
  owner('发射器与炮弹（下次发射生效）', {
    horizontalSpeedMps: 11,
    upwardSpeedMps: 3.5,
    radiusM: 0.6,
    massKg: 20,
    playerTimeScale: 1,
  });
  owner('单次落水喷溅', { burstCount: 384, capacity: 384 });
  const splash = { ...waterEntrySplashDefaults } as Record<string, number>;
  const splashFields = runtimeObjectFields(
    () => ({ ...splash }),
    (next) => {
      Object.assign(splash, next);
    },
  );
  sources.push(runtimeForm(advanced, '落水水花：喷射 / 尺寸 / 生命周期', splashFields));
  sources.push(
    runtimeForm(advanced, '入水响应强度', [
      {
        name: 'crownResponseRatio',
        value: 1,
        read: () => Number(splash.jetSpeed) / waterEntrySplashDefaults.jetSpeed,
        set: (value) => {
          splash.jetSpeed = Number(value) * waterEntrySplashDefaults.jetSpeed;
        },
      },
    ]),
  );
  owner('接触泡沫历史', { fadeToFivePercentSeconds: 3 }, ['fadeToFivePercentSeconds']);
  owner('天空光照表现', {
    sunTint: '#ffffff',
    sunIntensity: 2,
    ambientIntensity: 1,
    sunAzimuth: 30,
    sunElevation: 45,
  });
  owner('镜头取景', { fovDegrees: 60 });
  mountCoastControls(
    sources,
    forms,
    advanced,
    document.createElement('label'),
    document.createElement('label'),
    document.createElement('p'),
  );
  return { forms, sources, states, splash };
}

function input(dimension: string, field: string) {
  const node = document.querySelector<HTMLInputElement>(
    `#controls-${dimension} [data-parameter="${field}"]`,
  );
  if (!node) throw new Error(`Missing mounted ${dimension}.${field}`);
  return node;
}

it('mounts every dimension against owner fields without presenting two controls for one entry response', () => {
  const { forms, splash } = mountedControls();
  expect(forms).toHaveLength(9);
  expect(document.querySelector('#controls-entry [data-parameter="jetSpeed"]')).toBeNull();
  const response = input('entry', 'crownResponseRatio');
  response.value = '0.5';
  response.dispatchEvent(new Event('change'));
  expect(splash.jetSpeed).toBeCloseTo(waterEntrySplashDefaults.jetSpeed * 0.5);
  expect(response.value).toBe('0.5');
});

it('keeps transformed decay edits and source readbacks on the same owner', () => {
  const { states } = mountedControls();
  const decay = input('waves', 'oceanPatchConfig.waveDampingPerSecond');
  decay.value = '10';
  decay.dispatchEvent(new Event('change'));
  const recipe = states.get('局部水波与泡沫配方') as typeof coastLocalWaterRecipe;
  expect(recipe.oceanPatchConfig.waveDampingPerSecond).toBeCloseTo(-Math.log(0.05) / 10);
  expect(Number(decay.value)).toBeCloseTo(10);
  expect(input('foam', 'fadeToFivePercentSeconds').disabled).toBe(true);
});

it('reconciles retired material fields to disabled controls and restores supported fields', () => {
  const { states, forms } = mountedControls();
  const accepted = states.get('当前海面观感');
  if (!accepted) throw new Error('Missing optical owner');
  const dimension = document.querySelector<HTMLDetailsElement>('#controls-sea')?.closest('details');
  if (!dimension) throw new Error('Missing sea dimension');
  dimension.open = true;
  states.set('当前海面观感', { ...accepted, roughness: undefined });
  refreshRuntimeForms(forms);
  expect(input('sea', 'roughness').disabled).toBe(true);
  states.set('当前海面观感', { ...accepted, roughness: 0.25 });
  refreshRuntimeForms(forms);
  expect(input('sea', 'roughness').disabled).toBe(false);
  expect(input('sea', 'roughness').value).toBe('0.25');
});
