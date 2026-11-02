import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applicableControls, COMMON_CONTROLS, parseControls, SHOW_CONTROL_KINDS } from '../assets/show/controls.ts';
import { panelSlot } from '../assets/show/panel.ts';
import { SHOW_PROGRAMS } from '../assets/show/programs.ts';
import type { ShowState } from '../assets/show/show.ts';
import { discoverOutputs, packGuid } from '../assets/show/subjects.ts';
import { predict } from '../assets/show/timeline.ts';

it('rejects unknown, not yet implemented, malformed and repeated controls', () => {
  expect(parseControls(COMMON_CONTROLS).ok).toBe(true);
  const failure = (value: unknown) => {
    const parsed = parseControls(value);
    return parsed.ok ? undefined : { code: parsed.error.code, index: parsed.error.index };
  };
  expect(failure([{ kind: 'shading' }, { kind: 'wireframe' }])).toEqual({ code: 'control-unknown', index: 1 });
  expect(failure([{}])).toEqual({ code: 'control-unknown', index: 0 });
  expect(failure([{ kind: 'toString' }])).toEqual({ code: 'control-unknown', index: 0 });
  expect(failure([{ kind: 'lod', levels: 3 }])).toEqual({ code: 'control-not-ready', index: 0 });
  expect(failure([{ kind: 'shading' }, { kind: 'shading' }])).toEqual({ code: 'control-duplicate', index: 1 });
  expect(failure({ kind: 'shading' })).toEqual({ code: 'control-invalid', index: -1 });
});

it('every implemented control kind has a panel slot; unknown and pending kinds have none', () => {
  for (const [kind, ready] of Object.entries(SHOW_CONTROL_KINDS)) {
    const slot = panelSlot(kind);
    expect(slot.ok ? 'slot' : slot.error, kind).toBe(ready ? 'slot' : 'control-not-ready');
  }
  for (const kind of ['wireframe', '', 'constructor', '__proto__']) expect(panelSlot(kind)).toEqual({ ok: false, error: 'control-unknown' });
});

it('every program subject declares valid controls', () => {
  for (const [name, program] of Object.entries(SHOW_PROGRAMS))
    for (const subject of program.subjects) {
      const parsed = parseControls(subject.controls ?? COMMON_CONTROLS);
      expect(parsed.ok ? 'ok' : parsed.error, `${name}/${subject.name}`).toBe('ok');
    }
});

it('keeps only the controls that apply to the subject on stage', () => {
  const kinds = (facts: Parameters<typeof applicableControls>[1]) => applicableControls(COMMON_CONTROLS, facts).map((c) => c.kind);
  expect(kinds({ parts: 1, clean: false, mechanism: false })).toEqual(['camera', 'floor', 'shading']);
  expect(kinds({ parts: 4, clean: true, mechanism: true })).toEqual(COMMON_CONTROLS.map((c) => c.kind));
});

it('predicts hidden parts until the Show reports them', () => {
  const state = { hidden: [] } as unknown as ShowState;
  expect(predict(state, { kind: 'hide', subject: 0, parts: [2, 5] }).hidden).toEqual([2, 5]);
});

it('accepts a well-formed bake control and rejects one without its plain material', () => {
  const bake = { kind: 'bake', high: 'mesh/h', low: 'mesh/l.', plain: 'material/p', channels: [] };
  expect(parseControls([bake]).ok).toBe(true);
  const { plain: _, ...bare } = bake;
  const parsed = parseControls([bare]);
  expect(parsed.ok ? 'ok' : parsed.error.code).toBe('control-invalid');
});

it('predicts the bake levels until the Show reports them', () => {
  const state = { bake: { mesh: 'low', material: 'baked', available: true } } as unknown as ShowState;
  expect(predict(state, { kind: 'bake', mesh: 'high' }).bake).toEqual({ mesh: 'high', material: 'baked', available: true });
  expect(predict(state, { kind: 'bake', material: 'plain' }).bake).toEqual({ mesh: 'low', material: 'plain', available: true });
});

it('lists the Pack materials beside the discovered meshes', () => {
  const packageId = '01900000-0000-7000-8000-0000000c0410';
  const entry = (sourceKey: string, kind: string) => ({ guid: packGuid(packageId, sourceKey), kind, sourceKey });
  const [found] = discoverOutputs(
    [{ name: 'c', packs: [{ packageId, materials: { plain: 'material/c410-plain' } }] }],
    [entry('mesh/c410-low.a', 'mesh'), entry('mesh/c410-high', 'mesh'), entry('material/c410-plain', 'material')],
  );
  expect(found?.packs[0]?.meshes).toEqual(['mesh/c410-high', 'mesh/c410-low.a']);
  expect(found?.packs[0]?.materials).toEqual({ 'c410-plain': 'material/c410-plain', plain: 'material/c410-plain' });
});

it('discovers every mesh and material a Pack publishes when its subject names only the Pack', () => {
  const packageId = '01900000-0000-7000-8000-0000000c0001';
  const entry = (sourceKey: string, kind: string) => ({ guid: packGuid(packageId, sourceKey).toUpperCase(), kind, sourceKey });
  const entries = [
    entry('mesh/crate', 'mesh'),
    entry('mesh/crate/lod1', 'mesh'),
    entry('material/wood', 'material'),
    entry('mesh/lid', 'mesh'),
    { guid: packGuid('01900000-0000-7000-8000-0000000c0002', 'mesh/other'), kind: 'mesh', sourceKey: 'mesh/other' },
  ];
  const listed = { packageId, meshes: ['mesh/crate'] };
  const [found, kept] = discoverOutputs(
    [
      { name: 'crate', packs: [{ packageId }] },
      { name: 'listed', packs: [listed] },
    ],
    entries,
  );
  expect(found?.packs).toEqual([{ packageId, meshes: ['mesh/crate', 'mesh/lid'], materials: { wood: 'material/wood' } }]);
  expect(kept?.packs[0]).toBe(listed);
});

it('every Show project mounts the one shared timeline and panel UI', () => {
  for (const file of ['timeline.ui.html', 'timeline.ui.css']) {
    const shared = readFileSync(new URL(`../assets/ui/${file}`, import.meta.url), 'utf8');
    for (const project of ['gallery', 'hood-linkage', 'maid-whale', 'mech-gt', 'mech-gt-car', 'scifi-mech'])
      expect(readFileSync(new URL(`../${project}/assets/ui/${file}`, import.meta.url), 'utf8'), `${project}/${file}`).toBe(shared);
  }
});
