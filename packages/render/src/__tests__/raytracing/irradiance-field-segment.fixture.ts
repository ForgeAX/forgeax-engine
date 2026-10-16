/** Real GPU query over a covered planar distance grid. Both carriers run these bytes. */
export const segmentCases = Array.from({ length: 33 }, (_, i) => {
  const x = (i - 16) / 20;
  return { origin: [x, 0.7, 0] as const, endpoint: [0, 0.06, 0] as const };
});

export const segmentShader = `
#import forgeax_ray::irradiance_field_sample::{fieldSegmentVisibility}
@group(0) @binding(0) var<storage, read> segments: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
@compute @workgroup_size(1) fn verifySegmentEndpoint(@builtin(global_invocation_id) id: vec3u) {
 if(id.x < arrayLength(&results)) {
  results[id.x] = fieldSegmentVisibility(segments[2u*id.x].xyz, segments[2u*id.x+1u].xyz);
 }
}`;

export async function runSegmentEndpoint(
  device: GPUDevice,
  code: string,
  fieldBytes: Uint8Array,
  gridBytes: Uint8Array,
) {
  const owned: GPUBuffer[] = [];
  const buffer = (data: Uint8Array, usage: number) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(value, 0, data as Uint8Array<ArrayBuffer>);
    owned.push(value);
    return value;
  };
  const texture = device.createTexture({
    size: [9, 9, 9],
    dimension: '3d',
    format: 'rg32float',
    usage: 4 | 2,
  });
  const data = new Float32Array(9 * 9 * 9 * 2);
  for (let z = 0; z < 9; z++)
    for (let y = 0; y < 9; y++)
      for (let x = 0; x < 9; x++) data.set([-1 + y * 0.25, 1], ((z * 9 + y) * 9 + x) * 2);
  const cases = [
    ...segmentCases,
    ...segmentCases.map((c) => ({ ...c, endpoint: [0, 0.3, 0] as const })),
  ];
  const pairs = new Float32Array(cases.flatMap((c) => [...c.origin, 0, ...c.endpoint, 0]));
  const input = buffer(new Uint8Array(pairs.buffer), 128);
  const output = buffer(new Uint8Array(cases.length * 4), 128 | 4);
  const field = buffer(fieldBytes, 64);
  const grid = buffer(gridBytes, 64);
  const staging = device.createBuffer({ size: output.size, usage: 1 | 8 });
  owned.push(staging);
  try {
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'verifySegmentEndpoint' },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: field } },
          { binding: 4, resource: { buffer: grid } },
          { binding: 5, resource: texture.createView() },
        ],
      }),
    ];
    const sample = async () => {
      device.queue.writeTexture(
        { texture },
        data,
        { bytesPerRow: 9 * 8, rowsPerImage: 9 },
        [9, 9, 9],
      );
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      groups.forEach((group, i) => {
        pass.setBindGroup(i, group);
      });
      pass.dispatchWorkgroups(cases.length);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const values = Array.from(new Float32Array(staging.getMappedRange().slice(0)));
      staging.unmap();
      return values;
    };
    const covered = await sample();
    // Only the endpoint's interpolation footprint is unavailable. A jump past
    // the last covered sample must not publish transport through that absence.
    for (let z = 3; z <= 5; z++)
      for (let y = 4; y <= 5; y++)
        for (let x = 3; x <= 5; x++) data[((z * 9 + y) * 9 + x) * 2 + 1] = -1;
    const unavailable = await sample();
    return { covered, unavailable, cases };
  } finally {
    texture.destroy();
    for (const value of owned) value.destroy();
  }
}
