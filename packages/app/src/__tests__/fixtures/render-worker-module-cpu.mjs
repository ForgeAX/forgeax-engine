// CPU transport fixture: import the owning built Worker module, never initialize a GPU.
import { parentPort, workerData } from 'node:worker_threads';

if (parentPort === null) throw new Error('Fixture requires its own Node Worker');
let gpuCalls = 0;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    gpu: {
      requestAdapter() {
        gpuCalls++;
        throw new Error('Unexpected top-level GPU request');
      },
    },
  },
});
globalThis.postMessage = (data) => parentPort.postMessage({ fixture: 'product', data });
globalThis.close = () => parentPort.close();
let loaded = false;
let hostPort;
const pictures = new Map();
parentPort.on('message', async (message) => {
  if (message.fixture === 'load') {
    // Error mode is a genuine failing ES module, not a rejected transport mock.
    await import(
      workerData.failModule
        ? 'data:text/javascript,throw new Error("fixture-early-module-failure")'
        : workerData.moduleUrl
    );
    loaded = true;
    parentPort.postMessage({ fixture: 'loaded', moduleUrl: workerData.moduleUrl, gpuCalls });
    return;
  }
  if (message.kind === 'init') {
    if (!loaded) throw new Error('Fixture init arrived before module load completed');
    hostPort = message.hostPort;
    // Controlled CPU ready response: real GPU initialization is intentionally not invoked.
    parentPort.postMessage({
      fixture: 'product',
      data: {
        kind: 'ready',
        capabilities: { backendKind: 'webgpu', storageBuffer: true },
      },
    });
    return;
  }
  if (message.kind === 'draw') {
    pictures.set(message.frameId, message);
    return;
  }
  if (message.fixture === 'submit' || message.fixture === 'complete') {
    const picture = pictures.get(message.frameId);
    if (picture === undefined) throw new Error('Fixture picture was not published');
    const submitted = message.fixture === 'submit';
    const p = picture.publication;
    const buffers = submitted ? [] : [p.record];
    parentPort.postMessage(
      {
        fixture: 'product',
        data: {
          kind: submitted ? 'submitted' : 'completed',
          revision: p.revision,
          ...(submitted ? { features: [] } : { buffers }),
          frame: {
            kind: submitted ? 'frame-submitted' : 'frame-complete',
            worldIdentity: picture.worldIdentity,
            frameId: picture.frameId,
            deviceGeneration: 1,
            presentation: 'ready',
            engineUpdateMs: 0,
            kernelWaitMs: 0,
          },
        },
      },
      buffers,
    );
    hostPort?.postMessage({
      kind: submitted ? 'render-submitted' : 'render-complete',
      epoch: p.epoch,
      frame: {
        kind: submitted ? 'frame-submitted' : 'frame-complete',
        worldIdentity: picture.worldIdentity,
        frameId: picture.frameId,
        deviceGeneration: 1,
        presentation: 'ready',
        engineUpdateMs: 0,
        kernelWaitMs: 0,
      },
    });
    if (!submitted) pictures.delete(message.frameId);
    return;
  }
  if (message.kind === 'dispose' || message.kind === 'inspect') {
    if (typeof globalThis.onmessage !== 'function')
      throw new Error('Actual module handler is missing');
    globalThis.onmessage({ data: message });
    return;
  }
  throw new Error('Unexpected fixture command');
});
