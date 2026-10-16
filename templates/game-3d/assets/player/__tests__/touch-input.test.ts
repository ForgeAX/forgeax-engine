import { FixedUpdate, Update } from '@forgeax/engine/ecs';
import { INPUT_BACKEND_KEY, InputFrameStartScan, type InputBackendSample } from '@forgeax/engine/input';
import { CharacterController } from '@forgeax/engine/physics';
import { describe, expect, it } from 'vitest';
import { camera } from '../../camera/camera.pack.ts';
import { LOOK_SENSITIVITY } from '../../camera/third-person.ts';
import { pluginFixture } from '../../shared/__tests__/plugin-fixture.ts';
import { PLAYER_CONTROL_CHANNEL, type PlayerControl } from '../player-input.ts';
import playerPlugin, { ThirdPersonRig } from '../player.ts';

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
    moveAndSlide: (_entity: unknown, delta: ArrayLike<number>) => { moves.push(Array.from(delta)); },
  });
  let sample = empty();
  world.insertResource(INPUT_BACKEND_KEY, { sample: () => sample, detach() {} });
  world.addSystem(Update, { ...InputFrameStartScan, before: [FixedUpdate] }).unwrap();
  const player = await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001' });
  await ctx.plugin(camera);
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
    ...base, size, moves, send, player,
    rig: () => world.get(entity('player'), ThirdPersonRig).unwrap(),
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
      const pitch = f.rig().pitch;
      f.tick({ focusReset: true }, 1 / 30);
      expect(f.moves).toHaveLength(2);
      expect(Math.hypot(f.moves[0]![0]!, f.moves[0]![2]!)).toBeCloseTo(5.5 * 1.7 / 60);
      expect(f.moves[0]![1]).toBeCloseTo((6 - 18 / 60) / 60);
      expect(f.moves[1]![1]).toBeCloseTo((6 - 36 / 60) / 60);
      expect(f.rig().yaw).toBeCloseTo(80 * LOOK_SENSITIVITY);
      expect(f.rig().pitch).toBeLessThan(pitch);
      const yaw = f.rig().yaw;
      f.tick();
      expect(f.rig().yaw).toBe(yaw);
      await f.send({ kind: 'run', held: false });
      f.tick();
      expect(Math.hypot(f.moves[0]![0]!, f.moves[0]![2]!)).toBeCloseTo(5.5 / 60);
      await f.send({ kind: 'move', horizontal: 0, vertical: 0 });
      f.tick();
      expect(f.moves[0]?.[0]).toBe(0); expect(f.moves[0]?.[2]).toBe(0);
    } finally { await f.dispose(); }
  });

  it('retains a jump across Updates with no fixed step and consumes the edge only once', async () => {
    const f = await fixture();
    try {
      await f.send({ kind: 'jump' }, { kind: 'jump' });
      f.tick({}, 1 / 240); expect(f.moves).toHaveLength(0);
      f.tick({}, 1 / 240); expect(f.moves).toHaveLength(0);
      f.tick({}, 1 / 120);
      expect(f.moves).toHaveLength(1);
      expect(f.moves[0]![1]).toBeCloseTo((6 - 18 / 60) / 60);
      f.tick({}, 1 / 30);
      expect(f.moves[0]![1]).toBeCloseTo((6 - 36 / 60) / 60);
      expect(f.moves[1]![1]).toBeCloseTo((6 - 54 / 60) / 60);
    } finally { await f.dispose(); }
  });

  it('clears every held intent and unconsumed edge on UI reset or changed drawing-buffer extent', async () => {
    const f = await fixture();
    try {
      f.tick();
      for (const resize of [false, true]) {
        await f.send({ kind: 'move', horizontal: 1, vertical: 0 }, { kind: 'look', x: 20, y: 10 }, { kind: 'jump' }, { kind: 'run', held: true });
        if (resize) f.size.width = 1000;
        else await f.send({ kind: 'reset' });
        f.tick();
        expect(f.moves[0]?.[0]).toBe(0); expect(f.moves[0]?.[2]).toBe(0);
        expect(f.moves[0]![1]).toBeLessThanOrEqual(0);
        expect(f.rig().yaw).toBe(0);
        expect(f.ctx.game3dPlayer.readInput().run).toBe(false);
      }
      await f.send({ kind: 'move', horizontal: 1, vertical: 0 });
      f.tick(); expect(f.moves[0]![0]).toBeGreaterThan(0);
    } finally { await f.dispose(); }
  });

  it('bounds protocol input and ignores unrelated form messages and raw gameplay touches', async () => {
    const f = await fixture();
    try {
      await f.send({ kind: 'move', horizontal: 100, vertical: 100 }, { kind: 'look', x: 10000, y: 0 });
      f.tick();
      expect(Math.hypot(f.moves[0]![0]!, f.moves[0]![2]!)).toBeCloseTo(5.5 / 60);
      expect(f.rig().yaw).toBeCloseTo(250 * LOOK_SENSITIVITY);
      await f.send({ kind: 'reset' }, { channel: 'game-3d/runtime-vase', kind: 'move', horizontal: 1, vertical: 1 }, { kind: 'move', horizontal: Number.NaN, vertical: 1 });
      f.tick({ pointers: [{ pointerId: 1, pointerType: 'touch', x: 100, y: 50, active: true, pressure: 1, delta: { x: 80, y: -40 } }] });
      expect(f.moves[0]?.[0]).toBe(0); expect(f.moves[0]?.[2]).toBe(0);
    } finally { await f.dispose(); }
  });

  it('retains keyboard movement, Shift sprint, a single Space edge and one-frame mouse look', async () => {
    const f = await fixture();
    try {
      f.tick({ downCodes: new Set(['KeyW', 'ShiftLeft', 'Space']), pointerLocked: true, movementX: 10 }, 1 / 30);
      expect(f.moves).toHaveLength(2);
      expect(Math.hypot(f.moves[0]![0]!, f.moves[0]![2]!)).toBeCloseTo(5.5 * 1.7 / 60);
      expect(f.moves[1]![1]).toBeLessThan(f.moves[0]![1]!);
      expect(f.rig().yaw).toBeCloseTo(10 * LOOK_SENSITIVITY);
      f.tick({ movementX: 40 });
      expect(f.rig().yaw).toBeCloseTo(10 * LOOK_SENSITIVITY);
      expect(f.moves[0]?.[0]).toBe(0); expect(f.moves[0]?.[2]).toBe(0);
      f.tick({ buttons: [false, false, true], movementX: 5 });
      expect(f.rig().yaw).toBeCloseTo(15 * LOOK_SENSITIVITY);
    } finally { await f.dispose(); }
  });
});
