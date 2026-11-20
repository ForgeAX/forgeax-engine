import { FORGEAX_FRAME_COMPLETED_EVENT } from '@forgeax/engine/app';
import { createApp } from '@forgeax/engine/app/browser';
import { prepareRuntimePackDelivery, serveRuntimePackDelivery } from './runtime-packs';

let app;
let port;
let stopDelivery;
let stopRenderFrames;
let readyRenderFrames = 0;
let id = 0;
const pending = new Map();
export const errors = [];
export async function open(bootstrap, splitRender = false, taskPressure = false, renderMeshBudget, replacementMemoryChannel) {
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
  // Recovery replaces the transferred canvas. Capture receipts on its parent.
  const canvasHost = canvas.parentElement;
  readyRenderFrames = 0;
  const countReadyFrame = ({ detail }) => {
    if (detail.presentation === 'ready') readyRenderFrames++;
  };
  canvasHost.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, countReadyFrame, true);
  stopRenderFrames = () => canvasHost.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, countReadyFrame, true);
  const result = await createApp(
    canvas,
    {
      ...(renderMeshBudget === undefined ? {} : { dynamicGeometryMeshBudgetBytes: renderMeshBudget }),
      execution: {
        assetCatalog: { url: new URL('pack-index.json', document.baseURI).href },
        workers: { engine: true, render: splitRender, kernels: false },
        bootstrap: new URL(bootstrap, document.baseURI),
        bootstrapData: {
          channel: delivery,
          splitRender,
          replacementMemoryChannel,
          ...(taskPressure ? { pressureUrl: new URL('pressure.ktx2', document.baseURI).href } : {}),
        },
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
export const countReadyRenderFrames = () => readyRenderFrames;
export async function meshResidency() {
  const worldIdentity = report().world.identity;
  if (worldIdentity === null || app.remoteEval === undefined)
    throw new Error('Renderer inspection requires the ready source World');
  const inspection = await app.remoteEval(
    "return await execution.inspectRenderer({ fields: ['meshResidency'] });",
    worldIdentity,
  );
  if (!inspection.ok) throw inspection.error;
  return inspection.value.meshResidency;
}
export async function close() {
  (await app.dispose()).unwrap();
  stopRenderFrames();
  stopDelivery();
  port.close();
  return { errors, report: report(), pending: pending.size };
}

export const prepareDelivery = prepareRuntimePackDelivery;
