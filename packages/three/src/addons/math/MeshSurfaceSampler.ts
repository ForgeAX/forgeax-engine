import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';

// The pinned r187 runtime implements this fluent method; @types omits it.
declare module 'three/examples/jsm/math/MeshSurfaceSampler.js' {
  interface MeshSurfaceSampler {
    setRandomGenerator(randomFunction: () => number): this;
  }
}

export { MeshSurfaceSampler };
