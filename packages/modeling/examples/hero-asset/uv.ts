// UV stage: low-poly part meshes -> one Model (FXEM snapshot append) -> uv.plan -> unwrap -> uv.pack -> measure,
// then a software UV layout and checker picture written to <GALLERY_OUT>/uv/.

import { EDGE_SEAM, type EditMesh, NONE } from '../../src/mesh.ts';
import { createImage, type RGB, setPixel } from '../brep-kit/image.ts';
import { savePng } from '../gallery/common.ts';

const hue = (i: number): RGB => [
  60 + ((i * 97) % 180),
  80 + ((i * 53) % 150),
  140 + ((i * 29) % 110),
];
const checker = (u: number, v: number): RGB =>
  (Math.floor(u * 32) + Math.floor(v * 32)) % 2 === 0 ? [230, 200, 90] : [40, 60, 110];

/** Rasterize every uv0 triangle over the atlas: one picture colored by island, one checker sampled via uv. */
export function uvPictures(mesh: EditMesh, islandOf: Int32Array, dir = 'uv/v1'): void {
  const N = 1024;
  const pad = 24;
  const toPix = (u: number, v: number): [number, number] => [pad + u * N, pad + (1 - v) * N];
  const pictures: [string, (f: number, u: number, v: number) => RGB][] = [
    ['uv-layout.png', (f) => hue(islandOf[f] ?? 0)],
    ['uv-checker.png', (_f, u, v) => checker(u, v)],
  ];
  for (const [name, color] of pictures) {
    const canvas = createImage(N + 2 * pad, N + 2 * pad, [16, 18, 24]);
    for (const f of mesh.faces()) {
      const uvs = mesh.faceHalves(f).map((h) => {
        const c = mesh.corner('uv0', h) as Float32Array;
        return [c[0] as number, c[1] as number];
      });
      for (let t = 1; t + 1 < uvs.length; t++) {
        const [t0, t1, t2] = [uvs[0], uvs[t], uvs[t + 1]] as [
          [number, number],
          [number, number],
          [number, number],
        ];
        const [a, b, c] = [t0, t1, t2].map((q) => toPix(q[0], q[1])) as [
          [number, number],
          [number, number],
          [number, number],
        ];
        const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(den) < 1e-12) continue;
        const minx = Math.floor(Math.min(a[0], b[0], c[0]));
        const maxx = Math.ceil(Math.max(a[0], b[0], c[0]));
        const miny = Math.floor(Math.min(a[1], b[1], c[1]));
        const maxy = Math.ceil(Math.max(a[1], b[1], c[1]));
        for (let y = miny; y <= maxy; y++)
          for (let x = minx; x <= maxx; x++) {
            const w1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
            const w2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
            const w3 = 1 - w1 - w2;
            if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
            const u = t0[0] * w1 + t1[0] * w2 + t2[0] * w3;
            const v = t0[1] * w1 + t1[1] * w2 + t2[1] * w3;
            setPixel(canvas, x, y, color(f, u, v));
          }
      }
    }
    if (name === 'uv-layout.png') drawSeams(mesh, canvas, toPix);
    savePng(`${dir}/${name}`, canvas);
  }
}

/** Both uv0 sides of every seam edge as red lines. */
function drawSeams(
  mesh: EditMesh,
  canvas: ReturnType<typeof createImage>,
  toPix: (u: number, v: number) => [number, number],
): void {
  for (const e of mesh.edges()) {
    if (((mesh.eFlags[e] as number) & EDGE_SEAM) === 0) continue;
    for (const h of [e * 2, e * 2 + 1]) {
      if (mesh.hFace[h] === NONE) continue;
      const a = mesh.corner('uv0', h) as Float32Array;
      const b = mesh.corner('uv0', mesh.hNext[h] as number) as Float32Array;
      const [x0, y0] = toPix(a[0] as number, a[1] as number);
      const [x1, y1] = toPix(b[0] as number, b[1] as number);
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        setPixel(canvas, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), [235, 40, 40]);
      }
    }
  }
}

// UV v2 pictures: the checker sampled through uv0 on the 3D low mesh, iso/front/top, seams drawn as red lines.
import { raster3d, VIEWS3 } from './raster3d.ts';
export function checkerViews(mesh: EditMesh, dir: string): void {
  for (const v of VIEWS3) {
    const img = raster3d(mesh, v, 720);
    savePng(`${dir}/checker3d-${v.name}.png`, img);
  }
}
