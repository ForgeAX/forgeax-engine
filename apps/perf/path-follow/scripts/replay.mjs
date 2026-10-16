import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mat4 } from '@forgeax/engine-math';
import UPNG from 'upng-js';
import { create, globals } from 'webgpu';
import { arcOracle } from '../../../../packages/path/bench/oracle.mjs';
import {
  bindingReadRequest,
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '../../../../packages/rhi-debug/dist/index.mjs';
import * as webgpu from '../../../../packages/rhi-webgpu/dist/index.mjs';
import { writeReferencePng } from '../../../shared/png-codec.mjs';

const directory = resolve(process.env.FORGEAX_PATH_EVIDENCE ?? 'artifacts/path-follow');
await mkdir(resolve(directory, 'replay'), { recursive: true });
Object.assign(globalThis, globals);
Object.defineProperty(globalThis, 'navigator', {
  value: { gpu: create(process.platform === 'darwin' ? ['backend=metal'] : []) },
  configurable: true,
});
const capture = JSON.parse(await readFile(resolve(directory, 'capture.json'), 'utf8')),
  rows = [];
try {
  for (const source of capture.rows) {
    const bytes = new Uint8Array(await readFile(resolve(directory, `${source.phase}.rhitape`)));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== source.digest) throw new Error('Tape digest mismatch');
    const tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap(),
      limits = {};
    for (const key in adapter.limits)
      if (typeof adapter.limits[key] === 'number') limits[key] = adapter.limits[key];
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, limits))
    ).unwrap();
    const raw = device.nativeDevice().unwrap(),
      errors = [];
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const opened = await openReplay(tape, {
      device,
      createShaderModule: webgpu.createShaderModule,
    });
    if (!opened.ok) {
      raw.destroy();
      throw new Error(JSON.stringify(opened.error));
    }
    const session = opened.value;
    try {
      await writeFile(
        resolve(directory, 'replay', `${source.phase}-model.json`),
        `${JSON.stringify(model, null, 2)}\n`,
      );
      const meshWorks = model.works.filter(
        (work) =>
          work.kind.startsWith('drawIndexed') &&
          work.pipeline.shaders.some(
            (shader) =>
              shader.stage === 'vertex' &&
              shader.entryPoint === 'vs_main' &&
              shader.source?.includes('fn unlitVertex'),
          ),
      );
      if (!meshWorks.length) throw new Error('No actual unlit mesh draws');
      const last = model.works.findLast((work) => work.attachments?.colorViewHandleIds.length);
      if (!last) throw new Error('No color-producing work');
      const attachment =
        last.attachments.colorResolveViewHandleIds[0] ?? last.attachments.colorViewHandleIds[0];
      const requests = [],
        meshReads = [];
      function request(read) {
        const index = requests.length;
        requests.push(read);
        return index;
      }
      for (const work of meshWorks) {
        if (work.pipeline.status !== 'available') throw new Error('Mesh pipeline unavailable');
        const shader = work.pipeline.shaders.find((shader) => shader.stage === 'vertex').source;
        // Decode exactly the vertex shader's current root and selected instance rows.
        // Searching an entire GPU buffer can accidentally accept an unused history row.
        const declared = (group) =>
          shader.match(
            new RegExp(
              `@group\\(${group}\\)\\s+@binding\\(0\\)\\s+var<[^>]+>\\s+(\\w+):\\s+array<(\\w+)`,
            ),
          );
        const rootABI = declared(2),
          instanceABI = declared(3);
        const body = shader.match(/fn unlitVertex\(.*?(?=\nfn |\n@)/s)?.[0];
        if (
          !rootABI ||
          !instanceABI ||
          !body?.includes(`${rootABI[1]}[0].worldFromLocal`) ||
          !new RegExp(`${instanceABI[1]}\\[\\w+\\]\\.localFromInstance`).test(body)
        )
          throw new Error(`Unsupported bound transform ABI at work ${work.workIndex}`);
        const structure = (name) =>
          shader.match(new RegExp(`struct ${name}\\s*\\{([^}]+)\\}`))?.[1];
        const rootBody = structure(rootABI[2]),
          instanceBody = structure(instanceABI[2]);
        if (
          !rootBody?.trim().startsWith('worldFromLocal: mat4x4<f32>') ||
          !instanceBody?.trim().startsWith('localFromInstance: mat4x4<f32>')
        )
          throw new Error('Current transform is not the first bound field');
        const stride = instanceBody.includes('previousLocalFromInstance') ? 128 : 64;
        if (instanceBody.includes('region')) throw new Error('Unexpected sprite instance ABI');
        const root = request(bindingReadRequest(work, 2, 0).unwrap());
        const local = request(bindingReadRequest(work, 3, 0).unwrap());
        const indirect =
          work.kind === 'drawIndexedIndirect'
            ? request({
                resourceId: work.drawCall.indirectBufferHandleId,
                workIndex: work.workIndex,
                subresource: { offset: work.drawCall.indirectOffset, size: 20 },
              })
            : null;
        meshReads.push({ work, root, local, indirect, stride });
      }
      const cameraBinding = meshWorks[0].bindings.find(
        (binding) => binding.groupIndex === 0 && binding.binding === 0,
      );
      const cameraRead = request(bindingReadRequest(meshWorks[0], 0, 0).unwrap());
      const outputRead = request({ resourceId: attachment, workIndex: last.workIndex });
      const reads = (await session.readAtWorks(requests)).unwrap().map((result) => result.unwrap());
      const boundMatrices = [];
      function matrixAt(resource, offset) {
        if (offset < 0 || offset + 64 > resource.bytes.length)
          throw new Error('Selected matrix exceeds actual bound window');
        const view = new DataView(
          resource.bytes.buffer,
          resource.bytes.byteOffset,
          resource.bytes.byteLength,
        );
        return Float32Array.from({ length: 16 }, (_, i) => view.getFloat32(offset + i * 4, true));
      }
      for (const { work, root, local, indirect, stride } of meshReads) {
        let first = work.drawCall.firstInstance,
          count = work.drawCall.instanceCount;
        if (indirect !== null) {
          const args = reads[indirect].bytes;
          const view = new DataView(args.buffer, args.byteOffset, args.byteLength);
          first = view.getUint32(16, true);
          count = view.getUint32(4, true);
        }
        if (!Number.isInteger(first) || !Number.isInteger(count))
          throw new Error('Actual draw instance range absent');
        for (let ordinal = first; ordinal < first + count; ordinal++) {
          const matrix = mat4.multiply(
            mat4.create(),
            matrixAt(reads[root], 0),
            matrixAt(reads[local], ordinal * stride),
          );
          const rootBinding = work.bindings.find(
            (binding) => binding.groupIndex === 2 && binding.binding === 0,
          );
          const localBinding = work.bindings.find(
            (binding) => binding.groupIndex === 3 && binding.binding === 0,
          );
          boundMatrices.push({
            matrix,
            workIndex: work.workIndex,
            root: {
              resourceId: rootBinding.resourceId,
              offset: (rootBinding.bufferOffset ?? 0) + (rootBinding.dynamicOffset ?? 0),
            },
            instance: {
              resourceId: localBinding.resourceId,
              offset:
                (localBinding.bufferOffset ?? 0) +
                (localBinding.dynamicOffset ?? 0) +
                ordinal * stride,
              ordinal,
              stride,
            },
          });
        }
      }
      const oracle = arcOracle({ points: source.snapshot.path, closed: true, parameterization: 1 });
      const checked = [];
      for (const follower of source.snapshot.followers.filter((row) =>
        row.name.startsWith('patrol'),
      )) {
        const t = oracle.parameterAtDistance(follower.distance),
          point = oracle.point(t),
          tangent = oracle.tangent(t);
        const positionError = Math.hypot(
          ...point.map((value, index) => value - follower.matrix[12 + index]),
        );
        const forward = follower.matrix.slice(8, 11),
          length = Math.hypot(...forward),
          forwardDot = forward.reduce(
            (sum, value, index) => sum + (value / length) * tangent[index],
            0,
          );
        if (positionError > 0.005 || forwardDot < 0.9999)
          throw new Error(
            `Independent pose oracle failed for ${follower.name}: ${positionError}, ${forwardDot}`,
          );
        const match = boundMatrices.find((row) =>
          row.matrix.every((value, i) => Math.abs(value - follower.matrix[i]) <= 1e-5),
        );
        const found = match
          ? {
              workIndex: match.workIndex,
              root: match.root,
              instance: match.instance,
              maxMatrixError: Math.max(
                ...match.matrix.map((value, i) => Math.abs(value - follower.matrix[i])),
              ),
            }
          : undefined;
        checked.push({
          name: follower.name,
          positionError,
          forwardDot,
          boundMatrix: found ?? null,
        });
      }
      if (
        checked.filter((row) => row.boundMatrix).length <
        (['camera', 'closeup'].includes(source.phase) ? 1 : 8)
      )
        throw new Error('Expected patrol matrices absent from actual bound mesh resources');
      const cameraResource = reads[cameraRead];
      const view = new DataView(
          cameraResource.bytes.buffer,
          cameraResource.bytes.byteOffset,
          cameraResource.bytes.byteLength,
        ),
        offset = 0;
      const cameraMatrix = Float32Array.from(source.snapshot.cameraMatrix),
        inverse = mat4.invert(mat4.create(), cameraMatrix),
        projection = mat4.perspectiveReverseZ(
          mat4.create(),
          source.snapshot.camera.fov,
          source.snapshot.camera.aspect,
          source.snapshot.camera.near,
          source.snapshot.camera.far,
        ),
        expected = mat4.multiply(mat4.create(), projection, inverse);
      const actual = Array.from({ length: 16 }, (_, i) => view.getFloat32(offset + i * 4, true));
      const cameraError = Math.max(...actual.map((value, i) => Math.abs(value - expected[i])));
      if (cameraError > 1e-4)
        throw new Error(`Bound camera matrix differs from Scene camera: ${cameraError}`);
      const output = reads[outputRead],
        rgba = output.bytes.slice();
      if (output.format.startsWith('bgra'))
        for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
      const liveBytes = await readFile(resolve(directory, `${source.phase}-canvas.png`)),
        decoded = UPNG.decode(
          liveBytes.buffer.slice(liveBytes.byteOffset, liveBytes.byteOffset + liveBytes.byteLength),
        ),
        live = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
      if (decoded.width !== output.width || decoded.height !== output.height)
        throw new Error('Replay extent mismatch');
      let total = 0,
        max = 0;
      const histogram = new Uint32Array(256);
      for (let i = 0; i < rgba.length; i++) {
        const difference = Math.abs(rgba[i] - live[i]);
        total += difference;
        max = Math.max(max, difference);
        histogram[difference]++;
      }
      const quantile = (p) => {
        let seen = 0;
        for (let i = 0; i < 256; i++) {
          seen += histogram[i];
          if (seen >= rgba.length * p) return i / 255;
        }
        return 1;
      };
      const parity = {
        mean: total / rgba.length / 255,
        p95: quantile(0.95),
        p99: quantile(0.99),
        max: max / 255,
      };
      if (parity.mean > 0.05 || parity.p99 > 0.05 || errors.length)
        throw new Error(JSON.stringify({ parity, errors }));
      await writeFile(
        resolve(directory, 'replay', `${source.phase}.png`),
        writeReferencePng(rgba, output.width, output.height),
      );
      rows.push({
        phase: source.phase,
        digest,
        sourceDigest: source.sourceDigest,
        tick: source.snapshot.tick,
        workCount: model.works.length,
        resourceCount: model.resources.length,
        checked,
        camera: {
          workIndex: meshWorks[0].workIndex,
          resourceId: cameraBinding.resourceId,
          offset: (cameraBinding.bufferOffset ?? 0) + (cameraBinding.dynamicOffset ?? 0),
          actual,
          expected: Array.from(expected),
          maxError: cameraError,
        },
        parity,
        errors,
        features: Array.from(adapter.features),
      });
    } finally {
      (await session.dispose()).unwrap();
      raw.destroy();
    }
  }
  await writeFile(
    resolve(directory, 'replay', 'report.json'),
    `${JSON.stringify({ status: 'pass', rows }, null, 2)}\n`,
  );
} catch (error) {
  await writeFile(
    resolve(directory, 'replay', 'failure.json'),
    JSON.stringify({ status: 'failed', error: String(error), stack: error?.stack, rows }, null, 2) +
      '\n',
  );
  throw error;
}
