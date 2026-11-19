import {
  AnimationClip,
  Color,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from '@forgeax/engine/three';
import * as interaction from '@forgeax/engine/three/addons/interactive/InteractiveGroup.js';
import { NRRDLoader } from '@forgeax/engine/three/addons/loaders/NRRDLoader.js';
import { MD2CharacterComplex } from '@forgeax/engine/three/addons/misc/MD2CharacterComplex.js';
import { MorphAnimMesh } from '@forgeax/engine/three/addons/misc/MorphAnimMesh.js';
import { MorphBlendMesh } from '@forgeax/engine/three/addons/misc/MorphBlendMesh.js';
import { TubePainter } from '@forgeax/engine/three/addons/misc/TubePainter.js';
import { Volume } from '@forgeax/engine/three/addons/misc/Volume.js';
import { VolumeSlice } from '@forgeax/engine/three/addons/misc/VolumeSlice.js';
import { MarchingCubes } from '@forgeax/engine/three/addons/objects/MarchingCubes.js';

export function proceduralAddonTypeContracts(
  canvas: HTMLCanvasElement,
  offscreen: OffscreenCanvas,
) {
  AnimationClip.CreateFromMorphTargetSequence('idle', [{ name: 'idle0' }], 3);
  AnimationClip.CreateClipsFromMorphTargetSequences([{ name: 'idle0' }], 3);
  // @ts-expect-error Every morph target needs a name.
  AnimationClip.CreateFromMorphTargetSequence('idle', [{}], 3);
  const painter = new TubePainter();
  painter.moveTo(new Vector3());
  painter.lineTo(new Vector3(1, 0, 0));
  painter.setSize(2);
  painter.setColor(new Color('red'));
  painter.update();
  // @ts-expect-error The runtime does not expose its private stroke helper.
  painter.stroke();
  // @ts-expect-error The runtime does not expose this historical helper.
  painter.updateGeometry(0, 1);
  const cubes = new MarchingCubes(8, [new MeshBasicMaterial()]);
  cubes.update();
  cubes.colorArray?.at(0);
  // @ts-expect-error This historical method is absent, including after fluent calls.
  cubes.translateX(1).generateGeometry();
  // @ts-expect-error Optional output is not allocated unless colors are enabled.
  cubes.colorArray.at(0);
  new MorphAnimMesh();
  new MorphAnimMesh(undefined, [new MeshBasicMaterial()]);
  const character = new MD2CharacterComplex();
  character.animations = { idle: 'stand', move: 'run' };
  character.meshBody?.animationsMap.idle?.duration;
  const blend = new MorphBlendMesh(cubes.geometry, [new MeshBasicMaterial()]);
  blend.animationsMap.idle?.weight;
  // @ts-expect-error An animation configuration is a name map, not an array.
  character.animations = [];
  const volume = new Volume(2, 2, 1, 'uint8', new ArrayBuffer(4));
  volume.map((v, i, data) => v + (i < data.length ? 1 : 0));
  volume.map(
    function (v) {
      return v * this.scale;
    },
    { scale: 2 },
  );
  // @ts-expect-error Each callback must return the replacement voxel value.
  volume.map(() => undefined);
  volume.matrix = new Matrix4();
  volume.inverseMatrix = new Matrix4();
  volume.RASDimensions = [2, 2, 1];
  const slice: VolumeSlice = volume.extractSlice('z', 0);
  slice.sliceAccess(0, 0);
  slice.matrix.makeTranslation(0, 0, 1);
  new VolumeSlice(volume).geometry.dispose();
  // @ts-expect-error A slice accessor is a function, not the historical number declaration.
  const index: number = slice.sliceAccess;
  void index;
  new NRRDLoader()
    .setPath('/volumes/')
    .parse(new ArrayBuffer(1))
    .map((v) => v * 2);
  const group = new interaction.InteractiveGroup();
  group.listenToPointerEvents({ domElement: canvas }, new PerspectiveCamera());
  // @ts-expect-error The pointer host needs a real HTMLElement with DOM listeners and bounds.
  group.listenToPointerEvents({ domElement: offscreen }, new PerspectiveCamera());
  // @ts-expect-error This upstream declaration-only class has no runtime export.
  interaction.InteractiveObject3D;
  group.disconnect();
}
