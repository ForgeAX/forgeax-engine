import { BufferGeometry, DataTexture, FloatType, RGBAFormat, Texture } from '@forgeax/engine/three';
import { EXRExporter } from '@forgeax/engine/three/addons/exporters/EXRExporter.js';
import { LUTImageLoader } from '@forgeax/engine/three/addons/loaders/LUTImageLoader.js';
import { type MD2Geometry, MD2Loader } from '@forgeax/engine/three/addons/loaders/MD2Loader.js';
import { PVRLoader } from '@forgeax/engine/three/addons/loaders/PVRLoader.js';
import { WorkerPool } from '@forgeax/engine/three/addons/utils/WorkerPool.js';
/** Public declarations must preserve original failure results and real fields. */
export function portableAddonTypeContracts() {
  const md2 = new MD2Loader().setPath('/models/').parse(new ArrayBuffer(68));
  // @ts-expect-error Invalid MD2 headers return undefined.
  md2.computeBoundingBox();
  if (md2 !== undefined) {
    const geometry: MD2Geometry = md2;
    geometry.animations[0]?.clone();
    geometry.computeBoundingBox();
  }
  const pvr = new PVRLoader().setPath('/images/').parse(new ArrayBuffer(52), true);
  // @ts-expect-error Unrecognized PVR headers return undefined.
  pvr.mipmaps;
  if (pvr !== undefined) pvr.mipmaps[0]?.data.byteLength;
  const lut = new LUTImageLoader().setPath('/lut/');
  lut.parse(new Uint8ClampedArray(32), 2).texture3D.dispose();
  // @ts-expect-error This declared public helper does not exist in r187.
  lut.getImageData(new Texture());
  // @ts-expect-error The runtime helper is internal and named _horz2Vert.
  lut.horz2Vert(new Texture());
  const pool = new WorkerPool(1);
  const creator: (() => Worker) | null = pool.workerCreator;
  const idle: number = pool._getIdleWorker();
  void creator;
  void idle;
  pool.queue[0]?.transfer?.length;
  // @ts-expect-error The original property is queue, never quene.
  pool.quene;
  new EXRExporter().parse(new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType));
  // @ts-expect-error Geometry is not an image or renderer export source.
  new EXRExporter().parse(new BufferGeometry());
}
