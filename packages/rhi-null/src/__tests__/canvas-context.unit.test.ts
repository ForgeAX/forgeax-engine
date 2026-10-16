import type {
  CanvasConfiguration,
  Result,
  RhiDevice,
  RhiError as RhiErrorType,
  TextureDescriptor,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RhiNullDevice } from '../device';
import { rhi } from '../index';

interface TestCanvas {
  width: number;
  height: number;
}

const canvas = (width = 640, height = 360): TestCanvas => ({ width, height });

async function createDevice(): Promise<RhiNullDevice> {
  const adapterResult = await rhi.requestAdapter();
  if (!adapterResult.ok) throw adapterResult.error;
  const deviceResult = await adapterResult.value.requestDevice();
  if (!deviceResult.ok) throw deviceResult.error;
  return deviceResult.value as RhiNullDevice;
}

function acquire(surface: TestCanvas) {
  const result = rhi.acquireCanvasContext(surface as HTMLCanvasElement);
  if (!result.ok) throw result.error;
  return result.value;
}

function configuration(
  device: RhiDevice,
  overrides: Partial<CanvasConfiguration> = {},
): CanvasConfiguration {
  return { device, format: 'bgra8unorm', usage: 0x10, ...overrides };
}

function expectError<T>(result: Result<T, RhiErrorType>, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
    expect(result.error.expected.length).toBeGreaterThan(0);
    expect(result.error.hint.length).toBeGreaterThan(0);
  }
}

const invalidConfigurations: [string, Partial<CanvasConfiguration>][] = [
  ['unsupported format', { format: 'rgba8unorm-srgb' as CanvasConfiguration['format'] }],
  ['zero usage', { usage: 0 }],
  ['non-finite usage', { usage: Number.NaN }],
  ['fractional usage', { usage: 1.5 }],
  ['unsupported usage flag', { usage: 0x40 }],
  ['transient usage without render attachment', { usage: 0x20 }],
  ['transient usage with view formats', { usage: 0x30, viewFormats: ['rgba8unorm-srgb'] }],
  ['incompatible view format', { viewFormats: ['rgba8unorm-srgb'] }],
];

describe('RhiNullCanvasContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects current-texture access before configuration', () => {
    const context = acquire(canvas());
    expectError(context.getCurrentTexture(), 'webgpu-runtime-error');
    expect(context.getConfiguration()).toBeUndefined();
  });

  it('creates a sized texture through the configured device and returns a stored configuration copy', async () => {
    const owner = await createDevice();
    const surface = canvas(800, 450);
    const context = acquire(surface);
    const createTexture = vi.spyOn(owner, 'createTexture');
    const config = configuration(owner, {
      format: 'rgba8unorm',
      usage: 0x10 | 0x01,
      viewFormats: ['rgba8unorm-srgb'],
      colorSpace: 'display-p3',
      alphaMode: 'premultiplied',
    });

    expect(context.configure(config).ok).toBe(true);
    const current = context.getCurrentTexture();

    expect(current.ok).toBe(true);
    expect(createTexture).toHaveBeenCalledWith({
      size: { width: 800, height: 450, depthOrArrayLayers: 1 },
      dimension: '2d',
      format: 'rgba8unorm',
      usage: 0x11,
      viewFormats: ['rgba8unorm-srgb'],
    } satisfies TextureDescriptor);
    if (!current.ok) return;
    expect(owner.bookkeeper.validateOwnership(current.value).ok).toBe(true);

    const readback = context.getConfiguration();
    expect(readback).toMatchObject({
      device: owner,
      format: 'rgba8unorm',
      usage: 0x11,
      viewFormats: ['rgba8unorm-srgb'],
      colorSpace: 'display-p3',
      alphaMode: 'premultiplied',
    });
    readback?.viewFormats?.push('bgra8unorm-srgb');
    expect(context.getConfiguration()?.viewFormats).toEqual(['rgba8unorm-srgb']);
  });

  it('applies the canvas defaults and reuses the live texture in one acquisition interval', async () => {
    const owner = await createDevice();
    const context = acquire(canvas());
    expect(context.configure(configuration(owner, { usage: undefined })).ok).toBe(true);

    const first = context.getCurrentTexture();
    const second = context.getCurrentTexture();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toBe(second.value);
    expect(owner.bookkeeper.isDestroyed(first.value)).toBe(false);
    expect(owner.bookkeeper.isDestroyed(second.value)).toBe(false);
    expect(context.getConfiguration()).toMatchObject({ usage: 0x10, viewFormats: [] });
  });

  it('accepts the transient attachment usage only with its required descriptor shape', async () => {
    const owner = await createDevice();
    const context = acquire(canvas());
    const createTexture = vi.spyOn(owner, 'createTexture');
    expect(context.configure(configuration(owner, { usage: 0x30, viewFormats: [] })).ok).toBe(true);

    const current = context.getCurrentTexture();

    expect(current.ok).toBe(true);
    expect(createTexture).toHaveBeenCalledWith(
      expect.objectContaining({ usage: 0x30, viewFormats: [] }),
    );
  });

  it('releases the old texture and its views when the canvas extent changes', async () => {
    const owner = await createDevice();
    const surface = canvas(320, 200);
    const context = acquire(surface);
    const createTexture = vi.spyOn(owner, 'createTexture');
    expect(context.configure(configuration(owner)).ok).toBe(true);

    const first = context.getCurrentTexture();
    if (!first.ok) throw first.error;
    const view = owner.createTextureView(first.value, {});
    if (!view.ok) throw view.error;
    surface.width = 1024;
    surface.height = 768;
    const resized = context.getCurrentTexture();

    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(owner.bookkeeper.isDestroyed(first.value)).toBe(true);
    expect(owner.bookkeeper.isDestroyed(view.value)).toBe(true);
    expectError(owner.createTextureView(first.value, {}), 'destroy-after-destroy');
    expect(createTexture).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        size: { width: 1024, height: 768, depthOrArrayLayers: 1 },
      }),
    );
    expect(owner.bookkeeper.isDestroyed(resized.value)).toBe(false);
  });

  it('reconfigures with a new device owner and unconfigure retires its texture and views once', async () => {
    const firstOwner = await createDevice();
    const nextOwner = await createDevice();
    const context = acquire(canvas());
    expect(context.configure(configuration(firstOwner)).ok).toBe(true);
    const first = context.getCurrentTexture();
    if (!first.ok) throw first.error;
    const firstView = firstOwner.createTextureView(first.value, {});
    if (!firstView.ok) throw firstView.error;

    expect(context.configure(configuration(nextOwner, { format: 'rgba8unorm' })).ok).toBe(true);
    expect(firstOwner.bookkeeper.isDestroyed(first.value)).toBe(true);
    expect(firstOwner.bookkeeper.isDestroyed(firstView.value)).toBe(true);

    const next = context.getCurrentTexture();
    if (!next.ok) throw next.error;
    const nextView = nextOwner.createTextureView(next.value, {});
    if (!nextView.ok) throw nextView.error;
    const destroyNextTexture = vi.spyOn(nextOwner, 'destroyTexture');
    context.unconfigure();
    context.unconfigure();

    expect(nextOwner.bookkeeper.isDestroyed(next.value)).toBe(true);
    expect(nextOwner.bookkeeper.isDestroyed(nextView.value)).toBe(true);
    expect(destroyNextTexture).toHaveBeenCalledTimes(1);
    expect(context.getConfiguration()).toBeUndefined();
    expectError(context.getCurrentTexture(), 'webgpu-runtime-error');
    expect(nextOwner.destroyTexture(next.value).ok).toBe(false);
  });

  it('keeps the active configuration and current resource when a replacement descriptor is invalid', async () => {
    const owner = await createDevice();
    const context = acquire(canvas());
    expect(context.configure(configuration(owner)).ok).toBe(true);
    const current = context.getCurrentTexture();
    if (!current.ok) throw current.error;

    expectError(context.configure(configuration(owner, { usage: 0x40 })), 'rhi-descriptor-invalid');
    expect(context.getConfiguration()).toMatchObject({ device: owner, format: 'bgra8unorm' });
    expect(owner.bookkeeper.isDestroyed(current.value)).toBe(false);
  });

  it.each([
    ['missing extent', undefined],
    ['zero extent', canvas(0, 200)],
    ['non-finite extent', canvas(Number.POSITIVE_INFINITY, 200)],
  ])('rejects %s before storing configuration', async (_case, surface) => {
    const owner = await createDevice();
    const context = rhi.acquireCanvasContext(surface as HTMLCanvasElement | undefined).unwrap();

    expectError(context.configure(configuration(owner)), 'rhi-descriptor-invalid');
    expect(context.getConfiguration()).toBeUndefined();
    expect(owner.bookkeeper.allRecords()).toHaveLength(0);
  });

  it.each(
    invalidConfigurations,
  )('rejects %s without replacing the prior configuration', async (_case, overrides) => {
    const owner = await createDevice();
    const context = acquire(canvas());
    expect(context.configure(configuration(owner)).ok).toBe(true);
    const current = context.getCurrentTexture();
    if (!current.ok) throw current.error;

    const result = context.configure(configuration(owner, overrides));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        overrides.format === undefined ? 'rhi-descriptor-invalid' : 'webgpu-runtime-error',
      );
    }
    expect(owner.bookkeeper.isDestroyed(current.value)).toBe(false);
    expect(context.getConfiguration()).toMatchObject({ format: 'bgra8unorm' });
  });

  it('rejects a foreign backend before creating a texture', () => {
    const createTexture = vi.fn();
    const foreignDevice = {
      caps: { backendKind: 'webgpu' },
      createTexture,
      destroyTexture: vi.fn(),
    } as unknown as RhiDevice;
    const context = acquire(canvas());

    expectError(context.configure(configuration(foreignDevice)), 'rhi-not-available');
    expect(createTexture).not.toHaveBeenCalled();
    expect(context.getConfiguration()).toBeUndefined();
  });

  it('returns the configured owner error when that device can no longer create resources', async () => {
    const owner = await createDevice();
    const unavailableDevice = new Proxy(owner, {
      get(target, property) {
        if (property === 'createTexture') {
          return () =>
            err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'a live RhiNull device',
                hint: 'the device owner reported that it is unavailable',
              }),
            );
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const context = acquire(canvas());
    expect(context.configure(configuration(unavailableDevice)).ok).toBe(true);

    const result = context.getCurrentTexture();

    expectError(result, 'rhi-not-available');
    expect(owner.bookkeeper.allRecords()).toHaveLength(0);
  });
});
