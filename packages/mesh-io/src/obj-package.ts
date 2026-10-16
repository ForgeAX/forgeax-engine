import { posix } from 'node:path';
import { toMaterialAsset } from '@forgeax/engine-gltf';
import { type AssetError, type MaterialAsset, ok, type Result } from '@forgeax/engine-types';
import { Color, SRGBColorSpace } from 'three';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { formatFailure } from './errors';
import type { ImportedMesh } from './geometry';
import { parseObj } from './parse';

export interface ObjTextureSource {
  readonly sourceKey: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly colorSpace: 'srgb' | 'linear';
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/x-tga';
}
export interface ObjMaterialSource {
  readonly sourceKey: string;
  readonly name: string;
  readonly material: MaterialAsset;
  readonly textures: readonly {
    readonly slot: string;
    readonly sourceKey: string;
    readonly scale: readonly [number, number];
    readonly offset: readonly [number, number];
  }[];
}
export interface ObjPackage {
  readonly meshes: readonly ImportedMesh[];
  readonly materials: readonly ObjMaterialSource[];
  readonly textures: readonly ObjTextureSource[];
  readonly dependencies: readonly string[];
}
export const materialSourceKey = (name: string): string => `material:${encodeURIComponent(name)}`;

/** Read MTL and image dependencies at the producer boundary; no DOM TextureLoader or temporary pixels. */
export async function parseObjPackage(
  text: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<Result<ObjPackage, AssetError>> {
  const meshes = parseObj(text);
  if (!meshes.ok) return meshes;
  const materials: ObjMaterialSource[] = [],
    textures = new Map<string, ObjTextureSource>(),
    dependencies = new Set<string>();
  const libraries = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((match) =>
    (match[1] ?? '').trim(),
  );
  const used = new Set(
    meshes.value.flatMap((mesh) => mesh.mesh.materialSlots.map((slot) => slot.slotName)),
  );
  const missingUvs = new Set<string>();
  let activeMaterial = '';
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'usemtl') activeMaterial = fields.slice(1).join(' ');
    if (fields[0] === 'f' && fields.slice(1).some((vertex) => !vertex.split('/')[1]))
      missingUvs.add(activeMaterial);
  }
  const seen = new Set<string>();
  try {
    for (const path of new Set(libraries)) {
      dependencies.add(path);
      const creator = new MTLLoader().parse(new TextDecoder().decode(await read(path)), '');
      for (const [name, info] of Object.entries(creator.materialsInfo)) {
        if (!used.has(name)) continue;
        if (seen.has(name)) return formatFailure('MTL', `ambiguous material ${name}`);
        seen.add(name);
        const raw = info as Record<string, unknown>;
        for (const key of Object.keys(raw))
          if (
            (key.startsWith('map_') && key !== 'map_kd' && key !== 'map_ke') ||
            key === 'bump' ||
            key === 'disp'
          )
            return formatFailure(
              'MTL',
              `${key} requires a supported material mapping; source is not silently flattened`,
            );
        const number = (key: string, fallback: number) =>
          raw[key] === undefined ? fallback : Number(raw[key]);
        const opacity = raw.d !== undefined ? number('d', 1) : 1 - number('tr', 0);
        const metallic = number('pm', 0),
          roughness = raw.pr === undefined ? Math.sqrt(2 / (number('ns', 0) + 2)) : number('pr', 1);
        if (
          ![opacity, metallic, roughness].every(
            (value) => Number.isFinite(value) && value >= 0 && value <= 1,
          )
        )
          return formatFailure('MTL', 'invalid opacity or PBR scalar');
        const color = (
          key: string,
          fallback: readonly [number, number, number],
        ): readonly [number, number, number] => {
          const values = raw[key] ?? fallback;
          if (
            !Array.isArray(values) ||
            values.length !== 3 ||
            values.some(
              (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0,
            )
          )
            throw new Error(`invalid ${key} color`);
          const result = new Color().setRGB(values[0], values[1], values[2], SRGBColorSpace);
          return [result.r, result.g, result.b];
        };
        const diffuse = color('kd', [1, 1, 1]),
          emissive = color('ke', [0, 0, 0]);
        const bindings: ObjMaterialSource['textures'][number][] = [];
        const slots: Record<string, number> = {};
        for (const [key, slot, colorSpace] of [
          ['map_kd', 'baseColorTexture', 'srgb'],
          ['map_ke', 'emissiveTexture', 'srgb'],
          ['norm', 'normalTexture', 'linear'],
        ] as const) {
          if (raw[key] === undefined) continue;
          if (missingUvs.has(name))
            return formatFailure(
              'MTL',
              `textured material ${name} has faces without texture coordinates`,
            );
          if (typeof raw[key] !== 'string') return formatFailure('MTL', `invalid ${key}`);
          const params = creator.getTextureParams(raw[key] as string, {});
          const imagePath = posix.normalize(
            posix.join(posix.dirname(path), params.url.replace(/\\/g, '/')),
          );
          if (
            ![params.scale.x, params.scale.y, params.offset.x, params.offset.y].every(
              Number.isFinite,
            )
          )
            return formatFailure('MTL', 'invalid map transform');
          const sourceKey = `texture:${encodeURIComponent(imagePath)}:${colorSpace}`;
          const ext = imagePath.split('.').pop()?.toLowerCase();
          const mimeType =
            ext === 'png'
              ? 'image/png'
              : ext === 'jpg' || ext === 'jpeg'
                ? 'image/jpeg'
                : ext === 'tga'
                  ? 'image/x-tga'
                  : undefined;
          if (mimeType === undefined) return formatFailure('MTL', `unsupported image ${imagePath}`);
          dependencies.add(imagePath);
          if (!textures.has(sourceKey))
            textures.set(sourceKey, {
              sourceKey,
              path: imagePath,
              bytes: await read(imagePath),
              colorSpace,
              mimeType,
            });
          bindings.push({
            slot,
            sourceKey,
            scale: [params.scale.x, params.scale.y],
            offset: [params.offset.x, params.offset.y],
          });
          slots[slot] = 0;
        }
        const material = toMaterialAsset({
          name,
          baseColorFactor: [...diffuse, opacity],
          metallicFactor: metallic,
          roughnessFactor: roughness,
          emissiveFactor: emissive,
          ...(opacity < 1 ? { alphaMode: 'BLEND' as const } : {}),
          ...slots,
        });
        materials.push({ sourceKey: materialSourceKey(name), name, material, textures: bindings });
      }
    }
    const declaredNames = new Set(
      [...text.matchAll(/^\s*usemtl\s+(.+?)\s*$/gm)].map((match) => (match[1] ?? '').trim()),
    );
    for (const name of declaredNames)
      if (used.has(name) && !seen.has(name))
        return formatFailure('MTL', `unresolved usemtl ${name}`);
    return ok({
      meshes: meshes.value,
      materials,
      textures: [...textures.values()],
      dependencies: [...dependencies],
    });
  } catch (cause) {
    return formatFailure('OBJ closure', cause instanceof Error ? cause.message : String(cause));
  }
}
