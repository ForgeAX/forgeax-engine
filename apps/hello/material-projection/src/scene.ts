import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createSphereGeometry,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';

/**
 * `projection` is the reference scene. Every other mode swaps one feature
 * for its nearest non-feature so exactly one smoke gate must fail:
 * - `uv`: the boxes sample their (zeroed) mesh UVs instead of triplanar planes
 * - `world`: the object-space boxes project in world space
 * - `tangent`: the object-space normal map is decoded as a tangent-space map
 * - `standard`: the Lambert sphere is a specular Standard sphere
 * - `unlit`: matcap and normal spheres become plain textured/white unlit
 */
export type ProjectionMode = 'projection' | 'uv' | 'world' | 'tangent' | 'standard' | 'unlit';

/** Material under test for the performance grid; every lane shares one mesh. */
export type ProjectionGridLane =
  | 'standard-uv'
  | 'standard-triplanar'
  | 'standard-object-normal'
  | 'lambert'
  | 'unlit'
  | 'matcap'
  | 'normal';

export interface ProjectionOptions {
  readonly mode?: ProjectionMode;
  /** Spheres per row of a full-screen performance grid; replaces the reference scene. */
  readonly grid?: number;
  readonly gridLane?: ProjectionGridLane;
}

export const WIDTH = 480;
export const HEIGHT = 270;
/** Orthographic scale: world units map to pixels without perspective drift. */
export const PIXELS_PER_UNIT = 40;
const HALF_WIDTH = WIDTH / 2 / PIXELS_PER_UNIT;
const HALF_HEIGHT = HEIGHT / 2 / PIXELS_PER_UNIT;

export const TOP_Y = 1.5;
export const BOTTOM_Y = -1.5;
/**
 * World-projected pair: B is offset by 4.5 checker cells in x and 1.5 in z,
 * a half-cell shift on every projection plane. The object-projected pair has
 * the same offset but must render identically.
 */
export const BOX_OFFSET: readonly [number, number, number] = [2.25, 0, 0.75];
export const BOX_X = { worldA: -4.8, objectA: -0.3 } as const;
export const OBJECT_NORMAL_X = 4.4;
export const SPHERE_X = { standard: -4.2, lambert: -1.4, matcap: 1.4, normal: 4.2 } as const;
export const SPHERE_RADIUS = 0.8;
export const BOX_SIZE = 0.9;

/** Screen pixel of a world point under the reference orthographic camera. */
export function toPixel(x: number, y: number): [number, number] {
  return [WIDTH / 2 + x * PIXELS_PER_UNIT, HEIGHT / 2 - y * PIXELS_PER_UNIT];
}

function rgbaTexture(
  size: number,
  colorSpace: 'srgb' | 'linear',
  texel: (u: number, v: number) => readonly [number, number, number],
): TextureAsset {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = texel((x + 0.5) / size, (y + 0.5) / size);
      data.set([r, g, b, 255], (y * size + x) * 4);
    }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
    data,
    colorSpace,
    mips: { kind: 'none' },
  };
}

/** 2x2-cell checker per repeat: one texture repeat is one world unit at scale 1. */
function checker(): TextureAsset {
  return rgbaTexture(64, 'srgb', (u, v) =>
    (u < 0.5) === (v < 0.5) ? [236, 150, 52] : [36, 72, 150],
  );
}

/** Tangent-space dimples from h = sin(2 pi 2u) sin(2 pi 2v). */
function dimpleNormals(): TextureAsset {
  const k = 2 * Math.PI * 2;
  return rgbaTexture(64, 'linear', (u, v) => {
    const dx = -0.35 * Math.cos(k * u) * Math.sin(k * v);
    const dy = -0.35 * Math.sin(k * u) * Math.cos(k * v);
    const length = Math.hypot(dx, dy, 1);
    return [dx, dy, 1 / length].map((c, i) =>
      Math.round(((i < 2 ? c / length : c) * 0.5 + 0.5) * 255),
    ) as unknown as readonly [number, number, number];
  });
}

/** Constant object-space +X normal: every texel encodes (1, 0, 0). */
function objectPlusX(): TextureAsset {
  return rgbaTexture(4, 'linear', () => [255, 128, 128]);
}

/**
 * Matcap sphere image: red toward view-left, blue toward view-right, green
 * toward view-up, dimmed toward the rim so the center reads brightest.
 */
function matcapImage(): TextureAsset {
  return rgbaTexture(64, 'srgb', (u, v) => {
    const x = u * 2 - 1;
    const y = 1 - v * 2;
    const rim = Math.max(0, 1 - 0.6 * Math.min(1, x * x + y * y));
    const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255 * rim);
    return [channel(0.55 - 0.45 * x), channel(0.35 + 0.45 * y), channel(0.55 + 0.45 * x)];
  });
}

/** The box keeps positions and normals but every UV is zero: only projection can map it. */
function withoutUvs(mesh: MeshAsset): MeshAsset {
  const position = mesh.attributes.position;
  if (!(position instanceof Float32Array)) throw new Error('material-projection: box has no position');
  const vertexCount = position.length / 3;
  const attributes = { ...mesh.attributes, uv: new Float32Array(vertexCount * 2) };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) throw new Error(`material-projection: repack failed: ${packed.error.code}`);
  return { ...mesh, attributes, vertices: packed.value.vertices };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`material-projection: geometry failed: ${result.error.code}`);
  return result.value;
}

/** Swaps every grid sphere to one lane's material; materials are cached per lane. */
export type SetGridLane = (lane: ProjectionGridLane) => void;

export function buildProjectionWorld(world: World, options: ProjectionOptions = {}): SetGridLane | undefined {
  const mode = options.mode ?? 'projection';
  const material = (asset: MaterialAsset) =>
    world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', asset);
  const texture = (asset: TextureAsset) => world.allocSharedRef('TextureAsset', asset);
  const sampler = world.allocSharedRef('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  const bound = (handle: number) => ({ texture: handle, sampler });
  const checkerTexture = bound(texture(checker()));
  const dimpleTexture = bound(texture(dimpleNormals()));
  const sphereMesh = world.allocSharedRef('MeshAsset', unwrap(createSphereGeometry(1, 48, 32)));
  const spawn = (
    pos: readonly [number, number, number],
    mesh: number,
    materialHandle: number,
    rotation = quat.create(),
    scale: readonly [number, number, number] = [1, 1, 1],
  ) =>
    world
      .spawn(
        { component: Transform, data: { pos: [...pos], quat: [...rotation], scale: [...scale] } },
        { component: MeshFilter, data: { assetHandle: mesh as never } },
        { component: MeshRenderer, data: { materials: [materialHandle as never] } },
      )
      .unwrap();

  const grid = options.grid ?? 0;
  let setGridLane: SetGridLane | undefined;
  if (grid > 0) {
    const laneMaterials = new Map<ProjectionGridLane, number>();
    const laneMaterial = (lane: ProjectionGridLane) => {
      let handle = laneMaterials.get(lane);
      if (handle === undefined) {
        handle = material(gridMaterial(lane, checkerTexture, dimpleTexture));
        laneMaterials.set(lane, handle);
      }
      return handle;
    };
    const initial = laneMaterial(options.gridLane ?? 'standard-uv');
    const cell = (2 * HALF_WIDTH) / grid;
    const rows = Math.ceil((2 * HALF_HEIGHT) / cell);
    const radius = cell * 0.55;
    const spheres: EntityHandle[] = [];
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < grid; column += 1)
        spheres.push(
          spawn(
            [-HALF_WIDTH + (column + 0.5) * cell, -HALF_HEIGHT + (row + 0.5) * cell, 0],
            sphereMesh,
            initial,
            quat.create(),
            [radius, radius, radius],
          ),
        );
    setGridLane = (lane) => {
      const handle = laneMaterial(lane);
      for (const sphere of spheres)
        world.set(sphere, MeshRenderer, { materials: [handle as never] }).unwrap();
    };
  } else {
    buildReferenceScene(world, mode, {
      material,
      texture,
      bound,
      spawn,
      checkerTexture,
      dimpleTexture,
      sphereMesh,
    });
  }

  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0.45, -0.55, -0.7], color: [1, 0.98, 0.94], intensity: 2.2 },
    })
    .unwrap();
  const eye: [number, number, number] = [0, 0, 10];
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: eye,
          quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
          scale: [1, 1, 1],
        },
      },
      {
        component: Camera,
        data: orthographic({
          left: -HALF_WIDTH,
          right: HALF_WIDTH,
          bottom: -HALF_HEIGHT,
          top: HALF_HEIGHT,
          near: 0.1,
          far: 30,
        }),
      },
    )
    .unwrap();
  return setGridLane;
}

type TextureValue = { texture: number; sampler: number };

interface SceneKit {
  readonly material: (asset: MaterialAsset) => number;
  readonly texture: (asset: TextureAsset) => number;
  readonly bound: (handle: number) => TextureValue;
  readonly spawn: (
    pos: readonly [number, number, number],
    mesh: number,
    material: number,
    rotation?: ReturnType<typeof quat.create>,
    scale?: readonly [number, number, number],
  ) => unknown;
  readonly checkerTexture: TextureValue;
  readonly dimpleTexture: TextureValue;
  readonly sphereMesh: number;
}

function buildReferenceScene(world: World, mode: ProjectionMode, kit: SceneKit): void {
  const { material, texture, bound, spawn, checkerTexture, dimpleTexture, sphereMesh } = kit;
  const boxMesh = world.allocSharedRef(
    'MeshAsset',
    withoutUvs(unwrap(createBoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE))),
  );
  const boxSurface = {
    baseColor: [1, 1, 1, 1] as const,
    metallic: 0,
    roughness: 0.55,
    baseColorTexture: checkerTexture,
    normalTexture: dimpleTexture,
  };
  const worldBoxes = material(
    Materials.standard({
      ...boxSurface,
      ...(mode === 'uv' ? {} : { triplanar: { space: 'world', sharpness: 4 } }),
    }),
  );
  const objectBoxes = material(
    Materials.standard({
      ...boxSurface,
      ...(mode === 'uv'
        ? {}
        : { triplanar: { space: mode === 'world' ? 'world' : 'object', sharpness: 4 } }),
    }),
  );
  const tilt = quat.fromEuler(quat.create(), 0.45, 0.6, 0, 'XYZ');
  const offset = (x: number): [number, number, number] => [
    x + BOX_OFFSET[0],
    TOP_Y + BOX_OFFSET[1],
    BOX_OFFSET[2],
  ];
  spawn([BOX_X.worldA, TOP_Y, 0], boxMesh, worldBoxes, tilt);
  spawn(offset(BOX_X.worldA), boxMesh, worldBoxes, tilt);
  spawn([BOX_X.objectA, TOP_Y, 0], boxMesh, objectBoxes, tilt);
  spawn(offset(BOX_X.objectA), boxMesh, objectBoxes, tilt);

  // Object +X faces the camera after a -90 degree yaw; the non-uniform scale
  // exercises the cofactor normal transform. A correct decode is flat-lit.
  spawn(
    [OBJECT_NORMAL_X, TOP_Y, 0],
    sphereMesh,
    material(
      Materials.standard({
        baseColor: [0.85, 0.85, 0.85, 1],
        metallic: 0,
        roughness: 1,
        specular: 0,
        normalTexture: bound(texture(objectPlusX())),
        ...(mode === 'tangent' ? {} : { normalMapSpace: 'object' }),
      }),
    ),
    quat.fromAxisAngle(quat.create(), [0, 1, 0], -Math.PI / 2),
    [SPHERE_RADIUS, SPHERE_RADIUS * 1.1, SPHERE_RADIUS * 0.8],
  );

  const sphereScale: [number, number, number] = [SPHERE_RADIUS, SPHERE_RADIUS, SPHERE_RADIUS];
  const sphereAt = (x: number, handle: number) =>
    spawn([x, BOTTOM_Y, 0], sphereMesh, handle, quat.create(), sphereScale);
  const clay = { baseColor: [0.75, 0.32, 0.22, 1] as const };
  sphereAt(SPHERE_X.standard, material(Materials.standard({ ...clay, metallic: 0, roughness: 0.25 })));
  sphereAt(
    SPHERE_X.lambert,
    material(
      mode === 'standard'
        ? Materials.standard({ ...clay, metallic: 0, roughness: 0.25 })
        : Materials.lambert(clay),
    ),
  );
  const matcapTexture = bound(texture(matcapImage()));
  sphereAt(
    SPHERE_X.matcap,
    material(
      mode === 'unlit'
        ? Materials.unlit([1, 1, 1, 1], { baseColorTexture: matcapTexture })
        : Materials.matcap(matcapTexture),
    ),
  );
  sphereAt(
    SPHERE_X.normal,
    material(mode === 'unlit' ? Materials.unlit([1, 1, 1, 1]) : Materials.normal()),
  );
}

function gridMaterial(
  lane: ProjectionGridLane,
  checkerTexture: TextureValue,
  dimpleTexture: TextureValue,
): MaterialAsset {
  const surface = {
    baseColor: [1, 1, 1, 1] as const,
    metallic: 0,
    roughness: 0.55,
    baseColorTexture: checkerTexture,
    normalTexture: dimpleTexture,
  };
  switch (lane) {
    case 'standard-uv':
      return Materials.standard(surface);
    case 'standard-triplanar':
      return Materials.standard({ ...surface, triplanar: { space: 'world', sharpness: 4 } });
    case 'standard-object-normal':
      return Materials.standard({ ...surface, normalMapSpace: 'object' });
    case 'lambert':
      return Materials.lambert({
        baseColor: [1, 1, 1, 1],
        baseColorTexture: checkerTexture,
        normalTexture: dimpleTexture,
      });
    case 'unlit':
      return Materials.unlit([1, 1, 1, 1], { baseColorTexture: checkerTexture });
    case 'matcap':
      return Materials.matcap(checkerTexture);
    case 'normal':
      return Materials.normal();
  }
}
