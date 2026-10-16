import { commands } from 'vitest/browser';
import { describe } from 'vitest';
import {
  EndpointError,
  type EndpointEvent,
  type NetEndpoint,
  type PeerId,
} from '@forgeax/engine-net';
import {
  runEndpointBehaviorSuite,
  type EndpointPairHarness,
} from '../../net/__tests__/endpoint-behavior.contract';
import { connectWebSocketClientEndpoint } from '../src/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    startWebSocketListener(): Promise<{ id: string; url: string }>;
    pollWebSocketListener(id: string): Promise<SerializedEvent[]>;
    sendWebSocketListener(id: string, peerId: number, data: number[]): Promise<CommandResult>;
    closeWebSocketListener(id: string): Promise<CommandResult>;
  }
}

type SerializedEvent =
  | { kind: 'peer-connected' | 'peer-disconnected'; peerId: number }
  | { kind: 'message'; peerId: number; data: number[] };

type CommandResult = { ok: true } | { ok: false; code: string };

describe('browser WebSocket endpoint', () => {
  runEndpointBehaviorSuite(createBrowserHarness);
});

async function createBrowserHarness(): Promise<EndpointPairHarness> {
  const listener = await commands.startWebSocketListener();
  const result = await connectWebSocketClientEndpoint(listener.url);
  if (!result.ok) {
    await commands.closeWebSocketListener(listener.id);
    throw result.error;
  }

  return {
    endpoints: [asHarnessEndpoint(result.value), listenerHarness(listener.id)],
    cleanup: async () => {
      result.value.close();
      await commands.closeWebSocketListener(listener.id);
    },
  };
}

function asHarnessEndpoint(endpoint: NetEndpoint) {
  return {
    poll: () => endpoint.poll(),
    send: (peerId: PeerId, data: Uint8Array) => endpoint.send(peerId, data),
    close: () => endpoint.close(),
  };
}

function listenerHarness(id: string) {
  return {
    poll: async (): Promise<EndpointEvent[]> =>
      (await commands.pollWebSocketListener(id)).map(deserializeEvent),
    send: async (peerId: PeerId, data: Uint8Array) =>
      commandResult(await commands.sendWebSocketListener(id, peerId, [...data]), peerId),
    close: async () => commandResult(await commands.closeWebSocketListener(id), 0 as PeerId),
  };
}

function deserializeEvent(event: SerializedEvent): EndpointEvent {
  return event.kind === 'message'
    ? { kind: event.kind, peerId: event.peerId as PeerId, data: new Uint8Array(event.data) }
    : { kind: event.kind, peerId: event.peerId as PeerId };
}

function commandResult(result: CommandResult, peerId: PeerId) {
  return result.ok
    ? { ok: true as const, value: undefined }
    : {
        ok: false as const,
        error: new EndpointError({
          code: result.code as 'peer-not-found' | 'connection-closed' | 'already-closed',
          expected: 'the remote WebSocket listener operation must succeed',
          hint: 'inspect the listener lifecycle',
          detail: result.code === 'already-closed'
            ? { cause: 'listener closed' }
            : { peerId },
        }),
      };
}
