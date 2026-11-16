import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../../rhi-debug-viewer/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const ts = require('typescript');
const source = await readFile(new URL('../runtime-form.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { runtimeForm, runtimeObjectFields } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

test('refresh reads one coherent source only when an open or pending form demands it', () => {
  const dom = new JSDOM('<main></main>');
  for (const key of [
    'window',
    'Event',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLDetailsElement',
  ])
    globalThis[key] = dom.window[key];
  let reads = 0;
  let accepted = { mass: 10000, nested: { damping: 0.3 }, cooked: { bytes: [1, 2, 3] } };
  const parent = document.querySelector('main');
  assert.ok(parent);
  const form = runtimeForm(
    parent,
    'Native body',
    runtimeObjectFields(
      () => {
        reads++;
        return structuredClone(accepted);
      },
      (value) => {
        accepted = value;
      },
    ),
  );
  reads = 0;
  form.refresh();
  assert.equal(reads, 0, 'Collapsed facts must not clone full assets on ordinary frames');
  const section = parent.querySelector('details');
  assert.ok(section);
  section.open = true;
  reads = 0;
  form.refresh();
  assert.equal(reads, 1, 'All fields must share one detached owner observation per refresh');
  accepted.nested.damping = 0.7;
  form.refresh();
  assert.equal(parent.querySelector('[data-parameter="nested.damping"]').value, '0.7');
  accepted = { mass: 8000.25, nested: { gain: 2 }, cooked: { bytes: [4] } };
  form.refresh();
  assert.equal(parent.querySelector('[data-parameter="nested.damping"]'), null);
  assert.equal(parent.querySelector('[data-parameter="nested.gain"]').value, '2');
  form.setDisabled(true);
  accepted.extra = 3;
  form.refresh();
  assert.ok(parent.querySelector('[data-parameter="extra"]').disabled);
  dom.window.close();
});

test('collapsed pending edits retain requested value and synchronize accepted native state', () => {
  const dom = new JSDOM('<main></main>');
  for (const key of [
    'window',
    'Event',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLDetailsElement',
  ])
    globalThis[key] = dom.window[key];
  let accepted = { mass: 10000 },
    requested;
  const parent = document.querySelector('main');
  assert.ok(parent);
  const form = runtimeForm(
    parent,
    'Mass',
    runtimeObjectFields(
      () => ({ ...accepted }),
      (value) => {
        requested = value;
        form.refresh();
      },
    ),
  );
  const input = parent.querySelector('input');
  assert.ok(input);
  input.focus();
  input.value = '8000.25';
  input.dispatchEvent(new window.Event('change'));
  assert.equal(input.value, '8000.25');
  accepted = requested;
  form.refresh();
  assert.equal(input.value, '8000.25');
  assert.equal(document.activeElement, input);
  input.value = '7000';
  input.dispatchEvent(new window.Event('change'));
  form.rejectPending(new Error('Native owner refused publication'));
  assert.equal(input.value, '8000.25');
  assert.equal(input.validationMessage, 'Native owner refused publication');
  dom.window.close();
});

test('focused fields from a retired branch stay disabled until reconciliation', () => {
  const dom = new JSDOM('<main></main>');
  for (const key of [
    'window',
    'Event',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLDetailsElement',
  ])
    globalThis[key] = dom.window[key];
  let source = { nested: { damping: 0.3 } };
  const parent = document.querySelector('main');
  assert.ok(parent);
  const form = runtimeForm(
    parent,
    'Branch',
    runtimeObjectFields(
      () => structuredClone(source),
      (value) => {
        source = value;
      },
    ),
  );
  const section = parent.querySelector('details'),
    input = parent.querySelector('input');
  assert.ok(section);
  assert.ok(input);
  section.open = true;
  input.focus();
  source = { nested: { gain: 2 } };
  form.refresh();
  assert.ok(input.disabled);
  input.value = '5';
  input.dispatchEvent(new window.Event('change'));
  assert.deepEqual(source, { nested: { gain: 2 } });
  assert.equal(parent.querySelector('small').textContent, '运行时参数分支已替换');
  dom.window.close();
});

test('stage binding reconciliation leaves collapsed material observations demand-driven', async () => {
  const presentation = await readFile(new URL('../presentation.ts', import.meta.url), 'utf8');
  const body = ts
    .transpileModule(presentation, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    })
    .outputText.replace(/^import[\s\S]*?;\s*/gm, '');
  const componentNames = [
    'RigidBody',
    'Camera',
    'MeshRenderer',
    'ScreenSpaceReflection',
    'WaterPontoonSet',
    'WaterContactProbeSet',
    'ParticleEffectPlayer',
    'WaterZoneInstance',
    'WaterBodyInstance',
    'WaterFluidSimulation',
  ];
  const prefix = `const {runtimeForm,runtimeObjectFields}=globalThis.__waterFormTest;\n${componentNames.map((name) => `const ${name}=${JSON.stringify(name)};`).join('\n')}`;
  globalThis.__waterFormTest = { runtimeForm, runtimeObjectFields };
  const { stageRuntimePanel } = await import(
    `data:text/javascript;base64,${Buffer.from(prefix + body).toString('base64')}`
  );
  const dom = new JSDOM('<main></main>');
  for (const key of [
    'window',
    'Event',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLDetailsElement',
  ])
    globalThis[key] = dom.window[key];
  let reads = 0,
    now = 0,
    callback;
  const previousPerformance = globalThis.performance;
  globalThis.performance = { now: () => now };
  let material = { values: { roughness: 0.7 }, staticSwitches: { waterFoam: true } };
  const materials = [1];
  const app = {
    world: {
      query: ({ read }) => ({
        unwrap: () => (read[0] === 'MeshRenderer' ? [{ get: () => ({ materials }) }] : []),
      }),
    },
    assets: {
      read: () => {
        reads++;
        return { unwrap: () => structuredClone(material) };
      },
    },
    renderer: {
      subscribe: (listener) => {
        callback = listener;
        return () => {};
      },
    },
    pluginContext: { effect: () => {} },
  };
  const parent = document.querySelector('main');
  assert.ok(parent);
  try {
    const panel = stageRuntimePanel(app, parent, 'R1');
    const tick = async () => {
      now += 600;
      callback({
        kind: 'frame-submitted',
        receipt: { presentation: 'ready', completed: Promise.resolve({ ok: true }) },
      });
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    await tick();
    assert.equal(panel.forms.length, 0, 'Collapsed inspector must not mount Engine object forms');
    reads = 0;
    await tick();
    assert.equal(
      reads,
      0,
      'Existing collapsed bindings must not read full MaterialAsset just to remount fields',
    );
    panel.section.open = true;
    panel.section.dispatchEvent(new dom.window.Event('toggle'));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const section = parent.querySelector('.water-runtime-panel > details:nth-of-type(2)');
    assert.ok(section);
    section.open = true;
    reads = 0;
    await tick();
    assert.equal(reads, 1, 'An open binding shares the form observation');
    material = { values: { metallic: 0.25 }, staticSwitches: { waterFoam: true } };
    await tick();
    assert.equal(parent.querySelector('[data-parameter="values.roughness"]'), null);
    assert.equal(parent.querySelector('[data-parameter="values.metallic"]').value, '0.25');
    materials.push(2);
    await tick();
    assert.equal(panel.forms.length, 2, 'New mounted material handles remain discoverable');
    materials.splice(0, 1);
    await tick();
    assert.equal(panel.forms.length, 1, 'Retired mounted handles remove their form');
  } finally {
    globalThis.performance = previousPerformance;
    delete globalThis.__waterFormTest;
    dom.window.close();
  }
});

test('editing a rejected number clears stale validity and applies a valid correction', () => {
  const dom = new JSDOM('<main></main>');
  for (const key of [
    'window',
    'Event',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLDetailsElement',
  ])
    globalThis[key] = dom.window[key];
  let accepted = 20;
  const form = runtimeForm(document.querySelector('main'), 'Clarity', [
    {
      name: 'clarity',
      label: 'Clarity',
      value: 20,
      min: 2,
      max: 80,
      slider: true,
      read: () => accepted,
      set: (value) => {
        accepted = value;
      },
    },
  ]);
  form.section.open = true;
  const input = form.section.querySelector('input[data-parameter]');
  input.value = '0';
  input.dispatchEvent(new window.Event('change'));
  assert.equal(accepted, 20);
  form.refresh();
  assert.equal(input.value, '0', 'A validation error must describe the visible attempted value');
  input.value = '20';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(input.validationMessage, '');
  assert.equal(form.section.querySelector('small').textContent, '');
  assert.equal(input.checkValidity(), true);
  input.dispatchEvent(new window.Event('change'));
  assert.equal(accepted, 20);
  input.value = '0';
  input.dispatchEvent(new window.Event('change'));
  const range = form.section.querySelector('input[type=range]');
  range.value = '32';
  range.dispatchEvent(new window.Event('input'));
  assert.equal(input.checkValidity(), true);
  range.dispatchEvent(new window.Event('change'));
  assert.equal(accepted, 32);
  assert.equal(form.section.querySelector('small').textContent, '');
  dom.window.close();
});
