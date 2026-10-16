import { createEncoderModule } from 'draco3dgltf';

/** Real codec fixture, including raw normalized UBYTE colors. No decoder mocks. */
export async function dracoFixture() {
  const module = await createEncoderModule();
  const mesh = new module.Mesh();
  const builder = new module.MeshBuilder();
  const encoder = new module.Encoder();
  const encoded = new module.DracoInt8Array();
  try {
    const positionId = builder.AddFloatAttribute(
      mesh,
      module.POSITION,
      4,
      3,
      new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    );
    const colorId = builder.AddUInt8Attribute(
      mesh,
      module.COLOR,
      4,
      4,
      new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    );
    builder.AddFacesToMesh(mesh, 2, new Uint32Array([0, 1, 2, 0, 2, 3]));
    encoder.SetSpeedOptions(5, 5);
    encoder.SetAttributeQuantization(module.POSITION, 14);
    const count = encoder.EncodeMeshToDracoBuffer(mesh, encoded);
    if (count <= 0) throw new Error('fixture encoder failed');
    const bytes = Uint8Array.from({ length: count }, (_, index) => encoded.GetValue(index));
    const json = {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_draco_mesh_compression'],
      extensionsRequired: ['KHR_draco_mesh_compression'],
      buffers: [
        {
          byteLength: bytes.length,
          uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`,
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: bytes.length }],
      accessors: [
        { componentType: 5126, type: 'VEC3', count: 4, min: [0, 0, 0], max: [1, 1, 0] },
        { componentType: 5121, type: 'VEC4', count: 4, normalized: true },
        { componentType: 5123, type: 'SCALAR', count: 6 },
      ],
      meshes: [
        {
          name: 'DracoQuad',
          primitives: [
            {
              attributes: { POSITION: 0, COLOR_0: 1 },
              indices: 2,
              extensions: {
                KHR_draco_mesh_compression: {
                  bufferView: 0,
                  attributes: { POSITION: positionId, COLOR_0: colorId },
                },
              },
            },
          ],
        },
      ],
      nodes: [{ name: 'DracoQuad', mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };
    return { bytes, json };
  } finally {
    module.destroy(encoded);
    module.destroy(encoder);
    module.destroy(builder);
    module.destroy(mesh);
  }
}
