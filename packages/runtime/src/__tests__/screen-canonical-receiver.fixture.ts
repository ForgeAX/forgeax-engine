import { Transform } from '@forgeax/engine-scene';
import type { MeshAsset } from '@forgeax/engine-types';
import { assert } from 'vitest';
import { createProbeGlobalMesh } from '../../../render/src/__tests__/raytracing/probe-global.fixture';
import { SCREEN_PROBE_RECORD_BYTES } from '../../../render/src/raytracing/screen-probe-plan';
import {
  exactReceiverPoint,
  type Fraction,
  type ReceiverCase,
  receiverContains,
} from '../../../shader/src/__tests__/canonical-receiver-reconstruction.fixture';
import { exactEndpointDyadic } from '../../../shader/src/__tests__/sdf-surface-exact-endpoints.fixture';
import { SCENE_HEIGHT, SCENE_WIDTH, sceneGi, sceneHarness } from './gi-scenes.fixture';
import { testAssets } from './helpers/runtime-assets';
import { observeScreenWorldHit } from './screen-canonical-world-hit.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

/** Observes the real Renderer allocations. No replacement shader, adapter,
 * queue, encoder or submit is introduced into the producer path. */
function screenReceiverBuffers(device: GPUDevice) {
  const buffers = new Map<string, GPUBuffer>();
  const uploads = new Map<string, Uint8Array>();
  const original = device.createBuffer;
  const writeBuffer = device.queue.writeBuffer;
  const writeTexture = device.queue.writeTexture;
  const createEncoder = device.createCommandEncoder;
  let beforeWorld: GPUBuffer | undefined;
  let beforeScreenHistory: GPUBuffer | undefined;
  let corruptRevision = false;
  let wrongShortcut = false;
  let source = new Uint8Array();
  device.queue.writeBuffer = function (...args) {
    if (wrongShortcut && args[0].label === 'screen-probe.frame') {
      const data = args[2];
      const bytes = (
        ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data)
      ).slice();
      new Uint32Array(bytes.buffer)[9] = 32;
      args[2] = bytes;
    }
    const result = Reflect.apply(writeBuffer, this, args);
    const [buffer, offset, data, first = 0, count] = args;
    if (
      offset === 0 &&
      (buffer.label === 'screen-probe.frame' || /^view:.*:camera$/.test(buffer.label))
    ) {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const element =
        ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data
          ? Number(data.BYTES_PER_ELEMENT)
          : 1;
      uploads.set(
        buffer.label,
        bytes.slice(first * element, count === undefined ? undefined : (first + count) * element),
      );
    }
    return result;
  };
  device.queue.writeTexture = function (...args) {
    if (corruptRevision && args[0].texture.label === 'screen-probe.receiver-source') {
      const data = args[1];
      const bytes = (
        ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data)
      ).slice();
      const words = new Uint32Array(bytes.buffer);
      words[10] = ((words[10] ?? 0) ^ 1) >>> 0;
      args[1] = bytes;
    }
    const result = Reflect.apply(writeTexture, this, args);
    const [destination, data] = args;
    if (destination.texture.label === 'screen-probe.receiver-source')
      source = (
        ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data)
      ).slice();
    return result;
  };
  device.createBuffer = function (descriptor) {
    const buffer = Reflect.apply(original, this, [descriptor]);
    if (descriptor.label?.startsWith('screen-probe.')) buffers.set(descriptor.label, buffer);
    return buffer;
  };
  device.createCommandEncoder = function (...args) {
    const encoder = Reflect.apply(createEncoder, this, args);
    const begin = encoder.beginComputePass;
    encoder.beginComputePass = function (...passArgs) {
      if (passArgs[0]?.label === 'screen-probe.trace-screen') {
        const history = buffers.get('screen-probe.previousScene');
        assert(history, 'The actual screen shortcut history must exist');
        if (beforeScreenHistory?.size !== history.size) {
          beforeScreenHistory?.destroy();
          beforeScreenHistory = device.createBuffer({ size: history.size, usage: 9 });
        }
        // Preserve the history actually read, before this frame's storeScene.
        encoder.copyBufferToBuffer(history, 0, beforeScreenHistory, 0, history.size);
      }
      if (passArgs[0]?.label === 'screen-probe.trace-world') {
        const rays = buffers.get('screen-probe.rays');
        assert(rays, 'The real graph World pass must consume its actual rays');
        if (beforeWorld?.size !== rays.size) {
          beforeWorld?.destroy();
          beforeWorld = device.createBuffer({ size: rays.size, usage: 9 });
        }
        // Copy at the real graph boundary in its SAME encoder and submit.
        // No trace is replaced/repeated and no synthetic input is installed.
        encoder.copyBufferToBuffer(rays, 0, beforeWorld, 0, rays.size);
      }
      return Reflect.apply(begin, this, passArgs);
    };
    return encoder;
  };
  return {
    setWrongRevision(value: boolean) {
      corruptRevision = value;
    },
    setWrongShortcut(value: boolean) {
      wrongShortcut = value;
    },
    async read() {
      const sources = ['probes', 'rays'].map((label) => {
        const buffer = buffers.get(`screen-probe.${label}`);
        assert(buffer, `Missing actual screen-probe.${label}`);
        assert((buffer.usage & 4) !== 0, 'Production readback requires COPY_SRC');
        return buffer;
      });
      const size = sources.reduce((sum, buffer) => sum + buffer.size, 0);
      const staging = device.createBuffer({ size, usage: 9 });
      try {
        const encoder = device.createCommandEncoder();
        let offset = 0;
        for (const buffer of sources) {
          encoder.copyBufferToBuffer(buffer, 0, staging, offset, buffer.size);
          offset += buffer.size;
        }
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(1);
        const all = staging.getMappedRange().slice(0);
        offset = 0;
        const read = sources.map((buffer) => {
          const bytes = all.slice(offset, offset + buffer.size);
          offset += buffer.size;
          return bytes;
        });
        const frame = uploads.get('screen-probe.frame');
        const views = [...uploads].filter(([label]) => /^view:.*:camera$/.test(label));
        assert(
          frame && views.length === 1 && source.length > 0,
          'One actual frame/view/source upload is required',
        );
        const view = views[0]?.[1];
        assert(view && view.byteLength >= 64);
        assert(beforeWorld, 'The default graph World boundary must really execute');
        await beforeWorld.mapAsync(1);
        const before = beforeWorld.getMappedRange().slice(0);
        beforeWorld.unmap();
        assert(beforeScreenHistory, 'The real graph screen shortcut boundary must execute');
        await beforeScreenHistory.mapAsync(1);
        read.push(beforeScreenHistory.getMappedRange().slice(0));
        beforeScreenHistory.unmap();
        return {
          read,
          before,
          frame: frame.slice().buffer,
          view: view.slice(0, 64).buffer,
          source: source.slice(),
        };
      } finally {
        staging.destroy();
      }
    },
    dispose() {
      device.createBuffer = original;
      device.queue.writeBuffer = writeBuffer;
      device.queue.writeTexture = writeTexture;
      device.createCommandEncoder = createEncoder;
      beforeWorld?.destroy();
      beforeScreenHistory?.destroy();
      beforeWorld = undefined;
      beforeScreenHistory = undefined;
      buffers.clear();
      uploads.clear();
    },
  };
}

export interface ScreenReceiverAuthoredMesh {
  readonly mesh: MeshAsset;
  readonly handle: number;
  readonly position: readonly [number, number, number];
}

/** The original 1/64-thick blocker and receiver are actual Runtime assets.
 * An oblique primary camera can see the receiver around the thin blocker;
 * secondary outgoing rays must still see the blocker. */
export async function screenCanonicalScene(manifest: string, id: string) {
  const h = await sceneHarness(manifest, id);
  const device = h.native();
  assert(device);
  const hitObserver = observeScreenWorldHit(device);
  const observed = screenReceiverBuffers(device);
  try {
    const authored: ScreenReceiverAuthoredMesh[] = [];
    for (const [dimensions, position] of [
      [
        [4, 4, 0.25],
        [0, 0, -0.125],
      ],
      [
        [0.5, 0.5, 0.015625],
        [0, 0, 0.0625],
      ],
      [
        [4, 4, 0.03125],
        [0, 0, 1],
      ],
      // A real visible +X-facing history surface beyond the thin blocker.
      // The old normal-biased origin can bypass the blocker to this surface.
      [
        [0.015625, 0.5, 0.5],
        [-0.25, 0, 0.75],
      ],
    ] as const) {
      const mesh = await createProbeGlobalMesh(...dimensions);
      const handle = testAssets(h.world).create(mesh).unwrap();
      h.spawn(handle, authored.length === 3 ? h.emissive : h.white, position);
      authored.push({ mesh, handle, position });
    }
    const yaw = Math.atan2(3, 1);
    h.world
      .set(h.camera, Transform, {
        pos: [3, 0, 1],
        quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
      })
      .unwrap();
    const gi = sceneGi('screen');
    assert(gi.gather === 'screen-probe');
    renderValue(
      h.renderer.setProfile({
        ...h.base,
        visibleSurface: false,
        diffuseGi: { ...gi, field: { ...gi.field, hardwareRayTracing: false } },
      }),
    );
    return {
      ...h,
      authored,
      setWrongReceiverRevision: observed.setWrongRevision,
      setWrongScreenShortcut: observed.setWrongShortcut,
      async receiverImage(name: string, diagnose = false) {
        // Observation and all following buffer copies belong to this completed
        // frame. No extra Renderer draw occurs between identity and transport.
        const image = await h.captureFrameImage(name);
        const raw = await observed.read();
        const [probes, rays, previousScene] = raw.read;
        const { frame, view, source, before } = raw;
        assert(probes && rays && previousScene);
        assert(probes.byteLength % SCREEN_PROBE_RECORD_BYTES === 0);
        for (const [label, bytes] of [
          ['probes', probes],
          ['rays', rays],
          ['frame', frame],
          ['previous-scene', previousScene],
        ] as const)
          h.save(`${name}-${label}.raw`, new Uint8Array(bytes));
        h.save(`${name}-actual-view.f32`, new Uint8Array(view));
        h.save(`${name}-actual-source.u32`, source);
        h.save(`${name}-before-world.raw`, new Uint8Array(before));
        const diagnostic = diagnose ? await hitObserver.dispatch(before, rays) : undefined;
        if (diagnostic) {
          h.save(`${name}-world-hit.raw`, diagnostic.bytes);
          h.save(`${name}-world-hit.json`, diagnostic.metadata);
          h.save(`${name}-world-actual.wgsl`, diagnostic.source);
          h.save(`${name}-world-diagnostic.wgsl`, diagnostic.diagnosticSource);
          for (const input of diagnostic.inputs)
            h.save(`${name}-query-binding-${input.binding}.raw`, input.data);
        }
        return { image, probes, rays, frame, view, source, before, previousScene, diagnostic };
      },
      async dispose() {
        observed.dispose();
        hitObserver.dispose();
        await h.dispose();
      },
    };
  } catch (error) {
    observed.dispose();
    hitObserver.dispose();
    await h.dispose();
    throw error;
  }
}

/** Independent BigInt world-plane solve consumes the actual GBuffer pixel,
 * selected original primitive and the actual uploaded jittered matrix. */
export function checkCanonicalReceiver(
  mesh: ScreenReceiverAuthoredMesh,
  primitive: number,
  pixel: number,
  viewProjection: readonly number[],
  probe: ArrayBuffer,
  byteOffset: number,
) {
  const indices = mesh.mesh.indices;
  assert(indices);
  const positions = mesh.mesh.attributes.position as Float32Array;
  const vertex = (corner: number): readonly [number, number, number] => {
    const index = indices[primitive * 3 + corner];
    assert(index !== undefined);
    const x = positions[index * 3],
      y = positions[index * 3 + 1],
      z = positions[index * 3 + 2];
    assert(x !== undefined && y !== undefined && z !== undefined);
    return [x, y, z];
  };
  const forward = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...mesh.position, 1];
  const input: ReceiverCase = {
    name: `actual-pixel-${pixel}-primitive-${primitive}`,
    vertices: [vertex(0), vertex(1), vertex(2)],
    forward,
    viewProjection,
    pixel: [pixel & 65535, pixel >>> 16],
    extent: [SCENE_WIDTH, SCENE_HEIGHT],
    sampleOffset: [0.5, 0.5],
  };
  const exact = exactReceiverPoint(input);
  const floats = new Float32Array(probe, byteOffset, SCREEN_PROBE_RECORD_BYTES / 4);
  assert(exact, 'Actual canonical point must have an independent exact solution');
  assert(
    receiverContains(
      [0, 1, 2].map((axis) => ({
        lo: floats[8 + axis] ?? NaN,
        hi: floats[12 + axis] ?? NaN,
        valid: 1,
      })),
      exact,
    ),
  );
  return exact;
}

const fraction = (value: number): Fraction => ({
  n: exactEndpointDyadic(new Uint32Array(Float32Array.of(value).buffer)[0] ?? 0),
  d: 1n << 149n,
});
const subtract = (a: Fraction, b: Fraction): Fraction => ({
  n: a.n * b.d - b.n * a.d,
  d: a.d * b.d,
});
const add = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const multiply = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.n, d: a.d * b.d });
const divide = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d, d: a.d * b.n });
const less = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d;

/** Exact front-face oracle for the authored blocker. Its strict interior is
 * selected from inputs, before consulting any DUT status/distance/image. */
export function exactNearBlocker(point: readonly Fraction[], direction: readonly number[]) {
  const z = point[2],
    dz = direction[2];
  if (!z || z.n !== 0n || dz === undefined || !(dz > 0)) return undefined;
  const entry = divide(subtract(fraction(7 / 128), z), fraction(dz));
  const exit = divide(subtract(fraction(9 / 128), z), fraction(dz));
  for (let axis = 0; axis < 2; axis++) {
    const p = point[axis],
      d = direction[axis];
    if (!p || d === undefined) return undefined;
    const at = add(p, multiply(fraction(d), entry));
    if (!less(fraction(-0.25), at) || !less(at, fraction(0.25))) return undefined;
  }
  return { entry: Number(entry.n) / Number(entry.d), exit: Number(exit.n) / Number(exit.d) };
}
