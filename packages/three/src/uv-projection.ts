import type { ResolvedMaterialTextureCoordinates } from '@forgeax/engine-types';
import { type BufferGeometry, type Texture, Vector2 } from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import { textureCoordinates } from './texture';

export interface UvProjection {
  readonly coordinates: ReadonlyMap<Texture, ResolvedMaterialTextureCoordinates>;
  readonly attributes: Readonly<Record<string, Float32Array>>;
  readonly values: readonly unknown[];
}

/** Affine UVs can be authored in ordinary native UV streams; sampling, derivatives,
 * mip selection and wrapping continue to belong to the native material. */
export function projectUvs(geometry: BufferGeometry, textures: readonly Texture[]): UvProjection {
  const coordinates = new Map<Texture, ResolvedMaterialTextureCoordinates>();
  const attributes: Record<string, Float32Array> = {};
  const values: unknown[] = [];
  const used = new Set(textures.map((texture) => texture.channel));
  const baked = new Map<string, number>();
  for (const texture of new Set(textures)) {
    const native = textureCoordinates(texture);
    if (native.ok) {
      coordinates.set(texture, native.value);
      const name = texture.channel === 0 ? 'uv' : `uv${texture.channel}`;
      if (!geometry.hasAttribute(name))
        attributes[name] = new Float32Array((geometry.getAttribute('position')?.count ?? 0) * 2);
      continue;
    }
    const [, , p, , , q, , , w] = texture.matrix.elements;
    if (p !== 0 || q !== 0 || w !== 1 || !texture.matrix.elements.every(Number.isFinite))
      throw native.error;
    if (!Number.isInteger(texture.channel) || texture.channel < 0 || texture.channel > 3)
      return invalid('Texture.channel', texture.uuid).unwrap();
    const key = JSON.stringify([texture.channel, texture.matrix.elements]);
    let slot = baked.get(key);
    if (slot === undefined) {
      slot = Array.from({ length: 8 }, (_, index) => index).find((index) => !used.has(index));
      if (slot === undefined)
        return unsupported(
          'Material UV transforms exceed eight native UV streams',
          geometry.uuid,
        ).unwrap();
      used.add(slot);
      baked.set(key, slot);
      const source = geometry.getAttribute(texture.channel === 0 ? 'uv' : `uv${texture.channel}`);
      const count = geometry.getAttribute('position')?.count ?? 0,
        data = new Float32Array(count * 2),
        uv = new Vector2();
      for (let vertex = 0; vertex < count; vertex++) {
        uv.set(source?.getX(vertex) ?? 0, source?.getY(vertex) ?? 0).applyMatrix3(texture.matrix);
        if (!Number.isFinite(Math.fround(uv.x)) || !Number.isFinite(Math.fround(uv.y)))
          return invalid('Transformed UV values', texture.uuid).unwrap();
        data.set(uv.toArray(), vertex * 2);
      }
      attributes[slot === 0 ? 'uv' : `uv${slot}`] = data;
      values.push(slot, key);
    }
    coordinates.set(texture, {
      set: slot,
      transform: { offset: [0, 0], scale: [1, 1], rotation: 0 },
    });
  }
  return { coordinates, attributes, values };
}
