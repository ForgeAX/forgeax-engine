import { readResourceBytes } from './resource-bytes.ts';
import { HTTP_BATCH_SIZE, MCP_NATIVE_IMPORT_SOURCE } from '../contract.ts';
export function installNetworkRuntime(global: any, invoke: any, baseHref: string, batchSize = HTTP_BATCH_SIZE, nativeImportSource = MCP_NATIVE_IMPORT_SOURCE) {
  const fetchNative = global.fetch;
  const WorkerNative = global.Worker;
  const importNative = global.__fxMcpImport;
  const loadNative = importNative ?? ((url: string) => import(/* @vite-ignore */ url));
  const locationNative = global.__fxMcpLocation;
  const blobs = new Set<string>();
  const workers = new Map<any, { channel: MessageChannel; controller: AbortController }>();
  global.__fxMcpLocation = new URL(baseHref);
  const document = global.document;
  const baseDescriptor = document && Object.getOwnPropertyDescriptor(document, 'baseURI');
  if (document)
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      get: () => global.__fxMcpLocation.href,
    });
  const bytes = (ref: any, options: any = {}) => readResourceBytes(ref, (args: any) => invoke(args, options));
  const lifetime = new AbortController();
  type Read = { input: any; signal: AbortSignal; resolve(value: any): void; reject(error: unknown): void; finish(): void };
  let reads: Read[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const queued = reads;
    reads = [];
    for (let start = 0; start < queued.length; start += batchSize) {
      const batch = queued.slice(start, start + batchSize).filter(read => !read.signal.aborted);
      if (!batch.length) continue;
      const controller = new AbortController();
      const cancelled = () => { if (batch.every(read => read.signal.aborted)) controller.abort(); };
      for (const read of batch) read.signal.addEventListener('abort', cancelled);
      const options = { signal: controller.signal };
      void (async () => {
        const result = batch.length === 1
          ? [{ ok: true, value: await invoke(batch[0].input, options) }]
          : JSON.parse(new TextDecoder().decode(await bytes(
            await invoke({ action: 'http-batch', requests: batch.map(read => read.input) }, options), options)));
        if (result.length !== batch.length) throw new Error('HTTP batch omitted a response');
        for (let i = 0; i < batch.length; i++) {
          if (batch[i].signal.aborted) continue;
          result[i].ok ? batch[i].resolve(result[i].value) : batch[i].reject(new Error(result[i].error));
        }
      })().catch(error => { for (const read of batch) read.reject(error); }).finally(() => {
        for (const read of batch) { read.signal.removeEventListener('abort', cancelled); read.finish(); }
      });
    }
  };
  const readHttp = (input: any, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (reads.length >= 512) return Promise.reject(new Error('MCP pending HTTP read bound exceeded'));
    return new Promise<any>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      reads.push({ input, signal, resolve, reject, finish: () => signal.removeEventListener('abort', aborted) });
      if (!scheduled) { scheduled = true; setTimeout(flush, 0); }
    });
  };
  const resolve = (value: any) => new URL(String(value?.url ?? value), baseHref).href;
  const moduleCache = new Map<string, Promise<any>>();
  global.__fxMcpImport = (value: any, from = baseHref) => {
    const url = new URL(String(value), from).href;
    if (url.startsWith('blob:') || url.startsWith('data:')) return loadNative(url);
    let promise = moduleCache.get(url);
    if (!promise) {
      promise = (async () => {
        const ref = await invoke({ action: 'bundle', kind: 'module', url });
        const data = await bytes(ref);
        const blob = URL.createObjectURL(new Blob([data], { type: 'text/javascript' }));
        blobs.add(blob);
        return loadNative(blob);
      })();
      moduleCache.set(url, promise);
    }
    return promise;
  };
  global.fetch = async (input: any, options: any = {}) => {
    const url = resolve(input);
    if (url.startsWith('blob:') || url.startsWith('data:'))
      return fetchNative.call(global, input, options);
    const request = new Request(input instanceof Request ? input : url, options);
    request.signal.throwIfAborted();
    let body: string | undefined;
    if (request.body) {
      const data = new Uint8Array(await request.arrayBuffer());
      let binary = '';
      for (const byte of data) binary += String.fromCharCode(byte);
      body = btoa(binary);
    }
    const inputArgs = {
      action: 'http',
      url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(body === undefined ? {} : { body }),
    };
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    const ref = request.method === 'GET' || request.method === 'HEAD'
      ? await readHttp(inputArgs, signal)
      : await invoke(inputArgs, { signal });
    signal.throwIfAborted();
    const data = await bytes(ref, { signal });
    signal.throwIfAborted();
    const response = new Response(
      [204, 205, 304].includes(ref.status) || request.method === 'HEAD' ? null : data,
      { status: ref.status, headers: ref.headers },
    );
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  if (typeof WorkerNative === 'function') {
    const installer = installNetworkRuntime.toString();
    const source = `${nativeImportSource}const readResourceBytes=${readResourceBytes.toString()};const __vitePreload=fn=>fn();let ready=false;const queued=[];self.addEventListener('message',event=>{if(event.data?.__fxMcpWorkerStart){event.stopImmediatePropagation();const {port,source,baseHref}=event.data.__fxMcpWorkerStart;let seq=0;const pending=new Map();port.onmessage=e=>{const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);e.data.error?p.reject(new Error(e.data.error)):p.resolve(e.data.result);};const invoke=args=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});port.postMessage({id,args});});(${installer})(self,invoke,baseHref,${batchSize},${JSON.stringify(nativeImportSource)});const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));import(url).then(()=>{ready=true;for(const e of queued.splice(0))self.dispatchEvent(new MessageEvent('message',{data:e.data,ports:e.ports}));}).catch(e=>self.postMessage({__fxMcpFailure:String(e)}));}else if(!ready){event.stopImmediatePropagation();queued.push({data:event.data,ports:[...event.ports]});}}, {capture:true});`;
    const bootstrap = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    blobs.add(bootstrap);
    global.Worker = class extends WorkerNative {
      constructor(url: any, options: any = {}) {
        const href = resolve(url);
        if (href.startsWith('blob:') || href.startsWith('data:')) {
          super(url, options);
          return;
        }
        // A classic bootstrap can start inside an opaque sandbox; it imports the logical ESM entry.
        super(bootstrap, { ...options, type: 'classic' });
        const channel = new MessageChannel();
        const controller = new AbortController();
        workers.set(this, { channel, controller });
        channel.port1.onmessage = async (event) => {
          try {
            const result = await invoke(event.data.args, { signal: controller.signal });
            if (controller.signal.aborted) return;
            channel.port1.postMessage({ id: event.data.id, result });
          } catch (error) {
            channel.port1.postMessage({ id: event.data.id, error: String(error) });
          }
        };
        void (async () => {
          const ref = await invoke(
            { action: 'bundle', url: href, kind: 'worker' },
            { signal: controller.signal },
          );
          const data = await bytes(ref, { signal: controller.signal });
          if (controller.signal.aborted) return;
          this.postMessage(
            {
              __fxMcpWorkerStart: {
                port: channel.port2,
                source: new TextDecoder().decode(data),
                baseHref: href,
              },
            },
            [channel.port2],
          );
        })().catch((error) => {
          if (!controller.signal.aborted) console.error('MCP worker failed', error);
        });
      }
      terminate() {
        const state = workers.get(this);
        if (state) {
          state.controller.abort();
          state.channel.port1.close();
          state.channel.port2.close();
          workers.delete(this);
        }
        super.terminate();
      }
    };
  }
  return {
    bytes,
    dispose() {
      lifetime.abort(new Error('MCP network runtime retired'));
      for (const worker of workers.keys()) worker.terminate();
      for (const blob of blobs) URL.revokeObjectURL(blob);
      blobs.clear();
      moduleCache.clear();
      global.fetch = fetchNative;
      global.Worker = WorkerNative;
      global.__fxMcpImport = importNative;
      global.__fxMcpLocation = locationNative;
      if (document) {
        if (baseDescriptor) Object.defineProperty(document, 'baseURI', baseDescriptor);
        else delete document.baseURI;
      }
    },
  };
}
