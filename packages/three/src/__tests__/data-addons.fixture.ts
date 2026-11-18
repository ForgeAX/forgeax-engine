export const vtk =
  '# vtk DataFile Version 3.0\nSynthetic triangle\nASCII\nDATASET POLYDATA\nPOINTS 3 float\n-0.5 -0.5 0 0.5 -0.5 0 0 0.5 0\nPOLYGONS 1 4\n3 0 1 2\n';
export const paddedVtk = vtk + '\n'.repeat(250);
export const pcd =
  '# synthetic PCD\nVERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH 3\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 3\nDATA ascii\n-0.5 0 0 16711680\n0 0 0 65280\n0.5 0 0 255\n';
export const bvh = `HIERARCHY
ROOT Hips
{
 OFFSET 0 0 0
 CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
 JOINT Knee
 {
  OFFSET 0 -1 0
  CHANNELS 3 Zrotation Xrotation Yrotation
  End Site
  {
   OFFSET 0 -1 0
  }
 }
}
MOTION
Frames: 2
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
1 0 0 0 0 0 0 0 0
`;
export const fbx = `; FBX 7.4.0 synthetic ASCII triangle.
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}
Objects:  {
\tGeometry: 1001, "Geometry::Triangle", "Mesh" {
\t\tVertices: *9 {
\t\t\ta: -0.5,-0.5,0,0.5,-0.5,0,0,0.5,0
\t\t}
\t\tPolygonVertexIndex: *3 {
\t\t\ta: 0,1,-3
\t\t}
\t}
\tModel: 2001, "Model::Triangle", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A+",0,0,0
\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A+",0,0,0
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A+",1,1,1
\t\t}
\t}
}
Connections:  {
\tC: "OO",1001,2001
\tC: "OO",2001,0
}
`;
export function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}
export function tga(): ArrayBuffer {
  const b = new Uint8Array(18 + 16);
  b[2] = 2;
  b[12] = 2;
  b[14] = 2;
  b[16] = 32;
  b[17] = 0x28;
  b.set([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255], 18);
  return b.buffer;
}
export function dds(): ArrayBuffer {
  const b = new ArrayBuffer(128 + 8),
    v = new DataView(b);
  [0x20534444, 124, 0x81007, 4, 4, 8, 0, 1].forEach((n, i) => {
    v.setUint32(i * 4, n, true);
  });
  v.setUint32(76, 32, true);
  v.setUint32(80, 4, true);
  v.setUint32(84, 0x31545844, true);
  v.setUint32(108, 0x1000, true);
  v.setUint16(128, 0xf800, true);
  return b;
}
export function ktx(): ArrayBuffer {
  const b = new ArrayBuffer(64 + 4 + 8),
    v = new DataView(b);
  new Uint8Array(b).set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  [0x04030201, 0, 1, 0, 0x83f0, 0x1907, 4, 4, 0, 0, 1, 1, 0].forEach((n, i) => {
    v.setUint32(12 + i * 4, n, true);
  });
  v.setUint32(64, 8, true);
  v.setUint16(68, 0xf800, true);
  return b;
}
export function mdd(): ArrayBuffer {
  const b = new ArrayBuffer(40),
    v = new DataView(b);
  v.setUint32(0, 2);
  v.setUint32(4, 1);
  [0, 0.5, 0, 0, 0, 1, 2, 3].forEach((n, i) => {
    v.setFloat32(8 + i * 4, n);
  });
  return b;
}
export const cubeLut =
  'TITLE "Synthetic"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
export const threeDl = '0 1\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
export const ies =
  'IESNA:LM-63-1995\n[TEST] Synthetic\nTILT=NONE\n1 1000 1 3 1 1 1 0 0 0\n1 1 10\n0 90 180\n0\n100 100 100\n';
export const nrrd =
  'NRRD0005\ntype: ushort\ndimension: 3\nsizes: 2 2 1\nspace: left-posterior-superior\nspace directions: (1,0,0) (0,1,0) (0,0,1)\nencoding: ascii\nspace origin: (0,0,0)\n\n1 2 3 4';
export const pdb =
  'HEADER    SYNTHETIC\nATOM      1  C   GLY A   1       0.000   0.000   0.000  1.00  0.00           C  \nATOM      2  O   GLY A   1       1.000   0.000   0.000  1.00  0.00           O  \nCONECT    1    2\nEND\n';
export const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path fill="#22cc44" d="M 0 0 L 1 0 L 1 1 L 0 1 Z"/></svg>';

function joinBytes(...values: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(values.reduce((n, v) => n + v.length, 0));
  let offset = 0;
  for (const value of values) {
    out.set(value, offset);
    offset += value.length;
  }
  return out;
}
/** Own uncompressed 1x1 scanline EXR, three planar float channels. */
export function exr(): ArrayBuffer {
  const text = (value: string) => new TextEncoder().encode(value),
    u32 = (value: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, value, true);
      return b;
    };
  const floats = (...values: number[]) => {
    const b = new Uint8Array(values.length * 4),
      v = new DataView(b.buffer);
    values.forEach((n, i) => {
      v.setFloat32(i * 4, n, true);
    });
    return b;
  };
  const attr = (name: string, type: string, data: Uint8Array) =>
    joinBytes(text(`${name}\0${type}\0`), u32(data.length), data);
  const channel = (name: string) =>
    joinBytes(text(`${name}\0`), u32(2), new Uint8Array(4), u32(1), u32(1));
  const box = joinBytes(u32(0), u32(0), u32(0), u32(0));
  const header = joinBytes(
    u32(20000630),
    u32(2),
    attr(
      'channels',
      'chlist',
      joinBytes(channel('B'), channel('G'), channel('R'), new Uint8Array(1)),
    ),
    attr('compression', 'compression', new Uint8Array([0])),
    attr('dataWindow', 'box2i', box),
    attr('displayWindow', 'box2i', box),
    attr('lineOrder', 'lineOrder', new Uint8Array(1)),
    attr('pixelAspectRatio', 'float', floats(1)),
    attr('screenWindowCenter', 'v2f', floats(0, 0)),
    attr('screenWindowWidth', 'float', floats(1)),
    new Uint8Array(1),
  );
  const offset = new Uint8Array(8);
  new DataView(offset.buffer).setBigUint64(0, BigInt(header.length + 8), true);
  return joinBytes(header, offset, u32(0), u32(12), floats(0.25, 0.5, 1)).buffer as ArrayBuffer;
}
