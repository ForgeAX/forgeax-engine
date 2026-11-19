// One bounded content-only pool; decoding never receives the World or GPU handles.
export function createTextureDecoder(workerCount = 4) {
  const queue = [],
    workers = [];
  let nextId = 0;
  function pump() {
    for (const slot of workers) {
      if (slot.job || !queue.length) continue;
      const job = queue.shift();
      slot.job = job;
      slot.worker.postMessage({ id: job.id, bytes: job.bytes }, [job.bytes.buffer]);
    }
  }
  for (let i = 0; i < workerCount; i++) {
    const slot = {
      worker: new Worker(new URL('./texture-worker.js', import.meta.url), { type: 'module' }),
      job: null,
    };
    slot.worker.onmessage = ({ data }) => {
      const job = slot.job;
      slot.job = null;
      if (data.error) job.reject(Object.assign(new Error(data.error.message), data.error));
      else {
        const texture = data.texture;
        let offset = 0;
        texture.mipmaps = texture.levels.map((level) => {
          const mip = {
            width: level.width,
            height: level.height,
            data: texture.data.subarray(offset, offset + level.byteLength),
          };
          offset += level.byteLength;
          return mip;
        });
        job.resolve(texture);
      }
      pump();
    };
    slot.worker.onerror = (event) => {
      const job = slot.job;
      slot.job = null;
      job?.reject(new Error(event.message));
      for (const waiting of queue.splice(0)) waiting.reject(new Error(event.message));
    };
    workers.push(slot);
  }
  return {
    decode: (bytes) =>
      new Promise((resolve, reject) => {
        queue.push({ id: nextId++, bytes, resolve, reject });
        pump();
      }),
    dispose() {
      for (const slot of workers) slot.worker.terminate();
    },
  };
}
