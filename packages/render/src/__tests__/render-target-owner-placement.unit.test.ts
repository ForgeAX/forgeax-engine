import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import { RenderTargetOperationFailedError } from '../errors/render';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const factorySourcePath = resolve(testDirectory, '../assembly/factory.ts');
const hostSourcePath = resolve(testDirectory, '../assembly/render-target-host.ts');
const renderGraphSourcePath = resolve(testDirectory, '../../../render-graph/src');

describe('RenderTarget owner placement', () => {
  it('places the lifecycle seam under the existing Renderer assembly owner', () => {
    expect(existsSync(hostSourcePath)).toBe(true);
    const factorySource = readFileSync(factorySourcePath, 'utf8');
    const hostSource = readFileSync(hostSourcePath, 'utf8');

    expect(factorySource).toContain('createRenderTargetHost()');
    expect(factorySource).toContain('const renderTargetHost =');
    expect(hostSource).toContain("owner: 'renderer'");
    expect(hostSource).not.toContain('@forgeax/engine-render-graph');
    expect(hostSource).toContain('@forgeax/engine-rhi');
    expect(hostSource).not.toContain('@forgeax/engine-assets-runtime');
    expect(existsSync(renderGraphSourcePath)).toBe(true);
  });

  it('keeps one frame submission and one recovery entrypoint', () => {
    const factorySource = readFileSync(factorySourcePath, 'utf8');
    const drawBoundary = factorySource.slice(
      factorySource.indexOf('drawFrame(request'),
      factorySource.indexOf('observe(', factorySource.indexOf('drawFrame(request')),
    );

    expect(drawBoundary.match(/^\s+const submitted = renderSystem\.draw\(/m)).not.toBeNull();
    expect(drawBoundary).toContain('renderTargetHost.beginFrame()');
    expect(drawBoundary).toContain('renderTargetHost.onFrameSubmitted(completed)');
    expect(factorySource.match(/recover\(\): Promise/g)).toHaveLength(1);
    expect(factorySource.match(/renderTargetHost\.recover\(\)/g)).toHaveLength(1);
  });

  it('keeps the off path free of target allocation and graph submission', () => {
    const factorySource = readFileSync(factorySourcePath, 'utf8');
    const hostSource = readFileSync(hostSourcePath, 'utf8');

    expect(factorySource).not.toContain('new RenderTarget');
    expect(factorySource).not.toContain('CubeCamera');
    expect(factorySource).not.toContain('ReflectionProbe');
    expect(hostSource).toContain('createRenderTargetPhysical');
    expect(readFileSync(resolve(testDirectory, '../targets/physical.ts'), 'utf8')).toContain(
      'createTexture',
    );
    expect(hostSource).toContain('RhiCommandEncoder');
    expect(hostSource).not.toMatch(/queue\.submit|finish\(/);
    expect(hostSource).not.toMatch(/RenderGraph|AssetRegistry/);
  });

  it('keeps host lifecycle calls idempotent after renderer disposal', () => {
    const host = createRenderTargetHost();

    expect(host.owner).toBe('renderer');
    host.beginFrame();
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    host.recover();
    host.dispose();
    host.beginFrame();
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    host.recover();
    host.dispose();
  });

  it('binds only the active physical view after the completion receipt settles', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const host = createRenderTargetHost({ getDevice: () => device });
    const targetResult = host.createRenderTarget({
      shape: 'cube',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    const sourceResult = host.createRenderTargetTextureSource(targetResult.value, {
      aspect: 'color',
      dimension: 'cube',
      mipLevel: 0,
    });
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;
    const target = targetResult.value;
    const source = sourceResult.value;
    host.beginFrame();
    const before = host.resolveRenderTargetTextureSource(source);
    expect(before?.textureView).toBeUndefined();
    let resolveCompletion:
      | ((value: { readonly ok: true; readonly value: undefined }) => void)
      | undefined;
    const completion = new Promise<{ readonly ok: true; readonly value: undefined }>((resolve) => {
      resolveCompletion = resolve;
    });
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted(completion);
    resolveCompletion?.({ ok: true, value: undefined });
    await completion;
    await Promise.resolve();
    const after = host.resolveRenderTargetTextureSource(source);
    expect(after?.textureView).toBeDefined();
    host.dispose();
    expect(host.getPhysicalTarget(target)).toBeUndefined();
  });

  it('holds a progressive cube candidate until the renderer promotion gate opens', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    let canPromote = false;
    const host = createRenderTargetHost({
      getDevice: () => device,
      canPromoteTarget: () => canPromote,
    });
    const targetResult = host.createRenderTarget({
      shape: 'cube',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    const sourceResult = host.createRenderTargetTextureSource(targetResult.value, {
      aspect: 'color',
      dimension: 'cube',
      mipLevel: 0,
    });
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;

    host.beginFrame();
    const completion = Promise.resolve({ ok: true, value: undefined } as const);
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted(completion);
    await completion;
    await Promise.resolve();
    expect(host.resolveRenderTargetTextureSource(sourceResult.value)?.textureView).toBeUndefined();

    canPromote = true;
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined } as const));
    await Promise.resolve();
    await Promise.resolve();
    expect(host.resolveRenderTargetTextureSource(sourceResult.value)?.textureView).toBeDefined();
    host.dispose();
  });

  it('keeps a rejected copy pending instead of completing an empty readback', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const host = createRenderTargetHost({ getDevice: () => device });
    const created = host.createRenderTarget({
      shape: '2d',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: false,
      readback: true,
    });
    if (!created.ok) throw created.error;
    host.beginFrame();
    const physical = host.getPhysicalTarget(created.value);
    if (physical === undefined) throw new Error('Missing target physical');
    host.markTargetSubmitted(created.value, physical);
    host.onFrameSubmitted();
    await Promise.resolve();
    const ticket = host.requestTargetReadback(created.value, { mipLevel: 0 });
    if (!ticket.ok) throw ticket.error;
    const encoder = device.createCommandEncoder().unwrap();
    const failure = new RhiError({
      code: 'internal-error',
      expected: 'injected readback copy failure',
      hint: 'retry after repairing the encoder',
    });
    const copy = vi.spyOn(encoder, 'copyTextureToBuffer').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => host.encodePendingReadbacks(encoder)).toThrow(failure);
    const pending = await host.observeTargetReadbacks({ frameId: 1, deviceGeneration: 0 }, [
      ticket.value,
    ]);
    expect(pending.ok).toBe(false);
    host.encodePendingReadbacks(encoder);
    expect(copy).toHaveBeenCalledTimes(2);
    host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined } as const), {
      frameId: 2,
      deviceGeneration: 0,
    });
    const ready = await host.observeTargetReadbacks({ frameId: 2, deviceGeneration: 0 }, [
      ticket.value,
    ]);
    expect(ready.ok).toBe(true);
    host.dispose();
  });

  it.each([
    'aborted',
    'completion-failed',
    'completion-rejected',
  ] as const)('retries an uncommitted readback after %s', async (failure) => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const host = createRenderTargetHost({ getDevice: () => device });
    const created = host.createRenderTarget({
      shape: '2d',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: false,
      readback: true,
    });
    if (!created.ok) throw created.error;
    host.beginFrame();
    const physical = host.getPhysicalTarget(created.value);
    if (physical === undefined) throw new Error('Missing target physical');
    host.markTargetSubmitted(created.value, physical);
    host.onFrameSubmitted();
    await Promise.resolve();
    const ticket = host.requestTargetReadback(created.value, { mipLevel: 0 });
    if (!ticket.ok) throw ticket.error;
    const encoder = device.createCommandEncoder().unwrap();
    const copy = vi.spyOn(encoder, 'copyTextureToBuffer');
    host.encodePendingReadbacks(encoder);
    if (failure !== 'aborted') {
      const error = new RhiError({
        code: 'internal-error',
        expected: 'injected completion failure',
        hint: 'retry',
      });
      host.onFrameSubmitted(
        failure === 'completion-failed'
          ? Promise.resolve(
              err(
                new RenderTargetOperationFailedError({
                  operation: 'readback',
                  stage: 'submit',
                  generation: 0,
                  cause: error,
                  recovery: 'retry',
                }),
              ),
            )
          : Promise.reject(error),
        { frameId: 1, deviceGeneration: 0 },
      );
      await Promise.resolve();
    }
    const rejected = await host.observeTargetReadbacks({ frameId: 1, deviceGeneration: 0 }, [
      ticket.value,
    ]);
    expect(rejected.ok).toBe(false);
    host.beginFrame();
    host.encodePendingReadbacks(encoder);
    expect(copy).toHaveBeenCalledTimes(2);
    host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined } as const), {
      frameId: 2,
      deviceGeneration: 0,
    });
    await Promise.resolve();
    expect(
      (await host.observeTargetReadbacks({ frameId: 1, deviceGeneration: 0 }, [ticket.value])).ok,
    ).toBe(false);
    expect(
      (await host.observeTargetReadbacks({ frameId: 2, deviceGeneration: 0 }, [ticket.value])).ok,
    ).toBe(true);
    host.dispose();
  });

  it('releases every successful staging buffer while the target stays alive', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const host = createRenderTargetHost({ getDevice: () => device });
    const created = host.createRenderTarget({
      shape: '2d',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: false,
      readback: true,
    });
    if (!created.ok) throw created.error;
    host.beginFrame();
    const physical = host.getPhysicalTarget(created.value);
    if (physical === undefined) throw new Error('Missing target physical');
    host.markTargetSubmitted(created.value, physical);
    host.onFrameSubmitted();
    await Promise.resolve();
    const allocations = vi.spyOn(device, 'createBuffer');
    const destroy = vi.spyOn(device, 'destroyBuffer');
    try {
      for (let frameId = 1; frameId <= 20; frameId++) {
        const ticket = host.requestTargetReadback(created.value, { mipLevel: 0 });
        if (!ticket.ok) throw ticket.error;
        host.beginFrame();
        host.encodePendingReadbacks(device.createCommandEncoder().unwrap());
        const receipt = { frameId, deviceGeneration: 0 };
        host.onFrameSubmitted(Promise.resolve({ ok: true, value: undefined } as const), receipt);
        await Promise.resolve();
        const observed = await host.observeTargetReadbacks(receipt, [ticket.value]);
        expect(observed.ok).toBe(true);
        expect((await host.observeTargetReadbacks(receipt, [ticket.value])).ok).toBe(false);
      }
      expect(allocations).toHaveBeenCalledTimes(20);
      const allocated = allocations.mock.results.flatMap((result) =>
        result.type === 'return' ? [result.value.unwrap()] : [],
      );
      const retired = new Set(destroy.mock.calls.map(([buffer]) => buffer));
      expect(allocated.filter((buffer) => !retired.has(buffer))).toHaveLength(0);
      expect(host.getPhysicalTarget(created.value)).toBe(physical);
    } finally {
      host.dispose();
    }
  });

  it('retires physical generations and readback tickets across recovery', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    let generation = 0;
    const host = createRenderTargetHost({
      getDevice: () => device,
      getGeneration: () => generation,
    });
    const targetResult = host.createRenderTarget({
      shape: '2d',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: true,
    });
    expect(targetResult.ok).toBe(true);
    if (!targetResult.ok) return;
    const target = targetResult.value;
    host.beginFrame();
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    await Promise.resolve();
    expect(host.getPhysicalTarget(target)).toBeDefined();
    const ticket = host.requestTargetReadback(target, {
      mipLevel: 0,
    });
    expect(ticket.ok).toBe(true);

    generation = 1;
    host.recover();
    expect(host.getPhysicalTarget(target)).toBeUndefined();
    if (ticket.ok) {
      const stale = await host.observeTargetReadbacks({ frameId: 1, deviceGeneration: 0 }, [
        ticket.value,
      ]);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe('render-target-state-invalid');
    }

    host.beginFrame();
    for (const { target } of host.descriptions()) {
      const physical = host.getPhysicalTarget(target);
      if (physical !== undefined) host.markTargetSubmitted(target, physical);
    }
    host.onFrameSubmitted();
    await Promise.resolve();
    expect(host.getPhysicalTarget(target)).toBeDefined();
    host.dispose();
  });
});
