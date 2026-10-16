import { World } from '@forgeax/engine-ecs';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, type MeshAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';

function mesh(indices: Uint16Array | Uint32Array, position = 0): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(24 * 12).fill(position),
    indices,
    attributes: {
      position: new Float32Array(24 * 3),
      normal: new Float32Array(24 * 3),
      uv: new Float32Array(24 * 2),
      tangent: new Float32Array(24 * 4),
    },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: 24,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'default' }],
  };
}

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(
    device,
    undefined,
    () => {
      throw new Error('unused');
    },
    device.caps,
  );
  const worlds = [new World(), new World()];
  const upload = (source: MeshAsset, world = worlds[0]) => {
    assert(world);
    const handle = world.allocSharedRef('MeshAsset', source);
    return { handle, world, entry: store.ensureResident(handle, source, world).unwrap() };
  };
  return { device, store, worlds, upload };
}

it.each([
  'uint16',
  'uint32',
] as const)('shares identical %s indices across independent vertices and Worlds', async (format) => {
  const { store, worlds, upload } = await fixture();
  const indices =
    format === 'uint16'
      ? new Uint16Array([23, 0, 1, 2, 23]).subarray(1, 4)
      : new Uint32Array([0, 1, 2]);
  const first = upload(mesh(indices));
  const second = upload(mesh(indices.slice(), 1), worlds[1]);
  expect(second.entry.vertexBuffer).not.toBe(first.entry.vertexBuffer);
  expect(second.entry.indexBuffer).toBe(first.entry.indexBuffer);
  expect(second.entry.indexFormat).toBe(format);
  expect(second.entry.iboBytes).toBe(format === 'uint16' ? 8 : 12);
  store.destroyAll();
});

it('preserves one index format per physical buffer even when uploaded bytes match', async () => {
  const { store, upload } = await fixture();
  const shorts = new Uint16Array([0, 0, 1, 0, 2, 0]);
  const words = new Uint32Array([0, 1, 2]);
  expect(new Uint8Array(shorts.buffer)).toEqual(new Uint8Array(words.buffer));
  const first = upload(mesh(shorts));
  const second = upload(mesh(words, 1));
  expect(second.entry.indexBuffer).not.toBe(first.entry.indexBuffer);
  expect(second.entry.indexFormat).toBe('uint32');
  expect(first.entry.indexFormat).toBe('uint16');
  store.destroyAll();
});

it('keeps immutable bytes after author mutation and checks full bytes for a real hash collision', async () => {
  const { store, upload } = await fixture();
  const left = new Uint32Array([16, 12, 22, 6, 21, 14]);
  const right = new Uint32Array([3, 9, 8, 15, 13, 1]);
  const hash = (words: Uint32Array) =>
    words.reduce((value, word) => Math.imul(value ^ word, 16777619), 2166136261) >>> 0;
  expect(hash(left)).toBe(hash(right));
  const first = upload(mesh(left));
  left.fill(0);
  const same = upload(mesh(new Uint32Array([16, 12, 22, 6, 21, 14]), 1));
  expect(same.entry.indexBuffer).toBe(first.entry.indexBuffer);
  const collision = upload(mesh(right, 2));
  expect(collision.entry.indexBuffer).not.toBe(first.entry.indexBuffer);
  store.invalidateMesh(collision.handle, collision.world);
  expect(first.entry.indexBuffer?.isDestroyed).toBe(false);
  store.destroyAll();
});

it('fences a retired shared index allocation until its last lease and submission complete', async () => {
  const { store, upload } = await fixture();
  const first = upload(mesh(new Uint16Array([0, 1, 2])));
  const second = upload(mesh(new Uint16Array([0, 1, 2]), 1));
  const lease = store.retainMeshResidency(first.handle, first.world);
  assert(lease);
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  store.trackMeshSubmission(completed);
  store.invalidateMesh(first.handle, first.world);
  store.invalidateMesh(second.handle, second.world);
  expect(first.entry.indexBuffer?.isDestroyed).toBe(false);
  const third = upload(mesh(new Uint16Array([0, 1, 2]), 2));
  expect(third.entry.indexBuffer).toBe(first.entry.indexBuffer);
  finish();
  await completed;
  lease.release(false);
  expect(third.entry.indexBuffer?.isDestroyed).toBe(false);
  store.invalidateMesh(third.handle, third.world);
  expect(third.entry.indexBuffer?.isDestroyed).toBe(true);
  store.destroyAll();
});

it('checks complete vertex bytes after a large independent-lane hash collision', async () => {
  const { store, upload } = await fixture();
  const left = new Uint32Array(384);
  const right = new Uint32Array(384);
  left[0] = 3595022520;
  left[4] = 3468143941;
  right[0] = 807225351;
  right[4] = 2833037028;
  const key = store as unknown as {
    meshBufferKey(words: Uint32Array, usage: number): string;
  };
  expect(key.meshBufferKey(left, 1)).toBe(key.meshBufferKey(right, 1));
  const source = (words: Uint32Array): MeshAsset => ({
    ...mesh(new Uint16Array([0, 1, 2])),
    vertices: new Float32Array(words.buffer),
    attributes: {
      position: new Float32Array(32 * 3),
      normal: new Float32Array(32 * 3),
      uv: new Float32Array(32 * 2),
      tangent: new Float32Array(32 * 4),
    },
  });
  try {
    const first = upload(source(left));
    const same = upload(source(left.slice()));
    expect(same.entry.vertexBuffer).toBe(first.entry.vertexBuffer);
    const collision = upload(source(right));
    expect(collision.entry.vertexBuffer).not.toBe(first.entry.vertexBuffer);
    store.invalidateMesh(first.handle, first.world);
    expect(collision.entry.vertexBuffer.isDestroyed).toBe(false);
  } finally {
    store.destroyAll();
  }
});

it.each([
  257, 258, 259,
])('includes every lane and tail of a %i-word view in its content key', (length) => {
  const store = new GpuResidencyCache() as unknown as {
    meshBufferKey(words: Uint32Array, usage: number): string;
  };
  const words = new Uint32Array(length + 4).fill(17).subarray(2, length + 2);
  const original = store.meshBufferKey(words, 1);
  for (const index of [0, 1, 2, 3, length - 3, length - 2, length - 1]) {
    words[index] = 23;
    expect(store.meshBufferKey(words, 1)).not.toBe(original);
    words[index] = 17;
  }
  expect(store.meshBufferKey(words, 2)).not.toBe(original);
});

it('detaches a mutable index update even when the vertex allocation has only one owner', async () => {
  const { store, device, upload } = await fixture();
  const firstMesh = mesh(new Uint16Array([0, 1, 2]));
  const first = upload(firstMesh);
  const second = upload(mesh(new Uint16Array([0, 1, 2]), 1));
  const writes: unknown[] = [];
  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  device.queue.writeBuffer = (buffer, ...args) => {
    writes.push(buffer);
    return writeBuffer(buffer, ...args);
  };
  store.updateMesh(first.handle, firstMesh.vertices, new Uint16Array([2, 1, 0]), first.world);
  const updated = store.getMeshGpuHandles(first.handle, first.world);
  expect(updated?.indexBuffer).not.toBe(second.entry.indexBuffer);
  expect(writes).not.toContain(second.entry.indexBuffer?.handle);
  expect(second.entry.indexBuffer?.isDestroyed).toBe(false);
  const third = upload(mesh(new Uint16Array([0, 1, 2]), 2));
  expect(third.entry.indexBuffer).toBe(second.entry.indexBuffer);
  store.destroyAll();
});

it('removes an exclusively updated index allocation from immutable reuse', async () => {
  const { store, upload } = await fixture();
  const source = mesh(new Uint16Array([0, 1, 2]));
  const first = upload(source);
  store.updateMesh(first.handle, source.vertices, new Uint16Array([2, 1, 0]), first.world);
  const second = upload(mesh(new Uint16Array([0, 1, 2]), 1));
  expect(second.entry.indexBuffer).not.toBe(first.entry.indexBuffer);
  expect(store.getMeshGpuHandles(first.handle, first.world)).toBe(first.entry);
  store.destroyAll();
});

it.each([
  ['vertex', 'create'],
  ['vertex', 'write'],
  ['index', 'create'],
  ['index', 'write'],
] as const)('a failed %s %s leaves borrowed allocation ownership unchanged', async (kind, stage) => {
  const { store, device, upload } = await fixture();
  const first = upload(mesh(new Uint16Array([0, 1, 2])));
  const source =
    kind === 'vertex' ? mesh(new Uint16Array([0, 1, 2]), 1) : mesh(new Uint16Array([2, 1, 0]));
  const borrowed = kind === 'vertex' ? first.entry.indexBuffer : first.entry.vertexBuffer;
  assert(borrowed);
  const handle = first.world.allocSharedRef('MeshAsset', source);
  const createBuffer = device.createBuffer.bind(device);
  const writeBuffer = device.queue.writeBuffer.bind(device.queue);
  const failure = err(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'injected upload failure',
      hint: 'retry upload',
    }),
  );
  if (stage === 'create') device.createBuffer = () => failure;
  else device.queue.writeBuffer = () => failure;
  expect(store.ensureResident(handle, source, first.world).ok).toBe(false);
  expect(store.getMeshGpuHandles(handle, first.world)).toBeUndefined();
  expect(borrowed.isDestroyed).toBe(false);
  device.createBuffer = createBuffer;
  device.queue.writeBuffer = writeBuffer;
  const retry = store.ensureResident(handle, source, first.world).unwrap();
  expect(kind === 'vertex' ? retry.indexBuffer : retry.vertexBuffer).toBe(borrowed);
  store.invalidateMesh(first.handle, first.world);
  store.invalidateMesh(handle, first.world);
  expect(borrowed.isDestroyed).toBe(true);
  store.destroyAll();
});

it.each([
  'uint16',
  'uint32',
] as const)('derives %s index format from typed-array identity without reading an author width getter', async (format) => {
  const { store, upload } = await fixture();
  const indices = format === 'uint16' ? new Uint16Array([0, 1, 2]) : new Uint32Array([0, 1, 2]);
  const failure = new Error('author index width must not be observed');
  let reads = 0;
  Object.defineProperty(indices, 'BYTES_PER_ELEMENT', {
    get() {
      reads += 1;
      throw failure;
    },
  });
  try {
    const first = upload(mesh(indices));
    expect(first.entry.indexFormat).toBe(format);
    expect(first.entry.iboBytes).toBe(format === 'uint16' ? 8 : 12);
    expect(reads).toBe(0);
  } finally {
    store.destroyAll();
  }
});

it('uses typed index format even when an author width property spoofs matching bytes', async () => {
  const { store, upload } = await fixture();
  const shorts = new Uint16Array([0, 0, 1, 0, 2, 0]);
  Object.defineProperty(shorts, 'BYTES_PER_ELEMENT', { value: 4 });
  const words = new Uint32Array([0, 1, 2]);
  expect(new Uint8Array(shorts.buffer)).toEqual(new Uint8Array(words.buffer));
  try {
    const first = upload(mesh(shorts));
    const second = upload(mesh(words, 1));
    expect(first.entry.indexFormat).toBe('uint16');
    expect(second.entry.indexFormat).toBe('uint32');
    expect(first.entry.indexBuffer).not.toBe(second.entry.indexBuffer);
  } finally {
    store.destroyAll();
  }
});

it('publishes one immutable result per allocation and retains old results through replacement', async () => {
  const { store, upload } = await fixture();
  const source = mesh(new Uint16Array([0, 1, 2]));
  const first = upload(source);
  const published = store.ensureResident(first.handle, source, first.world);
  expect(store.ensureResident(first.handle, source, first.world)).toBe(published);
  expect(Object.isFrozen(published)).toBe(true);
  expect(() => Object.assign(published, { value: undefined })).toThrow(TypeError);
  store.invalidateMesh(first.handle, first.world);
  const next = store.ensureResident(first.handle, source, first.world);
  expect(next).not.toBe(published);
  expect(published.unwrap()).toBe(first.entry);
  expect(next.unwrap()).not.toBe(first.entry);
  store.destroyAll();
});
