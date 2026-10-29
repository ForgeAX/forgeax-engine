import { Hash } from 'node:crypto';
import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { err, ShaderSource, shaderSourceForDescriptor } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { makeShaderDeviceAdapter } from '../assembly/material-shader-policy';
import { DeviceScope } from '../device/device-scope';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { colorStageFixture } from './color-stage-device-lifetime.fixture';

it('retains the admitted source descriptor with the existing program across graph replacement', async () => {
  const f = await colorStageFixture();
  const matches = vi.spyOn(ShaderSource.prototype, 'matches');
  const hash = vi.spyOn(Hash.prototype, 'update');
  const compile = vi.fn(
    (_device: RhiDevice, descriptor: Parameters<typeof f.factory.createShaderModule>[0]) =>
      f.factory.createShaderModule(descriptor),
  );
  const adapter = makeShaderDeviceAdapter(
    f.device,
    new RhiErrorListenerRegistry(),
    undefined,
    compile,
    'immediate',
  );
  const modules = vi.fn(adapter.createShaderModule);
  const factory = { createShaderModule: modules };
  try {
    const first = await f.draw({ factory });
    const descriptor = modules.mock.calls[0]?.[0];
    if (descriptor?.label === undefined) throw Error('Expected a labeled source descriptor');
    expect(shaderSourceForDescriptor(descriptor)).toBeDefined();
    for (let frame = 0; frame < 16; frame++) await f.draw({ factory, width: 16 });
    expect(modules).toHaveBeenCalledTimes(17);
    for (const [request] of modules.mock.calls) expect(request).toBe(descriptor);
    expect(matches).not.toHaveBeenCalled();
    expect(hash.mock.calls.filter(([input]) => input === descriptor?.code)).toHaveLength(1);
    expect(compile).toHaveBeenCalledTimes(1);
    // Invalidation still reaches the factory using the same immutable CPU source.
    f.invalidateModules();
    adapter.invalidateModule(descriptor.label);
    expect((await f.draw({ factory })).pipeline).not.toBe(first.pipeline);
    expect(modules.mock.calls.at(-1)?.[0]).toBe(descriptor);
    await f.draw({ factory, strength: 0.5 });
    expect(modules.mock.calls.at(-1)?.[0]).not.toBe(descriptor);
  } finally {
    adapter.dispose();
    hash.mockRestore();
    matches.mockRestore();
    f.scope.retire();
  }
});

it('reuses LUT programs across graph replacement and resize while binding current views', async () => {
  const f = await colorStageFixture();
  const creates = vi.spyOn(f.device, 'createRenderPipeline'),
    modules = vi.spyOn(f.factory, 'createShaderModule'),
    bindings = vi.spyOn(f.device, 'createBindGroup');
  const first = await f.draw(),
    second = await f.draw({ width: 16 });
  expect(second.pipeline).toBe(first.pipeline);
  expect(creates).toHaveBeenCalledTimes(1);
  expect(modules).toHaveBeenCalledTimes(2);
  expect(second.inputView).not.toBe(first.inputView);
  expect(second.lutBinding).not.toBe(first.lutBinding);
  expect(second.groups.find((group) => group.index === 1)?.group).toBe(second.lutBinding);
  expect(Array.from(bindings.mock.calls.at(-1)?.[0].entries ?? [])[0]?.resource).toEqual({
    kind: 'textureView',
    value: second.inputView,
  });
  expect(modules.mock.calls[0]?.[0].code).toContain('mix(color.rgb, mapped.rgb, 0.35)');
  expect(creates.mock.calls[0]?.[0]).toMatchObject({
    fragment: { entryPoint: 'color_stage_fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  f.scope.retire();
});

it('separates exact strength source, target, stage layout, factory and device generation', async () => {
  const f = await colorStageFixture(),
    creates = vi.spyOn(f.device, 'createRenderPipeline');
  const initial = await f.draw();
  expect((await f.draw({ strength: 0.5 })).pipeline).not.toBe(initial.pipeline);
  expect((await f.draw()).pipeline).toBe(initial.pipeline);
  expect((await f.draw({ format: 'rgba16float' })).pipeline).not.toBe(initial.pipeline);
  expect((await f.draw({ layout: f.lutLayout() })).pipeline).not.toBe(initial.pipeline);
  expect((await f.draw({ factory: { ...f.factory } })).pipeline).not.toBe(initial.pipeline);
  const next = DeviceScope.create(2, f.scope.owner);
  expect((await f.draw({ scope: next })).pipeline).not.toBe(initial.pipeline);
  expect(creates).toHaveBeenCalledTimes(6);
  f.scope.retire();
  next.retire();
});

it('observes a replaced factory method without reusing its previous native program', async () => {
  const f = await colorStageFixture(),
    first = await f.draw(),
    original = f.factory.createShaderModule;
  f.factory.createShaderModule = (input) => original(input);
  expect((await f.draw()).pipeline).not.toBe(first.pipeline);
  f.scope.retire();
});

it('never admits a failed pipeline and retries the complete unchanged request', async () => {
  const f = await colorStageFixture(),
    creates = vi.spyOn(f.device, 'createRenderPipeline');
  creates.mockReturnValueOnce(
    err(new RhiError({ code: 'rhi-not-available', expected: 'test pipeline', hint: 'retry' })),
  );
  await expect(f.draw()).rejects.toBeDefined();
  const ready = await f.draw();
  expect((await f.draw()).pipeline).toBe(ready.pipeline);
  expect(creates).toHaveBeenCalledTimes(2);
  f.scope.retire();
});

it('bounds changing strength variants and releases retained programs at scope retirement', async () => {
  const f = await colorStageFixture(),
    creates = vi.spyOn(f.device, 'createRenderPipeline');
  const first = await f.draw({ strength: 0 });
  for (let i = 1; i <= 16; i++) await f.draw({ strength: i / 32 });
  expect((await f.draw({ strength: 0 })).pipeline).not.toBe(first.pipeline);
  expect(creates).toHaveBeenCalledTimes(18);
  expect(f.scope.resourceDelta()).toBe(1);
  f.scope.retire();
  expect(f.scope.resourceDelta()).toBe(0);
  const inactive = await f.draw({ strength: 0 });
  expect((await f.draw({ strength: 0 })).pipeline).not.toBe(inactive.pipeline);
});

it('observes module invalidation in the unchanged factory before reusing a pipeline', async () => {
  const f = await colorStageFixture(),
    first = await f.draw();
  f.invalidateModules();
  expect((await f.draw()).pipeline).not.toBe(first.pipeline);
  f.scope.retire();
});

it('does not bypass the module factory pending state with an older cached pipeline', async () => {
  const f = await colorStageFixture(),
    creates = vi.spyOn(f.device, 'createRenderPipeline');
  const first = await f.draw();
  f.invalidateModules();
  vi.spyOn(f.factory, 'createShaderModule').mockReturnValueOnce(
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'pending module',
        hint: 'retry after preparation',
      }),
    ),
  );
  await expect(f.draw()).rejects.toBeDefined();
  expect(creates).toHaveBeenCalledTimes(1);
  expect((await f.draw()).pipeline).not.toBe(first.pipeline);
  expect(creates).toHaveBeenCalledTimes(2);
  f.scope.retire();
});

it('does not share a pipeline with a distinct device identity in the same scope', async () => {
  const f = await colorStageFixture(),
    first = await f.draw();
  const device = new Proxy(f.device, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const alternate = await f.draw({ device });
  expect(alternate.pipeline).not.toBe(first.pipeline);
  expect((await f.draw({ device })).pipeline).toBe(alternate.pipeline);
  f.scope.retire();
});

it('preserves graph-local reuse for a public frame runtime without an assembly device scope', async () => {
  const f = await colorStageFixture(),
    creates = vi.spyOn(f.device, 'createRenderPipeline');
  await f.draw({ unscoped: true, repeats: 3 });
  expect(creates).toHaveBeenCalledTimes(1);
  expect(f.scope.resourceDelta()).toBe(0);
  f.scope.retire();
});
