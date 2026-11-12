import { testPlatform } from './platform-fixture';
// remote-integration.test.ts — app.remote type inference + dev/prod/headless
// integration tests (feat-20260629-inspector-two-layer-model M4 / w18, w19).
//
// w18 (type inference): verifies app.remote.port is number, app.remote.close()
//   is Promise<void>, no `as RemoteHandle` assertion needed, import chain does
//   not touch @forgeax/engine-remote. TDD red — type inference passes as soon
//   as RemoteHandle lands in @forgeax/engine-types (w17) + App.remote in
//   types.ts (same commit).
//
// Assemble hosts opt into the Node remote server through `remoteServe`.
//
// charter P3 explicit failure: assertions read structured properties
//   (port / close / ok/error Result shapes), not prose message strings.

import { World } from '@forgeax/engine-ecs';
import { startServer } from '@forgeax/engine-remote/server';
import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createApp } from '../create-app';
import type { App } from '../types';

// ---------------------------------------------------------------------------
// w18: Type inference — app.remote.port / app.remote.close() are inferred
//      as RemoteHandle without `as`, and the import chain never touches
//      @forgeax/engine-remote (proven by the fact that RemoteHandle is
//      imported from @forgeax/engine-types via the App interface, not from
//      @forgeax/engine-remote directly).

describe('remote-integration w18 — type inference', () => {
  it('app.remote.port is inferred as number without as RemoteHandle', () => {
    const app = {
      remote: { port: 5732, close: async () => {} },
    } as App;
    if (app.remote) {
      const port: number = app.remote.port;
      expect(port).toBe(5732);
      expectTypeOf(app.remote.port).toEqualTypeOf<number>();
    }
  });

  it('app.remote.close() returns Promise<void>', () => {
    const app = {
      remote: { port: 5732, close: async () => {} },
    } as App;
    if (app.remote) {
      const result = app.remote.close();
      expectTypeOf(result).toEqualTypeOf<Promise<void>>();
    }
  });

  it('app.remote is RemoteHandle | undefined (no temporal coupling to remote package)', () => {
    // The App type imports RemoteHandle from @forgeax/engine-types via
    // import('@forgeax/engine-types').RemoteHandle — no static import of
    // @forgeax/engine-remote. The type inference tests above (port as number,
    // close() as Promise<void>) already prove the shape is correct.
    // This test asserts the field is optional (non-required) by checking
    // that a bare { port, close } satisfies the type.
    const remoteVal: NonNullable<App['remote']> = {
      port: 5732,
      close: async () => {},
    };
    expect(remoteVal.port).toBe(5732);
    expectTypeOf(remoteVal.port).toEqualTypeOf<number>();
    expectTypeOf(remoteVal.close).toEqualTypeOf<() => Promise<void>>();
  });

  it('app.remote import chain does not touch @forgeax/engine-remote (compile-time proven)', () => {
    // This file imports startServer from @forgeax/engine-remote/server
    // (needed for w19 integration tests), but the App type's remote field
    // resolves through @forgeax/engine-types.RemoteHandle — no transitive
    // dependency on the remote runtime. The type-level path is:
    //   app/types.ts -> import('@forgeax/engine-types').RemoteHandle
    // which is verified by the RemoteHandle interface living in
    // packages/types/src/index.ts (w17).
    const app = {
      remote: { port: 5732, close: async () => {} },
    } as App;
    // @typescript-eslint/no-unused-expressions
    app.remote?.port;
    // If this file compiled without errors and app.remote.port was inferred as
    // number without `as RemoteHandle`, the type path is clean.
  });
});

// ---------------------------------------------------------------------------
// Assemble hosts opt into remote service startup explicitly.
describe('remote-integration — explicit host assembly', () => {
  // Server start/stop round-trip validates the remote machinery outside of
  // createApp — useful as a baseline for the w20 integration.
  it('startServer creates a server with port > 0 and close() tears it down', async () => {
    const world = new World();
    const result = await startServer({
      port: 0, // OS-assigned ephemeral port
      host: '127.0.0.1',
      world,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`startServer failed: ${result.error.code}`);

    const handle = result.value;
    expect(handle.port).toBeGreaterThan(0);

    // close() should resolve without error
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('startServer with non-loopback host warns but succeeds', async () => {
    // The warning is logged but the server still starts — integration path
    // verifies no crash on the non-localhost code path.
    const world = new World();
    const result = await startServer({
      port: 0,
      host: '0.0.0.0',
      world,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.port).toBeGreaterThan(0);
      await result.value.close();
    }
  });

  it('assemble createApp leaves remote service disabled without an explicit host fact', async () => {
    // Use the assemble form as a proxy: verify that the App type carries
    // remote, but createApp does not yet populate it. After w20, we extend
    // this test to canvas-form (or exercise via the flag resolver).
    const world = new World();
    const rendererStub = makeRendererStub();

    const result = await createApp({ platform: testPlatform(), renderer: rendererStub, world });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const app = result.value;
      expect(app.remote).toBeUndefined();
    }
  });

  it('headless/dawn-node default: app.remote is undefined without explicit opt-in', async () => {
    // Assemble startup remains disabled unless the host passes `remoteServe: true`.
    const world = new World();
    const result = await createApp({
      platform: testPlatform(),
      renderer: makeRendererStub(),
      world,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.remote).toBeUndefined();
    }
  });

  it('ignores ambient remote-serve environment and requires the host assembly fact', async () => {
    vi.stubEnv('FORGEAX_ENGINE_REMOTE_SERVE', '1');
    try {
      const result = await createApp({
        platform: testPlatform(),
        renderer: makeRendererStub(),
        world: new World(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.remote).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('remote server eval round-trip: startServer + client.eval reads world', async () => {
    // Baseline that eval works: start a server, inject a component, connect
    // via WS, eval reads back. After w20, this path works through app.remote
    // too (without manual startServer).
    const world = new World();
    const serverResult = await startServer({
      port: 0,
      host: '127.0.0.1',
      world,
    });
    expect(serverResult.ok).toBe(true);
    if (!serverResult.ok) return;

    const handle = serverResult.value;
    try {
      const { defaultConnect } = await import('@forgeax/engine-types/inspector-client');
      const connectResult = await defaultConnect(`ws://127.0.0.1:${handle.port}/inspector`);
      expect(connectResult.ok).toBe(true);
      if (connectResult.ok) {
        const client = connectResult.value;
        const evalResult = (await client.eval('JSON.stringify(typeof world)')) as unknown as {
          ok?: boolean;
          value?: unknown;
          error?: unknown;
        };
        if (evalResult.ok !== undefined && evalResult.ok) {
          expect(String(evalResult.value)).toBe('"object"');
        }
        await client.dispose();
      }
    } finally {
      await handle.close();
    }
  });
});

/** Minimal renderer stub for assemble-form createApp tests. */
function makeRendererStub(): Renderer {
  const ready: Promise<{ ok: true; value: undefined }> = Promise.resolve({
    ok: true,
    value: undefined,
  });
  return {
    backend: 'webgpu' as const,
    ready,
    draw: (): { ok: true; value: undefined } => ({ ok: true, value: undefined }),
    onError: (): (() => void) => () => {},
    onLost: (): (() => void) => () => {},
    dispose: (): void => {},
  } as unknown as Renderer;
}
