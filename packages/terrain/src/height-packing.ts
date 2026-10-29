import { createTerrainGrids } from '@forgeax/engine-geometry';
import type {
  Asset,
  MaterialAsset,
  MeshAsset,
  TerrainAsset,
  TerrainSource,
  TextureAsset,
} from '@forgeax/engine-types';
import { numMipLevels, resolveMaterialAsset } from '@forgeax/engine-types';
import { encodeTerrainHeight, terrainHeightAtlas, terrainHeightMipOffset } from './height-atlas.js';
import { terrainSourceHeightRange } from './height-bounds.js';
import { cookTerrainIds } from './material-id.js';
import { terrainSampleHeight } from './query.js';
import { terrainTextureGuid } from './texture-binding.js';
import { terrainDerivedLayoutValid } from './validation.js';

/** Shared producer/acceptance encoding retains the sampled f32 exactly. */
export function terrainHeightTexel(
  source: TerrainSource,
  fx: number,
  fz: number,
): readonly number[] {
  const height = terrainSampleHeight(source, fx, fz);
  if (height === undefined) throw new RangeError('terrain cook sample escaped the author grid');
  return encodeTerrainHeight(height);
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

type TerrainHeightAtlas = ReturnType<typeof terrainHeightAtlas>;

function closureAsset(closure: ReadonlyMap<string, Asset>, guid: unknown): Asset | undefined {
  return closure.get(String(guid).toLowerCase());
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function equalBytes(
  a: ArrayBuffer | ArrayBufferView | undefined,
  b: ArrayBuffer | ArrayBufferView | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const left = bytesOf(a),
    right = bytesOf(b);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** Every section material must bind exactly that section's height and control textures. */
function sectionMaterialsBindSectionTextures(
  root: TerrainAsset,
  closure: ReadonlyMap<string, Asset>,
): boolean {
  const materialTable = Object.fromEntries(
    [...closure].filter((row): row is [string, MaterialAsset] => row[1].kind === 'material'),
  );
  for (const section of root.sections) {
    const material = resolveMaterialAsset(String(section.material), materialTable);
    if (!material.ok) return false;
    const height = material.value.asset.values?.terrainHeightTexture,
      control = material.value.asset.values?.terrainWeightTexture;
    if (
      terrainTextureGuid(height) !== String(section.heightTexture) ||
      (typeof control === 'object' && control !== null && 'texture' in control
        ? control.texture
        : control) !== section.weightTexture
    )
      return false;
  }
  return true;
}

function gridGeometryMatches(actual: MeshAsset, expected: MeshAsset): boolean {
  if (
    !(actual.indices instanceof Uint16Array || actual.indices instanceof Uint32Array) ||
    actual.indices.length !== expected.indices?.length ||
    actual.indices.some((value, index) => value !== expected.indices?.[index]) ||
    !equalBytes(actual.vertices, expected.vertices) ||
    !equalBytes(actual.aabb, expected.aabb) ||
    actual.morphTargets?.length
  )
    return false;
  return (
    Object.keys(actual.attributes).length === Object.keys(expected.attributes).length &&
    Object.entries(expected.attributes).every(([key, value]) =>
      equalBytes(actual.attributes[key as keyof MeshAsset['attributes']], value),
    )
  );
}

function gridSubmeshesMatch(actual: MeshAsset, expected: MeshAsset): boolean {
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
  return true;
}

/** Shared grid meshes must equal the canonical grids derived from the subsection size. */
function gridsMatchCanonical(root: TerrainAsset, grids: readonly (Asset | undefined)[]): boolean {
  const canonical = createTerrainGrids(root.subsectionVertices);
  if (grids.length !== canonical.length) return false;
  for (const [index, expected] of canonical.entries()) {
    const actual = grids[index];
    if (actual?.kind !== 'mesh') return false;
    if (!gridGeometryMatches(actual, expected) || !gridSubmeshesMatch(actual, expected))
      return false;
  }
  return true;
}

function controlTextureShaped(control: TextureAsset, n: number, ids: boolean): boolean {
  return (
    control.format === 'rgba8unorm' &&
    control.colorSpace === 'linear' &&
    control.shape.viewDimension === '2d' &&
    control.shape.extent.width === n &&
    control.shape.extent.height === n &&
    (ids
      ? control.mips.kind === 'none'
      : control.mips.kind === 'packed' &&
        control.mips.levelCount === numMipLevels({ width: n, height: n }))
  );
}

function heightTextureShaped(tex: TextureAsset, n: number, atlas: TerrainHeightAtlas): boolean {
  return (
    tex.format === 'rgba8unorm' &&
    tex.colorSpace === 'linear' &&
    tex.shape.viewDimension === '2d' &&
    tex.shape.extent.width === atlas.width &&
    tex.shape.extent.height === atlas.height &&
    tex.mips.kind === 'packed' &&
    tex.mips.levelCount === numMipLevels({ width: n, height: n })
  );
}

/** Author-grid scan of one section: its weighted layers and height bounds. */
function sectionSampleFacts(
  root: TerrainAsset,
  index: number,
  atlas: TerrainHeightAtlas,
):
  | { readonly activeLayers: readonly number[]; readonly min: number; readonly max: number }
  | undefined {
  const n = root.subsectionVertices;
  const active = new Set<number>();
  let min = Infinity,
    max = -Infinity;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const sample =
        (Math.floor(index / atlas.columns) * (n - 1) + z) * root.columns +
        (index % atlas.columns) * (n - 1) +
        x;
      const h = root.heights[sample];
      if (h === undefined) return undefined;
      for (let l = 0; l < root.layers.length; l++)
        if ((root.weights[sample * root.layers.length + l] ?? 0) > 0) active.add(l);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  for (let l = 0; l < root.layers.length; l++)
    if (root.layers[l]?.blend === 'height') active.add(l);
  return { activeLayers: [...active].sort((a, b) => a - b), min, max };
}

/** Author-grid coordinate of texel `texel` in a `size`-wide mip of section cell `cell`. */
function sectionMipCoordinate(cell: number, texel: number, size: number, n: number): number {
  return cell * (n - 1) + (size === 1 ? (n - 1) / 2 : (texel * (n - 1)) / (size - 1));
}

/** Every height-atlas mip texel and control texel must re-derive from author samples. */
function sectionTexelsMatch(
  root: TerrainAsset,
  index: number,
  atlas: TerrainHeightAtlas,
  tex: TextureAsset,
  control: TextureAsset,
  activeLayers: readonly number[],
  idTexels: readonly Uint8Array[] | undefined,
): boolean {
  const n = root.subsectionVertices;
  let offset = 0;
  for (let size = n; size >= 1; size /= 2) {
    const mipOffset = terrainHeightMipOffset(atlas.width, atlas.height, Math.log2(n / size));
    for (let z = 0; z < size; z++)
      for (let x = 0; x < size; x++) {
        const fx = sectionMipCoordinate(index % atlas.columns, x, size, n),
          fz = sectionMipCoordinate(Math.floor(index / atlas.columns), z, size, n);
        const expected = terrainHeightTexel(root, fx, fz),
          i = offset + (z * size + x) * 4;
        const pixel =
          mipOffset +
          ((Math.floor(index / atlas.tileColumns) * size + z) * atlas.tileColumns * size +
            (index % atlas.tileColumns) * size +
            x) *
            4;
        if (expected.some((byte, c) => tex.data[pixel + c] !== byte)) return false;
        if (idTexels !== undefined && size !== n) continue;
        const weights =
          idTexels !== undefined
            ? (idTexels[index]?.subarray(i, i + 4) ?? [])
            : terrainWeightTexel(root, activeLayers, fx, fz);
        for (let c = 0; c < 4; c++) if (control.data[i + c] !== (weights[c] ?? 0)) return false;
      }
    offset += size * size * 4;
  }
  return (
    terrainHeightMipOffset(atlas.width, atlas.height, Math.log2(n) + 1) === tex.data.length &&
    (idTexels !== undefined ? n * n * 4 : offset) === control.data.length
  );
}

function sectionTexturesMatchSource(
  root: TerrainAsset,
  index: number,
  atlas: TerrainHeightAtlas,
  tex: TextureAsset,
  control: TextureAsset,
  idTexels: readonly Uint8Array[] | undefined,
): boolean {
  const n = root.subsectionVertices;
  const section = root.sections[index];
  if (section === undefined) return false;
  if (
    !controlTextureShaped(control, n, idTexels !== undefined) ||
    !heightTextureShaped(tex, n, atlas)
  )
    return false;
  const facts = sectionSampleFacts(root, index, atlas);
  if (facts === undefined) return false;
  if (
    facts.activeLayers.length !== section.activeLayers.length ||
    facts.activeLayers.some((layer, i) => section.activeLayers[i] !== layer)
  )
    return false;
  if (section.minHeight > facts.min || section.maxHeight < facts.max) return false;
  return sectionTexelsMatch(root, index, atlas, tex, control, facts.activeLayers, idTexels);
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
  const idTexels = ids?.ok ? ids.value : undefined;
  const textures = root.sections.map((section) => closureAsset(closure, section.heightTexture));
  const controls = root.sections.map((section) => closureAsset(closure, section.weightTexture));
  const grids = root.grids.map((guid) => closureAsset(closure, guid));
  if (
    textures.some((asset) => asset?.kind !== 'texture') ||
    textures.some((asset) => asset !== textures[0]) ||
    controls.some((asset) => asset?.kind !== 'texture') ||
    grids.some((asset) => asset?.kind !== 'mesh')
  )
    return false;
  if (!sectionMaterialsBindSectionTextures(root, closure)) return false;
  if (!gridsMatchCanonical(root, grids)) return false;
  const { min, max } = terrainSourceHeightRange(root.heights);
  if (
    root.heightRange[0] > min ||
    root.heightRange[1] < max ||
    textures.length !== root.sections.length ||
    controls.length !== root.sections.length
  )
    return false;
  const atlas = terrainHeightAtlas(root);
  for (let index = 0; index < root.sections.length; index++) {
    const tex = textures[index],
      control = controls[index];
    if (tex?.kind !== 'texture' || control?.kind !== 'texture') return false;
    if (!sectionTexturesMatchSource(root, index, atlas, tex, control, idTexels)) return false;
  }
  return true;
}
