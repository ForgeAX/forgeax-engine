import { decodeImage, toRgba8 } from '@forgeax/engine/rhi-debug';
import * as THREE from '@forgeax/engine/three';
import { MapControls } from '@forgeax/engine/three/addons/controls/MapControls.js';
import { LoftGeometry } from '@forgeax/engine/three/addons/geometries/LoftGeometry.js';
import { RoundedBoxGeometry } from '@forgeax/engine/three/addons/geometries/RoundedBoxGeometry.js';
import { MeshSurfaceSampler } from '@forgeax/engine/three/addons/math/MeshSurfaceSampler.js';
import { OBB } from '@forgeax/engine/three/addons/math/OBB.js';
import { mergeGeometries } from '@forgeax/engine/three/addons/utils/BufferGeometryUtils.js';
import { clone } from '@forgeax/engine/three/addons/utils/SkeletonUtils.js';
import { CheckList, defineFeature } from '../../lab/feature';

function yellowCenter(pixels: Uint8Array) {
  let count = 0,
    x = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 200 && (pixels[i + 1] ?? 0) > 200 && (pixels[i + 2] ?? 0) < 20) {
      count++;
      x += (i / 4) % 128;
    }
  }
  return { count, x: x / count };
}

export default defineFeature({
  title: 'Three.js compatibility',
  catalog: 'Three.js compatibility',
  kind: 'probe',
  summary:
    'Ordinary Three.js r187 scene objects, RGB vertex-colored Points and direct material and bound userData references, Physical uniforms and shared Sprite material-instance position/rotation/scale inputs render through ForgeAX. CanvasTarget shares the same canvas size and DPR authority. This probe owns and retires an independent renderer; the package example provides interactive controls.',
  expect:
    'At least 60 ready GPU frames complete, a captured green cube has real colored pixels, and changing the same material to red changes the captured output. This is bounded compatibility, not full Three conformance.',
  setup() {
    return {
      async checks() {
        const checks = new CheckList();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        const renderer = new THREE.WebGPURenderer({ canvas });
        const loft = new LoftGeometry(
          [-0.85, 0.85].map((z) => [
            new THREE.Vector3(-0.4, -0.85, z),
            new THREE.Vector3(0.4, -0.85, z),
            new THREE.Vector3(0.4, 0.85, z),
            new THREE.Vector3(-0.4, 0.85, z),
          ]),
          { capStart: true, capEnd: true },
        );
        checks.ok(
          'LoftGeometry retains the public geometry family',
          loft instanceof THREE.BufferGeometry,
        );
        const left = loft.toNonIndexed().translate(-0.5, 0, 0);
        loft.dispose();
        const right = new RoundedBoxGeometry(0.8, 1.7, 1.7, 2, 0.06).translate(0.5, 0, 0);
        const geometry = mergeGeometries([left, right]);
        left.dispose();
        right.dispose();
        if (geometry === null) throw new Error('CPU addon geometry merge failed');
        checks.ok(
          'merged geometry uses the public constructor',
          geometry instanceof THREE.BufferGeometry,
        );
        checkAddonBounds(checks, geometry);
        const tint = THREE.TSL.materialReference('tint', 'color');
        const material = new THREE.MeshPhysicalNodeMaterial({ color: 0x110000 });
        material.colorNode = tint;
        Reflect.set(material, 'tint', new THREE.Color(0x20dd40));
        const parameters = { glow: new THREE.Color(0.01, 0.08, 0.02) };
        const glow = THREE.TSL.userData('glow', 'color', parameters);
        material.emissiveNode = glow;
        const film = THREE.TSL.uniform(0.4);
        material.iridescenceNode = film;
        checks.ok(
          'NodeMaterial retains its original public base',
          material instanceof THREE.NodeMaterial,
        );
        const scene = new THREE.Scene(),
          camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
        camera.position.z = 5;
        const controls = new MapControls(camera, canvas);
        checks.ok(
          'MapControls shares the original CPU target and camera family',
          controls.target instanceof THREE.Vector3 && controls.object === camera,
        );
        controls.dispose();
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        const pointGeometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-1.2, -1.3, 0),
          new THREE.Vector3(0, -1.3, 0),
          new THREE.Vector3(1.2, -1.3, 0),
        ]);
        pointGeometry.setAttribute(
          'color',
          new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3),
        );
        const pointMaterial = new THREE.PointsMaterial({
          size: 1,
          sizeAttenuation: false,
          vertexColors: true,
        });
        scene.add(new THREE.Points(pointGeometry, pointMaterial));
        const labelDefinition = new THREE.SpriteNodeMaterial({ color: 0xffff00 });
        const labelPosition = THREE.TSL.uniform(new THREE.Vector3(0.1, 0, 0));
        const labelRotation = THREE.TSL.uniform(0.3);
        const labelScale = THREE.TSL.uniform(new THREE.Vector2(0.3, 0.2));
        labelDefinition.positionNode = labelPosition;
        labelDefinition.rotationNode = labelRotation;
        labelDefinition.scaleNode = labelScale;
        const labelMaterial = new THREE.NodeMaterialInstance(labelDefinition);
        checks.ok(
          'Sprite instance shares its original definition and inputs',
          labelMaterial.nodeMaterial === labelDefinition && labelMaterial.scaleNode === labelScale,
        );
        const label = new THREE.Sprite(labelMaterial);
        label.position.set(-1.4, 1.2, 0);
        scene.add(label);
        scene.add(new THREE.AmbientLight(0xffffff, 1));
        const copied = clone(scene),
          copiedMesh = copied.children[0];
        checks.ok(
          'cloned mesh preserves the public family and shared geometry',
          copiedMesh instanceof THREE.Mesh && copiedMesh.geometry === geometry,
        );
        const point = new THREE.Vector3();
        new MeshSurfaceSampler(mesh)
          .setRandomGenerator(() => 0.25)
          .build()
          .sample(point);
        checks.ok(
          'CPU sampler writes a finite source position',
          point.toArray().every(Number.isFinite),
        );
        try {
          await renderer.init();
          checkDefaultFramebufferState(checks, renderer);
          const target = new THREE.CanvasTarget(canvas);
          target.setDrawingBufferSize(64, 64, 2);
          renderer.setCanvasTarget(target);
          checks.ok('canvas target retains public identity', renderer.getCanvasTarget() === target);
          checks.equal('renderer reads target DPR', renderer.getPixelRatio(), 2);
          checks.equal(
            'renderer reads target logical width',
            renderer.getSize(new THREE.Vector2()).x,
            64,
          );

          let completed = 0;
          const deadline = performance.now() + 120_000;
          while (completed < 60) {
            renderer.render(scene, camera);
            const receipt = renderer.inspect().receipt;
            if (receipt === undefined) throw new Error('Missing native frame receipt');
            const completion = await receipt.completed;
            if (!completion.ok) throw completion.error;
            if (receipt.presentation === 'ready') completed++;
            if (performance.now() > deadline) throw new Error('Three scene readiness deadline');
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          checks.equal('ready native frames completed', completed, 60);
          const pixels = async () => {
            const capture = await renderer.captureFrame(scene, camera);
            const display = capture.observation.observations?.find(
              (entry) => entry.domain === 'final-display',
            );
            if (display === undefined)
              throw new Error('Missing receipt-bound final-display pixels');
            return toRgba8(decodeImage(display.bytes, display.metadata).unwrap());
          };
          const green = await pixels();
          checkPointColors(checks, green, pointGeometry, camera);
          Reflect.set(material, 'tint', new THREE.Color(0xdd2040));
          parameters.glow = new THREE.Color(0.08, 0.01, 0.02);
          film.value = 0.7;
          labelPosition.value.x = 0.35;
          labelRotation.value = -0.4;
          labelScale.value.set(0.25, 0.35);
          const red = await pixels();
          checks.ok(
            'direct material reference leaves the source node cache untouched',
            tint.node === null && tint.reference === null,
          );
          checks.ok(
            'bound userData reference leaves its explicit store and source cache untouched',
            glow.reference === parameters && glow.node === null,
          );
          let greenPixels = 0,
            redPixels = 0;
          for (let i = 0; i < green.length; i += 4) {
            if ((green[i + 1] ?? 0) > (green[i] ?? 0) + 30) greenPixels++;
            if ((red[i] ?? 0) > (red[i + 1] ?? 0) + 30) redPixels++;
          }
          const yellowBefore = yellowCenter(green),
            yellowAfter = yellowCenter(red);
          checks.ok(
            'captured cube is green before the edit',
            greenPixels > 100,
            `pixels=${greenPixels}`,
          );
          checks.ok('same source material becomes red', redPixels > 100, `pixels=${redPixels}`);
          checks.ok(
            'node Sprite remains visible before and after edits',
            yellowBefore.count > 20 && yellowAfter.count > 20,
          );
          checks.ok(
            'Sprite uniform edit moves the captured output',
            Math.abs(yellowAfter.x - yellowBefore.x) > 1,
          );
        } finally {
          pointGeometry.dispose();
          pointMaterial.dispose();
          geometry.dispose();
          material.dispose();
          labelMaterial.dispose();
          labelDefinition.dispose();
          await renderer.dispose();
        }
        return checks.items;
      },
    };
  },
});

function checkAddonBounds(checks: CheckList, geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  if (geometry.boundingBox === null) throw Error('missing bounds');
  const obb = new OBB().fromBox3(geometry.boundingBox);
  checks.ok(
    'CPU addon OBB shares the public vector family and contains the geometry center',
    obb.center instanceof THREE.Vector3 &&
      obb.containsPoint(geometry.boundingBox.getCenter(new THREE.Vector3())),
  );
}

function checkDefaultFramebufferState(checks: CheckList, renderer: THREE.WebGPURenderer): void {
  renderer.setRenderTarget(null, 2, 3);
  checks.ok(
    'default framebuffer selectors retain state without selecting a GPU subresource',
    renderer.getRenderTarget() === null &&
      renderer.getActiveCubeFace() === 2 &&
      renderer.getActiveMipmapLevel() === 3,
  );
}

function checkPointColors(
  checks: CheckList,
  pixels: Uint8Array,
  geometry: THREE.BufferGeometry,
  camera: THREE.PerspectiveCamera,
): void {
  const position = new THREE.Vector3();
  let visible = true;
  for (let i = 0; i < 3; i++) {
    position.fromBufferAttribute(geometry.getAttribute('position'), i).project(camera);
    const x = Math.floor((position.x * 0.5 + 0.5) * 128),
      y = Math.floor((0.5 - position.y * 0.5) * 128),
      offset = (y * 128 + x) * 4;
    let colored = false;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const sample = offset + (dy * 128 + dx) * 4;
        colored ||= (pixels[sample + i] ?? 0) > 100 && (pixels[sample + ((i + 1) % 3)] ?? 255) < 5;
      }
    visible &&= colored;
  }
  checks.ok('native Points transport RGB vertex colors at the projected positions', visible);
}
