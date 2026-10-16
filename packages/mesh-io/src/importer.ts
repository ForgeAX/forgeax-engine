import { packMeshBin } from '@forgeax/engine-import/mesh-bin';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  IMPORT_ERROR_HINTS,
  type ImportContext,
  ImportError,
  type ImportedAsset,
  type ImportResult,
  type MaterialTextureValue,
} from '@forgeax/engine-types';
import type { ImportedMesh } from './geometry.js';
import { materialSourceKey, parseObjPackage } from './obj-package';
import { parseObj, parseStl, parseSvg } from './parse.js';

export type MeshSourceFormat = 'obj' | 'stl' | 'svg';

export async function parseMeshSource(
  format: MeshSourceFormat,
  bytes: Uint8Array,
  curveSegments = 24,
) {
  switch (format) {
    case 'obj':
      return parseObj(new TextDecoder().decode(bytes));
    case 'stl':
      return parseStl(bytes);
    case 'svg':
      return parseSvg(new TextDecoder().decode(bytes), curveSegments);
  }
}

export function meshSourceKey(mesh: ImportedMesh): string {
  return `mesh:${encodeURIComponent(mesh.name)}`;
}

function createMeshImporter(format: MeshSourceFormat) {
  return {
    key: format,
    async import(ctx: ImportContext): Promise<ImportResult> {
      const source = await ctx.readSource();
      if (!source.ok)
        return {
          ok: false,
          error: new ImportError({
            code: 'source-read-failed',
            expected: 'readable mesh source',
            hint: IMPORT_ERROR_HINTS['source-read-failed'],
            detail: { source: ctx.source, reason: String(source.error) },
          }),
        };
      const obj =
        format === 'obj'
          ? await parseObjPackage(new TextDecoder().decode(source.value), async (path) => {
              const result = await ctx.readSibling(path);
              if (!result.ok) throw result.error;
              return result.value;
            })
          : undefined;
      const parsed =
        obj ??
        (await parseMeshSource(
          format,
          source.value,
          typeof ctx.importSettings.curveSegments === 'number'
            ? ctx.importSettings.curveSegments
            : 24,
        ));
      if (!parsed.ok)
        return {
          ok: false,
          error: new ImportError({
            code: 'import-internal-error',
            expected: parsed.error.expected,
            hint: parsed.error.hint,
            detail: { reason: JSON.stringify(parsed.error.detail) },
          }),
        };
      const meshes =
        obj?.ok === true ? obj.value.meshes : (parsed.value as readonly ImportedMesh[]);
      try {
        const assets: ImportedAsset[] = [];
        const declarations = new Map(ctx.subAssets.map((row) => [row.sourceKey, row]));
        if (declarations.size !== ctx.subAssets.length)
          return {
            ok: false,
            error: new ImportError({
              code: 'import-internal-error',
              expected: 'unique sourceKeys',
              hint: 'Reimport source sidecar',
              detail: { reason: 'duplicate sourceKeys' },
            }),
          };
        if (obj?.ok === true) {
          for (const texture of obj.value.textures) {
            const declaration = declarations.get(texture.sourceKey);
            if (declaration?.kind !== 'texture')
              throw new Error(`missing texture declaration ${texture.sourceKey}`);
            const decoded = await ctx.decodeImage(texture.bytes, texture.mimeType, {
              ...ctx.importSettings,
              colorSpace: texture.colorSpace,
            });
            if (!decoded.ok) throw decoded.error;
            assets.push({
              guid: declaration.guid,
              kind: 'texture',
              name: texture.path,
              payload: decoded.value.texture,
              refs: [],
              artifacts: {
                body: {
                  bytes: decoded.value.bytes,
                  mediaType: decoded.value.mediaType ?? texture.mimeType,
                  ...(decoded.value.assetCodec === undefined
                    ? {}
                    : { assetCodec: decoded.value.assetCodec }),
                },
              },
            });
          }
          for (const material of obj.value.materials) {
            const declaration = declarations.get(material.sourceKey);
            if (declaration?.kind !== 'material')
              throw new Error(`missing material declaration ${material.sourceKey}`);
            const values = { ...material.material.values },
              refs = [];
            for (const texture of material.textures) {
              const declaration = declarations.get(texture.sourceKey);
              if (declaration?.kind !== 'texture') throw new Error('missing texture GUID');
              values[texture.slot] = {
                texture: refs.length as unknown as MaterialTextureValue['texture'],
                coordinates: {
                  set: 0,
                  transform: {
                    scale: [texture.scale[0], -texture.scale[1]],
                    offset: [texture.offset[0], 1 - texture.offset[1]],
                  },
                },
              };
              refs.push({ guid: declaration.guid, sourceField: { fieldName: texture.slot } });
            }
            assets.push({
              guid: declaration.guid,
              kind: 'material',
              name: material.name,
              payload: { ...material.material, values },
              refs,
              artifacts: {},
            });
          }
        }
        const meshesByKey = new Map(meshes.map((mesh) => [meshSourceKey(mesh), mesh]));
        for (const declaration of ctx.subAssets.filter((row) => row.kind === 'mesh')) {
          const sourceKey = declaration.sourceKey;
          const sourceMesh = sourceKey === undefined ? undefined : meshesByKey.get(sourceKey);
          if (
            sourceKey === undefined ||
            declaration.kind !== 'mesh' ||
            sourceMesh === undefined ||
            meshesByKey.size !== meshes.length
          )
            return {
              ok: false,
              error: new ImportError({
                code: 'import-internal-error',
                expected: 'one named mesh for every declared sourceKey',
                hint: 'Repair object names and reimport the source sidecar.',
                detail: { reason: `unresolved or ambiguous ${declaration.sourceKey}` },
              }),
            };
          const refs: { guid: string; sourceField: { fieldName: string; arrayIndex: number } }[] =
            [];
          const mesh = {
            ...sourceMesh.mesh,
            materialSlots: sourceMesh.mesh.materialSlots.map((slot, index) => {
              const material = declarations.get(materialSourceKey(slot.slotName));
              if (material === undefined) return slot;
              const parsedGuid = AssetGuid.parse(material.guid);
              if (!parsedGuid.ok) throw new Error('invalid material GUID');
              const guid = parsedGuid.value;
              refs.push({
                guid: material.guid,
                sourceField: { fieldName: 'materialSlots', arrayIndex: index },
              });
              return { ...slot, defaultMaterial: guid };
            }),
          };
          const packed = packMeshBin(
            mesh,
            sourceKey,
            refs.map((ref) => ref.guid),
          );
          if (!packed.ok)
            return {
              ok: false,
              error: new ImportError({
                code: 'import-internal-error',
                expected: 'canonical mesh-bin output',
                hint: 'Repair mesh source and reimport.',
                detail: { reason: packed.error.actual },
              }),
            };
          assets.push({
            guid: declaration.guid,
            kind: 'mesh',
            name: sourceMesh.name,
            payload: mesh,
            refs,
            artifacts: {
              body: {
                bytes: packed.value,
                mediaType: 'application/x-forgeax-mesh',
                assetCodec: { name: 'mesh-binary', version: '5' },
              },
            },
          });
        }
        if (assets.length !== ctx.subAssets.length)
          throw new Error('source closure differs from sidecar; reimport');
        const byGuid = new Map(assets.map((asset) => [asset.guid, asset]));
        return {
          ok: true,
          value: {
            assets: ctx.subAssets.map((row) => {
              const asset = byGuid.get(row.guid);
              if (asset === undefined) throw new Error(`missing declared GUID ${row.guid}`);
              return asset;
            }),
            sourceDependencies: obj?.ok === true ? obj.value.dependencies : [],
          },
        };
      } catch (cause) {
        return {
          ok: false,
          error: new ImportError({
            code: 'import-internal-error',
            expected: 'complete valid OBJ material and image closure',
            hint: 'Reimport source sidecar and repair missing dependencies.',
            detail: { reason: cause instanceof Error ? cause.message : String(cause) },
          }),
        };
      }
    },
  };
}

export const objImporter = createMeshImporter('obj');
export const stlImporter = createMeshImporter('stl');
export const svgImporter = createMeshImporter('svg');
