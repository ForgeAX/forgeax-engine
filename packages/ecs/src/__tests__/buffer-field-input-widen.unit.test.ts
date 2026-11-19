import { describe, expect, it } from 'vitest';
import { createCommandBuffer, detachCommandBufferPayloads, flushCommands } from '../commands';
import { defineComponent, isSchemaVocabKeyword } from '../component';
import { World } from '../world';
import { worldRead } from '../world-read';

// Byte intent is explicit at the producer; the field itself is an ordinary u8 array.
describe('byte array input', () => {
  it.each([
    () => new Float32Array([1.5, -2]),
    () => new Uint16Array([0x1234, 0x5678]).subarray(1),
    () => new DataView(Uint8Array.of(0, 7, 8, 0).buffer, 1, 2),
    () => Uint8Array.of(3, 9).buffer,
    () => new SharedArrayBuffer(3),
  ])('stores an explicit byte window through spawn and set', (makeInput) => {
    const input = makeInput();
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    const Data = defineComponent('ExplicitBytes', { value: 'array<u8>' });
    const world = new World();
    const entity = world.spawn({ component: Data, data: { value: bytes } }).unwrap();
    expect([...world.get(entity, Data).unwrap().value]).toEqual([...bytes]);
    world.set(entity, Data, { value: [] }).unwrap();
    world.set(entity, Data, { value: bytes }).unwrap();
    expect([...world.get(entity, Data).unwrap().value]).toEqual([...bytes]);
  });

  it.each(['buffer', 'buffer<8>'])('rejects the retired %s declaration', (type) => {
    expect(isSchemaVocabKeyword(type)).toBe(false);
    expect(() => defineComponent('RetiredBytes', { value: type } as never)).toThrow();
  });

  it('uses the ordinary numeric range and semantic read APIs', () => {
    const Data = defineComponent('ByteRange', { value: 'array<u8, 4>' });
    const world = new World();
    const entity = world.spawn({ component: Data, data: { value: [1, 2, 3, 4] } }).unwrap();
    world.setArrayRange(entity, Data, 'value', 1, [8, 9]).unwrap();
    expect(world[worldRead].getArrayLength(entity, Data, 'value')).toBe(4);
    expect(world[worldRead].getArrayElement(entity, Data, 'value', 2)).toBe(9);
    const out = new Uint8Array(4);
    expect(world[worldRead].copyArray(entity, Data, 'value', out)).toBe(4);
    expect([...out]).toEqual([1, 8, 9, 4]);
  });
});

describe('fixed byte array initialization after row reuse', () => {
  it.each([0, 2])('initializes the unwritten tail after a %i-byte prefix', (count) => {
    const Bytes = defineComponent('ReusedFixedBytes', { bytes: 'array<u8, 4>' });
    const world = new World();
    const old = world
      .spawn({ component: Bytes, data: { bytes: Uint8Array.of(1, 2, 3, 4) } })
      .unwrap();
    world.despawn(old).unwrap();
    const prefix = Uint8Array.of(9, 8).subarray(0, count);
    const fresh =
      count === 0
        ? world.spawn({ component: Bytes, data: {} }).unwrap()
        : world.spawn({ component: Bytes, data: { bytes: prefix } }).unwrap();
    expect(Array.from(world.get(fresh, Bytes).unwrap().bytes)).toEqual(
      count === 0 ? [0, 0, 0, 0] : [9, 8, 0, 0],
    );
  });
});

describe('numeric array ingestion', () => {
  it.each([
    'array<u8>',
    'array<u8, 4>',
  ] as const)('refuses mismatched views atomically for %s through direct and detached writes', (type) => {
    const Values = defineComponent('MismatchedByteInput', { data: type });
    const world = new World();
    const entity = world.spawn({ component: Values, data: { data: [3, 8, 2, 1] } }).unwrap();
    const empty = world.spawn().unwrap();
    for (const value of [
      new Float32Array([1, 2]),
      new Int8Array([1, 2]),
      new Uint8ClampedArray([1, 2]),
    ]) {
      const epoch = world[worldRead].getMutationEpoch();
      const data = { data: value as never };
      expect(world.spawn({ component: Values, data })).toMatchObject({
        ok: false,
        error: { code: 'managed-array-invalid-value' },
      });
      expect(world.addComponent(empty, { component: Values, data })).toMatchObject({
        ok: false,
        error: { code: 'managed-array-invalid-value' },
      });
      expect(world.set(entity, Values, data)).toMatchObject({
        ok: false,
        error: { code: 'managed-array-invalid-value' },
      });
      expect([...world.get(entity, Values).unwrap().data]).toEqual([3, 8, 2, 1]);
      expect(world.hasComponent(empty, Values)).toBe(false);
      expect(world[worldRead].getMutationEpoch()).toBe(epoch);
      const commands = createCommandBuffer(world);
      const pending = commands.spawn({ component: Values, data });
      detachCommandBufferPayloads(commands);
      expect(() => flushCommands(commands, world)).toThrowError(
        expect.objectContaining({
          code: 'command-failed',
          detail: expect.objectContaining({
            cause: expect.objectContaining({ code: 'managed-array-invalid-value' }),
          }),
        }),
      );
      expect(commands.status).toBe('aborted');
      expect(world.hasComponent(pending, Values)).toBe(false);
      expect(world.execution.health).toBe('healthy');
    }
  });
  it.each([BigInt64Array, BigUint64Array])('refuses %s before changing a numeric array', (Ctor) => {
    const Values = defineComponent('BigIntNumericInput', { data: 'array<u32>' });
    const world = new World();
    const entity = world.spawn({ component: Values, data: { data: [3, 8] } }).unwrap();
    const epoch = world[worldRead].getMutationEpoch();
    const result = world.set(entity, Values, { data: new Ctor([1n]) as never });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('managed-array-invalid-value');
    expect([...world.get(entity, Values).unwrap().data]).toEqual([3, 8]);
    expect(world[worldRead].getMutationEpoch()).toBe(epoch);
  });
});
