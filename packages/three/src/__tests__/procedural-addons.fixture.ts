import { BufferGeometry, Float32BufferAttribute } from '@forgeax/engine/three';

/** A texture-free asset exercises USD hierarchy, indexed topology and transforms. */
export const usdTriangle = `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)
def Xform "Root"
{
    double3 xformOp:translate = (0.25, 0, 0)
    uniform token[] xformOpOrder = ["xformOp:translate"]
    def Mesh "Triangle"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(-1, -1, 0), (1, -1, 0), (0, 1, 0)]
        uniform token subdivisionScheme = "none"
    }
}
`;

/** Generated IFF/LWO2 with one layer, surface and indexed triangle. */
export function lwoTriangle(): ArrayBuffer {
  const text = (value: string) => new TextEncoder().encode(value);
  const concat = (...parts: Uint8Array[]) => {
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  };
  const integers = (values: number[], width: 2 | 4) => {
    const bytes = new Uint8Array(values.length * width),
      data = new DataView(bytes.buffer);
    values.forEach((v, i) => {
      if (width === 2) data.setUint16(i * width, v);
      else data.setUint32(i * width, v);
    });
    return bytes;
  };
  const floats = (values: number[]) => {
    const bytes = new Uint8Array(values.length * 4),
      data = new DataView(bytes.buffer);
    values.forEach((v, i) => {
      data.setFloat32(i * 4, v);
    });
    return bytes;
  };
  const chunk = (id: string, bytes: Uint8Array) =>
    concat(text(id), integers([bytes.length], 4), bytes, new Uint8Array(bytes.length % 2));
  const chunks = concat(
    chunk('TAGS', text('surface\0')),
    chunk('LAYR', concat(integers([0, 0], 2), floats([0, 0, 0]), text('triangle\0\0'))),
    chunk('PNTS', floats([-1, -1, 0, 1, -1, 0, 0, 1, 0])),
    chunk('POLS', concat(text('FACE'), integers([3, 0, 1, 2], 2))),
    chunk('PTAG', concat(text('SURF'), integers([0, 0], 2))),
    chunk('SURF', text('surface\0\0\0')),
  );
  return concat(text('FORM'), integers([chunks.length + 4], 4), text('LWO2'), chunks).buffer;
}

export function morphTriangle(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0], 3),
  );
  geometry.morphAttributes.position = [0, 1, 2].map((frame) => {
    const attribute = new Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, frame * 0.35, 0.5 + frame * 0.25, 0],
      3,
    );
    attribute.name = `idle${frame}`;
    return attribute;
  });
  return geometry;
}
