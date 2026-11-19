import {
  BoxGeometry,
  CubeTexture,
  DataTexture,
  FloatType,
  Group,
  Mesh,
} from '@forgeax/engine/three';
import { HDRCubeTextureLoader } from '@forgeax/engine/three/addons/loaders/HDRCubeTextureLoader.js';
import { KMZLoader } from '@forgeax/engine/three/addons/loaders/KMZLoader.js';
import { UVsDebug } from '@forgeax/engine/three/addons/utils/UVsDebug.js';
import { WorkerPool } from '@forgeax/engine/three/addons/utils/WorkerPool.js';
import { strToU8, zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { portableCollada } from './portable-addons.fixture';

export async function portableBrowserAddons() {
  const geometry = new BoxGeometry();
  let cube: CubeTexture | undefined;
  const pool = new WorkerPool(1);
  const workers: Worker[] = [];
  const workerUrl = URL.createObjectURL(
    new Blob(
      [
        'onmessage = e => { const a = new Uint8Array(e.data.buffer); a[0] += e.data.add; postMessage({id:e.data.id,buffer:e.data.buffer},[e.data.buffer]); };',
      ],
      { type: 'text/javascript' },
    ),
  );
  const buffers = [new Uint8Array([1, 2]), new Uint8Array([10, 20])];
  pool.setWorkerCreator(() => {
    const w = new Worker(workerUrl);
    workers.push(w);
    return w;
  });
  try {
    const jobs = buffers.map((bytes, id) =>
      pool.postMessage({ id, add: 3, buffer: bytes.buffer }, [bytes.buffer]),
    );
    const detached = buffers.map((bytes) => bytes.byteLength);
    const queued = pool.queue.length;
    const responses = await Promise.all(jobs);
    const workerValues = responses.map((event) => {
      const data = event.data as { id: number; buffer: ArrayBuffer };
      return { id: data.id, bytes: Array.from(new Uint8Array(data.buffer)) };
    });
    const workerCount = workers.length;
    pool.dispose();
    const afterDispose = {
      workers: pool.workers.length,
      queue: pool.queue.length,
      status: pool.workerStatus,
    };
    const canvas = UVsDebug(geometry, 128);
    document.body.append(canvas);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('UV debug requires a real Canvas2D');
    const pixels = context.getImageData(0, 0, 128, 128).data;
    let darkPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if ((pixels[i] ?? 255) < 128) darkPixels++;
    canvas.remove();
    const zip = zipSync({
      'doc.kml': strToU8(
        '<kml><Placemark><Model><Link><href>models/a.dae</href></Link></Model></Placemark></kml>',
      ),
      'models/a.dae': strToU8(portableCollada),
    });
    const archive = Uint8Array.from(zip).buffer;
    const scene = new KMZLoader().parse(archive).scene;
    const sceneIdentity = scene instanceof Group;
    let vertices = 0;
    scene.traverse((object) => {
      if (object instanceof Mesh) {
        vertices += object.geometry.getAttribute('position').count;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const m of materials) m.dispose();
      }
    });
    const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n');
    const urls = Array.from({ length: 6 }, (_, i) => {
      const bytes = new Uint8Array(header.length + 4);
      bytes.set(header);
      bytes.set([128 + i * 16, 64, 32, 129], header.length);
      return `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}`;
    });
    cube = await new HDRCubeTextureLoader().setDataType(FloatType).loadAsync(urls);
    const cubeIdentity = cube instanceof CubeTexture;
    const faces = cube.images.map((face) => {
      if (!(face instanceof DataTexture)) throw new Error('HDR cube face is not a DataTexture');
      return {
        native: true,
        width: face.image.width,
        height: face.image.height,
        red: face.image.data?.[0],
      };
    });
    return {
      detached,
      queued,
      workerValues,
      workerCount,
      afterDispose,
      canvasSize: [canvas.width, canvas.height],
      darkPixels,
      sceneIdentity,
      vertices,
      cubeIdentity,
      faces,
    };
  } finally {
    pool.dispose();
    URL.revokeObjectURL(workerUrl);
    geometry.dispose();
    for (const face of cube?.images ?? []) if (face instanceof DataTexture) face.dispose();
    cube?.dispose();
  }
}
