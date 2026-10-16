// One scene snapshot feeds raster capture, software GI and independent exact PT.
export function sceneSnapshot(prepared, options = {}) {
  const { resolution = 256, light = 1, wall = 'red', cameraX = 0 } = options;
  const field = {
    ...prepared.field,
    bricks: Uint32Array.from(prepared.field.bricks),
    values: Float32Array.from(prepared.field.values),
  };
  const boxes = [
    ['white', [0, -3.15, 0], [3.3, 0.15, 3.3], 0],
    ['white', [0, 0, -3.15], [3.3, 3.15, 0.15], 0],
    [wall, [-3.15, 0, 0], [0.15, 3.15, 3.3], 0],
    ['blue', [3.15, 0, 0], [0.15, 3.15, 3.3], 0],
    ['white', [0, 3.15, 0], [3.3, 0.15, 3.3], 0],
    ['white', [-1.1, -1.8, -0.8], [0.8, 1.2, 0.8], -0.3],
    ['white', [1.1, -2.15, 1], [0.7, 0.85, 0.7], 0.28],
  ];
  const sources = boxes.map(([name, center, scale, angle], id) => {
    const material = prepared.materials.find((m) => m.name === name);
    if (!material) throw new Error(`Unknown material: ${name}`);
    const c = Math.cos(angle),
      s = Math.sin(angle),
      [x, y, z] = scale;
    return {
      field,
      layout: prepared.layout,
      sections: [
        {
          indexOffset: 0,
          indexCount: prepared.geometry.indices.length,
          material: { id, ...material.card },
        },
      ],
      instance: {
        ...prepared.geometry,
        instanceId: id,
        geometryId: 0,
        mask: 255,
        transform: [c * x, 0, -s * x, 0, 0, y, 0, 0, s * z, 0, c * z, 0, ...center, 1],
      },
    };
  });
  const camera = {
    origin: [cameraX, 0.3, 9],
    target: [0, -0.3, -0.4],
    up: [0, 1, 0],
    verticalFov: 0.68,
  };
  const lights = [
    {
      kind: 'point',
      position: new Float32Array([0, 2.1, 0.7]),
      color: new Float32Array([35 * light, 35 * light, 35 * light]),
      intensity: 35 * light,
      invRangeSquared: 0,
    },
  ];
  const settings = {
    resolution,
    cardResolution: 32,
    view: { camera, near: 0.1, far: 30 },
    probeOrigin: [-2.7, -2.7, -2.7],
    probeSpacing: 1.8,
    probeCounts: [4, 4, 4],
    samples: 128,
    iterations: 0,
    environment: [0, 0, 0],
  };
  const materials = boxes.map(([name], id) => ({
    id,
    ...prepared.materials.find((m) => m.name === name).ray,
  }));
  return { sources, materials, lights, settings, camera };
}
