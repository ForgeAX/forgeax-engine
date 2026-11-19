/** Small generated format fixtures; no downloaded models or images. */
export function md2Triangle(): ArrayBuffer {
  const frameSize = 52,
    frameOffset = 92,
    end = frameOffset + frameSize * 2;
  const buffer = new ArrayBuffer(end),
    data = new DataView(buffer);
  const header = [
    844121161,
    8,
    2,
    2,
    frameSize,
    0,
    3,
    3,
    1,
    0,
    2,
    68,
    68,
    80,
    frameOffset,
    end,
    end,
  ];
  header.forEach((value, i) => {
    data.setInt32(i * 4, value, true);
  });
  [
    [0, 0],
    [2, 0],
    [0, 2],
  ].forEach(([u, v], i) => {
    data.setInt16(68 + i * 4, u ?? 0, true);
    data.setInt16(70 + i * 4, v ?? 0, true);
  });
  for (let i = 0; i < 3; i++) {
    data.setUint16(80 + i * 2, i, true);
    data.setUint16(86 + i * 2, i, true);
  }
  for (let frame = 0; frame < 2; frame++) {
    const offset = frameOffset + frame * frameSize;
    for (let axis = 0; axis < 3; axis++) data.setFloat32(offset + axis * 4, 1, true);
    new Uint8Array(buffer, offset + 24, 16).set(new TextEncoder().encode(`idle${frame}`));
    new Uint8Array(buffer, offset + 40, 12).set([
      0,
      0,
      frame,
      0,
      1,
      0,
      frame,
      0,
      0,
      0,
      1 + frame,
      0,
    ]);
  }
  return buffer;
}

export function pvrTexture(faces = 1): ArrayBuffer {
  const buffer = new ArrayBuffer(52 + faces * 64),
    header = new Uint32Array(buffer, 0, 13);
  header.set([0x03525650, 0, 3, 0, 0, 0, 8, 8, 1, 1, faces, 2, 0]);
  new Uint8Array(buffer, 52).forEach((_, i, bytes) => {
    bytes[i] = i % 256;
  });
  return buffer;
}

export function tiffImage(): ArrayBuffer {
  const bits = 134,
    pixels = 140,
    buffer = new ArrayBuffer(146),
    data = new DataView(buffer);
  data.setUint16(0, 0x4949, true);
  data.setUint16(2, 42, true);
  data.setUint32(4, 8, true);
  data.setUint16(8, 10, true);
  const tags = [
    [256, 4, 1, 2],
    [257, 4, 1, 1],
    [258, 3, 3, bits],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, pixels],
    [277, 3, 1, 3],
    [278, 4, 1, 1],
    [279, 4, 1, 6],
    [284, 3, 1, 1],
  ];
  tags.forEach(([tag, type, count, value], i) => {
    const offset = 10 + i * 12;
    data.setUint16(offset, tag ?? 0, true);
    data.setUint16(offset + 2, type ?? 0, true);
    data.setUint32(offset + 4, count ?? 0, true);
    data.setUint32(offset + 8, value ?? 0, true);
  });
  for (let i = 0; i < 3; i++) data.setUint16(bits + i * 2, 8, true);
  new Uint8Array(buffer, pixels).set([255, 0, 0, 0, 128, 255]);
  return buffer;
}

export const portableCollada = `<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><unit meter="1"/><up_axis>Y_UP</up_axis></asset><library_geometries><geometry id="g"><mesh>
<source id="p"><float_array id="a" count="9">-0.5 -0.5 0 0.5 -0.5 0 0 0.5 0</float_array>
<technique_common><accessor source="#a" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
<vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles>
</mesh></geometry></library_geometries><library_visual_scenes><visual_scene id="s"><node id="n"><instance_geometry url="#g"/></node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#s"/></scene></COLLADA>`;
