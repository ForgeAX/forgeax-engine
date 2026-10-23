import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createTorusGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import {
  attachBarrelDistortionCameraFrame,
  createBarrelDistortionMapping,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  computeDisplayScreenRay,
  displayToScenePixel,
  pickDisplay,
  pickTriangleDisplay,
  pickVertexDisplay,
  pickVertexOnEntityDisplay,
} from '../display-picking';

describe('display picking frame authority', () => {
  it('picks through a hollow foreground mesh to the nearest rear triangle', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const torus = assets.create(createTorusGeometry(1, 0.25, 24, 12).unwrap()).unwrap();
    const box = assets.create(createBoxGeometry(0.8, 0.8, 0.8).unwrap()).unwrap();
    const ringEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: torus } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    const cubeEntity = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -2] } },
        { component: MeshFilter, data: { assetHandle: box } },
        { component: MeshRenderer, data: { materials: [] } },
      )
      .unwrap();
    propagateTransforms(world);

    const viewMatrix = mat4.identity(mat4.create());
    viewMatrix[14] = -5;
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(64, 64, { strength: 0 }).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix,
        projectionMatrix: mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 1, 0.1, 100),
      },
    );

    expect(pickDisplay(world, 32, 32, mapping, 64, 64)?.entity).toBe(ringEntity);
    const result = pickTriangleDisplay(world, 32, 32, mapping, 64, 64);
    expect(result.status).toBe('hit');
    if (result.status !== 'hit') return;
    expect(result.hit.entity).toBe(cubeEntity);
    expect(result.hit.precision).toBe('triangle');
  });

  it('constructs the identity display ray without a live World', () => {
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(640, 360, undefined).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix: mat4.create(),
        projectionMatrix: mat4.create(),
      },
    );
    const ray = computeDisplayScreenRay(320, 180, mapping, 640, 360);
    expect(ray).toBeDefined();
  });

  it('uses the submitted camera matrices for the display ray', () => {
    const viewMatrix = mat4.create();
    viewMatrix[12] = -0.5;
    const projectionMatrix = mat4.create();
    projectionMatrix[0] = 0.75;
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(64, 64, undefined).unwrap(),
      {
        projection: 'orthographic',
        far: 100,
        viewMatrix,
        projectionMatrix,
      },
    );
    const ray = computeDisplayScreenRay(32, 32, mapping, 64, 64);
    expect(ray).toBeDefined();
    if (ray === undefined) return;
    expect(Array.from(ray.view)).toEqual(Array.from(viewMatrix));
    expect(Array.from(ray.proj)).toEqual(Array.from(projectionMatrix));
  });

  it('rejects a display query without an accepted frame context', () => {
    expect(computeDisplayScreenRay(10, 10, undefined, 640, 360)).toBeUndefined();
  });

  it('rejects a viewport that disagrees with the submitted mapping extent', () => {
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(640, 360, undefined).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix: mat4.create(),
        projectionMatrix: mat4.create(),
      },
    );
    expect(computeDisplayScreenRay(640, 360, mapping, 1280, 720)).toBeUndefined();
    const out = { x: 0, y: 0 };
    expect(displayToScenePixel(out, undefined, 10, 10)).toBe(false);
  });

  it('uses caller-normalized DPR and embedded offsets while rejecting crop misses', () => {
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(640, 360, undefined).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix: mat4.create(),
        projectionMatrix: mat4.create(),
      },
    );
    const embeddedOffset = { left: 37, top: 19 };
    const devicePixelRatio = 2;
    const cssPoint = { x: embeddedOffset.left + 160, y: embeddedOffset.top + 90 };
    const submittedPixel = {
      x: (cssPoint.x - embeddedOffset.left) * devicePixelRatio,
      y: (cssPoint.y - embeddedOffset.top) * devicePixelRatio,
    };

    // Offset/DPR normalization belongs to the host display adapter. The
    // public picking API consumes the resulting physical pixel against the
    // accepted submitted extent.
    expect(
      computeDisplayScreenRay(submittedPixel.x, submittedPixel.y, mapping, 640, 360),
    ).toBeDefined();
    expect(computeDisplayScreenRay(-1, submittedPixel.y, mapping, 640, 360)).toBeUndefined();
    expect(computeDisplayScreenRay(640, submittedPixel.y, mapping, 640, 360)).toBeDefined();
    expect(computeDisplayScreenRay(641, submittedPixel.y, mapping, 640, 360)).toBeUndefined();
    // A DPR-sized viewport is a different submitted extent and must fail
    // closed instead of silently selecting a second display mapping.
    expect(
      computeDisplayScreenRay(submittedPixel.x, submittedPixel.y, mapping, 1280, 720),
    ).toBeUndefined();
  });

  it('fails closed for omitted display context across every display entrypoint', () => {
    const world = {
      get: () => {
        throw new Error('missing frame context must not consult World');
      },
    } as unknown as World;
    expect(pickDisplay(world, 10, 10, undefined, 640, 360)).toBeUndefined();
    expect(pickTriangleDisplay(world, 10, 10, undefined, 640, 360)).toMatchObject({
      status: 'miss',
      precision: 'triangle',
    });
    expect(pickVertexDisplay(world, 10, 10, undefined, 640, 360)).toBeUndefined();
    expect(
      pickVertexOnEntityDisplay(world, 10, 10, undefined, 640, 360, 18 as never),
    ).toBeUndefined();
  });
});

describe('display vertex selection', () => {
  it('remaps all and single-entity hits before radius and limit selection', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices: positions,
      attributes: { position: positions },
      indices: new Uint16Array([0, 1, 2]),
      aabb: new Float32Array([-0.5, -0.5, 0, 0.5, 0.5, 0]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'Default' }],
    };
    const material: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    };
    const meshHandle = assets.create(mesh).unwrap();
    const materialHandle = assets.create(material).unwrap();
    const entities = [0, -1].map((z) =>
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, z] } },
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          { component: MeshRenderer, data: { materials: [materialHandle] } },
        )
        .unwrap(),
    );
    propagateTransforms(world);
    const view = mat4.identity(mat4.create());
    view[14] = -5;
    const mapping = attachBarrelDistortionCameraFrame(
      createBarrelDistortionMapping(600, 600, {
        strength: 0.2,
        centerX: 0.5,
        centerY: 0.5,
      }).unwrap(),
      {
        projection: 'perspective',
        far: 100,
        viewMatrix: view,
        projectionMatrix: mat4.perspectiveReverseZ(mat4.create(), Math.PI / 4, 1, 0.1, 100),
      },
    );
    const all = pickVertexDisplay(world, 300, 300, mapping, 600, 600, {});
    expect(Array.isArray(all)).toBe(true);
    if (!Array.isArray(all)) throw new Error('Expected vertex array');
    expect(all).toHaveLength(6);
    expect(pickVertexDisplay(world, 300, 300, mapping, 600, 600)).toEqual(all[0]);
    expect(pickVertexDisplay(world, 300, 300, mapping, 600, 600, { limit: 1 })).toEqual(
      all.slice(0, 1),
    );
    const entity = entities[0];
    if (entity === undefined) throw new Error('Expected mesh entity');
    const selected = pickVertexOnEntityDisplay(world, 300, 300, mapping, 600, 600, entity, {});
    expect(selected).toEqual(all.filter((hit) => hit.entity === entity));
    expect(
      pickVertexOnEntityDisplay(world, 300, 300, mapping, 600, 600, entity, {
        radius: 1,
      }),
    ).toEqual([]);
    expect(pickVertexDisplay(world, 300, 300, mapping, 600, 600, { radius: NaN })).toEqual([]);
  });
});
