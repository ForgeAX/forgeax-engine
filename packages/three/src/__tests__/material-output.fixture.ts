import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { saveBrowserEvidence } from './browser-evidence.fixture';
import materialOutputPartitions from './material-output-partitions.json' with { type: 'json' };
import {
  browserRendererFixture,
  comparePixels,
  displayPixels,
  readyFrames,
  verifyReplay,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

function configureOutputMaterial(
  material: THREE.Material,
  name: string,
  texture: THREE.DataTexture,
  bytes: Uint8Array,
): void {
  if (name === 'opaque-map' || name === 'cutoff' || name === 'coverage')
    (material as THREE.MeshBasicMaterial).map = texture;
  if (name === 'alpha-map') {
    for (let i = 0; i < 64; i++)
      bytes.set([Math.round((i * 255) / 63), 255 - Math.round((i * 255) / 63), 0, 255], i * 4);
    (material as THREE.MeshBasicMaterial).alphaMap = texture;
    material.transparent = true;
  }
  if (name === 'hash') {
    material.alphaHash = true;
    material.opacity = 0.5;
  }
  if (name === 'cutoff' || name === 'coverage') material.alphaTest = 0.5;
  if (name === 'coverage') material.alphaToCoverage = true;
  if (name.endsWith('premultiplied') || ['subtractive', 'multiply', 'custom'].includes(name)) {
    material.transparent = true;
    material.opacity = 0.4;
    material.premultipliedAlpha = true;
    if (name === 'additive-premultiplied') material.blending = THREE.AdditiveBlending;
    if (name === 'subtractive') material.blending = THREE.SubtractiveBlending;
    if (name === 'multiply') material.blending = THREE.MultiplyBlending;
    if (name === 'custom') {
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneMinusSrcColorFactor;
    }
  }
  if (name === 'double-sided') {
    material.transparent = true;
    material.opacity = 0.4;
    material.side = THREE.DoubleSide;
  }
}

async function verifyTextureReplacement(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  material: THREE.MeshStandardMaterial,
  previous: Uint8Array,
): Promise<void> {
  const map = material.map;
  const replacement = new THREE.DataTexture(Uint8Array.of(16, 192, 240, 255), 1, 1);
  replacement.needsUpdate = true;
  material.map = replacement;
  try {
    await readyFrames(renderer, scene, camera);
    const capture = await renderer.captureFrame(scene, camera);
    const expected = await renderReference(scene, camera);
    await saveBrowserEvidence('material-output-standard-opaque-map-rebound', capture, expected);
    const pixels = displayPixels(capture);
    comparePixels(pixels, expected);
    expect(pixels).not.toEqual(previous);
    await verifyReplay(capture);
  } finally {
    material.map = map;
    replacement.dispose();
  }
}

// Every declared case belongs to exactly one browser process, including new cases.
export function testMaterialOutputPartition(partition: 0 | 1 | 2 | 3): void {
  const rendererFor = browserRendererFixture();
  const cases = materialOutputPartitions[partition];
  if (cases === undefined) throw new Error('Material output partition is missing');
  it.each(cases)('matches WebGPU material output: %s', {
    timeout: 120000,
  }, async (caseName) => {
    const physical = caseName.startsWith('physical-');
    const standard = physical || caseName.startsWith('standard-');
    const name = caseName.replace(/^(standard|physical)-/, '');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x284860);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 5;
    const bytes = new Uint8Array(64 * 4);
    for (let i = 0; i < 64; i++) bytes.set([210, 120, 60, Math.round((i * 255) / 63)], i * 4);
    const texture = new THREE.DataTexture(bytes, 64, 1);
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    const material =
      name === 'normal'
        ? new THREE.MeshNormalMaterial()
        : physical
          ? new THREE.MeshPhysicalMaterial({ color: 0xf0a060 })
          : standard
            ? new THREE.MeshStandardMaterial({ color: 0xf0a060 })
            : new THREE.MeshBasicMaterial({ color: 0xf0a060 });
    if (standard) scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
    configureOutputMaterial(material, name, texture, bytes);
    const mesh = new THREE.Mesh(
      name === 'normal' || name === 'double-sided'
        ? new THREE.SphereGeometry(
            1.3,
            testQuality.geometry.sphereWidth,
            testQuality.geometry.sphereHeight,
          )
        : new THREE.PlaneGeometry(3, 3),
      material,
    );
    scene.add(mesh);
    const renderer = rendererFor({ antialias: name === 'coverage' });
    try {
      await renderer.init();
      await readyFrames(renderer, scene, camera, 60, async () => {
        if (renderer.inspect().receipt?.presentation === 'ready') {
          const failed = await renderer.captureFrame(scene, camera);
          await saveBrowserEvidence(`material-output-${caseName}-readiness-failure`, failed);
        }
      });
      const capture = await renderer.captureFrame(scene, camera);
      const reference = await renderReference(scene, camera, { antialias: name === 'coverage' });
      await saveBrowserEvidence(`material-output-${caseName}`, capture, reference);
      comparePixels(displayPixels(capture), reference);
      const pixels = displayPixels(capture);
      expect(pixels.some((value, index) => index % 4 !== 3 && value !== pixels[index % 4])).toBe(
        true,
      );
      await verifyReplay(capture);
      let editedParameter: 'rgb' | 'emissive' | undefined;
      if (caseName === 'opaque-map' && material instanceof THREE.MeshBasicMaterial) {
        const color = material.color;
        color.r = 0.1;
        color.g = 0.7;
        editedParameter = 'rgb';
      } else if (
        caseName === 'standard-opaque-map' &&
        material instanceof THREE.MeshStandardMaterial
      ) {
        material.emissive.setRGB(0.05, 0.25, 0.08);
        material.emissiveIntensity = 1.25;
        editedParameter = 'emissive';
      }
      if (editedParameter !== undefined) {
        await readyFrames(renderer, scene, camera);
        const edited = await renderer.captureFrame(scene, camera);
        const expected = await renderReference(scene, camera);
        await saveBrowserEvidence(
          `material-output-${caseName}-edited-${editedParameter}`,
          edited,
          expected,
        );
        comparePixels(displayPixels(edited), expected);
        expect(displayPixels(edited)).not.toEqual(pixels);
        await verifyReplay(edited);
        if (editedParameter === 'emissive' && material instanceof THREE.MeshStandardMaterial)
          await verifyTextureReplacement(renderer, scene, camera, material, displayPixels(edited));
      }
      if (name === 'double-sided') {
        material.forceSinglePass = true;
        await readyFrames(renderer, scene, camera);
        const single = await renderer.captureFrame(scene, camera);
        const expected = await renderReference(scene, camera);
        await saveBrowserEvidence(`material-output-${caseName}-single`, single, expected);
        comparePixels(displayPixels(single), expected);
        expect(displayPixels(single)).not.toEqual(pixels);
        await verifyReplay(single);
      }
    } finally {
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
    }
  });
}
