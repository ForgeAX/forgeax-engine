import * as THREE from '@forgeax/engine/three';
import { DecalGeometry } from '@forgeax/engine/three/addons/geometries/DecalGeometry.js';
import { plane } from '@forgeax/engine/three/addons/geometries/ParametricFunctions.js';
import { ParametricGeometry } from '@forgeax/engine/three/addons/geometries/ParametricGeometry.js';
import { TeapotGeometry } from '@forgeax/engine/three/addons/geometries/TeapotGeometry.js';
import { OBJLoader } from '@forgeax/engine/three/addons/loaders/OBJLoader.js';
import { EdgeSplitModifier } from '@forgeax/engine/three/addons/modifiers/EdgeSplitModifier.js';
import { SimplifyModifier } from '@forgeax/engine/three/addons/modifiers/SimplifyModifier.js';
import { TessellateModifier } from '@forgeax/engine/three/addons/modifiers/TessellateModifier.js';
export async function authoringGeometries() {
  const box = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2),
    material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(box, material);
  mesh.updateMatrixWorld();
  const imported = new OBJLoader().parse(
    'o triangle\nv -0.5 -0.5 0\nv 0.5 -0.5 0\nv 0 0.5 0\nf 1 2 3\n',
  ).children[0];
  if (!(imported instanceof THREE.Mesh)) throw Error('missing OBJ mesh');
  const geometry = imported.geometry;
  if (Array.isArray(imported.material))
    imported.material.forEach((m) => {
      m.dispose();
    });
  else imported.material.dispose();
  try {
    return {
      split: new EdgeSplitModifier().modify(box, Math.PI / 4),
      simplified: await new SimplifyModifier().modify(box, 4),
      tessellated: new TessellateModifier(0.4, 2).modify(box),
      decal: new DecalGeometry(
        mesh,
        new THREE.Vector3(0, 0, 0.5),
        new THREE.Euler(),
        new THREE.Vector3(0.8, 0.8, 0.4),
      ),
      parametric: new ParametricGeometry(plane, 4, 4)
        .rotateX(-Math.PI / 2)
        .translate(-0.5, -0.5, 0),
      teapot: new TeapotGeometry(0.5, 3),
      obj: geometry,
    };
  } finally {
    box.dispose();
    material.dispose();
  }
}
