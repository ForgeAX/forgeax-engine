import type {
  NetEndpoint,
  NetEndpointConnector,
  NetSession,
  NetSessionState,
  SessionId,
} from '@forgeax/engine-net';
import { netPlugin } from '@forgeax/engine-net';
import { createWebSocketConnector } from '@forgeax/engine-net-websocket/node';
import { expectTypeOf } from 'vitest';

const connector = createWebSocketConnector('ws://127.0.0.1:8787');
const endpoint: NetEndpoint = {} as NetEndpoint;
const session = {} as NetSession;

expectTypeOf(connector).toMatchTypeOf<NetEndpointConnector>();
expectTypeOf<NetEndpointConnector['connect']>().parameter(0).toEqualTypeOf<AbortSignal>();
expectTypeOf(connector.connect(new AbortController().signal)).resolves.toMatchTypeOf<unknown>();
expectTypeOf(session.getRecoverySnapshot().sessionId).toEqualTypeOf<SessionId>();
expectTypeOf(session.getRecoverySnapshot().state).toMatchTypeOf<NetSessionState>();
expectTypeOf(
  netPlugin({ endpoint, connector, sessionId: 1, maxRawMessages: 32 }),
).toMatchTypeOf<unknown>();
