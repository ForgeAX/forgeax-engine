import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import {
  issuedSectionIndex,
  sealSourceDraws,
  sourceDrawForSection,
} from '../../gpu-driven/source-draw-indices';
import type { RenderableDrawReceipt } from '../gpu-draw-receipts';
import { emitGpuDrivenDrawReceipts } from '../gpu-draw-receipts';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

it('allocates binding and submit callbacks per geometry pass while preserving every direct draw', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  for (let entity = 1; entity <= 129; entity++) f.add({ entity, submeshes: 1 });
  const actions = new Set<() => unknown>();
  const bindings = new Set<() => unknown>();
  let bound = 0;
  const profile: NonNullable<typeof f.c.profilePhase> = (phase, action) => {
    if (phase === 'record/graph-execute/forward/draw-submit') actions.add(action);
    if (phase === 'record/graph-execute/forward/material-bind-groups') {
      bindings.add(action);
      bound++;
    }
    return action();
  };
  Object.assign(f.c, { profilePhase: profile });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const draw = vi.spyOn(pass, 'drawIndexed');
  try {
    f.record(pass);
    expect(actions.size).toBe(1);
    expect(bindings.size).toBe(1);
    expect(bound).toBe(129);
    expect(draw).toHaveBeenCalledTimes(129);
    expect(f.receipts).toHaveLength(129);
    f.record(pass);
    expect(actions.size).toBe(2);
    expect(bindings.size).toBe(2);
    expect(bound).toBe(258);
    expect(draw).toHaveBeenCalledTimes(258);
    expect(f.receipts).toHaveLength(258);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('shares immutable CPU facts without dropping draws or retaining changed material facts', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const first = f.add({ entity: 1, submeshes: 1 });
  for (let entity = 2; entity <= 129; entity++) {
    const entry = f.add({ entity, submeshes: 1 });
    Object.assign(entry.source, {
      material: first.source.material,
      materials: [first.source.material],
    });
  }
  const observed: RenderableDrawReceipt[] = [];
  const submitted = f.c.onRenderableDraw;
  Object.assign(f.c, {
    onRenderableDraw: (...args: Parameters<NonNullable<typeof submitted>>) => {
      submitted?.(...args);
      if (args[2] !== undefined) observed.push(args[2]);
    },
  });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const draw = vi.spyOn(pass, 'drawIndexed');
  try {
    f.record(pass);
    expect(draw).toHaveBeenCalledTimes(129);
    expect(f.receipts.map((receipt) => receipt.entity)).toEqual(
      Array.from({ length: 129 }, (_, index) => index + 1),
    );
    expect(new Set(observed).size).toBe(1);
    const held = observed[0];
    expect(Object.isFrozen(held)).toBe(true);
    expect(held?.material).toBe(first.source.material.snapshot);
    expect(held).not.toHaveProperty('passIndex');
    f.record(pass, 'temporal');
    expect(draw).toHaveBeenCalledTimes(258);
    expect(new Set(observed.slice(129)).size).toBe(1);
    expect(observed[129]).not.toBe(held);
    expect(observed[129]?.unsupportedLineage).toBe(true);
    expect(held?.unsupportedLineage).toBe(false);
    const replacement = f.add({ entity: 130, submeshes: 1 });
    f.record(pass);
    expect(observed.at(-1)?.material).toBe(replacement.source.material.snapshot);
    expect(observed.at(-1)).not.toBe(held);
    expect(held?.material).toBe(first.source.material.snapshot);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('keeps draw coverage when a material receipt consumer closes during recording', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const first = f.add({ entity: 1, submeshes: 1 }).source.material.snapshot;
  for (let entity = 2; entity <= 128; entity++) f.add({ entity, submeshes: 1 });
  const last = f.add({ entity: 129, submeshes: 1 }).source.material.snapshot;
  const receipts: RenderableDrawReceipt[] = [];
  const original = f.c.onRenderableDraw;
  let collecting = true;
  const consume = Object.assign(
    (...args: Parameters<NonNullable<typeof original>>) => {
      original?.(...args);
      if (args[2] !== undefined) receipts.push(args[2]);
      collecting = false;
    },
    { needsMaterialReceipt: (material: typeof first) => collecting || material === last },
  );
  Object.assign(f.c, { onRenderableDraw: consume });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  const draw = vi.spyOn(pass, 'drawIndexed');
  try {
    f.record(pass);
    expect(draw).toHaveBeenCalledTimes(129);
    expect(receipts.map((receipt) => receipt.material)).toEqual([first, last]);
    expect(receipts.every(Object.isFrozen)).toBe(true);
    expect(f.receipts).toHaveLength(129);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('publishes independent complete CPU receipts with exact optional fields', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const instanced = f.add({ entity: 1, submeshes: 1, instances: 2 });
  const ordinary = f.add({ entity: 2, submeshes: 1 });
  const observed: RenderableDrawReceipt[] = [];
  Object.assign(f.c, {
    onRenderableDraw: (_entry: unknown, _submesh: unknown, receipt: RenderableDrawReceipt) =>
      observed.push(receipt),
  });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass);
    expect(observed).toHaveLength(2);
    expect(observed[0]).not.toBe(observed[1]);
    for (const [index, entry] of [instanced, ordinary].entries()) {
      const receipt = observed[index];
      expect(receipt).toEqual({
        lane: 'cpu',
        ready: true,
        pipeline: f.pipeline,
        material: entry.source.material.snapshot,
        unsupportedLineage: index === 0,
        programKey: entry.source.material.snapshot.materialShaderId,
      });
      expect(receipt).not.toHaveProperty('passIndex');
    }
    // A later pass cannot rewrite the previously published ordinary receipt.
    f.record(pass, 'temporal');
    expect(observed[1]?.unsupportedLineage).toBe(false);
    expect(observed.slice(2).every((receipt) => receipt.unsupportedLineage === true)).toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it.each([undefined, []])('preserves every CPU draw without GPU source draws %j', async (draws) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, claimed: [] });
  Object.assign(entry.source, { gpuDrivenDraws: draws });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass);
    expect(f.receipts).toEqual([0, 1, 2].map((submesh) => ({ entity: 1, submesh })));
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('uses each validated GPU ownership lookup once across recording and preserves CPU residuals', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  f.add({ entity: 1, claimed: [0, 2] });
  const selection = f.prepareSelection();
  const has = vi.spyOn(selection, 'owns');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass, 'forward', selection);
    expect(f.receipts).toEqual([{ entity: 1, submesh: 1 }]);
    expect(has).toHaveBeenCalledTimes(2);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('rebuilds compact source indices across sparse rows and nested recording', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const outer = cpuSetupFixture(device, module);
  const inner = cpuSetupFixture(device, module);
  outer.add({ entity: 1, claimed: [0, 2] });
  outer.add({ entity: 2, claimed: [1] });
  outer.add({ entity: 3, claimed: [] });
  inner.add({ entity: 4, claimed: [1] });
  const submitted = outer.c.onRenderableDraw;
  let nested = false;
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  Object.assign(outer.c, {
    onRenderableDraw: (...args: Parameters<NonNullable<typeof submitted>>) => {
      submitted?.(...args);
      if (nested) return;
      nested = true;
      inner.record(pass);
    },
  });
  try {
    outer.record(pass);
    expect(outer.receipts).toEqual([
      { entity: 1, submesh: 1 },
      { entity: 2, submesh: 0 },
      { entity: 2, submesh: 2 },
      ...[0, 1, 2].map((submesh) => ({ entity: 3, submesh })),
    ]);
    expect(inner.receipts).toEqual([0, 2].map((submesh) => ({ entity: 4, submesh })));
    expect([...outer.errors, ...inner.errors]).toEqual([]);
  } finally {
    pass.end();
    outer.dispose();
    inner.dispose();
  }
});

it.each([
  'ordinal',
  'mixed',
] as const)('preserves the %s source-to-mesh draw domain', async (identity) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, claimed: identity === 'ordinal' ? [2] : [0, 2] });
  const draws = entry.source.gpuDrivenDraws ?? [];
  Object.assign(entry.source, {
    gpuDrivenDraws: draws.map((draw, index) => {
      if (index !== 0) return draw;
      const { drawItemIndex: _drawItemIndex, ...ordinal } = draw;
      return ordinal;
    }),
  });
  const selection = f.prepareSelection();
  const has = vi.spyOn(selection, 'owns');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass, 'forward', selection);
    expect(f.receipts).toEqual([0, 1].map((submesh) => ({ entity: 1, submesh })));
    expect(has).toHaveBeenCalledTimes(1);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('retains accepted ownership through dispatch reordering without borrowing another entity sharing draw metadata', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const first = f.add({ entity: 1, claimed: [0, 2] });
  const second = f.add({ entity: 2 });
  const selection = f.prepareSelection();
  Object.assign(second.source, { gpuDrivenDraws: first.source.gpuDrivenDraws });
  const rows = f.entries.slice();
  const has = vi.spyOn(selection, 'owns');
  const ownership = selection;
  expect(has).not.toHaveBeenCalled();
  f.entries.reverse();
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass, 'forward', ownership);
    expect(f.receipts).toEqual([
      ...[0, 1, 2].map((submesh) => ({ entity: 2, submesh })),
      { entity: 1, submesh: 1 },
    ]);
    expect(has).toHaveBeenCalledTimes(4);
    const submitted = vi.fn();
    emitGpuDrivenDrawReceipts(
      rows.map((row) => row.source),
      ownership,
      submitted,
    );
    expect(submitted.mock.calls.map(([row, submesh]) => [row.source.entityKey, submesh])).toEqual([
      [1, 0],
      [1, 2],
    ]);
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('revalidates a same-count source replacement before recording compact draw ownership', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const original = f.add({ entity: 1, claimed: [0, 2] });
  const first = f.prepareSelection();
  const draws = original.source.gpuDrivenDraws ?? [];
  f.entries[0] = {
    ...original,
    source: {
      ...original.source,
      gpuDrivenDraws: draws.map((draw, index) =>
        index === 0
          ? {
              ...draw,
              drawItemIndex: 1,
              first: 3,
              geometry: { ...draw.geometry, draw: { ...draw.geometry.draw, first: 3 } },
            }
          : draw,
      ),
    },
  };
  const replacement = first;
  // A retained selection rejects the changed geometry without rebuilding claims.
  expect(replacement).toBe(first);
  const selection = f.prepareSelection();
  const has = vi.spyOn(selection, 'owns');
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass, 'forward', replacement);
    expect(f.receipts).toEqual([0, 1].map((submesh) => ({ entity: 1, submesh })));
    expect(has).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('maps retained ordinal ownership through the current same-count mesh replacement', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, claimed: [2] });
  Object.assign(entry.source, {
    gpuDrivenDraws: entry.source.gpuDrivenDraws?.map(({ drawItemIndex: _index, ...draw }) => draw),
  });

  const ownership = f.prepareSelection();
  f.entries[0] = {
    ...entry,
    mesh: { ...entry.mesh, submeshes: [...entry.mesh.submeshes].reverse() },
  };

  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    f.record(pass, 'forward', ownership);
    expect(f.receipts).toEqual([1, 2].map((submesh) => ({ entity: 1, submesh })));
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it.each(
  [
    [0, 1, 2],
    [0, 2],
    [2, 0],
  ].map((sections) => ({ sections })),
)('routes issued sections $sections exactly once as selection rotates', async ({ sections }) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, claimed: sections });
  const draws = sealSourceDraws([...(entry.source.gpuDrivenDraws ?? [])]);
  Object.assign(entry.source, { gpuDrivenDraws: draws });
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    expect(Object.isFrozen(draws)).toBe(true);
    for (const section of [-1, 0.5, 0, 1, 2, 3])
      expect(issuedSectionIndex(draws, section)).toBe(sections.indexOf(section));
    for (const selected of [sections, ...sections.map((section) => [section]), []]) {
      f.selectedDraws.clear();
      for (const [i, section] of sections.entries()) {
        const draw = draws[i];
        assert(draw);
        expect(sourceDrawForSection(draws, section)).toBe(draw);
        expect(Object.isFrozen(draw)).toBe(true);
        if (selected.includes(section)) f.selectedDraws.add(draw.geometry);
      }
      const selection = f.prepareSelection();
      f.receipts.length = 0;
      f.record(pass, 'forward', selection);
      const gpu = vi.fn();
      emitGpuDrivenDrawReceipts([entry.source], selection, gpu);
      expect(gpu.mock.calls.map(([, section]) => section).sort()).toEqual([...selected].sort());
      expect(f.receipts.map((receipt) => receipt.submesh)).toEqual(
        [0, 1, 2].filter((section) => !selected.includes(section)),
      );
    }
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it.each([
  'borrowed',
  'caller-frozen',
  'issued',
] as const)('preserves legacy duplicate and missing section semantics for a %s roster', async (owner) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1, claimed: [0, 1, 2] });
  const selection = f.prepareSelection();
  const rows = [...(entry.source.gpuDrivenDraws ?? [])];
  const [first, second, third] = rows;
  assert(first && second && third);
  const duplicates = sealSourceDraws([{ ...first, drawItemIndex: 1 }, second]);
  expect(issuedSectionIndex(duplicates, 1)).toBeUndefined();
  expect(sourceDrawForSection(duplicates, 1)).toBe(duplicates[0]);
  const { drawItemIndex: _legacy, ...ordinal } = third;
  const live = [{ ...first, drawItemIndex: 1 }, { ...second, materialSlot: 1 }, ordinal];
  const table =
    owner === 'issued'
      ? sealSourceDraws(live)
      : owner === 'caller-frozen'
        ? Object.freeze(live)
        : live;
  Object.assign(entry.source, { gpuDrivenDraws: table });
  const owns = vi.spyOn(selection, 'owns').mockReturnValue(false);
  const pass = device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  try {
    for (let revision = 0; revision < (owner === 'borrowed' ? 2 : 1); revision++) {
      if (revision === 1) {
        const [a, b] = live;
        assert(a && b);
        live.splice(0, 2, b, a);
      }
      expect(issuedSectionIndex(table, 1)).toBeUndefined();
      expect(sourceDrawForSection(table, 1)).toBe(table[0]);
      expect(sourceDrawForSection(table, 2)).toBe(ordinal);
      owns.mockClear();
      expect(selection.has(entry.source, 1)).toBe(false);
      expect(owns.mock.calls[0]?.[1]).toBe(table[0]);
      owns.mockClear();
      f.receipts.length = 0;
      f.record(pass, 'forward', selection);
      expect(owns.mock.calls.map(([, draw, index]) => [draw, index])).toEqual([[table[1], 1]]);
      expect(f.receipts.map(({ submesh }) => submesh)).toEqual([0, 1, 2]);
    }
    expect(f.errors).toEqual([]);
  } finally {
    pass.end();
    f.dispose();
  }
});

it('observes same-length caller edits until a new owner explicitly issues the table', () => {
  const template = receiptRow().source.gpuDrivenDraws?.[0];
  assert(template);
  const live = [2, 0].map((drawItemIndex) => ({ ...template, drawItemIndex }));
  const table = Object.freeze(live);
  const row = table[0];
  assert(row);
  expect(issuedSectionIndex(table, 2)).toBeUndefined();
  expect(sourceDrawForSection(table, 2)).toBe(row);
  row.drawItemIndex = 7;
  expect(sourceDrawForSection(table, 2)).toBeUndefined();
  expect(sourceDrawForSection(table, 7)).toBe(row);
  expect(issuedSectionIndex(table, 7)).toBeUndefined();
  const owned = sealSourceDraws(table.map((draw) => ({ ...draw })));
  row.drawItemIndex = 8;
  expect(issuedSectionIndex(owned, 7)).toBe(0);
  expect(sourceDrawForSection(table, 8)).toBe(row);
});
