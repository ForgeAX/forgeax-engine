import { parentPort } from 'node:worker_threads';

if (parentPort === null) {
  throw new Error('the MSDF Node worker requires worker_threads.parentPort');
}

const listeners = new Map();
const endpoint = globalThis;

class NodeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

endpoint.ImageData = NodeImageData;
endpoint.addEventListener = (type, listener) => {
  if (type !== 'message') return;
  const handler = (data) => listener({ data, origin: '*' });
  listeners.set(listener, handler);
  parentPort.on('message', handler);
};

endpoint.removeEventListener = (type, listener) => {
  if (type !== 'message') return;
  const handler = listeners.get(listener);
  if (handler === undefined) return;
  listeners.delete(listener);
  parentPort.off('message', handler);
};

endpoint.postMessage = (message, transferList = []) => {
  parentPort.postMessage(message, [...transferList]);
};

await import('@zappar/msdf-generator/worker.js');
