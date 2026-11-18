export const gcode = 'G90\nG0 X0 Y0 Z0\nG1 X1 Y0 Z0 E1\nG1 X1 Y1 Z0 E2\n';
export const vrml =
  '#VRML V2.0 utf8\nShape { appearance Appearance { material Material { diffuseColor 0.2 0.8 0.3 } } geometry Box { size 1 1 1 } }';
export const amf =
  '<?xml version="1.0"?><amf unit="millimeter" version="1.1"><object id="0"><mesh><vertices><vertex><coordinates><x>-0.5</x><y>-0.5</y><z>0</z></coordinates></vertex><vertex><coordinates><x>0.5</x><y>-0.5</y><z>0</z></coordinates></vertex><vertex><coordinates><x>0</x><y>0.5</y><z>0</z></coordinates></vertex></vertices><volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume></mesh></object></amf>';
export const collada = `<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset><library_geometries><geometry id="triangle"><mesh><source id="positions"><float_array id="positions-array" count="9">-0.5 -0.5 0 0.5 -0.5 0 0 0.5 0</float_array><technique_common><accessor source="#positions-array" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="vertices"><input semantic="POSITION" source="#positions"/></vertices><triangles count="1"><input semantic="VERTEX" source="#vertices" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries><library_visual_scenes><visual_scene id="Scene"><node id="Triangle"><instance_geometry url="#triangle"/></node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>`;
export const threeMFModel = `<?xml version="1.0"?><model unit="meter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="-0.5" y="-0.5" z="0"/><vertex x="0.5" y="-0.5" z="0"/><vertex x="0" y="0.5" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
export const threeMFRelations = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
export function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
function integers(...values: number[]): Uint8Array {
  const b = new Uint8Array(values.length * 4),
    v = new DataView(b.buffer);
  for (const [i, n] of values.entries()) v.setUint32(i * 4, n, true);
  return b;
}
function chunk(
  name: string,
  content: Uint8Array,
  children: Uint8Array = new Uint8Array(),
): Uint8Array {
  return concat(
    new TextEncoder().encode(name),
    integers(content.length, children.length),
    content,
    children,
  );
}
export function vox(): ArrayBuffer {
  return concat(
    new TextEncoder().encode('VOX '),
    integers(150),
    chunk(
      'MAIN',
      new Uint8Array(),
      concat(
        chunk('SIZE', integers(1, 1, 1)),
        chunk('XYZI', concat(integers(1), new Uint8Array([0, 0, 0, 1]))),
      ),
    ),
  ).buffer as ArrayBuffer;
}
export function tds(): ArrayBuffer {
  const u16 = (...n: number[]) => {
    const b = new Uint8Array(n.length * 2),
      v = new DataView(b.buffer);
    for (const [i, x] of n.entries()) v.setUint16(i * 2, x, true);
    return b;
  };
  const floats = (...n: number[]) => {
    const b = new Uint8Array(n.length * 4),
      v = new DataView(b.buffer);
    for (const [i, x] of n.entries()) v.setFloat32(i * 4, x, true);
    return b;
  };
  const part = (id: number, data: Uint8Array) => concat(u16(id), integers(data.length + 6), data);
  return part(
    0x4d4d,
    part(
      0x3d3d,
      part(
        0x4000,
        concat(
          new TextEncoder().encode('triangle\0'),
          part(
            0x4100,
            concat(
              part(0x4110, concat(u16(3), floats(-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0))),
              part(0x4120, u16(1, 0, 1, 2, 0)),
            ),
          ),
        ),
      ),
    ),
  ).buffer as ArrayBuffer;
}
/** Own stored ZIP container; no compression library or worker is needed by this fixture. */
export function threeMF(): ArrayBuffer {
  const entries = [
    ['_rels/.rels', threeMFRelations],
    ['3D/3dmodel.model', threeMFModel],
  ];
  const locals: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) {
      c ^= x;
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, value] of entries) {
    const n = new TextEncoder().encode(name),
      data = new TextEncoder().encode(value),
      sum = crc(data),
      local = new Uint8Array(30),
      l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint32(14, sum, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, n.length, true);
    const c = new Uint8Array(46),
      v = new DataView(c.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint32(16, sum, true);
    v.setUint32(20, data.length, true);
    v.setUint32(24, data.length, true);
    v.setUint16(28, n.length, true);
    v.setUint32(42, offset, true);
    locals.push(concat(local, n, data));
    central.push(concat(c, n));
    offset += local.length + n.length + data.length;
  }
  const table = concat(...central),
    end = new Uint8Array(22),
    v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, table.length, true);
  v.setUint32(16, offset, true);
  return concat(...locals, table, end).buffer as ArrayBuffer;
}
