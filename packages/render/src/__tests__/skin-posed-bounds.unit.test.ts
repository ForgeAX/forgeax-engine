import { World } from '@forgeax/engine-ecs';
import { box3, mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { SkinPosedBoundsCache, skinPosedBounds, skinPosedBoundsCache } from '../skin-posed-bounds';
import type { SkinPose } from '../systems/skin-palette-types';

function fixture() {
  const mesh: MeshAsset = {
    kind: 'mesh',
    attributes: {
      position: new Float32Array([-2, 1, 0, 3, -1, 2]),
      skinIndex: new Uint16Array([0, 1, 0, 0, 0, 1, 0, 0]),
      skinWeight: new Float32Array([0.25, 0.75, 0, 0, 0.25, 0.75, 0, 0]),
    },
    vertices: new Float32Array(0),
    indices: new Uint16Array(0),
    submeshes: [],
    materialSlots: [],
  };
  const first = mat4.identity(mat4.create());
  const second = mat4.identity(mat4.create());
  second[12] = 4;
  second[13] = 2;
  second[14] = -2;
  const pose: SkinPose = {
    identity: 'bounds-unit',
    generation: 1,
    jointCount: 2,
    jointWorlds: [first, second],
    inverseBindMatrices: [mat4.identity(mat4.create()), mat4.identity(mat4.create())],
  };
  return { mesh, pose, world: mat4.identity(mat4.create()), second };
}

describe('exact current skin bounds', () => {
  it('encloses weighted XYZ and homogeneous positions in mesh-local space', () => {
    const { mesh, pose, world, second } = fixture();
    expect(skinPosedBounds(mesh, pose, world)).toEqual(
      new Float32Array([1, 0.5, -1.5, 6, 2.5, 0.5]),
    );
    second[15] = 2;
    expect(skinPosedBounds(mesh, pose, world)).toEqual(
      new Float32Array([1 / 1.75, 0.5 / 1.75, -1.5, 6, 2.5, 0.5]),
    );
    second[15] = 1;
    world[12] = -5;
    expect(skinPosedBounds(mesh, pose, world)).toEqual(
      new Float32Array([6, 0.5, -1.5, 11, 2.5, 0.5]),
    );
  });

  it('reads current borrowed mesh, weight and joint values without changing prior bounds', () => {
    const { mesh, pose, world, second } = fixture();
    const first = skinPosedBounds(mesh, pose, world);
    second[12] = 8;
    expect(skinPosedBounds(mesh, pose, world)).toEqual(
      new Float32Array([4, 0.5, -1.5, 9, 2.5, 0.5]),
    );
    (mesh.attributes.position as Float32Array)[0] = -4;
    expect(skinPosedBounds(mesh, pose, world)).toEqual(
      new Float32Array([2, 0.5, -1.5, 9, 2.5, 0.5]),
    );
    (mesh.attributes.skinWeight as Float32Array)[0] = 0.5;
    expect(skinPosedBounds(mesh, pose, world)).not.toEqual(first);
    expect(first).toEqual(new Float32Array([1, 0.5, -1.5, 6, 2.5, 0.5]));
  });

  it('uses only the declared typed-array subviews', () => {
    const { mesh, pose, world } = fixture();
    const attributes = {
      position: new Float32Array([NaN, -2, 1, 0, 3, -1, 2, NaN]).subarray(1, 7),
      skinIndex: new Uint16Array([65535, 0, 1, 0, 0, 0, 1, 0, 0, 65535]).subarray(1, 9),
      skinWeight: new Float32Array([NaN, 0.25, 0.75, 0, 0, 0.25, 0.75, 0, 0, NaN]).subarray(1, 9),
    };
    expect(skinPosedBounds({ ...mesh, attributes }, pose, world)).toEqual(
      skinPosedBounds(mesh, pose, world),
    );
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
  ])('rejects nonfinite position, weight and palette values (%s)', (value) => {
    const { mesh, pose, world, second } = fixture();
    const positions = mesh.attributes.position as Float32Array;
    positions[0] = value;
    expect(skinPosedBounds(mesh, pose, world)).toBeUndefined();
    positions[0] = -2;
    const weights = mesh.attributes.skinWeight as Float32Array;
    weights[0] = value;
    expect(skinPosedBounds(mesh, pose, world)).toBeUndefined();
    weights[0] = 0.25;
    second[0] = value;
    expect(skinPosedBounds(mesh, pose, world)).toBeUndefined();
  });

  it('retains zero-weight lane validation and rejects nonpositive homogeneous weight', () => {
    const { mesh, pose, world } = fixture();
    const indices = mesh.attributes.skinIndex as Uint16Array;
    indices[2] = 2;
    expect(skinPosedBounds(mesh, pose, world)).toBeUndefined();
    indices[2] = 0;
    const weights = mesh.attributes.skinWeight as Float32Array;
    weights.fill(0);
    expect(skinPosedBounds(mesh, pose, world)).toBeUndefined();
    weights.fill(-1);
    expect(skinPosedBounds(mesh, pose, world)).toBeUndefined();
  });

  it('keeps singular transforms and malformed attribute or palette shapes conservative', () => {
    const { mesh, pose, world } = fixture();
    world[0] = 0;
    expect(skinPosedBounds(mesh, pose, world)).toBeUndefined();
    mat4.identity(world);
    expect(
      skinPosedBounds(
        { ...mesh, attributes: { ...mesh.attributes, position: new Float32Array(4) } },
        pose,
        world,
      ),
    ).toBeUndefined();
    expect(
      skinPosedBounds(
        { ...mesh, attributes: { ...mesh.attributes, skinWeight: new Float32Array(4) } },
        pose,
        world,
      ),
    ).toBeUndefined();
    expect(
      skinPosedBounds(mesh, { ...pose, inverseBindMatrices: [new Float32Array(15)] }, world),
    ).toBeUndefined();
    expect(skinPosedBounds(mesh, { ...pose, jointWorlds: [] }, world)).toBeUndefined();
  });
});

describe('exact skin pose reuse', () => {
  function reusableFixture() {
    const input = fixture();
    const cache = new SkinPosedBoundsCache();
    const read = vi.spyOn(cache, 'read');
    const resolve = () => skinPosedBounds(input.mesh, input.pose, input.world, cache);
    const fresh = () => skinPosedBounds(input.mesh, input.pose, input.world);
    resolve();
    resolve();
    resolve();
    expect(read.mock.results.at(-1)?.value).toBeDefined();
    return { ...input, cache, read, resolve, fresh };
  }

  it('reuses a held pose without exposing private cached bounds', () => {
    const { resolve, fresh } = reusableFixture();
    const first = resolve();
    if (first === undefined) throw Error('missing cached bounds');
    first.fill(999);
    expect(resolve()).toEqual(fresh());
    expect(resolve()).not.toBe(resolve());
  });

  it.each([
    'position',
    'skinIndex',
    'skinWeight',
  ] as const)('observes in-place %s edits', (field) => {
    const { mesh, resolve, fresh, read } = reusableFixture();
    const values = mesh.attributes[field];
    if (!(values instanceof Float32Array || values instanceof Uint16Array))
      throw Error('missing attribute');
    values[0] = field === 'position' ? -4 : field === 'skinIndex' ? 1 : 0.5;
    expect(resolve()).toEqual(fresh());
    expect(read.mock.results.at(-1)?.value).toBeUndefined();
    resolve();
    expect(read.mock.results.at(-1)?.value).toBeDefined();
  });

  it('observes bone/world motion, inverse-bind edits and matrix rebinds', () => {
    const { pose, world, second, resolve, fresh, read } = reusableFixture();
    for (const mutate of [
      () => {
        second[12] = 8;
      },
      () => {
        world[12] = -5;
      },
      () => {
        const bind = pose.inverseBindMatrices[1];
        if (bind) bind[13] = 3;
      },
      () => {
        const replacement = mat4.identity(mat4.create());
        replacement[14] = 9;
        (pose.jointWorlds as ReturnType<typeof mat4.create>[])[1] = replacement;
      },
    ]) {
      mutate();
      expect(resolve()).toEqual(fresh());
      expect(read.mock.results.at(-1)?.value).toBeUndefined();
    }
  });

  it('keeps accessor observations and validates values after those accessors run', () => {
    const { mesh, resolve, fresh } = reusableFixture();
    const attributes = mesh.attributes;
    const positions = attributes.position as Float32Array;
    let calls = 0;
    Object.defineProperty(mesh, 'attributes', {
      get() {
        calls++;
        if (calls === 2) positions[0] = -4;
        return attributes;
      },
    });
    positions[0] = -2;
    const cached = resolve();
    expect(calls).toBe(3);
    calls = 0;
    positions[0] = -2;
    expect(fresh()).toEqual(cached);
    expect(calls).toBe(3);
  });

  it.each([
    'position',
    'skinIndex',
    'skinWeight',
  ] as const)('never reuses a shared %s buffer', (field) => {
    const { mesh, pose, world, cache, read } = reusableFixture();
    const current = mesh.attributes[field];
    if (!(current instanceof Float32Array || current instanceof Uint16Array))
      throw Error('missing attribute');
    const buffer = new SharedArrayBuffer(current.byteLength);
    const shared = field === 'skinIndex' ? new Uint16Array(buffer) : new Float32Array(buffer);
    shared.set(current);
    const sharedMesh = { ...mesh, attributes: { ...mesh.attributes, [field]: shared } };
    read.mockClear();
    for (let iteration = 0; iteration < 3; iteration++) {
      shared[0] = field === 'skinIndex' ? iteration % 2 : iteration * 0.25;
      expect(skinPosedBounds(sharedMesh, pose, world, cache)).toEqual(
        skinPosedBounds(sharedMesh, pose, world),
      );
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('does not turn nonfinite, detached or singular changes into stale success', () => {
    const { mesh, second, world, resolve } = reusableFixture();
    const positions = mesh.attributes.position as Float32Array;
    positions[0] = NaN;
    expect(resolve()).toBeUndefined();
    positions[0] = -2;
    second[0] = Infinity;
    expect(resolve()).toBeUndefined();
    second[0] = 1;
    world[0] = 0;
    expect(resolve()).toBeUndefined();
    mat4.identity(world);
    structuredClone(positions.buffer, { transfer: [positions.buffer] });
    expect(resolve()).toBeUndefined();
  });

  it('bypasses proxy numeric accessors and does not read overridden view metadata', () => {
    const { mesh, pose, world, cache, read } = reusableFixture();
    const positions = mesh.attributes.position as Float32Array;
    const proxy = new Proxy(positions, {
      get(target, property) {
        if (property === '0') return -4;
        return Reflect.get(target, property, target);
      },
    });
    const proxied = { ...mesh, attributes: { ...mesh.attributes, position: proxy } };
    read.mockClear();
    expect(skinPosedBounds(proxied, pose, world, cache)).toEqual(
      skinPosedBounds(proxied, pose, world),
    );
    expect(read).not.toHaveBeenCalled();
    const metadata = vi.fn(() => {
      throw Error('unexpected metadata getter');
    });
    Object.defineProperty(positions, 'buffer', { get: metadata });
    Object.defineProperty(positions, 'byteOffset', { get: metadata });
    Object.defineProperty(positions, 'byteLength', { get: metadata });
    expect(skinPosedBounds(mesh, pose, world, cache)).toEqual(skinPosedBounds(mesh, pose, world));
    expect(metadata).not.toHaveBeenCalled();
  });

  it('bounds owner memory to 32 identities per World and separates World lifetimes', () => {
    const first = new World(),
      second = new World();
    const original = skinPosedBoundsCache(first, 'skin-0');
    expect(skinPosedBoundsCache(first, 'skin-0')).toBe(original);
    expect(skinPosedBoundsCache(second, 'skin-0')).not.toBe(original);
    for (let index = 1; index <= 32; index++) skinPosedBoundsCache(first, `skin-${index}`);
    expect(skinPosedBoundsCache(first, 'skin-0')).not.toBe(original);
  });
});

describe('opt-in conservative current-joint envelopes', () => {
  function enclosing(actual: Float32Array | undefined, expected: Float32Array | undefined) {
    expect(actual).toBeDefined();
    expect(expected).toBeDefined();
    if (!actual || !expected) throw Error('missing finite enclosure');
    for (let axis = 0; axis < 3; axis++) {
      expect(actual[axis]).toBeLessThanOrEqual(expected[axis] as number);
      expect(actual[axis + 3]).toBeGreaterThanOrEqual(expected[axis + 3] as number);
    }
  }

  it('encloses raw and normalized positions with moving affine joints and mesh roots', () => {
    const { mesh, pose, world, second } = fixture();
    const cache = new SkinPosedBoundsCache();
    for (let frame = 0; frame < 60; frame++) {
      const angle = frame * 0.03;
      second[0] = Math.cos(angle);
      second[2] = -Math.sin(angle);
      second[8] = Math.sin(angle);
      second[10] = Math.cos(angle);
      second[12] = frame * 0.17;
      second[13] = -frame * 0.03;
      world[12] = frame * 0.11;
      world[14] = -frame * 0.07;
      enclosing(
        skinPosedBounds(mesh, pose, world, cache, true),
        skinPosedBounds(mesh, pose, world),
      );
    }
    (mesh.attributes.skinWeight as Float32Array)[0] = 0.5;
    enclosing(skinPosedBounds(mesh, pose, world, cache, true), skinPosedBounds(mesh, pose, world));
    const bind = pose.inverseBindMatrices[1];
    if (!bind) throw Error('missing inverse bind');
    bind[12] = -3;
    enclosing(skinPosedBounds(mesh, pose, world, cache, true), skinPosedBounds(mesh, pose, world));
    (pose.inverseBindMatrices as Float32Array[])[1] = mat4.identity(mat4.create());
    enclosing(skinPosedBounds(mesh, pose, world, cache, true), skinPosedBounds(mesh, pose, world));
  });

  it('revalidates full public geometry content and never exposes its private input snapshot', () => {
    const { mesh, pose, world } = fixture();
    const cache = new SkinPosedBoundsCache();
    const read = () => skinPosedBounds(mesh, pose, world, cache, true);
    const first = read();
    for (const field of ['position', 'skinIndex', 'skinWeight'] as const) {
      const data = mesh.attributes[field] as Float32Array | Uint16Array;
      data[0] = field === 'position' ? -100 : field === 'skinIndex' ? 1 : 0.8;
      enclosing(read(), skinPosedBounds(mesh, pose, world));
    }
    const result = read();
    result?.fill(999);
    enclosing(read(), skinPosedBounds(mesh, pose, world));
    expect(first).not.toEqual(result);
    (mesh.attributes.position as Float32Array)[0] = NaN;
    expect(read()).toBeUndefined();
  });

  it('falls back exactly for signed weights, projective palettes and shared geometry', () => {
    const { mesh, pose, world, second } = fixture();
    const cache = new SkinPosedBoundsCache();
    const read = () => skinPosedBounds(mesh, pose, world, cache, true);
    read();
    second[15] = 2;
    expect(read()).toEqual(skinPosedBounds(mesh, pose, world));
    second[15] = 1;
    (mesh.attributes.skinWeight as Float32Array)[0] = -0.1;
    expect(read()).toEqual(skinPosedBounds(mesh, pose, world));
    (mesh.attributes.skinWeight as Float32Array)[0] = 0.25;
    for (const field of ['position', 'skinIndex', 'skinWeight'] as const) {
      const current = mesh.attributes[field] as Float32Array | Uint16Array;
      const buffer = new SharedArrayBuffer(current.byteLength);
      const sharedValues =
        field === 'skinIndex' ? new Uint16Array(buffer) : new Float32Array(buffer);
      sharedValues.set(current);
      const shared = { ...mesh, attributes: { ...mesh.attributes, [field]: sharedValues } };
      for (let frame = 0; frame < 3; frame++) {
        sharedValues[0] = field === 'skinIndex' ? frame % 2 : frame * 0.3;
        expect(skinPosedBounds(shared, pose, world, cache, true)).toEqual(
          skinPosedBounds(shared, pose, world),
        );
      }
    }
  });

  it('preserves zero-weight lane validation, singular transforms and getter observations', () => {
    const { mesh, pose, world } = fixture();
    const cache = new SkinPosedBoundsCache();
    skinPosedBounds(mesh, pose, world, cache, true);
    (mesh.attributes.skinIndex as Uint16Array)[2] = 2;
    expect(skinPosedBounds(mesh, pose, world, cache, true)).toBeUndefined();
    (mesh.attributes.skinIndex as Uint16Array)[2] = 0;
    world[0] = 0;
    expect(skinPosedBounds(mesh, pose, world, cache, true)).toBeUndefined();
    mat4.identity(world);
    const attributes = mesh.attributes;
    let reads = 0;
    Object.defineProperty(mesh, 'attributes', {
      get() {
        reads++;
        return attributes;
      },
    });
    skinPosedBounds(mesh, pose, world, cache, true);
    expect(reads).toBe(3);
  });

  it('contains exact bounds across finite affine scales, cancellation and nonunit sums', () => {
    const { mesh, pose, world, second } = fixture();
    const cache = new SkinPosedBoundsCache();
    let seed = 1923;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 2 ** 32;
    };
    for (let sample = 0; sample < 128; sample++) {
      for (const matrix of pose.jointWorlds) {
        for (let column = 0; column < 4; column++) {
          for (let row = 0; row < 3; row++) matrix[column * 4 + row] = (random() - 0.5) * 30;
        }
      }
      second[12] = sample % 2 === 0 ? 1e7 : -1e7;
      world[0] = 0.5 + random() * 3;
      world[5] = 0.5 + random() * 3;
      world[10] = 0.5 + random() * 3;
      world[12] = (random() - 0.5) * 100;
      const weights = mesh.attributes.skinWeight as Float32Array;
      weights[0] = random() * 2;
      weights[1] = random() * 2;
      const conservative = skinPosedBounds(mesh, pose, world, cache, true);
      enclosing(conservative, skinPosedBounds(mesh, pose, world));
      if (!conservative) throw Error('missing local enclosure');
      enclosing(
        box3.transformBox3(box3.create(), conservative, world),
        skinPosedBounds(mesh, pose, mat4.identity(mat4.create())),
      );
    }
  });
});
