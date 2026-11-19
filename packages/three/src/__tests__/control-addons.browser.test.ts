import * as THREE from '@forgeax/engine/three';
import { ArcballControls } from '@forgeax/engine/three/addons/controls/ArcballControls.js';
import { DragControls } from '@forgeax/engine/three/addons/controls/DragControls.js';
import { FirstPersonControls } from '@forgeax/engine/three/addons/controls/FirstPersonControls.js';
import { FlyControls } from '@forgeax/engine/three/addons/controls/FlyControls.js';
import { MapControls } from '@forgeax/engine/three/addons/controls/MapControls.js';
import { PointerLockControls } from '@forgeax/engine/three/addons/controls/PointerLockControls.js';
import { TrackballControls } from '@forgeax/engine/three/addons/controls/TrackballControls.js';
import { TransformControls } from '@forgeax/engine/three/addons/controls/TransformControls.js';
import { SelectionHelper } from '@forgeax/engine/three/addons/interactive/SelectionHelper.js';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import {
  comparePixels,
  displayPixels,
  readyFrames,
  testScene,
  verifyReplay,
} from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

function canvasHost() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  document.body.append(canvas);
  return canvas;
}
function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number) {
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: r.left + x,
      clientY: r.top + y,
    }),
  );
}
function key(type: string) {
  window.dispatchEvent(new KeyboardEvent(type, { code: 'KeyW', key: 'w', bubbles: true }));
}
function navigation(mode: string, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
  if (mode === 'fly') {
    const control = new FlyControls(camera, canvas);
    return {
      control,
      act: () => {
        key('keydown');
        control.update(0.25);
        key('keyup');
      },
    };
  }
  if (mode === 'first-person') {
    const control = new FirstPersonControls(camera, canvas);
    control.dampingFactor = 1;
    control.lookSpeed = 0;
    return {
      control,
      act: () => {
        key('keydown');
        control.update(0.25);
        key('keyup');
      },
    };
  }
  if (mode === 'pointer-lock') {
    const control = new PointerLockControls(camera, canvas);
    return {
      control,
      act: () => {
        control.moveForward(0.4);
        control.moveRight(0.2);
      },
    };
  }
  const control =
    mode === 'map'
      ? new MapControls(camera, canvas)
      : mode === 'trackball'
        ? new TrackballControls(camera, canvas)
        : new ArcballControls(camera, canvas);
  if (control instanceof MapControls) control.enableDamping = false;
  if (control instanceof TrackballControls) control.staticMoving = true;
  if (control instanceof ArcballControls) control.enableAnimations = false;
  return {
    control,
    act: () => {
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
      );
      control.update();
    },
  };
}
for (const mode of ['map', 'trackball', 'arcball', 'fly', 'first-person', 'pointer-lock'])
  it(`renders source camera motion from ${mode} controls`, { timeout: 120000 }, async () => {
    const canvas = canvasHost(),
      s = testScene(),
      input = navigation(mode, s.camera, canvas),
      renderer = new THREE.WebGPURenderer({ canvas });
    try {
      expect(input.control).toBeInstanceOf(THREE.Controls);
      await renderer.init();
      await readyFrames(renderer, s.scene, s.camera, 60);
      const before = await renderer.captureFrame(s.scene, s.camera);
      const position = s.camera.position.clone();
      input.act();
      expect(s.camera.position.distanceTo(position)).toBeGreaterThan(0.01);
      const after = await renderer.captureFrame(s.scene, s.camera),
        reference = await renderReference(s.scene, s.camera);
      await saveBrowserEvidence(`r187-controls-${mode}`, after, reference);
      comparePixels(displayPixels(after), reference);
      expect(equalBytes(displayPixels(before), displayPixels(after))).toBe(false);
      await verifyReplay(after, `r187-controls-${mode}`);
    } finally {
      input.control.dispose();
      s.mesh.geometry.dispose();
      s.material.dispose();
      await renderer.dispose();
      canvas.remove();
    }
  });
it('renders real pointer-drag edits and retires DOM selection listeners', {
  timeout: 120000,
}, async () => {
  const canvas = canvasHost(),
    s = testScene(),
    renderer = new THREE.WebGPURenderer({ canvas }),
    control = new DragControls([s.mesh], s.camera, canvas);
  try {
    await renderer.init();
    await readyFrames(renderer, s.scene, s.camera, 60);
    const before = await renderer.captureFrame(s.scene, s.camera);
    pointer(canvas, 'pointermove', 64, 64);
    pointer(canvas, 'pointerdown', 64, 64);
    pointer(canvas, 'pointermove', 82, 64);
    pointer(canvas, 'pointerup', 82, 64);
    expect(s.mesh.position.x).toBeGreaterThan(0.2);
    const frame = await renderer.captureFrame(s.scene, s.camera),
      reference = await renderReference(s.scene, s.camera);
    await saveBrowserEvidence('r187-controls-drag', frame, reference);
    comparePixels(displayPixels(frame), reference);
    expect(equalBytes(displayPixels(before), displayPixels(frame))).toBe(false);
    await verifyReplay(frame, 'r187-controls-drag');
    control.dispose();
    const selection = new SelectionHelper({ domElement: canvas }, 'selection-test');
    pointer(canvas, 'pointerdown', 10, 20);
    pointer(canvas, 'pointermove', 40, 55);
    expect(selection.isDown).toBe(true);
    expect(selection.element.parentElement).toBe(canvas.parentElement);
    expect(selection.element.style.width).toBe('30px');
    expect(selection.element.style.height).toBe('35px');
    pointer(canvas, 'pointerup', 40, 55);
    expect(selection.element.isConnected).toBe(false);
    selection.dispose();
    pointer(canvas, 'pointerdown', 10, 20);
    expect(selection.isDown).toBe(false);
    expect(selection.element.isConnected).toBe(false);
  } finally {
    control.dispose();
    s.mesh.geometry.dispose();
    s.material.dispose();
    await renderer.dispose();
    canvas.remove();
  }
});
it('keeps TransformControls attachment explicit and rejects unsupported native gizmo ordering', {
  timeout: 120000,
}, async () => {
  const canvas = canvasHost(),
    s = testScene(),
    control = new TransformControls(s.camera, canvas),
    renderer = new THREE.WebGPURenderer({ canvas });
  try {
    control.attach(s.mesh);
    control.setMode('translate');
    control.setSpace('world');
    control.setTranslationSnap(0.25);
    expect(control.object).toBe(s.mesh);
    expect(control.translationSnap).toBe(0.25);
    const helper = control.getHelper();
    expect(helper).toBeInstanceOf(THREE.Object3D);
    s.scene.add(helper);
    await renderer.init();
    expect(() => renderer.render(s.scene, s.camera)).toThrow(/three-(invalid-value|unsupported)/);
    s.scene.remove(helper);
    control.detach();
    await readyFrames(renderer, s.scene, s.camera, 60);
    const frame = await renderer.captureFrame(s.scene, s.camera);
    await verifyReplay(frame, 'r187-transform-gizmo-recovery');
  } finally {
    control.dispose();
    s.mesh.geometry.dispose();
    s.material.dispose();
    await renderer.dispose();
    canvas.remove();
  }
});
