import WebSocket, { WebSocketServer } from 'ws';
import { DEFAULT_REPLICATION_LIMITS, decodeReplicationPacket } from '@forgeax/engine-net';

export const M17_CHAOS_CONTROLS = Object.freeze([
  'disconnect',
  'duplicate',
  'out-of-order',
  'delayed-delivery',
  'late-join',
]);

const OPEN = 1;
const DEFAULT_DELAY_MS = 40;
const MAX_QUEUED_FRAMES = 128;
const MAX_EVENTS = 512;
const SABOTAGE_CONTROLS = Object.freeze({
  'm17-duplicate-exactly-once': 'duplicate',
  'm17-delayed-delivery': 'delayed-delivery',
  'm17-late-join-baseline': 'late-join',
});

function toBytes(data) {
  if (data instanceof Uint8Array)
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function decodedPacket(bytes) {
  const decoded = decodeReplicationPacket(bytes, DEFAULT_REPLICATION_LIMITS);
  return decoded.ok ? decoded.value : undefined;
}

function isDataPacket(packet) {
  return packet?.kind === 'baseline' || packet?.kind === 'delta';
}

function packetShape(packet) {
  if (!isDataPacket(packet)) return undefined;
  return {
    kind: packet.kind,
    sessionId: packet.sessionId,
    epoch: packet.epoch,
    sequence: packet.sequence,
    tick: packet.tick,
  };
}

function controlSet(mode) {
  return new Set(
    mode === 'all'
      ? M17_CHAOS_CONTROLS
      : mode
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => M17_CHAOS_CONTROLS.includes(entry)),
  );
}

function emptyControl() {
  return { attempted: 0, applied: 0, delivered: 0 };
}

function normalizeDelay(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DELAY_MS;
}

/**
 * A deliberately small real-socket proxy used only by the multiplayer-snake
 * acceptance gauntlet. It has no NetEndpoint or retry semantics: it forwards
 * bytes between two ws connections and records bounded, deterministic chaos.
 */
export function startChaosWebSocketProxy({
  targetUrl,
  targetHostUrl,
  mode = 'all',
  sabotage = '',
  delayMs = DEFAULT_DELAY_MS,
} = {}) {
  if (typeof targetUrl !== 'string' || targetUrl.length === 0)
    return Promise.reject(new Error('M17 chaos proxy requires a target WebSocket URL'));
  const enabled = controlSet(mode);
  const effectiveDelayMs = normalizeDelay(delayMs);
  const controls = {
    disconnect: emptyControl(),
    duplicate: { ...emptyControl(), copies: 0 },
    'out-of-order': { ...emptyControl(), captured: 0, staleReplayed: 0, sabotageReordered: 0 },
    'delayed-delivery': { ...emptyControl(), delayedFrames: 0, maxDelayMs: 0 },
    'late-join': { ...emptyControl(), marked: 0, observed: 0 },
  };
  const events = [];
  const connections = [];
  const sessionConnectionCounts = new Map();
  const disconnectedSessionIds = new Set();
  const staleFrames = new Map();
  const hostConnections = [];
  const timers = new Set();
  let nextConnectionId = 1;
  let replacementPending = false;
  let lateJoinPending = false;
  let closed = false;
  let server;
  let hostServer;
  let closePromise;

  const record = (event) => {
    events.push({ at: Date.now(), ...event });
    if (events.length > MAX_EVENTS) events.shift();
  };

  const sabotagedControl = SABOTAGE_CONTROLS[sabotage];
  const has = (control) => enabled.has(control) && sabotagedControl !== control;

  const schedule = (delay, callback) => {
    let timer;
    timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, Math.max(0, delay));
    timers.add(timer);
    return timer;
  };

  const clearConnectionTimer = (connection) => {
    if (connection.timer !== undefined) {
      clearTimeout(connection.timer);
      timers.delete(connection.timer);
      connection.timer = undefined;
    }
  };

  const closeConnection = (connection, reason) => {
    if (connection.closed) return;
    connection.closed = true;
    clearConnectionTimer(connection);
    connection.outbound.length = 0;
    connection.clientQueue.length = 0;
    record({ kind: 'connection-closed', connectionId: connection.id, reason });
    if (connection.downstream.readyState === OPEN) connection.downstream.close();
    if (connection.upstream?.readyState === OPEN) connection.upstream.close();
    else connection.upstream?.terminate();
  };

  const sendImmediately = (connection, bytes, packet, eventKind = 'forward') => {
    if (connection.closed || connection.downstream.readyState !== OPEN) return false;
    try {
      connection.downstream.send(bytes, { binary: true });
      if (isDataPacket(packet)) {
        connection.dataFramesDelivered += 1;
        record({
          kind: eventKind,
          connectionId: connection.id,
          packet: packetShape(packet),
        });
      }
      return true;
    } catch (cause) {
      record({ kind: 'send-error', connectionId: connection.id, error: String(cause) });
      closeConnection(connection, 'downstream-send-error');
      return false;
    }
  };

  const pumpOutbound = (connection) => {
    if (connection.closed || connection.pumping) return;
    connection.pumping = true;
    const pump = () => {
      if (connection.closed) {
        connection.pumping = false;
        return;
      }
      const item = connection.outbound[0];
      if (item === undefined) {
        connection.pumping = false;
        return;
      }
      const waitMs = Math.max(0, item.releaseAt - Date.now());
      if (waitMs > 0) {
        connection.timer = schedule(waitMs, () => {
          connection.timer = undefined;
          pump();
        });
        return;
      }
      connection.outbound.shift();
      const sent = sendImmediately(connection, item.bytes, item.packet, item.eventKind);
      if (!sent) {
        connection.pumping = false;
        return;
      }
      pump();
    };
    pump();
  };

  const enqueueOutbound = (connection, bytes, packet, {
    bypassControls = false,
    eventKind = 'forward',
  } = {}) => {
    if (connection.closed) return;
    if (connection.outbound.length >= MAX_QUEUED_FRAMES) {
      record({ kind: 'queue-overflow', connectionId: connection.id });
      closeConnection(connection, 'bounded-chaos-queue-overflow');
      return;
    }
    let releaseAt = Math.max(Date.now(), connection.nextReleaseAt);
    let delayed = false;
    if (!bypassControls && has('delayed-delivery') && isDataPacket(packet) &&
      packet.kind === 'delta' && !connection.delayed) {
      connection.delayed = true;
      delayed = true;
      releaseAt = Math.max(Date.now(), connection.nextReleaseAt) + effectiveDelayMs;
      controls['delayed-delivery'].attempted += 1;
      controls['delayed-delivery'].applied += 1;
      controls['delayed-delivery'].delayedFrames += 1;
      controls['delayed-delivery'].maxDelayMs = Math.max(
        controls['delayed-delivery'].maxDelayMs,
        effectiveDelayMs,
      );
      record({
        kind: 'delayed-delivery',
        connectionId: connection.id,
        delayMs: effectiveDelayMs,
        packet: packetShape(packet),
      });
    }
    connection.nextReleaseAt = releaseAt;
    connection.outbound.push({ bytes, packet, releaseAt, eventKind: delayed ? 'delayed-forward' : eventKind });
    if (!bypassControls && has('duplicate') && isDataPacket(packet) &&
      packet.kind === 'baseline' && !connection.duplicated) {
      connection.duplicated = true;
      controls.duplicate.attempted += 1;
      controls.duplicate.applied += 1;
      controls.duplicate.copies += 1;
      connection.outbound.push({
        bytes: new Uint8Array(bytes),
        packet,
        releaseAt,
        eventKind: 'duplicate-forward',
      });
      record({ kind: 'duplicate-delivery', connectionId: connection.id, packet: packetShape(packet) });
    }
    pumpOutbound(connection);
  };

  const noteSession = (connection, packet) => {
    if (packet?.kind !== 'session-open' && packet?.kind !== 'session-resume') return;
    connection.sessionId = packet.sessionId;
    const count = (sessionConnectionCounts.get(packet.sessionId) ?? 0) + 1;
    sessionConnectionCounts.set(packet.sessionId, count);
    connection.connectionOrdinal = count;
    connection.replacement = connection.replacement || packet.kind === 'session-resume' || count > 1 ||
      disconnectedSessionIds.has(packet.sessionId);
    record({
      kind: 'session-bound',
      connectionId: connection.id,
      sessionId: packet.sessionId,
      connectionOrdinal: count,
      replacement: connection.replacement,
    });
  };

  const staleFor = (sessionId) => {
    const keyed = staleFrames.get(sessionId) ?? staleFrames.get('*');
    if (keyed !== undefined) return keyed;
    return [...staleFrames.values()].sort((left, right) => left.packet.epoch - right.packet.epoch)[0];
  };

  const forwardUpstreamFrame = (connection, bytes) => {
    const packet = decodedPacket(bytes);
    if (isDataPacket(packet)) {
      if (has('out-of-order') && connection.connectionOrdinal === 1 && packet.kind === 'baseline') {
        const key = connection.sessionId ?? '*';
        if (!staleFrames.has(key)) {
          staleFrames.set(key, { bytes: new Uint8Array(bytes), packet });
          controls['out-of-order'].captured += 1;
          record({ kind: 'out-of-order-captured', connectionId: connection.id, packet: packetShape(packet) });
        }
      }
      if (sabotage === 'm17-out-of-order-baseline' && connection.replacement) {
        if (packet.kind === 'baseline' && connection.sabotageBaseline === undefined) {
          connection.sabotageBaseline = { bytes: new Uint8Array(bytes), packet };
          controls['out-of-order'].attempted += 1;
          controls['out-of-order'].applied += 1;
          record({ kind: 'sabotage-held-baseline', connectionId: connection.id, packet: packetShape(packet) });
          return;
        }
        if (packet.kind === 'delta' && connection.sabotageBaseline !== undefined &&
          !connection.sabotageReleased) {
          connection.sabotageReleased = true;
          controls['out-of-order'].sabotageReordered += 1;
          record({ kind: 'sabotage-out-of-order', connectionId: connection.id, packet: packetShape(packet) });
          sendImmediately(connection, bytes, packet, 'sabotage-delta-before-baseline');
          sendImmediately(
            connection,
            connection.sabotageBaseline.bytes,
            connection.sabotageBaseline.packet,
            'sabotage-baseline-after-delta',
          );
          return;
        }
      }
      if (has('out-of-order') && connection.replacement && packet.kind === 'baseline' &&
        !connection.staleReplayed) {
        const stale = staleFor(connection.sessionId);
        if (stale !== undefined && stale.packet.epoch < packet.epoch) {
          connection.staleReplayed = true;
          controls['out-of-order'].attempted += 1;
          controls['out-of-order'].applied += 1;
          controls['out-of-order'].staleReplayed += 1;
          record({
            kind: 'out-of-order-stale-replay',
            connectionId: connection.id,
            current: packetShape(packet),
            stale: packetShape(stale.packet),
          });
          enqueueOutbound(connection, bytes, packet);
          enqueueOutbound(connection, stale.bytes, stale.packet, {
            bypassControls: true,
            eventKind: 'stale-epoch-forward',
          });
          return;
        }
      }
    }
    enqueueOutbound(connection, bytes, packet);
  };

  const flushClientQueue = (connection) => {
    if (connection.closed || connection.upstream?.readyState !== OPEN) return;
    for (const bytes of connection.clientQueue.splice(0)) connection.upstream.send(bytes, { binary: true });
  };

  const forwardClientFrame = (connection, bytes) => {
    noteSession(connection, decodedPacket(bytes));
    if (connection.closed) return;
    if (connection.upstream?.readyState === OPEN) {
      try {
        connection.upstream.send(bytes, { binary: true });
      } catch (cause) {
        record({ kind: 'upstream-send-error', connectionId: connection.id, error: String(cause) });
        closeConnection(connection, 'upstream-send-error');
      }
      return;
    }
    if (connection.clientQueue.length >= MAX_QUEUED_FRAMES) {
      record({ kind: 'queue-overflow', connectionId: connection.id, direction: 'client-to-upstream' });
      closeConnection(connection, 'bounded-client-queue-overflow');
      return;
    }
    connection.clientQueue.push(new Uint8Array(bytes));
  };

  const attachUpstream = (connection) => {
    const upstream = new WebSocket(targetUrl);
    upstream.binaryType = 'arraybuffer';
    connection.upstream = upstream;
    upstream.on('open', () => {
      connection.upstreamOpened = true;
      record({ kind: 'upstream-open', connectionId: connection.id });
      flushClientQueue(connection);
    });
    upstream.on('message', (data, isBinary) => {
      if (connection.closed) return;
      if (!isBinary) {
        closeConnection(connection, 'upstream-text-frame');
        return;
      }
      const bytes = toBytes(data);
      if (bytes === undefined) {
        closeConnection(connection, 'upstream-invalid-frame');
        return;
      }
      forwardUpstreamFrame(connection, bytes);
    });
    upstream.on('error', (cause) => {
      record({ kind: 'upstream-error', connectionId: connection.id, error: String(cause) });
      closeConnection(connection, 'upstream-error');
    });
    upstream.on('close', () => closeConnection(connection, 'upstream-close'));
  };

  const startServer = () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    server.on('connection', (downstream) => {
      const replacement = replacementPending;
      replacementPending = false;
      const connection = {
        id: nextConnectionId++,
        downstream,
        upstream: undefined,
        sessionId: undefined,
        connectionOrdinal: 0,
        replacement,
        closed: false,
        pumping: false,
        timer: undefined,
        nextReleaseAt: 0,
        outbound: [],
        clientQueue: [],
        dataFramesDelivered: 0,
        delayed: false,
        duplicated: false,
        staleReplayed: false,
        sabotageBaseline: undefined,
        sabotageReleased: false,
        upstreamOpened: false,
      };
      connections.push(connection);
      if (lateJoinPending) {
        lateJoinPending = false;
        controls['late-join'].observed += 1;
        controls['late-join'].attempted += 1;
        controls['late-join'].applied += 1;
        record({ kind: 'late-join-observed', connectionId: connection.id });
      }
      downstream.binaryType = 'arraybuffer';
      downstream.on('message', (data, isBinary) => {
        if (!isBinary) {
          closeConnection(connection, 'downstream-text-frame');
          return;
        }
        const bytes = toBytes(data);
        if (bytes === undefined) {
          closeConnection(connection, 'downstream-invalid-frame');
          return;
        }
        forwardClientFrame(connection, bytes);
      });
      downstream.on('error', (cause) => {
        record({ kind: 'downstream-error', connectionId: connection.id, error: String(cause) });
        closeConnection(connection, 'downstream-error');
      });
      downstream.on('close', () => closeConnection(connection, 'downstream-close'));
      attachUpstream(connection);
      record({ kind: 'connection-opened', connectionId: connection.id });
    });
  };

  const startHostServer = () => {
    if (targetHostUrl === undefined) return Promise.resolve();
    hostServer = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    hostServer.on('connection', (downstream) => {
      const connection = {
        downstream,
        upstream: undefined,
        closed: false,
        queue: [],
      };
      hostConnections.push(connection);
      const closeHostConnection = (reason) => {
        if (connection.closed) return;
        connection.closed = true;
        connection.queue.length = 0;
        if (connection.downstream.readyState === OPEN) connection.downstream.close();
        else connection.downstream.terminate();
        if (connection.upstream?.readyState === OPEN) connection.upstream.close();
        else connection.upstream?.terminate();
        record({ kind: 'host-connection-closed', reason });
      };
      const flushHostQueue = () => {
        if (connection.closed || connection.upstream?.readyState !== OPEN) return;
        for (const frame of connection.queue.splice(0))
          connection.upstream.send(frame.data, { binary: frame.isBinary });
      };
      const upstream = new WebSocket(targetHostUrl);
      connection.upstream = upstream;
      upstream.on('open', flushHostQueue);
      upstream.on('message', (data, isBinary) => {
        if (connection.closed || connection.downstream.readyState !== OPEN) return;
        try {
          connection.downstream.send(data, { binary: isBinary });
        } catch {
          closeHostConnection('host-downstream-send-error');
        }
      });
      upstream.on('error', () => closeHostConnection('host-upstream-error'));
      upstream.on('close', () => closeHostConnection('host-upstream-close'));
      downstream.on('message', (data, isBinary) => {
        if (connection.closed) return;
        if (connection.upstream?.readyState === OPEN) {
          try {
            connection.upstream.send(data, { binary: isBinary });
          } catch {
            closeHostConnection('host-upstream-send-error');
          }
          return;
        }
        if (connection.queue.length >= MAX_QUEUED_FRAMES) {
          closeHostConnection('host-queue-overflow');
          return;
        }
        connection.queue.push({ data, isBinary });
      });
      downstream.on('error', () => closeHostConnection('host-downstream-error'));
      downstream.on('close', () => closeHostConnection('host-downstream-close'));
    });
    return new Promise((resolve, reject) => {
      const onError = (cause) => reject(cause);
      hostServer.once('error', onError);
      hostServer.once('listening', () => {
        hostServer.off('error', onError);
        resolve();
      });
    });
  };

  const promise = new Promise((resolve, reject) => {
    try {
      startServer();
    } catch (cause) {
      reject(cause);
      return;
    }
    const hostReady = startHostServer();
    const onError = (cause) => reject(cause);
    server.once('error', onError);
    server.once('listening', async () => {
      server.off('error', onError);
      try {
        await hostReady;
      } catch (cause) {
        reject(cause);
        return;
      }
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('M17 chaos proxy did not expose a TCP address'));
        return;
      }
      const hostAddress = hostServer?.address();
      if (hostServer !== undefined && (hostAddress === null || typeof hostAddress === 'string')) {
        reject(new Error('M17 chaos host proxy did not expose a TCP address'));
        return;
      }
      resolve({
        url: `ws://127.0.0.1:${address.port}`,
        ...(hostAddress === null || hostAddress === undefined || typeof hostAddress === 'string'
          ? {}
          : { hostUrl: `ws://127.0.0.1:${hostAddress.port}` }),
        disconnectSession(sessionId) {
          controls.disconnect.attempted += 1;
          if (sabotage === 'm17-disconnect-recovery') {
            record({ kind: 'sabotage-skipped-disconnect', sessionId });
            return false;
          }
          const connection = [...connections].reverse().find((candidate) =>
            !candidate.closed && candidate.sessionId === sessionId,
          );
          if (connection === undefined) {
            record({ kind: 'disconnect-missing-session', sessionId });
            return false;
          }
          controls.disconnect.applied += 1;
          controls.disconnect.delivered += 1;
          disconnectedSessionIds.add(sessionId);
          replacementPending = true;
          record({ kind: 'disconnect', connectionId: connection.id, sessionId, mode: 'terminate' });
          connection.downstream.terminate();
          connection.upstream?.terminate();
          return true;
        },
        markLateJoin() {
          if (sabotage === 'm17-late-join-baseline') {
            record({ kind: 'sabotage-skipped-late-join' });
            return;
          }
          controls['late-join'].marked += 1;
          lateJoinPending = true;
          record({ kind: 'late-join-marked' });
        },
        snapshot() {
          const active = connections.filter((connection) => !connection.closed);
          return {
            schemaVersion: 1,
            targetUrl,
            mode,
            sabotage,
            delayMs: effectiveDelayMs,
            controls: structuredClone(controls),
            events: [...events],
            resources: {
              connections: active.length,
              upstreamSockets: active.filter((connection) => connection.upstream?.readyState === OPEN).length,
              hostConnections: hostConnections.filter((connection) => !connection.closed).length,
              hostUpstreamSockets: hostConnections.filter(
                (connection) => connection.upstream?.readyState === OPEN,
              ).length,
              timers: timers.size,
              queuedFrames: active.reduce((total, connection) => total + connection.outbound.length, 0),
              lateJoinPending,
              serverListening: !closed,
              hostServerListening: hostServer !== undefined && !closed,
            },
          };
        },
        async close() {
          if (closePromise !== undefined) return closePromise;
          closePromise = (async () => {
            closed = true;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const connection of connections) closeConnection(connection, 'proxy-close');
            for (const connection of hostConnections)
              if (!connection.closed) {
                connection.closed = true;
                connection.queue.length = 0;
                connection.downstream.terminate();
                connection.upstream?.terminate();
              }
            await Promise.all([
              new Promise((done) => {
                try {
                  server.close(() => done());
                } catch {
                  done();
                }
              }),
              new Promise((done) => {
                if (hostServer === undefined) {
                  done();
                  return;
                }
                try {
                  hostServer.close(() => done());
                } catch {
                  done();
                }
              }),
            ]);
            record({ kind: 'proxy-closed' });
          })();
          return closePromise;
        },
      });
    });
  });
  return promise;
}
