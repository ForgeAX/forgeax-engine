import { createRequire } from 'node:module';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { MaterialAsset } from '@forgeax/engine/types';
import { afterEach, expect, it, vi } from 'vitest';
import { readRuntimeFormFields, refreshRuntimeForms, runtimeForm } from '../../../runtime-form';
import { createSeaControls } from '../sea-controls';

const require = createRequire(
  new URL('../../../../rhi-debug-viewer/package.json', import.meta.url),
);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (
    html: string,
  ) => {
    window: Window & typeof globalThis & { close(): void };
  };
};

const material = (distanceM = 20, roughness = 0.055): MaterialAsset => ({
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
  parameters: [
    { name: 'absorptionPerM', type: 'vec3' },
    { name: 'roughness', type: 'f32' },
    { name: 'baseColor', type: 'vec4' },
  ],
  values: {
    absorptionPerM: [3 / distanceM, 1 / distanceM, 0.5 / distanceM],
    roughness,
    baseColor: [0.1, 0.3, 0.4, 1],
  },
});
const control = (fields: ReturnType<typeof createSeaControls>, name: string) => {
  const field = readRuntimeFormFields(fields).find((field) => field.name === name);
  if (!field) throw new Error(`Missing ${name} field`);
  return field;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('refreshes clarity from the accepted material absorption after a real value patch', () => {
  const assets = new AssetRegistry();
  const handle = assets.create(material()).unwrap();
  const fields = createSeaControls(assets, () => handle);
  const held = assets.snapshot(handle).unwrap();
  try {
    assets.update(handle, { values: { absorptionPerM: [3 / 80, 1 / 80, 0.5 / 80] } }).unwrap();
    const clarity = control(fields, 'clarity');
    expect(clarity.value).toBe(80);
    expect(clarity.read?.()).toBe(80);
    clarity.set(40);
    const accepted = assets.read(handle).unwrap();
    expect(accepted.values?.absorptionPerM).toEqual([3 / 40, 1 / 40, 0.5 / 40]);
    expect(accepted.values?.roughness).toBe(0.055);
    expect(accepted.values?.baseColor).toEqual([0.1, 0.3, 0.4, 1]);
    expect(control(fields, 'clarity').value).toBe(40);
    expect(held.read<MaterialAsset>(handle).unwrap().values?.absorptionPerM).toEqual([
      0.15, 0.05, 0.025,
    ]);
  } finally {
    held.dispose();
    assets.dispose();
  }
});

it('refreshes all fields from one selected material and retains captured write addresses', () => {
  const assets = new AssetRegistry();
  const ocean = assets.create(material(20, 0.17)).unwrap();
  const lake = assets.create(material(40, 0.3)).unwrap();
  let selected = ocean;
  const fields = createSeaControls(assets, () => selected);
  try {
    const oldClarity = control(fields, 'clarity');
    selected = lake;
    const read = vi.spyOn(assets, 'read');
    const observation = readRuntimeFormFields(fields);
    expect(read).toHaveBeenCalledTimes(1);
    expect(observation.map((field) => field.value)).toEqual([0.3, 40]);
    oldClarity.set(80);
    expect(assets.read(ocean).unwrap().values?.absorptionPerM).toEqual([3 / 80, 1 / 80, 0.5 / 80]);
    expect(control(fields, 'clarity').value).toBe(40);
    const roughness = control(fields, 'roughness');
    roughness.set(0.17);
    expect(assets.read(lake).unwrap().values?.roughness).toBe(0.17);
    expect(() => roughness.set(4)).toThrow('Value outside admitted range');
    expect(assets.read(lake).unwrap().values?.roughness).toBe(0.17);
  } finally {
    assets.dispose();
  }
});

it('keeps a committed 80 m slider edit through the actual runtime form refresh', () => {
  const dom = new JSDOM('<main></main>');
  for (const key of [
    'window',
    'document',
    'Event',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLDetailsElement',
  ] as const)
    vi.stubGlobal(key, dom.window[key]);
  const assets = new AssetRegistry();
  const handle = assets.create(material()).unwrap();
  let form: ReturnType<typeof runtimeForm> | undefined;
  try {
    const parent = document.querySelector('main');
    if (!parent) throw new Error('Missing form parent');
    const fields = createSeaControls(assets, () => handle);
    form = runtimeForm(parent, 'Sea', fields);
    form.section.open = true;
    form.refresh();
    const input = parent.querySelector<HTMLInputElement>('[data-parameter="clarity"]');
    const range = parent.querySelector<HTMLInputElement>(
      'input[type="range"][aria-label="清澈距离"]',
    );
    if (!input || !range) throw new Error('Missing clarity controls');
    input.value = '0';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    expect(input.validity.customError).toBe(true);
    expect(control(fields, 'clarity').read?.()).toBe(20);
    input.value = '20';
    input.dispatchEvent(new Event('input'));
    expect(input.validity.customError).toBe(false);
    input.dispatchEvent(new Event('change'));
    expect(form.rejection).toBe('');
    range.value = '80';
    range.dispatchEvent(new Event('input'));
    range.dispatchEvent(new Event('change'));
    expect(input.value).toBe('80');
    expect(input.validity.valid).toBe(true);
    expect(form.pending).toBe(false);
    const read = vi.spyOn(assets, 'read');
    refreshRuntimeForms([form]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('80');
    expect(range.value).toBe('80');
    expect(control(fields, 'clarity').read?.()).toBe(80);
    expect(form.rejection).toBe('');
  } finally {
    form?.remove();
    assets.dispose();
    dom.window.close();
  }
});
