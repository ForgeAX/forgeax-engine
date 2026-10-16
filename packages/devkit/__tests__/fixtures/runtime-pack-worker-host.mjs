import { createApp } from '@forgeax/engine/app/browser';
import { prepareRuntimePackDelivery, serveRuntimePackDelivery } from './runtime-packs';

let app;
let port;
let stopDelivery;
let id = 0;
const pending = new Map();
export const errors = [];
export async function open(bootstrap) {
  const channel = new MessageChannel();
  port = channel.port1;
  port.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(JSON.stringify(data.error)));
    else request.resolve(data.value);
  };
  const delivery = `runtime-pack-worker-${crypto.randomUUID()}`;
  stopDelivery = serveRuntimePackDelivery(delivery);
  const canvas = document.querySelector('canvas');
  const result = await createApp(
    canvas,
    {
      execution: {
        assetCatalog: { url: new URL('pack-index.json', document.baseURI).href },
        workers: { engine: true, render: false, kernels: false },
        bootstrap: new URL(bootstrap, document.baseURI),
        bootstrapData: { channel: delivery },
        bootstrapPort: channel.port2,
        startupTimeoutMs: 90000,
        frameTimeoutMs: 30000,
      },
    },
    { shaderManifestUrl: new URL('shaders/manifest.json', document.baseURI).href },
  );
  app = result.unwrap();
  app.onError((error) => errors.push(JSON.parse(JSON.stringify(error))));
  app.start().unwrap();
  return report();
}
export function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    port.postMessage({ id: requestId, method, args });
  });
}
export const report = () => app.execution.report();
export async function close() {
  (await app.dispose()).unwrap();
  stopDelivery();
  port.close();
  return { errors, report: report(), pending: pending.size };
}

export const prepareDelivery = prepareRuntimePackDelivery;
