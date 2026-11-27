import {
  createFileStore,
  createRecordStore,
  type RecordStore,
  StorageError,
  type StorageErrorCode,
} from '@forgeax/engine-platform';

type Bytes = Uint8Array<ArrayBuffer>;
type Space = 'saves' | 'cache' | 'files';
type Operation =
  | 'read'
  | 'replace'
  | 'import'
  | 'remove'
  | 'open'
  | 'close'
  | 'begin'
  | 'append'
  | 'commit'
  | 'abort';

interface Request {
  readonly space: Space;
  readonly operation: Operation;
  readonly key: string;
  readonly nonce?: string;
  readonly size?: number;
  readonly offset?: number;
  readonly length?: number;
  readonly bytes?: Bytes;
}

type Invoke = (
  command: string,
  body: ArrayBuffer,
  options: { headers: Record<string, string> },
) => Promise<ArrayBuffer | number[]>;

const knownErrors = new Set<string>([
  'invalid-input',
  'missing',
  'unavailable',
  'quota',
  'cancelled',
  'closed',
  'io',
  'commit-unknown',
]);

function hostInvoke(): Invoke | undefined {
  return (globalThis as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;
}

function changesStorage(request: Request): boolean {
  return request.operation !== 'read' && request.operation !== 'open';
}

function bridgeFailure(request: Request, cause?: unknown): StorageError {
  return new StorageError(changesStorage(request) ? 'commit-unknown' : 'unavailable', cause);
}

async function invokeStorage(invoke: Invoke, request: Request): Promise<Bytes> {
  try {
    const bytes = request.bytes;
    const body =
      bytes === undefined
        ? new ArrayBuffer(0)
        : bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const output = await invoke('storage_io', body, {
      headers: {
        'x-forgeax-space': request.space,
        'x-forgeax-operation': request.operation,
        'x-forgeax-key': request.key,
        'x-forgeax-nonce': request.nonce ?? '',
        'x-forgeax-size': String(request.size ?? 0),
        'x-forgeax-offset': String(request.offset ?? 0),
        'x-forgeax-length': String(request.length ?? 0),
      },
    });
    return output instanceof ArrayBuffer ? new Uint8Array(output) : Uint8Array.from(output);
  } catch (cause) {
    if (typeof cause === 'string' && knownErrors.has(cause))
      throw new StorageError(cause as StorageErrorCode, cause);
    throw bridgeFailure(request, cause);
  }
}

type Reply = { kind: 'result'; id: string; bytes?: Bytes; code?: StorageErrorCode };

function ownTauriLease(leases: Map<string, Request>, request: Request): void {
  if (request.space !== 'files') return;
  const { operation, key, nonce, space } = request;
  if (operation === 'open' && nonce !== undefined) {
    leases.set(nonce, { space, operation: 'close', key, nonce });
  } else if (operation === 'begin') {
    leases.set(key, { space, operation: 'abort', key });
  }
}

function releaseTauriLease(leases: Map<string, Request>, request: Request): void {
  if (request.space !== 'files') return;
  if (request.operation === 'close' && request.nonce !== undefined) leases.delete(request.nonce);
  if (request.operation === 'abort' || request.operation === 'commit') leases.delete(request.key);
}

export function serveTauriStorage(name: string): () => Promise<void> {
  const invoke = hostInvoke();
  if (invoke === undefined) return async () => {};
  const channel = new BroadcastChannel(name);
  const inflight = new Set<Promise<void>>();
  const leases = new Map<string, Request>();
  let closed = false;
  channel.onmessage = ({ data }) => {
    if (closed || data?.kind !== 'request' || typeof data.id !== 'string' || !data.request) return;
    const id: string = data.id;
    const request: Request = data.request;
    const reply = (value: Reply) => {
      if (!closed) channel.postMessage(value);
    };
    const pending = invokeStorage(invoke, request).then(
      (bytes) => {
        ownTauriLease(leases, request);
        releaseTauriLease(leases, request);
        reply({ kind: 'result', id, bytes });
      },
      (error: StorageError) => reply({ kind: 'result', id, code: error.code }),
    );
    inflight.add(pending);
    const retire = () => inflight.delete(pending);
    void pending.then(retire, retire);
  };
  return async () => {
    closed = true;
    channel.close();
    await Promise.allSettled(inflight);
    await Promise.allSettled([...leases.values()].map((request) => invokeStorage(invoke, request)));
    leases.clear();
  };
}

function requestFromHost(name: string, request: Request): Promise<Bytes> {
  const channel = new BroadcastChannel(name);
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout);
      channel.close();
    };
    const timeout = setTimeout(() => {
      finish();
      reject(bridgeFailure(request));
    }, 30_000);
    channel.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (data?.kind !== 'result' || data.id !== id) return;
      finish();
      if (data.bytes !== undefined) resolve(data.bytes);
      else reject(new StorageError(data.code ?? 'io'));
    };
    try {
      channel.postMessage({ kind: 'request', id, request });
    } catch (cause) {
      finish();
      reject(new StorageError('unavailable', cause));
    }
  });
}

function tauriRequest(name: string | undefined) {
  return (request: Request, signal?: AbortSignal): Promise<Bytes> => {
    signal?.throwIfAborted();
    const invoke = hostInvoke();
    if (invoke !== undefined) return invokeStorage(invoke, request);
    if (name !== undefined) return requestFromHost(name, request);
    return Promise.reject(new StorageError('unavailable'));
  };
}

export function createTauriRecordStore(
  space: 'cache' | 'saves',
  channel?: string,
  legacy?: RecordStore,
): RecordStore {
  const execute = tauriRequest(channel);
  const name = (key: string) =>
    space === 'cache' && key.startsWith('sha256:') ? key.slice(7) : key;
  return createRecordStore({
    async read(key, signal) {
      const record = { space, key: name(key) };
      try {
        return await execute({ ...record, operation: 'read' }, signal);
      } catch (cause) {
        if (!(cause instanceof StorageError) || cause.code !== 'missing') throw cause;
      }
      const bytes = legacy === undefined ? undefined : (await legacy.read(key, signal)).unwrap();
      if (bytes === undefined) return undefined;
      return execute({ ...record, operation: 'import', bytes, nonce: crypto.randomUUID() }, signal);
    },
    async replace(key, bytes, signal) {
      await execute(
        { space, operation: 'replace', key: name(key), nonce: crypto.randomUUID(), bytes },
        signal,
      );
    },
    async remove(key, signal) {
      // Clear the historical slot first so a later read cannot import a deliberate deletion.
      if (legacy !== undefined) (await legacy.remove(key, signal)).unwrap();
      await execute({ space, operation: 'remove', key: name(key) }, signal);
    },
  });
}

export function createTauriRuntimePackCache(channel?: string) {
  const records = createTauriRecordStore('cache', channel);
  return {
    async read(key: string, signal: AbortSignal) {
      return (await records.read(key, signal)).unwrap();
    },
    async write(key: string, bytes: Bytes, signal: AbortSignal) {
      (await records.replace(key, bytes, signal)).unwrap();
    },
  };
}

const chunkLimit = 8 * 1024 * 1024;

export function createTauriFileStore(channel?: string) {
  const execute = tauriRequest(channel);
  return createFileStore({
    async open(ref, signal) {
      const request = {
        space: 'files' as const,
        key: ref.id,
        size: ref.byteLength,
        nonce: crypto.randomUUID(),
      };
      await execute({ ...request, operation: 'open' }, signal);
      return {
        async read(offset, target, current) {
          for (let copied = 0; copied < target.byteLength; ) {
            const length = Math.min(chunkLimit, target.byteLength - copied);
            const part = await execute(
              { ...request, operation: 'read', offset: offset + copied, length },
              current,
            );
            if (part.byteLength !== length) throw new StorageError('io');
            current.throwIfAborted();
            target.set(part, copied);
            copied += length;
          }
          return target.byteLength;
        },
        async close() {
          await execute({ ...request, operation: 'close' });
        },
      };
    },
    async create(byteLength, signal) {
      const id = crypto.randomUUID();
      const request = { space: 'files' as const, key: id, size: byteLength };
      await execute({ ...request, operation: 'begin' }, signal);
      return {
        id,
        async append(offset, bytes, current) {
          for (let position = 0; position < bytes.byteLength; position += chunkLimit) {
            await execute(
              {
                ...request,
                operation: 'append',
                offset: offset + position,
                bytes: bytes.subarray(position, position + chunkLimit),
              },
              current,
            );
          }
        },
        async seal(current) {
          await execute({ ...request, operation: 'commit' }, current);
        },
        async discard() {
          await execute({ ...request, operation: 'abort' });
        },
      };
    },
    async remove(ref, signal) {
      await execute(
        { space: 'files', key: ref.id, size: ref.byteLength, operation: 'remove' },
        signal,
      );
    },
  });
}
