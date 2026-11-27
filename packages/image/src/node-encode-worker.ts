import { getHeapStatistics } from 'node:v8';
import { basisEncode } from '@forgeax/engine-codec/encode';
import {
  type ImageEncodeRequest,
  type ImageEncodeResponse,
  imageEncodeFailure,
} from './node-encode-wire.js';

if (process.send === undefined) throw new Error('Image encoder requires an owned Node IPC process');
process.on('message', async (request: ImageEncodeRequest) => {
  let result: ImageEncodeResponse['result'];
  try {
    result = await basisEncode(request.pixels, request.options);
  } catch {
    result = imageEncodeFailure(request.options.mode, 'native encoder worker failed');
  }
  if (result.ok) result = { ok: true, value: new Uint8Array(result.value) };
  const response: ImageEncodeResponse = {
    id: request.id,
    result,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
  };
  process.send?.(response);
});
