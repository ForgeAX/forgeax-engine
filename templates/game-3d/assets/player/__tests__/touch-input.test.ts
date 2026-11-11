import { FixedUpdate, Update } from '@forgeax/engine/ecs';
import { INPUT_BACKEND_KEY, InputFrameStartScan, type InputBackendSample } from '@forgeax/engine/input';
import { CharacterController } from '@forgeax/engine/physics';
import { describe, expect, it } from 'vitest';
import { pluginFixture } from '../../__tests__/plugin-fixture.ts';
import { PLAYER_CONTROL_CHANNEL, PLAYER_STATE_CHANNEL, type PlayerControl, type PlayerHudState } from '../../shared/player-protocol.ts';
import playerPlugin from '../player.ts';

const empty = (): InputBackendSample => ({
  downKeys: new Set(), upKeys: new Set(), buttons: [false, false, false],
  movementX: 0, movementY: 0, wheelDelta: 0, focused: true, pointerLocked: false,
});

async function fixture() {
  const base = await pluginFixture();
  const { world, ctx, entity } = base;
  const size = { width: 800, height: 400 };
  const channel = new MessageChannel();
  if (!ctx.gameHost) throw new Error('Expected fixture GameHost');
  Object.assign(ctx.gameHost, { drawingBufferSize: () => size, port: channel.port2 });
  expect(ctx.gameHost.canvas).toBeUndefined();
  world.components.register(CharacterController).unwrap();
  world.addComponent(entity('player'), { component: CharacterController, data: { grounded: true } }).unwrap();
  const moves: number[][] = [];
  world.insertResource('PhysicsWorld', {
    hasBody: () => true,
    moveAndSlide: (_entity: unknown, delta: ArrayLike<number>) => { moves.push(Array.from(delta)); return delta; },
  });
  let sample = empty();
  world.insertResource(INPUT_BACKEND_KEY, { sample: () => sample, detach() {} });
  world.addSystem(Update, { ...InputFrameStartScan, before: [FixedUpdate] }).unwrap();
  const player = await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001', transform: '019fb7ce-1000-7000-8000-000000000002', wheels: '019fb7ce-1000-7000-8000-000000000003' });
  const hud: PlayerHudState[] = [];
  channel.port1.addEventListener('message', (event) => {
    if (event.data?.channel === PLAYER_STATE_CHANNEL) hud.push(event.data.state);
  });
  channel.port1.start();
  const send = async (...messages: (PlayerControl | Record<string, unknown>)[]) => {
    const delivered = new Promise<void>((resolve) => {
      const receive = (event: MessageEvent) => {
        if (!event.data.barrier) return;
        channel.port2.removeEventListener('message', receive); resolve();
      };
      channel.port2.addEventListener('message', receive);
    });
    for (const message of messages) channel.port1.postMessage({ channel: PLAYER_CONTROL_CHANNEL, ...message });
    channel.port1.postMessage({ barrier: true });
    await delivered;
  };
  return {
    ...base, size, moves, send, player, hud,
    input: () => ctx.get('game3dPlayer')!.readInput(),
    tick(next: Partial<InputBackendSample> = {}, dt = 1 / 60) {
      moves.length = 0; sample = { ...empty(), ...next }; world.update(dt).unwrap();
    },
    async dispose() { await ctx.fiber.dispose(); channel.port1.close(); channel.port2.close(); },
  };
}

describe('ordinary game UI touch input consumption', () => {
  it('combines move, look, Jump and held Run on the actual World while raw UI-owned input is empty', async () => {
    const f = await fixture();
    try {
      f.tick();
      await f.send({ kind: 'move', horizontal: 0, vertical: 1 }, { kind: 'look', x: 80, y: -40 }, { kind: 'jump' }, { kind: 'run', held: true });
      f.tick({ focusReset: true }, 1 / 30);
      expect(f.moves).toHaveLength(2);
      expect(Math.hypot(f.moves[0]![0]!, f.moves[0]![2]!)).toBeCloseTo(5.5 * 1.7 / 60);
      expect(f.moves[0]![1]).toBeCloseTo((6 - 18 / 60) / 60);
      expect(f.moves[1]![1]).toBeCloseTo((6 - 36 / 60) / 60);
      expect(f.input()).toMatchObject({ lookX: 80, lookY: -40, run: true });
      f.tick();
      expect(f.input()).toMatchObject({ lookX: 0, lookY: 0 });
      await f.send({ kind: 'run', held: false });
      f.tick();
      expect(Math.hypot(f.moves[0]![0]!, f.moves[0]![2]!)).toBeCloseTo(5.5 / 60);
      await f.send({ kind: 'move', horizontal: 0, vertical: 0 });
      f.tick();
      expect(f.moves[0]?.[0]).toBe(0); expect(f.moves[0]?.[2]).toBe(0);
      // The HUD reports the applied fixed-step displacement: running, walking, then stopped.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.hud.map((state) => state.speed)).toEqual([0, 9.4, 5.5, 0]);
    } finally { await f.dispose(); }
  });
});
