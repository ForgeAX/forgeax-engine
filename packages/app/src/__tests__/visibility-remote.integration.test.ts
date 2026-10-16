import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { Visibility } from '@forgeax/engine-render';
import { defaultConnect } from '@forgeax/engine-types/inspector-client';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../create-app';
import { testPlatform } from './platform-fixture';

async function introspect(port: number): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/inspector`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (raw) => {
        try {
          const response = JSON.parse(raw.toString()) as { result: Record<string, unknown> };
          resolve(response.result);
        } catch (error) {
          reject(error);
        }
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'introspect', id: 1 }));
    });
  } finally {
    ws.close();
  }
}

function makeRendererStub(): Renderer {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

describe('createApp to remote visibility discovery', () => {
  it('introspects then evaluates a Query and recovers an invalid write', async () => {
    const previous = process.env.FORGEAX_ENGINE_REMOTE_SERVE;
    process.env.FORGEAX_ENGINE_REMOTE_SERVE = '1';
    const world = new World();
    world.components.register(Visibility).unwrap();
    const result = await createApp({
      platform: testPlatform(),
      renderer: makeRendererStub(),
      world,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.remote).toBeDefined();

    try {
      const port = result.value.remote?.port;
      expect(port).toBeGreaterThan(0);
      if (port === undefined) return;
      const doc = await introspect(port);
      const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
      expect(schemas.Visibility).toBeDefined();
      expect((doc.methods as Array<{ name: string }>).map((method) => method.name)).toEqual([
        'eval',
        'introspect',
      ]);

      const connection = await defaultConnect(`ws://127.0.0.1:${port}/inspector`);
      expect(connection.ok).toBe(true);
      if (!connection.ok) return;
      try {
        const value = await connection.value.eval(`(async () => {
          const render = await _import('@forgeax/engine-render');
          const entity = world.spawn({
            component: render.Visibility,
            data: { state: render.VisibilityStateValue.hidden },
          }).unwrap();
          const query = world.query({ read: [render.Visibility] }).unwrap();
          let current;
          for (const row of query) {
            current = ['inherited', 'hidden', 'visible'][row.get(render.Visibility).state];
          }
          const effective = render.resolveVisibility(world).effective(entity);
          const invalid = world.set(entity, render.Visibility, { state: 99 });
          const recovered = world.set(entity, render.Visibility, {
            state: render.VisibilityStateValue.visible,
          });
          return {
            current,
            effective,
            invalid: invalid.ok ? undefined : {
              code: invalid.error.code,
              expected: invalid.error.expected,
              hint: invalid.error.hint,
              detail: invalid.error.detail,
            },
            recovered: recovered.ok,
            restored: render.resolveVisibility(world).effective(entity),
          };
        })()`);
        expect(value).toMatchObject({
          current: 'hidden',
          effective: 'hidden',
          invalid: { code: 'component-field-invalid-value' },
          recovered: true,
          restored: 'visible',
        });
        expect((value as { invalid: { hint: string } }).invalid.hint.length).toBeGreaterThan(0);
      } finally {
        await connection.value.dispose();
      }
    } finally {
      await result.value.remote?.close();
      if (previous === undefined) delete process.env.FORGEAX_ENGINE_REMOTE_SERVE;
      else process.env.FORGEAX_ENGINE_REMOTE_SERVE = previous;
    }
  });
});
