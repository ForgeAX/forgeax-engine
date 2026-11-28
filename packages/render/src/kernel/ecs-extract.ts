// Pure ECS World -> KernelStandardFrameInput extractor for `@forgeax/engine-render`.
// Reads canonical ECS components (`Camera`, `Transform`, `GlobalTransform`, `MeshFilter`,
// `MeshRenderer`, `DirectionalLight`, `PointLight`, `SpotLight`, `Skylight`, `Fog`,
// `ShadowParticipation`, `Visibility`) without mutating the source World.

import type { World } from '@forgeax/engine-ecs';
import {
  type KernelStandardCameraInput,
  type KernelStandardFogInput,
  type KernelStandardFrameInput,
  type KernelStandardLightInput,
  type KernelStandardRenderObjectInput,
  type KernelStandardSkyboxInput,
  type KernelStandardSkylightInput,
  type KernelTonemapMode,
  kernelMat4Invert,
  kernelMat4Multiply,
  kernelMat4Ortho,
  kernelMat4Perspective,
} from '@forgeax/engine-render-kernel';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_MSAA_FXAA,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
} from '../components/camera';
import { DirectionalLight } from '../components/directional-light';
import { Fog, FogModeValue } from '../components/fog';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { PointLight } from '../components/point-light';
import { ShadowParticipation } from '../components/shadow-participation';
import { Skylight } from '../components/skylight';
import { SpotLight } from '../components/spot-light';
import { Visibility, VisibilityStateValue } from '../components/visibility';

export interface ExtractWorldToKernelOptions {
  readonly width: number;
  readonly height: number;
  readonly skybox?: KernelStandardSkyboxInput | undefined;
  readonly readbackTicketId?: number | undefined;
  readonly userData?: unknown;
  /** Fallback clear color when no Camera entity overrides it. */
  readonly defaultClearColor?: readonly [number, number, number, number] | undefined;
}

function isIdentityMat4(m: ArrayLike<number>): boolean {
  return (
    m[0] === 1 &&
    m[5] === 1 &&
    m[10] === 1 &&
    m[15] === 1 &&
    m[12] === 0 &&
    m[13] === 0 &&
    m[14] === 0 &&
    m[1] === 0 &&
    m[2] === 0 &&
    m[4] === 0 &&
    m[6] === 0 &&
    m[8] === 0 &&
    m[9] === 0
  );
}

function composeTrsMat4(
  pos: ArrayLike<number>,
  quat: ArrayLike<number>,
  scale: ArrayLike<number>,
  out: Float32Array,
): Float32Array {
  const x = quat[0] ?? 0;
  const y = quat[1] ?? 0;
  const z = quat[2] ?? 0;
  const w = quat[3] ?? 1;
  const sx = scale[0] ?? 1;
  const sy = scale[1] ?? 1;
  const sz = scale[2] ?? 1;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = pos[0] ?? 0;
  out[13] = pos[1] ?? 0;
  out[14] = pos[2] ?? 0;
  out[15] = 1;
  return out;
}

function resolvePoseMatrix(
  gt: { readonly world?: Float32Array | ArrayLike<number> | undefined } | undefined,
  t:
    | {
        readonly pos: ArrayLike<number>;
        readonly quat: ArrayLike<number>;
        readonly scale: ArrayLike<number>;
      }
    | undefined,
): Float32Array {
  const out = new Float32Array(16);
  if (gt?.world !== undefined && !isIdentityMat4(gt.world)) {
    for (let i = 0; i < 16; i++) out[i] = gt.world[i] ?? 0;
    return out;
  }
  if (t !== undefined) {
    return composeTrsMat4(t.pos, t.quat, t.scale, out);
  }
  if (gt?.world !== undefined) {
    for (let i = 0; i < 16; i++) out[i] = gt.world[i] ?? 0;
    return out;
  }
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

function mapCameraTonemap(code: number): KernelTonemapMode {
  if (code === TONEMAP_AGX) return 'agx';
  if (code === TONEMAP_REINHARD || code === TONEMAP_REINHARD_EXTENDED) return 'reinhard';
  if (code === TONEMAP_NEUTRAL) return 'neutral';
  if (code === TONEMAP_NONE || code === TONEMAP_LINEAR) return 'none';
  if (code === TONEMAP_ACES_FILMIC) return 'aces';
  return 'aces';
}

function extractCamera(
  world: World,
  width: number,
  height: number,
  defaultClearColor: readonly [number, number, number, number],
): KernelStandardCameraInput {
  const aspect = Math.max(width, 1) / Math.max(height, 1);
  let selected: KernelStandardCameraInput | undefined;
  const q = world.query({ read: [Camera], optional: [Transform, GlobalTransform] });
  if (q.ok) {
    q.value.forEach((row) => {
      if (selected !== undefined) return;
      const cam = row.get(Camera);
      const camWorld = resolvePoseMatrix(row.get(GlobalTransform), row.get(Transform));
      const view = kernelMat4Invert(camWorld, new Float32Array(16));
      const proj = new Float32Array(16);
      if (cam.projection === CAMERA_PROJECTION_ORTHOGRAPHIC) {
        kernelMat4Ortho(cam.left, cam.right, cam.bottom, cam.top, cam.near, cam.far, proj);
      } else {
        const fovRad = cam.fov > 0 ? cam.fov : (60 * Math.PI) / 180;
        const camAspect = cam.aspect > 0 ? cam.aspect : aspect;
        kernelMat4Perspective(
          fovRad,
          camAspect,
          Math.max(0.01, cam.near),
          Math.max(cam.far, 1),
          proj,
        );
      }
      const viewProj = kernelMat4Multiply(proj, view, new Float32Array(16));
      const cc = cam.clearColor;
      const clearColor: readonly [number, number, number, number] =
        cc !== undefined && cc.length >= 4
          ? [cc[0] ?? 0, cc[1] ?? 0, cc[2] ?? 0, cc[3] ?? 1]
          : defaultClearColor;
      const fxaa =
        cam.postProcessing !== false &&
        (cam.antialias === ANTIALIAS_FXAA || cam.antialias === ANTIALIAS_MSAA_FXAA);
      const bloomEnabled = cam.postProcessing !== false && cam.bloom === BLOOM_ENABLED;
      selected = {
        viewProj,
        position: [camWorld[12] ?? 0, camWorld[13] ?? 0, camWorld[14] ?? 0],
        clearColor,
        exposure: cam.exposure > 0 ? cam.exposure : 1.0,
        tonemap: mapCameraTonemap(cam.tonemap),
        cullMask: cam.cullMask >>> 0 || 0xffff_ffff,
        ...(bloomEnabled
          ? {
              bloom: {
                enabled: true,
                threshold: cam.bloomThreshold,
                intensity: cam.bloomIntensity,
              },
            }
          : {}),
        fxaa,
      };
    });
  }
  if (selected !== undefined) return selected;
  const fallbackProj = kernelMat4Perspective(
    (60 * Math.PI) / 180,
    aspect,
    0.1,
    1000,
    new Float32Array(16),
  );
  return {
    viewProj: fallbackProj,
    position: [0, 0, 5],
    clearColor: defaultClearColor,
    exposure: 1.0,
    tonemap: 'aces',
  };
}

function extractLights(world: World): readonly KernelStandardLightInput[] {
  const lights: KernelStandardLightInput[] = [];
  let nextId = 1;

  const dirQ = world.query({ read: [DirectionalLight] });
  if (dirQ.ok) {
    dirQ.value.forEach((row) => {
      const dl = row.get(DirectionalLight);
      lights.push({
        id: nextId++,
        kind: 'directional',
        direction: [dl.direction[0] ?? 0, dl.direction[1] ?? -1, dl.direction[2] ?? 0],
        color: [dl.color[0] ?? 1, dl.color[1] ?? 1, dl.color[2] ?? 1],
        intensity: dl.intensity,
        castShadow: dl.castShadow === true,
        cascadeCount: Math.max(1, Math.min(4, Math.round(dl.cascadeCount || 1))),
        shadowDistance: dl.shadowDistance > 0 ? dl.shadowDistance : 24,
      });
    });
  }

  const pointQ = world.query({ read: [PointLight, Transform], optional: [GlobalTransform] });
  if (pointQ.ok) {
    pointQ.value.forEach((row) => {
      const pl = row.get(PointLight);
      const mat = resolvePoseMatrix(row.get(GlobalTransform), row.get(Transform));
      lights.push({
        id: nextId++,
        kind: 'point',
        position: [mat[12] ?? 0, mat[13] ?? 0, mat[14] ?? 0],
        color: [pl.color[0] ?? 1, pl.color[1] ?? 1, pl.color[2] ?? 1],
        intensity: pl.intensity,
        range: Number.isFinite(pl.range) && pl.range > 0 ? pl.range : 1e9,
      });
    });
  }

  const spotQ = world.query({ read: [SpotLight, Transform], optional: [GlobalTransform] });
  if (spotQ.ok) {
    spotQ.value.forEach((row) => {
      const sl = row.get(SpotLight);
      const mat = resolvePoseMatrix(row.get(GlobalTransform), row.get(Transform));
      const outerDeg = Number.isFinite(sl.outerConeDeg) ? sl.outerConeDeg : 60;
      lights.push({
        id: nextId++,
        kind: 'spot',
        position: [mat[12] ?? 0, mat[13] ?? 0, mat[14] ?? 0],
        direction: [sl.direction[0] ?? 0, sl.direction[1] ?? -1, sl.direction[2] ?? 0],
        color: [sl.color[0] ?? 1, sl.color[1] ?? 1, sl.color[2] ?? 1],
        intensity: sl.intensity,
        range: Number.isFinite(sl.range) && sl.range > 0 ? sl.range : 1e9,
        outerConeCos: Math.cos((outerDeg * Math.PI) / 180),
      });
    });
  }

  return lights;
}

function extractSkylight(world: World): KernelStandardSkylightInput | undefined {
  let out: KernelStandardSkylightInput | undefined;
  const q = world.query({ read: [Skylight] });
  if (q.ok) {
    q.value.forEach((row) => {
      if (out !== undefined) return;
      const sky = row.get(Skylight);
      const gc = sky.groundColor;
      const hasGround =
        gc !== undefined && ((gc[0] ?? 0) > 0 || (gc[1] ?? 0) > 0 || (gc[2] ?? 0) > 0);
      out = {
        skyColor: [sky.color[0] ?? 1, sky.color[1] ?? 1, sky.color[2] ?? 1],
        ...(hasGround ? { groundColor: [gc[0] ?? 0, gc[1] ?? 0, gc[2] ?? 0] as const } : {}),
        intensity: sky.intensity,
      };
    });
  }
  return out;
}

function extractFog(world: World): KernelStandardFogInput | undefined {
  let out: KernelStandardFogInput | undefined;
  const q = world.query({ read: [Fog] });
  if (q.ok) {
    q.value.forEach((row) => {
      if (out !== undefined) return;
      const fog = row.get(Fog);
      const mode: KernelStandardFogInput['mode'] =
        fog.mode === FogModeValue.linear
          ? 'linear'
          : fog.mode === FogModeValue.exp2
            ? 'exp2'
            : 'exp';
      out = {
        mode,
        color: [fog.color[0] ?? 0, fog.color[1] ?? 0, fog.color[2] ?? 0],
        density: fog.density,
        heightFalloff: fog.heightFalloff,
        near: fog.near,
        far: fog.far,
        maxOpacity: fog.maxOpacity,
      };
    });
  }
  return out;
}

function extractRenderObjects(world: World): readonly KernelStandardRenderObjectInput[] {
  const objects: KernelStandardRenderObjectInput[] = [];
  const q = world.query({
    read: [MeshFilter, MeshRenderer, Transform],
    optional: [GlobalTransform, Visibility, ShadowParticipation],
  });
  if (!q.ok) return objects;

  q.value.forEach((row) => {
    const filter = row.get(MeshFilter);
    const renderer = row.get(MeshRenderer);
    const vis = row.get(Visibility);
    if (vis !== undefined && vis.state === VisibilityStateValue.hidden) return;
    const meshKey = Number(filter.assetHandle);
    if (meshKey === 0) return;
    const matHandles = renderer.materials;
    if (matHandles.length === 0) return;
    const shadowPart = row.get(ShadowParticipation);
    const worldMatrix = resolvePoseMatrix(row.get(GlobalTransform), row.get(Transform));
    const castShadow = shadowPart === undefined ? true : shadowPart.cast !== false;
    const receiveShadow = shadowPart === undefined ? true : shadowPart.receive !== false;
    const layerMask = renderer.renderLayers >>> 0 || 1;
    for (let subIdx = 0; subIdx < matHandles.length; subIdx++) {
      const matKey = Number(matHandles[subIdx]);
      if (matKey === 0) continue;
      objects.push({
        entityId: ((Number(row.entity) & 0x00ff_ffff) << 4) | (subIdx & 0xf),
        meshKey,
        submeshIndex: subIdx,
        materialKey: matKey,
        worldMatrix,
        visible: true,
        castShadow,
        receiveShadow,
        frustumCulled: renderer.frustumCulled !== false,
        layerMask,
      });
    }
  });
  return objects;
}

/**
 * Extracts a complete, immutable `KernelStandardFrameInput` from an ECS `World` using canonical
 * `@forgeax/engine-render` and `@forgeax/engine-scene` components.
 */
export function extractWorldToKernelFrame(
  world: World,
  options: ExtractWorldToKernelOptions,
): KernelStandardFrameInput {
  const width = Math.max(1, options.width | 0);
  const height = Math.max(1, options.height | 0);
  const camera = extractCamera(
    world,
    width,
    height,
    options.defaultClearColor ?? [0.05, 0.06, 0.08, 1],
  );
  const lights = extractLights(world);
  const skylight = extractSkylight(world);
  const fog = extractFog(world);
  const objects = extractRenderObjects(world);
  return {
    width,
    height,
    camera,
    ...(skylight === undefined ? {} : { skylight }),
    ...(fog === undefined ? {} : { fog }),
    ...(options.skybox === undefined ? {} : { skybox: options.skybox }),
    lights,
    objects,
    ...(options.readbackTicketId === undefined
      ? {}
      : { readbackTicketId: options.readbackTicketId }),
    ...(options.userData === undefined ? {} : { userData: options.userData }),
  };
}
