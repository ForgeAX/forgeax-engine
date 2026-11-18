import * as THREE from '@forgeax/engine/three';
import { BoxLineGeometry } from '@forgeax/engine/three/addons/geometries/BoxLineGeometry.js';
import { ConvexGeometry } from '@forgeax/engine/three/addons/geometries/ConvexGeometry.js';
import { ParametricGeometry } from '@forgeax/engine/three/addons/geometries/ParametricGeometry.js';
import { RoundedBoxGeometry } from '@forgeax/engine/three/addons/geometries/RoundedBoxGeometry.js';
import { TextGeometry } from '@forgeax/engine/three/addons/geometries/TextGeometry.js';
import { FontLoader } from '@forgeax/engine/three/addons/loaders/FontLoader.js';
import { PLYLoader } from '@forgeax/engine/three/addons/loaders/PLYLoader.js';
import { STLLoader } from '@forgeax/engine/three/addons/loaders/STLLoader.js';
import { XYZLoader } from '@forgeax/engine/three/addons/loaders/XYZLoader.js';

export const fontData = {
  glyphs: {
    A: { ha: 1000, x_min: 0, x_max: 1000, o: 'm 0 0 l 1000 0 l 1000 1000 l 0 1000 l 0 0' },
  },
  familyName: 'SyntheticSquare',
  ascender: 1000,
  descender: 0,
  underlinePosition: 0,
  underlineThickness: 0,
  boundingBox: { xMin: 0, xMax: 1000, yMin: 0, yMax: 1000 },
  resolution: 1000,
  original_font_information: {},
};
export const stl =
  'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex -0.5 -0.5 0\nvertex 0.5 -0.5 0\nvertex 0 0.5 0\nendloop\nendfacet\nendsolid triangle';
export const ply =
  'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n-0.5 -0.5 0\n0.5 -0.5 0\n0 0.5 0\n3 0 1 2\n';
export function addonGeometries() {
  return {
    rounded: new RoundedBoxGeometry(1, 1, 1, 2, 0.12),
    parametric: new ParametricGeometry(
      (u, v, out) => out.set(u - 0.5, v - 0.5, Math.sin(u * Math.PI) * 0.2),
      8,
      8,
    ),
    convex: new ConvexGeometry([
      new THREE.Vector3(-0.5, -0.5, 0),
      new THREE.Vector3(0.5, -0.5, 0),
      new THREE.Vector3(0, 0.5, 0),
      new THREE.Vector3(0, 0, 0.5),
    ]),
    text: new TextGeometry('A', {
      font: new FontLoader().parse(fontData),
      size: 1,
      depth: 0.2,
      bevelEnabled: false,
      curveSegments: 2,
    }).translate(-0.5, -0.5, 0),
    stl: new STLLoader().parse(stl),
    ply: new PLYLoader().parse(ply),
    lines: new BoxLineGeometry(1, 1, 1, 2, 2, 2),
    points: new XYZLoader().parse('-0.4 -0.4 0 255 0 0\n0.4 -0.4 0 0 255 0\n0 0.4 0 0 0 255'),
  };
}
