import {
  BufferGeometry,
  type Camera,
  Float32BufferAttribute,
  type Material,
  Mesh,
  type Object3D,
  OrthographicCamera,
} from 'three/src/Three.Core.js';

// Same single-triangle positions and UV convention as Three's MIT-licensed QuadMesh.
// Geometry supplies clip-space coverage without importing a runtime node graph.
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
geometry.setAttribute('uv', new Float32BufferAttribute([0, -1, 0, 1, 2, 1], 2));
const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

type QuadRenderer = {
  init(): Promise<unknown>;
  render(object: Object3D, camera: Camera): void;
};

/** Reusable fullscreen triangle using the ordinary supported material families. */
export class QuadMesh extends Mesh {
  readonly camera = camera;
  readonly isQuadMesh = true;

  constructor(material: Material) {
    super(geometry, material);
  }

  render(renderer: QuadRenderer): void {
    renderer.render(this, this.camera);
  }

  async renderAsync(renderer: QuadRenderer): Promise<void> {
    await renderer.init();
    this.render(renderer);
  }
}
