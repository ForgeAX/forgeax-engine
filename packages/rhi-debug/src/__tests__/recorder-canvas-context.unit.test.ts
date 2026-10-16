import type {
  CanvasConfiguration,
  RhiCanvasContext,
  RhiDevice,
  RhiInstance,
} from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { decodeTape } from '../protocol/codec';
import { assembleTape } from '../recorder/assemble';
import { createRecorderProxy, type RecordableBackend } from '../recorder/proxy';

it('forwards live presentation proof through configure and teardown', () => {
  const proof = { descriptor: true, acquisition: true, validation: true };
  const context: RhiCanvasContext = {
    configure: vi.fn(() => {
      Object.defineProperty(context, 'presentationProof', { value: proof, configurable: true });
      return ok(undefined);
    }),
    unconfigure: () => {
      delete (context as { presentationProof?: unknown }).presentationProof;
    },
    getConfiguration: () => undefined,
    getCurrentTexture: vi.fn(),
  };
  const proxy = createRecorderProxy(backend(vi.fn(() => ok(context))));
  const acquired = proxy.backend.rhi.acquireCanvasContext?.({} as HTMLCanvasElement);
  if (!acquired?.ok) throw new Error('canvas context acquisition failed');
  const wrapped = acquired.value;
  expect(wrapped.presentationProof).toBeUndefined();
  wrapped.configure({ device: {} as RhiDevice, format: 'rgba8unorm' }).unwrap();
  expect(wrapped.presentationProof).toBe(proof);
  wrapped.unconfigure();
  expect(wrapped.presentationProof).toBeUndefined();
});

it('forwards live native alpha capabilities, including an explicit empty list', () => {
  let modes: readonly GPUCanvasAlphaMode[] | undefined;
  const context: RhiCanvasContext = {
    get supportedAlphaModes() {
      return modes;
    },
    configure: vi.fn(() => ok(undefined)),
    unconfigure: vi.fn(),
    getConfiguration: () => undefined,
    getCurrentTexture: vi.fn(),
  };
  const proxy = createRecorderProxy(backend(vi.fn(() => ok(context))));
  const acquired = proxy.backend.rhi.acquireCanvasContext?.({} as HTMLCanvasElement);
  if (!acquired?.ok) throw new Error('canvas context acquisition failed');
  expect(acquired.value.supportedAlphaModes).toBeUndefined();
  modes = ['opaque'];
  expect(acquired.value.supportedAlphaModes).toBe(modes);
  modes = [];
  expect(acquired.value.supportedAlphaModes).toEqual([]);
});

function backend(acquireCanvasContext: ReturnType<typeof vi.fn>): RecordableBackend {
  return {
    rhi: {
      requestAdapter: vi.fn(),
      acquireCanvasContext,
    } as unknown as RhiInstance & RecordableBackend['rhi'],
    createShaderModule: vi.fn(),
  };
}

describe('recorder canvas context device identity', () => {
  it('forwards presentation proof produced during WebGL2 configure', () => {
    const proof = {
      descriptor: true,
      acquisition: true,
      validation: true,
      surfaceIdentity: 'surface-1',
      requested: { width: 1 },
      validated: { width: 1 },
    } as unknown as NonNullable<RhiCanvasContext['presentationProof']>;
    const context: RhiCanvasContext = {
      configure: vi.fn(() => {
        Object.assign(context, { presentationProof: proof });
        return ok(undefined);
      }),
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(),
      getCurrentTexture: vi.fn(),
    } as unknown as RhiCanvasContext;
    const proxy = createRecorderProxy(backend(vi.fn(() => ok(context))));
    const acquired = proxy.backend.rhi.acquireCanvasContext?.({} as HTMLCanvasElement);
    if (!acquired?.ok) throw new Error('canvas context acquisition failed');
    expect(acquired.value.presentationProof).toBeUndefined();
    acquired.value.configure({
      device: {} as RhiDevice,
      format: 'bgra8unorm',
    } as CanvasConfiguration);
    expect(acquired.value.presentationProof).toBe(proof);
  });

  it('resolves the actual Null recorder device without bypassing its resource factories', async () => {
    const proxy = createRecorderProxy({ rhi, createShaderModule });
    const adapter = (await proxy.backend.rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    expect(device.caps.backendKind).toBe('null');
    expect(proxy.backend.unwrapDeviceForSurface(device).unwrap() === device).toBe(true);
    const raw = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    expect(proxy.backend.unwrapDeviceForSurface(raw).ok).toBe(false);
  });

  it('requires configuration before the actual Null context exposes its current texture', () => {
    const proxy = createRecorderProxy({ rhi, createShaderModule });
    const context = proxy.backend.rhi.acquireCanvasContext?.({
      width: 64,
      height: 64,
    } as HTMLCanvasElement);
    if (!context?.ok) throw new Error('Null context acquisition failed');
    const texture = context.value.getCurrentTexture();
    expect(texture.ok).toBe(false);
    if (texture.ok) throw new Error('an unconfigured Null context must reject texture access');
    expect(texture.error).toMatchObject({
      code: 'webgpu-runtime-error',
      expected: 'GPUCanvasContext.getCurrentTexture to succeed (context configured)',
      hint: 'configure the context before requesting its current texture',
    });
    expect(context.value.getConfiguration()).toBeUndefined();
    expect(() => context.value.unconfigure()).not.toThrow();
    expect(context.value.getConfiguration()).toBeUndefined();
  });
  it('captures the configured Null texture identity through an accepted attachment and retires it at completion', async () => {
    const proxy = createRecorderProxy({ rhi, createShaderModule });
    const adapter = await proxy.backend.rhi.requestAdapter();
    if (!adapter.ok) throw adapter.error;
    const requested = await adapter.value.requestDevice();
    if (!requested.ok) throw requested.error;
    const context = proxy.backend.rhi.acquireCanvasContext?.({
      width: 64,
      height: 64,
    } as HTMLCanvasElement);
    if (!context?.ok) throw new Error('Null context acquisition failed');
    proxy.recorder.arm(1).unwrap();
    const configured = context.value.configure({
      device: requested.value,
      format: 'bgra8unorm',
    });
    if (!configured.ok) throw configured.error;

    const texture = context.value.getCurrentTexture();
    if (!texture.ok) throw texture.error;
    const repeated = context.value.getCurrentTexture();
    if (!repeated.ok) throw repeated.error;
    expect(repeated.value).toBe(texture.value);

    const viewed = requested.value.createTextureView(texture.value, { format: 'bgra8unorm' });
    if (!viewed.ok) throw viewed.error;
    const textureCreate = proxy.recorder
      .getEvents()
      .find((event) => event.kind === 'createTexture');
    if (textureCreate?.kind !== 'createTexture')
      throw new Error('the configured Null context texture was not recorded');
    const encoder = requested.value.createCommandEncoder({});
    if (!encoder.ok) throw encoder.error;
    encoder.value
      .beginRenderPass({
        colorAttachments: [{ view: viewed.value, loadOp: 'clear', storeOp: 'store' }],
      })
      .end();
    const commands = encoder.value.finish();
    if (!commands.ok) throw commands.error;
    const submitted = requested.value.queue.submit([commands.value]);
    if (!submitted.ok) throw submitted.error;

    const successor = context.value.getCurrentTexture();
    if (!successor.ok) throw successor.error;
    expect(successor.value).not.toBe(texture.value);
    expect(requested.value.createTextureView(texture.value, {}).ok).toBe(true);
    expect(
      proxy.recorder
        .getEvents()
        .some(
          (event) => event.kind === 'destroyTexture' && event.handleId === textureCreate.handleId,
        ),
    ).toBe(false);

    await requested.value.queue.onSubmittedWorkDone();
    expect(context.value.getCurrentTexture()).toMatchObject({ ok: true, value: successor.value });
    const retired = requested.value.createTextureView(texture.value, {});
    expect(retired.ok).toBe(false);
    if (retired.ok) throw new Error('the submitted canvas texture must retire on completion');
    expect(retired.error.code).toBe('destroy-after-destroy');
    expect(
      proxy.recorder
        .getEvents()
        .some(
          (event) => event.kind === 'destroyTexture' && event.handleId === textureCreate.handleId,
        ),
    ).toBe(true);

    proxy.recorder.onFrameEnd();
    const assembled = assembleTape(proxy.recorder);
    if (!assembled.ok) throw assembled.error;
    const decoded = decodeTape(assembled.value.bytes);
    if (!decoded.ok) throw decoded.error;
    const tape = decoded.value;
    const capturedView = tape.bootstrap.find((resource) => resource.kind === 'texture-view');
    if (!capturedView) throw new Error('captured tape omitted the real canvas texture view');
    expect(capturedView.create).toMatchObject({
      kind: 'createTextureView',
      desc: { format: 'bgra8unorm' },
    });
    const sourceHandleId = capturedView.create.sourceHandleId;
    if (typeof sourceHandleId !== 'string')
      throw new Error('captured view omitted its source handle');
    const capturedTexture = tape.bootstrap.find(
      (resource) => resource.kind === 'texture' && resource.handleId === sourceHandleId,
    );
    if (!capturedTexture) throw new Error('captured view does not resolve to its created texture');
    expect(capturedTexture.create).toMatchObject({
      kind: 'createTexture',
      desc: {
        format: 'bgra8unorm',
        size: expect.objectContaining({ width: 64, height: 64 }),
      },
    });
    expect(tape.events).toContainEqual(
      expect.objectContaining({
        kind: 'beginRenderPass',
        colorAttachmentViewHandleIds: expect.arrayContaining([capturedView.handleId]),
      }),
    );
    expect(tape.events).toContainEqual(expect.objectContaining({ kind: 'submit' }));
  });

  it('unwraps the recorder device before forwarding canvas configure', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = {
      configure,
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(),
      getCurrentTexture: vi.fn(),
    } as unknown as RhiCanvasContext;
    const acquireCanvasContext = vi.fn(() => ok(context));
    const originalDevice = { caps: {} } as unknown as RhiDevice;
    const recorderDevice = { _realDevice: originalDevice } as unknown as RhiDevice;
    const proxy = createRecorderProxy(backend(acquireCanvasContext));

    const acquired = proxy.backend.rhi.acquireCanvasContext?.({} as HTMLCanvasElement);
    expect(acquired?.ok).toBe(true);
    if (!acquired?.ok) return;

    const configuration = {
      device: recorderDevice,
      format: 'bgra8unorm',
    } as CanvasConfiguration;
    expect(acquired.value.configure(configuration)).toEqual(ok(undefined));
    expect(acquireCanvasContext).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith({
      ...configuration,
      device: originalDevice,
    });
  });

  it('preserves a native device when no recorder identity is present', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = {
      configure,
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(),
      getCurrentTexture: vi.fn(),
    } as unknown as RhiCanvasContext;
    const proxy = createRecorderProxy(backend(vi.fn(() => ok(context))));
    const nativeDevice = { caps: {} } as unknown as RhiDevice;
    const acquired = proxy.backend.rhi.acquireCanvasContext?.({} as HTMLCanvasElement);
    if (!acquired?.ok) throw new Error('canvas context acquisition failed');

    acquired.value.configure({ device: nativeDevice, format: 'bgra8unorm' } as CanvasConfiguration);
    expect(configure).toHaveBeenCalledWith({ device: nativeDevice, format: 'bgra8unorm' });
  });
});
