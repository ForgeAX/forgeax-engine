import type { PeerId } from '@forgeax/engine/net';
import {
  createMemoryEndpointConnector,
  createMemoryEndpointPair,
  isEndpointError,
} from '@forgeax/engine/net';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Host-neutral NetEndpoint',
  catalog: 'Host-neutral NetEndpoint',
  kind: 'headless',
  summary:
    'NetEndpoint is poll/send/close over complete Uint8Array messages with PeerId and connect/disconnect events. It knows nothing about World, profiles or codecs; the memory pair is the reference implementation.',
  expect:
    'All checks pass: both sides see peer-connected, bytes arrive intact and in order, close() is observed as peer-disconnected by the remote, and failures are structured EndpointError values.',
  async run(checks) {
    const [left, right] = createMemoryEndpointPair();
    const leftEvents = left.poll();
    const rightEvents = right.poll();
    checks.ok(
      'left sees peer-connected',
      leftEvents.some((event) => event.kind === 'peer-connected'),
      JSON.stringify(leftEvents),
    );
    checks.ok(
      'right sees peer-connected',
      rightEvents.some((event) => event.kind === 'peer-connected'),
      JSON.stringify(rightEvents),
    );
    const toRight =
      leftEvents.find((event) => event.kind === 'peer-connected')?.peerId ?? (0 as PeerId);
    checks.ok('send 1 ok', left.send(toRight, Uint8Array.of(1, 2, 3)).ok);
    checks.ok('send 2 ok', left.send(toRight, Uint8Array.of(9)).ok);
    const messages = right
      .poll()
      .flatMap((event) => (event.kind === 'message' ? [Array.from(event.data)] : []));
    checks.equal('bytes arrive complete and ordered', messages, [[1, 2, 3], [9]]);
    checks.equal('idle poll returns empty', right.poll().length, 0);
    const unknown = left.send(999 as PeerId, Uint8Array.of(0));
    checks.ok(
      'send to an unknown peer is peer-not-found',
      !unknown.ok && isEndpointError(unknown.error) && unknown.error.code === 'peer-not-found',
      unknown.ok ? 'ok' : unknown.error.code,
    );
    checks.ok('close ok', right.close().ok);
    checks.ok(
      'remote observes peer-disconnected',
      left.poll().some((event) => event.kind === 'peer-disconnected' && event.peerId === toRight),
    );
    const late = right.send(toRight, Uint8Array.of(1));
    checks.ok(
      'send after close reports already-closed',
      !late.ok && late.error.code === 'already-closed',
      late.ok ? 'ok' : late.error.code,
    );
    const again = right.close();
    checks.ok(
      'second close reports already-closed',
      !again.ok && again.error.code === 'already-closed',
      again.ok ? 'ok' : again.error.code,
    );
    const connector = createMemoryEndpointConnector(() => createMemoryEndpointPair()[0]);
    const aborted = new AbortController();
    aborted.abort();
    const refused = await connector.connect(aborted.signal);
    checks.ok(
      'aborted connect fails with connection-failed',
      !refused.ok && refused.error.code === 'connection-failed',
      refused.ok ? 'ok' : refused.error.code,
    );
    const connected = await connector.connect(new AbortController().signal);
    checks.ok('connector yields a fresh endpoint', connected.ok);
  },
});
