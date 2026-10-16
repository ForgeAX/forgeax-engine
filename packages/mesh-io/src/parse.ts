import { type AssetError, ok, type Result } from '@forgeax/engine-types';
import { Mesh } from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { formatFailure } from './errors.js';
import { geometryToMesh, type ImportedMesh } from './geometry.js';
import { svgWorker } from './svg.js';

export function parseObj(text: string): Result<readonly ImportedMesh[], AssetError> {
  try {
    const object = new OBJLoader().parse(text);
    const meshes: ImportedMesh[] = [];
    for (const child of object.children) {
      if (!(child instanceof Mesh))
        return formatFailure('OBJ', 'line and point objects cannot be imported as triangle meshes');
      const mesh = geometryToMesh(child.geometry);
      if (!mesh.ok) return mesh;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      meshes.push({
        name: child.name || `Mesh_${meshes.length}`,
        mesh: {
          ...mesh.value,
          materialSlots: mesh.value.materialSlots.map((slot, index) => ({
            ...slot,
            slotName: materials[index]?.name || slot.slotName,
          })),
        },
      });
    }
    return meshes.length === 0 ? formatFailure('OBJ', 'no triangle mesh') : ok(meshes);
  } catch (cause) {
    return formatFailure('OBJ', cause instanceof Error ? cause.message : String(cause));
  }
}

export function parseStl(bytes: Uint8Array): Result<readonly ImportedMesh[], AssetError> {
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const geometry = new STLLoader().parse(buffer);
    const mesh = geometryToMesh(geometry);
    return mesh.ok ? ok([{ name: 'Mesh', mesh: mesh.value }]) : mesh;
  } catch (cause) {
    return formatFailure('STL', cause instanceof Error ? cause.message : String(cause));
  }
}

export async function parseSvg(
  text: string,
  curveSegments = 24,
): Promise<Result<readonly ImportedMesh[], AssetError>> {
  if (!Number.isInteger(curveSegments) || curveSegments < 2 || curveSegments > 256)
    return formatFailure('curveSegments', 'expected an integer in [2, 256]');
  return svgWorker(text, curveSegments);
}
