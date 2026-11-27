import { afterEach, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => {
  const deviceModule = Promise.withResolvers<void>();
  return {
    deviceModule,
    stagedShaders: Promise.resolve({}),
    stageShaders: vi.fn(),
    adopt: vi.fn(),
    receive: vi.fn(),
  };
});

vi.mock('@forgeax/engine-runtime/internal/shader-publication', () => ({
  stagePublicationShaders: control.stageShaders,
}));

vi.mock('../execution/render-worker-runtime', async () => {
  await control.deviceModule.promise;
  return {
    adoptStagedRenderShaders: control.adopt,
    receiveRenderWorkerInput: control.receive,
  };
});

afterEach(() => {
  control.deviceModule.resolve();
  vi.unstubAllGlobals();
});

it('starts shader admission before the device module and replays pending requests in order', async () => {
  vi.stubGlobal('onmessage', null);
  control.stageShaders.mockReturnValue({ ready: control.stagedShaders });
  await import('../execution/render-worker-entry');
  const send = Reflect.get(globalThis, 'onmessage') as (event: MessageEvent) => void;
  const url = '/fixture/shaders.json';
  const init = new MessageEvent('message', { data: { kind: 'init' } });
  const dispose = new MessageEvent('message', { data: { kind: 'dispose' } });
  send(new MessageEvent('message', { data: { kind: 'stage-shader-manifest', url } }));
  send(new MessageEvent('message', { data: { kind: 'stage-shader-manifest', url } }));
  send(init);
  send(dispose);

  expect(control.stageShaders).toHaveBeenCalledExactlyOnceWith({ shaderManifestUrl: url });
  expect(control.adopt).not.toHaveBeenCalled();
  expect(control.receive).not.toHaveBeenCalled();

  control.deviceModule.resolve();
  await vi.waitFor(() => {
    expect(globalThis.onmessage).toBe(control.receive);
    expect(control.adopt).toHaveBeenCalledExactlyOnceWith({ url, ready: control.stagedShaders });
    expect(control.receive.mock.calls).toEqual([[init], [dispose]]);
  });
  expect(control.adopt.mock.invocationCallOrder[0]).toBeLessThan(
    control.receive.mock.invocationCallOrder[0] as number,
  );
});
