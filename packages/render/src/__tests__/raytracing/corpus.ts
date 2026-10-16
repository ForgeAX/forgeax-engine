import {
  buildRayReferenceScene,
  type RayMeshInstance,
  type ReferenceRay,
} from '../../raytracing/scene';

export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mesh(instanceId = 7, x = 0, z = 0): RayMeshInstance {
  const transform = [...identity];
  transform[12] = x;
  transform[14] = z;
  return {
    instanceId,
    geometryId: 0xabcdef01,
    materialId: 0xffabcdef,
    mask: 1,
    positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0],
    indices: [0, 1, 2],
    transform,
  };
}

export function referenceCorpus() {
  const instances: RayMeshInstance[] = [
    mesh(7),
    mesh(9, 0, -2),
    { ...mesh(12, 3), mask: 2 },
    { ...mesh(18, -3), transform: [-2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, -3, 0, -1, 1] },
  ];
  // Enough leaves to exercise both BVH descent and escape; stable IDs survive sorting.
  for (let i = 0; i < 32; i++) instances.push(mesh(100 + i, 20 + i * 3, -(i % 4)));
  instances.push({
    ...mesh(200, 120),
    positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0, 2, -1, -1, 4, -1, -1, 3, 1, -1],
    indices: [0, 1, 2, 3, 4, 5],
  });
  const c = Math.cos(0.7),
    s = Math.sin(0.7);
  instances.push({ ...mesh(201), transform: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 130, 0, 0, 1] });
  const rays: ReferenceRay[] = [];
  const ray = (
    x: number,
    y: number,
    mask = 255,
    tMin = 0,
    tMax = 50,
    dz = -1,
    z = 3,
  ): ReferenceRay => ({ origin: [x, y, z], direction: [0, 0, dz], mask, tMin, tMax });
  rays.push(
    ray(0, 0),
    ray(0, 0, 255, 3.1),
    ray(0, 0, 255, 0, 2),
    ray(3, 0, 1),
    ray(3, 0, 2),
    ray(-3, 0),
    ray(0, 0, 0),
    ray(0, 0, 255, 0, 50, 1, -3),
  );
  // Pixel-center rays avoid the undefined identity of exact shared-edge/coincident ties.
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 96; x++) rays.push(ray((x + 0.5) / 12 - 4, (y + 0.5) / 12 - 2));
  for (let i = 0; i < 32; i++) rays.push(ray(20 + i * 3, 0));
  rays.push({ origin: [0, 0, 3], direction: [0, 0, -2], tMin: 0, tMax: 50, mask: 255 });
  rays.push({ origin: [0, 0, 3], direction: [1, 0, 0], tMin: 0, tMax: 50, mask: 255 });
  rays.push(ray(123, 0), ray(130, 0), {
    origin: [0, 0, 3],
    direction: [0.1, 0.05, -1],
    tMin: 0,
    tMax: 50,
    mask: 255,
  });
  return { scene: buildRayReferenceScene(instances).unwrap(), rays, instances };
}
