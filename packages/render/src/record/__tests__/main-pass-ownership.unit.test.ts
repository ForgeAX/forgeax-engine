import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { emitGpuDrivenDrawReceipts } from '../gpu-draw-receipts';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

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
