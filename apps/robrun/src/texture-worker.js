import { transcodeTexturePacked } from '@forgeax/engine/codec';

self.onmessage = async ({ data: { id, bytes } }) => {
  try {
    const result = await transcodeTexturePacked({
      encoding: 'ktx2',
      data: bytes,
      target: 'rgba8unorm',
    });
    if (!result.ok) throw result.error;
    self.postMessage({ id, texture: result.value }, [result.value.data.buffer]);
  } catch (error) {
    self.postMessage({
      id,
      error: { message: String(error.message ?? error), code: error.code, detail: error.detail },
    });
  }
};
