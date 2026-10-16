import { createTerrainGrids } from '@forgeax/engine-geometry';
import type {
  Asset,
  MaterialAsset,
  MeshAsset,
  TerrainAsset,
  TerrainSource,
} from '@forgeax/engine-types';
import { resolveMaterialAsset } from '@forgeax/engine-types';
import { cookTerrainIds } from './material-id.js';
import { terrainSampleHeight } from './query.js';
import { terrainTextureGuid } from './texture-binding.js';
import { terrainDerivedLayoutValid } from './validation.js';

/** Preserve the actual maximum without subtract/add cancellation; constant fields retain an encoding span. */
export function terrainHeightRange(min: number, max: number): readonly [number, number] {
  return [min, Math.max(max, min + 1e-6)];
}

/** Shared producer/acceptance encoding; RG is height and BA is the source normal XZ. */
export function terrainHeightTexel(
  source: TerrainSource,
  fx: number,
  fz: number,
  min: number,
  range: number,
): readonly number[] {
  const h = terrainSampleHeight(source, fx, fz);
  if (h === undefined) throw new RangeError('terrain cook sample escaped the author grid');
  const packed = Math.round(Math.max(0, Math.min(1, (h - min) / range)) * 65535);
  const left = Math.max(0, fx - 1),
    right = Math.min(fx + 1, source.columns - 1);
  const top = Math.max(0, fz - 1),
    bottom = Math.min(fz + 1, source.rows - 1);
  const dx =
    ((terrainSampleHeight(source, right, fz) ?? h) - (terrainSampleHeight(source, left, fz) ?? h)) /
    ((right - left) * source.spacing);
  const dz =
    ((terrainSampleHeight(source, fx, bottom) ?? h) - (terrainSampleHeight(source, fx, top) ?? h)) /
    ((bottom - top) * source.spacing);
  const length = Math.hypot(dx, 1, dz);

  return [
    packed >>> 8,
    packed & 255,
    Math.round((0.5 - (dx / length) * 0.5) * 255),
    Math.round((0.5 - (dz / length) * 0.5) * 255),
  ];
}

export function terrainWeightTexel(
  source: TerrainSource,
  activeLayers: readonly number[],
  fx: number,
  fz: number,
): readonly number[] {
  const u = fx,
    v = fz;
  const ix = Math.min(Math.floor(u), source.columns - 2),
    iz = Math.min(Math.floor(v), source.rows - 2);
  const a = u - ix,
    b = v - iz;
  const values = activeLayers.map((l) => {
    const at = (x: number, z: number) =>
      source.weights[((iz + z) * source.columns + ix + x) * source.layers.length + l] ?? 0;
    return Math.round(
      ((at(0, 0) * (1 - a) + at(1, 0) * a) * (1 - b) + (at(0, 1) * (1 - a) + at(1, 1) * a) * b) *
        255,
    );
  });
  const group = activeLayers.flatMap((l, i) => (source.layers[l]?.blend === 'alpha' ? [] : [i]));
  const sum = group.reduce((s, l) => s + (values[l] ?? 0), 0);
  if (sum > 0 && group.length) {
    let largest = group[0] ?? 0;
    for (const l of group) if ((values[l] ?? 0) > (values[largest] ?? 0)) largest = l;
    values[largest] = (values[largest] ?? 0) + 255 - sum;
  }
  return values;
}

/** Validate geometry against author samples before admitting a terrain closure. */
export function terrainDerivedGeometryValid(
  root: TerrainAsset,
  closure: ReadonlyMap<string, Asset>,
): boolean {
  if (!terrainDerivedLayoutValid(root)) return false;
  const ids =
    root.materialEncoding.kind === 'ids'
      ? cookTerrainIds(root, root.materialEncoding.maxWeightError)
      : undefined;
  if (ids && !ids.ok) return false;
  const textures = root.sections.map((section) => closure.get(section.heightTexture.toLowerCase()));
  const controls = root.sections.map((section) => closure.get(section.weightTexture.toLowerCase()));
  const grids = root.grids.map((guid) => closure.get(guid.toLowerCase()));
  if (
    textures.some((asset) => asset?.kind !== 'texture') ||
    controls.some((asset) => asset?.kind !== 'texture') ||
    grids.some((asset) => asset?.kind !== 'mesh')
  )
    return false;
  const materialTable = Object.fromEntries(
    [...closure].filter((row): row is [string, MaterialAsset] => row[1].kind === 'material'),
  );
  for (const section of root.sections) {
    const material = resolveMaterialAsset(section.material, materialTable);
    if (!material.ok) return false;
    const height = material.value.asset.values?.terrainHeightTexture,
      control = material.value.asset.values?.terrainWeightTexture;
    if (
      terrainTextureGuid(height) !== section.heightTexture ||
      (typeof control === 'object' && control !== null && 'texture' in control
        ? control.texture
        : control) !== section.weightTexture
    )
      return false;
  }
  const bytes = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const equalBytes = (
    a: ArrayBuffer | ArrayBufferView | undefined,
    b: ArrayBuffer | ArrayBufferView | undefined,
  ): boolean => {
    if (a === undefined || b === undefined) return a === b;
    const left = bytes(a),
      right = bytes(b);
    return left.length === right.length && left.every((v, i) => v === right[i]);
  };
  const canonical = createTerrainGrids(root.subsectionVertices);
  if (grids.length !== canonical.length) return false;
  for (const [index, expected] of canonical.entries()) {
    const actualAsset = grids[index];
    const actual = actualAsset?.kind === 'mesh' ? actualAsset : undefined;
    if (
      actual === undefined ||
      !(actual.indices instanceof Uint32Array) ||
      !equalBytes(actual.indices, expected.indices) ||
      !equalBytes(actual.vertices, expected.vertices) ||
      !equalBytes(actual.aabb, expected.aabb) ||
      actual.morphTargets?.length
    )
      return false;
    const keys = Object.keys(actual.attributes),
      expectedKeys = Object.keys(expected.attributes);
    if (
      keys.length !== expectedKeys.length ||
      Object.entries(expected.attributes).some(
        ([key, value]) =>
          !equalBytes(actual.attributes[key as keyof MeshAsset['attributes']], value),
      )
    )
      return false;
    if (actual.submeshes.length !== expected.submeshes.length) return false;
    for (const [i, submesh] of expected.submeshes.entries()) {
      const candidate = actual.submeshes[i];
      if (
        candidate === undefined ||
        candidate.indexOffset !== submesh.indexOffset ||
        candidate.indexCount !== submesh.indexCount ||
        candidate.vertexCount !== submesh.vertexCount ||
        candidate.topology !== submesh.topology ||
        candidate.materialSlot !== submesh.materialSlot
      )
        return false;
    }
  }
  let min = Infinity,
    max = -Infinity;
  for (const h of root.heights) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  const range = Math.max(max - min, 1e-6);
  if (
    root.heightRange[0] !== min ||
    root.heightRange[1] !== terrainHeightRange(min, max)[1] ||
    textures.length !== root.sections.length ||
    controls.length !== root.sections.length
  )
    return false;
  const n = root.subsectionVertices,
    nx = (root.columns - 1) / (n - 1);
  for (const [index, section] of root.sections.entries()) {
    const textureAsset = textures[index],
      controlAsset = controls[index];
    const tex = textureAsset?.kind === 'texture' ? textureAsset : undefined,
      control = controlAsset?.kind === 'texture' ? controlAsset : undefined;
    if (
      tex === undefined ||
      control === undefined ||
      control.format !== 'rgba8unorm' ||
      control.colorSpace !== 'linear' ||
      control.shape.viewDimension !== '2d' ||
      control.shape.extent.width !== n ||
      control.shape.extent.height !== n ||
      (ids
        ? control.mips.kind !== 'none'
        : control.mips.kind !== 'packed' || control.mips.levelCount !== Math.log2(n) + 1) ||
      tex.format !== 'rgba8unorm' ||
      tex.colorSpace !== 'linear' ||
      tex.shape.viewDimension !== '2d' ||
      tex.shape.extent.width !== n ||
      tex.shape.extent.height !== n ||
      tex.mips.kind !== 'packed' ||
      tex.mips.levelCount !== Math.log2(n) + 1
    )
      return false;
    const active = new Set<number>();
    let sectionMin = Infinity,
      sectionMax = -Infinity;
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const h =
          root.heights[
            (Math.floor(index / nx) * (n - 1) + z) * root.columns + (index % nx) * (n - 1) + x
          ];
        if (h === undefined) return false;
        const sample =
          (Math.floor(index / nx) * (n - 1) + z) * root.columns + (index % nx) * (n - 1) + x;
        for (let l = 0; l < root.layers.length; l++)
          if ((root.weights[sample * root.layers.length + l] ?? 0) > 0) active.add(l);
        sectionMin = Math.min(sectionMin, h);
        sectionMax = Math.max(sectionMax, h);
      }
    for (let l = 0; l < root.layers.length; l++)
      if (root.layers[l]?.blend === 'height') active.add(l);
    const activeLayers = [...active].sort((a, b) => a - b);
    if (
      activeLayers.length !== section.activeLayers.length ||
      activeLayers.some((layer, i) => section.activeLayers[i] !== layer)
    )
      return false;
    if (section.minHeight !== sectionMin || section.maxHeight !== sectionMax) return false;
    let offset = 0;
    for (let size = n; size >= 1; size /= 2) {
      for (let z = 0; z < size; z++)
        for (let x = 0; x < size; x++) {
          const fx =
              (index % nx) * (n - 1) + (size === 1 ? (n - 1) / 2 : (x * (n - 1)) / (size - 1)),
            fz =
              Math.floor(index / nx) * (n - 1) +
              (size === 1 ? (n - 1) / 2 : (z * (n - 1)) / (size - 1));
          const expected = terrainHeightTexel(root, fx, fz, min, range),
            i = offset + (z * size + x) * 4;
          if (expected.some((byte, c) => tex.data[i + c] !== byte)) return false;
          if (ids && size !== n) continue;
          const weights = ids?.ok
            ? (ids.value[index]?.subarray(i, i + 4) ?? [])
            : terrainWeightTexel(root, activeLayers, fx, fz);
          for (let c = 0; c < 4; c++) if (control.data[i + c] !== (weights[c] ?? 0)) return false;
        }
      offset += size * size * 4;
    }
    if (offset !== tex.data.length || (ids ? n * n * 4 : offset) !== control.data.length)
      return false;
  }
  return true;
}
