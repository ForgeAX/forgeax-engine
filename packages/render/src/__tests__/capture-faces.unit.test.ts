import { describe, expect, it } from 'vitest';
import { buildCaptureFaces } from '../capture/faces';
import type { PlanarCapture } from '../capture/planar-state';
import type { CubeCaptureWork } from '../capture/scheduler';
import { RenderTargetLayerInvalidError } from '../errors/render';
import type { CubeCaptureGraphWork } from '../record/target-capture-graph';
import type { CameraSnapshot } from '../render-contract';
import type { RenderTarget } from '../targets/contracts';
import type { RenderTargetPhysical } from '../targets/physical';

const target = (): RenderTarget => ({}) as RenderTarget;
const physical = (shape: string, layers = 1): RenderTargetPhysical =>
  ({ descriptor: { shape, depthOrArrayLayers: layers } }) as unknown as RenderTargetPhysical;
const display = { position: new Float32Array(3), world: new Float32Array(16) } as CameraSnapshot;

describe('buildCaptureFaces', () => {
  it('keys cube, planar, auxiliary and scene-input faces in capture order', () => {
    const cube = target();
    const mirror = target();
    const aux = target();
    const scene = target();
    const item = {
      target: cube,
      face: '+Y',
      candidateGeneration: 3,
      view: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      position: [1, 2, 3],
      near: 0.1,
      far: 10,
    } as unknown as CubeCaptureWork;
    const sceneWork = {
      target: scene,
      layer: 0,
      sceneInput: true,
      featureIdentity: 'sdf',
    } as unknown as CubeCaptureGraphWork;
    const planarPhysical = physical('2d');
    const faces = buildCaptureFaces({
      cube: [item],
      auxiliaryCameras: [
        { target: mirror, planarReflection: {} } as unknown as CameraSnapshot,
        { target: aux, targetLayer: 1 } as unknown as CameraSnapshot,
      ],
      planar: { physical: planarPhysical } as unknown as PlanarCapture,
      sceneInputs: [sceneWork],
      displayCamera: display,
      physicalOf: (t) => (t === aux ? physical('2d-array', 2) : physical('cube', 6)),
    });
    expect(faces.map((face) => face.key)).toEqual([
      { kind: 'cube', target: cube, layer: 2 },
      { kind: 'planar', target: mirror },
      { kind: 'auxiliary', target: aux, layer: 1 },
      { kind: 'scene-input', featureIdentity: 'sdf', target: scene },
    ]);
    expect(faces[0]?.work.candidateGeneration).toBe(3);
    expect(faces[1]?.work.physical).toBe(planarPhysical);
    expect(faces[3]?.work).toBe(sceneWork);
  });

  it('skips a planar mirror that is not due and a cube target without physical', () => {
    const mirror = target();
    const faces = buildCaptureFaces({
      cube: [{ target: target(), face: '+X' } as unknown as CubeCaptureWork],
      auxiliaryCameras: [{ target: mirror, planarReflection: {} } as unknown as CameraSnapshot],
      planar: undefined,
      sceneInputs: [],
      displayCamera: display,
      physicalOf: () => undefined,
    });
    expect(faces).toEqual([]);
  });

  it('throws a layer error for an auxiliary layer out of range', () => {
    const aux = target();
    expect(() =>
      buildCaptureFaces({
        cube: [],
        auxiliaryCameras: [{ target: aux, targetLayer: 4 } as unknown as CameraSnapshot],
        planar: undefined,
        sceneInputs: [],
        displayCamera: display,
        physicalOf: () => physical('2d-array', 2),
      }),
    ).toThrow(RenderTargetLayerInvalidError);
  });
});
