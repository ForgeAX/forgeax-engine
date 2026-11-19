import type { App } from '@forgeax/engine/app';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { createMeshBuilder, meshAttributeWindow } from '@forgeax/engine/geometry';
import { MeshFilter, MeshRenderer, PointLight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { MeshAsset } from '@forgeax/engine/types';
import { presentationGuid } from './presentation-identity';

function museumSurfaceChannels(box: MeshAsset) {
  const position = meshAttributeWindow(box, 'position');
  const normal = meshAttributeWindow(box, 'normal');
  const uv = meshAttributeWindow(box, 'uv');
  if (!position || !normal || !uv || position.count === 0
    || normal.count !== position.count || uv.count !== position.count)
    throw new Error('Museum architecture requires matching box surface channels');
  return { position, normal, uv };
}

/** Ordinary exhibit architecture; it supplies no Water geometry or simulation. */
export async function dressWaterMuseum(
  app: App,
  center: readonly [number, number, number],
  dimensions: readonly [number, number, number],
) {
  const { world, assets } = app;
  if (!assets) throw new Error('Water museum requires the App asset owner');
  const mesh = (await assets.load(presentationGuid('mesh/plank'), 'mesh')).unwrap();
  const box = assets.read(mesh).unwrap();
  const { position, normal, uv } = museumSurfaceChannels(box);
  const materials = new Map(
    await Promise.all(
      ['limestone', 'plaster', 'ink', 'brass', 'wood', 'lamp'].map(
        async (key) =>
          [
            key,
            (await assets.load(presentationGuid(`material/${key}`), 'material')).unwrap(),
          ] as const,
      ),
    ),
  );
  const entities: EntityHandle[] = [];
  const [width, height, depth] = dimensions;
  const batches = new Map<string, { positions: number[]; normals: number[]; uv: number[]; indices: number[] }>();
  const place = (material: string, pos: number[], scale: number[]) => {
    let batch = batches.get(material);
    if (!batch) {
      batch = { positions: [], normals: [], uv: [], indices: [] };
      batches.set(material, batch);
    }
    const offset = batch.positions.length / 3;
    for (let vertex = 0; vertex < position.count; vertex++) {
      const positionOffset = position.offset + vertex * position.stride;
      const normalOffset = normal.offset + vertex * normal.stride;
      const uvOffset = uv.offset + vertex * uv.stride;
      const transformedNormal = [0, 1, 2].map((axis) => (normal.data[normalOffset + axis] ?? 0) / (scale[axis] ?? 1));
      const magnitude = Math.hypot(...transformedNormal);
      for (let axis = 0; axis < 3; axis++) {
        batch.positions.push((position.data[positionOffset + axis] ?? 0) * (scale[axis] ?? 1) + (pos[axis] ?? 0));
        batch.normals.push((transformedNormal[axis] ?? 0) / Math.max(0.00001, magnitude));
      }
      batch.uv.push(uv.data[uvOffset] ?? 0, uv.data[uvOffset + 1] ?? 0);
    }
    for (const index of box.indices ?? []) batch.indices.push(offset + index);
  };
  // Finite floor tiles give texture an authored physical scale, avoiding stretched slab UVs.
  const columns = Math.ceil(width / 5),
    rows = Math.ceil(depth / 5);
  for (let x = 0; x < columns; x++)
    for (let z = 0; z < rows; z++)
      place(
        'limestone',
        [((x + 0.5) * width) / columns - width / 2, -0.22, ((z + 0.5) * depth) / rows - depth / 2],
        [width / columns - 0.035, 0.4, depth / rows - 0.035],
      );
  place('ink', [0, -0.55, 0], [width + 0.4, 0.3, depth + 0.4]);
  place('plaster', [0, height / 2, -depth / 2], [width, height, 0.7]);
  for (const side of [-1, 1]) {
    place('plaster', [(side * width) / 2, height / 2, -depth * 0.18], [0.7, height, depth * 0.64]);
    place('ink', [(side * width) / 2, 0.7, -depth * 0.18], [0.76, 1.4, depth * 0.64]);
    place('brass', [side * (width / 2 - 0.4), 1.42, -depth * 0.18], [0.07, 0.045, depth * 0.64]);
  }
  place('ink', [0, 0.7, -depth / 2 + 0.38], [width, 1.4, 0.08]);
  place('brass', [0, 1.43, -depth / 2 + 0.43], [width, 0.05, 0.06]);
  const bays = Math.max(3, Math.ceil(width / 9));
  for (let i = 0; i <= bays; i++) {
    const x = -width / 2 + (i * width) / bays;
    place('limestone', [x, height / 2, -depth / 2 + 0.48], [0.58, height, 0.7]);
    if (i < bays) {
      const middle = x + width / bays / 2;
      place(
        'ink',
        [middle, height * 0.52, -depth / 2 + 0.42],
        [width / bays - 1.7, height * 0.62, 0.11],
      );
      // Framed wave reliefs make each bay an authored exhibit, rather than a
      // repeated empty wood panel. These are architectural motifs, not Water output.
      const panelWidth = width / bays - 2;
      place('plaster', [middle, height * 0.52, -depth / 2 + 0.5], [panelWidth, height * 0.57, 0.12]);
      for (const edge of [-1, 1]) {
        place('brass', [middle + edge * panelWidth / 2, height * 0.52, -depth / 2 + 0.6], [0.055, height * 0.59, 0.06]);
        place('brass', [middle, height * 0.52 + edge * height * 0.295, -depth / 2 + 0.6], [panelWidth, 0.055, 0.06]);
      }
      for (let band = 0; band < 3; band++)
        for (let point = 0; point < 12; point++) {
          const x = (point / 11 - 0.5) * panelWidth * 0.8;
          const y = height * (0.44 + band * 0.075) + Math.sin(point * 0.65 + i * 0.7 + band) * height * 0.035;
          place(band === 1 ? 'brass' : 'ink', [middle + x, y, -depth / 2 + 0.64], [panelWidth / 13, 0.09, 0.08]);
        }
      place('ink', [middle, height * 0.27, -depth / 2 + 0.64], [panelWidth * 0.5, 0.14, 0.08]);
      place('lamp', [middle, height * 0.86, -depth / 2 + 0.7], [width / bays - 2, 0.08, 0.18]);
    }
  }
  // Open roof preserves the inspection camera; perimeter beams make the room legible.
  place('limestone', [0, height, -depth / 2 + 0.4], [width, 0.55, 1.2]);
  for (const side of [-1, 1])
    place('limestone', [(side * width) / 2, height, -depth * 0.18], [1.2, 0.55, depth * 0.64]);
  for (const side of [-1, 1]) {
    place('ink', [side * width * 0.39, 0.42, depth * 0.24], [width * 0.13, 0.75, 2.1]);
    for (let slat = 0; slat < 5; slat++)
      place('wood', [side * width * 0.39, 0.85, depth * 0.24 + (slat - 2) * 0.38], [width * 0.14, 0.12, 0.33]);
  }
  // Static architecture shares one draw per material; detail does not add hundreds
  // of independently refreshed entities or per-frame geometry work.
  for (const [key, batch] of batches) {
    const material = materials.get(key);
    if (material === undefined) throw new Error('Missing museum material ' + key);
    const geometry = createMeshBuilder({
      attributes: {
        position: new Float32Array(batch.positions),
        normal: new Float32Array(batch.normals),
        uv: new Float32Array(batch.uv),
      },
      indices: batch.indices,
    }).build().unwrap();
    const geometryHandle = assets.create(geometry).unwrap();
    entities.push(world.spawn(
      { component: Transform, data: { pos: center } },
      { component: MeshFilter, data: { assetHandle: geometryHandle } },
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap());
    assets.release(geometryHandle).unwrap();
  }
  for (const x of [-width * 0.28, width * 0.28]) {
    const entity = world
      .spawn(
        {
          component: Transform,
          data: { pos: [center[0] + x, center[1] + height * 0.7, center[2] - depth * 0.25] },
        },
        {
          component: PointLight,
          data: { color: [1, 0.91, 0.78], intensity: 100, range: height * 3.5 },
        },
      )
      .unwrap();
    entities.push(entity);
  }
  return { entities };
}
