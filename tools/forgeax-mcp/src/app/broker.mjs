import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { createHostWebSocketClient } from '@forgeax/engine-host/transport';
import { HTTP_BATCH_SIZE } from '../contract.ts';
import { bundlePackProgram } from './program-bundler.mjs';
export function createNetworkBroker(config, { bundle, trace = () => {} } = {}) {
  const originKey = (url) => {
    const protocol =
      url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol;
    const hostname = ['localhost', '127.0.0.1'].includes(url.hostname) ? 'localhost' : url.hostname;
    return `${protocol}//${hostname}:${url.port}`;
  };
  const origins = new Set([originKey(new URL(config.viewUrl))]);
  const lifetime = new AbortController();
  const hosts = new Map();
  const resources = new Map();
  const admit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'url' && typeof item === 'string') {
        try {
          const u = new URL(item);
          if (
            ['127.0.0.1', 'localhost'].includes(u.hostname) &&
            u.protocol === 'http:' &&
            u.searchParams.has('forgeaxWorkspaceTarget')
          )
            origins.add(originKey(u));
        } catch {}
      } else if (item && typeof item === 'object') admit(item);
    }
  };
  const allow = (input) => {
    const url = new URL(input);
    if (!origins.has(originKey(url)) || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
      throw new Error(`URL outside selected View/project services: ${url.origin}${url.pathname}`);
    return url;
  };
  const store = (bytes, mime, url) => {
    lifetime.signal.throwIfAborted();
    const raw = Buffer.from(bytes);
    const started = performance.now();
    // Pack artifacts may carry binary MIME even when their bytes are WGSL.
    // Choose wire compression by its measured size, independently of domain metadata.
    const compressed = raw.length > 32768 ? gzipSync(raw, { level: 1 }) : raw;
    const encoding = compressed.length < raw.length ? 'gzip' : undefined;
    const data = encoding ? compressed : raw;
    const id = createHash('sha256').update(data).digest('hex');
    resources.delete(id);
    resources.set(id, { data });
    while (
      [...resources.values()].reduce((sum, value) => sum + value.data.length, 0) >
      256 * 1024 * 1024
    )
      resources.delete(resources.keys().next().value);
    if (raw.length > 32768)
      trace({
        event: 'resource',
        mime,
        originalBytes: raw.length,
        wireBytes: data.length,
        compressMs: Math.round((performance.now() - started) * 100) / 100,
      });
    return {
      resourceId: id,
      bytes: data.length,
      decodedBytes: raw.length,
      ...(encoding ? { encoding } : {}),
      ...(data.length <= 49152 ? { base64: data.toString('base64') } : {}),
      mime,
      url,
    };
  };
  async function invoke(input, { signal } = {}) {
    lifetime.signal.throwIfAborted();
    const { action } = input;
    if (action === 'program') return store(await bundlePackProgram(input), 'text/javascript');
    if (action === 'http-batch') {
      if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > HTTP_BATCH_SIZE)
        throw new Error(`HTTP batch requires one to ${HTTP_BATCH_SIZE} reads`);
      if (input.requests.some(request => !['GET', 'HEAD'].includes(request.method)))
        throw new Error('HTTP batching accepts reads only');
      const replies = await Promise.all(input.requests.map(async request => {
        try { return { ok: true, value: await invoke({ ...request, action: 'http' }, { signal }) }; }
        catch (error) { return { ok: false, error: String(error) }; }
      }));
      return store(JSON.stringify(replies), 'application/json');
    }
    if (action === 'http' || action === 'bundle')
      trace({ event: 'request', action, path: new URL(input.url).pathname });
    if (action === 'http') {
      const url = allow(input.url);
      const response = await fetch(url, {
        method: input.method ?? 'GET',
        headers: input.headers ?? {},
        ...(input.body ? { body: Buffer.from(input.body, 'base64') } : {}),
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(30000)])
          : AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]),
      });
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > 64 * 1024 * 1024) throw new Error('Response exceeds View transport bound');
      const headers = Object.fromEntries(response.headers);
      delete headers['content-encoding'];
      delete headers['content-length'];
      if (headers['content-type']?.includes('application/json')) {
        try {
          admit(JSON.parse(data));
        } catch {}
      }
      return {
        status: response.status,
        headers,
        ...store(data, headers['content-type'] ?? 'application/octet-stream', url.href),
      };
    }
    if (action === 'chunk') {
      const resource = resources.get(input.resourceId);
      if (!resource) {
        trace({ event: 'resource-miss', resourceId: input.resourceId });
        throw new Error('Expired resource');
      }
      const offset = input.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > resource.data.length)
        throw new Error('Invalid offset');
      return { base64: resource.data.subarray(offset, offset + 192 * 1024).toString('base64') };
    }
    if (action === 'host-open') {
      const url = allow(input.url);
      if (hosts.size >= 12) throw new Error('Host connection bound exceeded');
      trace({ event: 'host-open', path: url.pathname });
      const socket = new WebSocket(url);
      const id = randomUUID();
      const state = {
        socket,
        client: undefined,
        queue: [],
        subscriptions: new Map(),
        requests: new Map(),
        closed: false,
      };
      hosts.set(id, state);
      const admitted = createHostWebSocketClient(socket);
      const abort = () => socket.close(1000, 'MCP admission cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const client = await admitted;
        state.client = client;
        if (state.closed || lifetime.signal.aborted) throw new Error('MCP service retired');
        client.onDisconnect((error) => {
          state.closed = true;
          state.error = error;
        });
        return { connectionId: id, caller: client.caller, generation: client.generation };
      } catch (error) {
        hosts.delete(id);
        socket.close();
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    }
    const state = hosts.get(input.connectionId);
    if (action === 'host-request') {
      if (!state || state.closed) throw new Error('Host connection retired');
      const requestId = input.requestId;
      if (typeof requestId !== 'string' || state.requests.has(requestId))
        throw new Error('Unique Host request ID required');
      if (state.requests.size >= 512) throw new Error('Host pending request bound exceeded');
      const controller = new AbortController();
      state.requests.set(requestId, controller);
      const started = performance.now();
      void (async () => {
        let packet;
        try {
          const value = await state.client.request(input.service, input.payload, {
            signal: controller.signal,
            ...(input.generation === undefined ? {} : { generation: input.generation }),
          });
          admit(value);
          packet = { ok: true, value, generation: state.client.generation };
        } catch (error) {
          packet = {
            ok: false,
            error: {
              code: error.code,
              expected: error.expected,
              hint: error.hint,
              detail: error.detail,
              message: error.message,
            },
          };
        } finally {
          state.requests.delete(requestId);
        }
        if (state.closed) return;
        trace({
          event: 'host-result',
          service: input.service,
          operation: input.payload?.operation,
          ms: Math.round(performance.now() - started),
          ok: packet.ok,
        });
        state.queue.push({
          requestId,
          response: store(JSON.stringify(packet), 'application/json'),
        });
      })();
      return {};
    }
    if (action === 'host-cancel') {
      state?.requests.get(input.requestId)?.abort();
      return {};
    }
    if (action === 'host-subscribe') {
      if (!state || state.closed) throw new Error('Host connection retired');
      if (!state.subscriptions.has(input.topic))
        state.subscriptions.set(
          input.topic,
          state.client.subscribe(input.topic, (value) => {
            if (state.queue.length >= 1000) {
              state.client.close('MCP event bound exceeded');
              return;
            }
            admit(value);
            state.queue.push({ topic: input.topic, value });
          }),
        );
      return {};
    }
    if (action === 'host-unsubscribe') {
      state?.subscriptions.get(input.topic)?.();
      state?.subscriptions.delete(input.topic);
      return {};
    }
    if (action === 'host-read') {
      const read = (connectionId) => {
        const state = hosts.get(connectionId);
        if (!state)
          return store(
            JSON.stringify({
              events: [],
              closed: true,
              error: { message: 'Host connection retired' },
            }),
            'application/json',
          );
        const json = JSON.stringify({
          events: state.queue.splice(0, 100),
          closed: state.closed,
          error: state.error,
        });
        const bytes = Buffer.from(json);
        return bytes.length <= 32768
          ? {
              mime: 'application/json',
              bytes: bytes.length,
              decodedBytes: bytes.length,
              base64: bytes.toString('base64'),
            }
          : store(bytes, 'application/json');
      };
      if (input.connectionIds)
        return {
          connections: input.connectionIds.map((connectionId) => ({
            connectionId,
            response: read(connectionId),
          })),
        };
      return read(input.connectionId);
    }
    if (action === 'host-close') {
      if (state) {
        state.closed = true;
        for (const request of state.requests.values()) request.abort();
      }
      state?.client.close('MCP document retired');
      hosts.delete(input.connectionId);
      return {};
    }
    if (action === 'bundle') {
      const url = allow(input.url);
      const bundler = broker.bundle ?? bundle;
      if (!bundler) throw new Error('Bundler missing');
      const result = await bundler(url.href, input.kind ?? 'module');
      return store(result.source, 'text/javascript', url.href);
    }
    throw new Error('Unknown transport action');
  }
  const broker = {
    invoke,
    store,
    admit,
    allow,
    bundle,
    close() {
      lifetime.abort(new Error('MCP service retired'));
      for (const state of hosts.values()) {
        state.closed = true;
        for (const request of state.requests.values()) request.abort();
        if (state.client) state.client.close('MCP service retired');
        else state.socket.close(1000, 'MCP service retired');
      }
      hosts.clear();
      resources.clear();
    },
  };
  return broker;
}
