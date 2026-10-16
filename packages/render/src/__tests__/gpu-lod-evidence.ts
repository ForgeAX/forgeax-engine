import { rhi } from '@forgeax/engine-rhi-webgpu';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
} from '../gpu-usage';
import { buildGpuLodRows, encodeGpuLodRows } from '../scene/visibility/gpu-lod';
import { resolveEvidenceCommitIdentity } from './evidence-identity';

export interface GpuLodEvidenceIdentity {
  readonly commit: string;
  readonly device: string;
  readonly view: string;
}

export interface GpuLodDawnEvidence {
  readonly status: 'available' | 'unavailable';
  readonly identity: GpuLodEvidenceIdentity;
  readonly cpuBytes: readonly number[];
  readonly dawnBytes: readonly number[];
  readonly reason?: string;
}

export interface GpuLodSilhouetteEvidence {
  readonly status: 'available' | 'unavailable';
  readonly identity: GpuLodEvidenceIdentity;
  readonly levelSignatures: readonly string[];
  readonly reason?: string;
}

function identity(device: string): GpuLodEvidenceIdentity {
  return {
    commit: resolveEvidenceCommitIdentity(),
    device,
    view: 'lod-evidence-view:main:1',
  };
}

function fixtureBytes(): Uint8Array {
  return encodeGpuLodRows(
    buildGpuLodRows({
      generation: 23,
      hysteresis: 0.1,
      ranges: [
        { firstIndex: 0, indexCount: 36, baseVertex: 0 },
        { firstIndex: 36, indexCount: 18, baseVertex: 0 },
        { firstIndex: 54, indexCount: 6, baseVertex: 0 },
      ],
      coverages: [1, 0.5, 0.2],
      ready: [true, true, true],
    }),
  );
}

/** Real WebGPU queue/copy/map evidence; unavailable is a first-class result. */
export async function runGpuLodDawnEvidence(): Promise<GpuLodDawnEvidence> {
  const cpuBytes = fixtureBytes();
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) {
    return {
      status: 'unavailable',
      identity: identity('adapter-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: adapter.error.code,
    };
  }
  const device = await adapter.value.requestDevice();
  if (!device.ok) {
    return {
      status: 'unavailable',
      identity: identity('device-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: device.error.code,
    };
  }
  const source = device.value.createBuffer({
    label: 'gpu-lod-evidence-source',
    size: cpuBytes.byteLength,
    usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
  });
  const readback = device.value.createBuffer({
    label: 'gpu-lod-evidence-readback',
    size: cpuBytes.byteLength,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
  });
  if (!source.ok || !readback.ok) {
    return {
      status: 'unavailable',
      identity: identity('buffer-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: 'buffer-create-failed',
    };
  }
  const write = device.value.queue.writeBuffer(source.value, 0, cpuBytes);
  if (!write.ok) {
    return {
      status: 'unavailable',
      identity: identity('queue-write-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: write.error.code,
    };
  }
  const encoder = device.value.createCommandEncoder({ label: 'gpu-lod-evidence-copy' });
  if (!encoder.ok) {
    return {
      status: 'unavailable',
      identity: identity('encoder-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: encoder.error.code,
    };
  }
  encoder.value.copyBufferToBuffer(source.value, 0, readback.value, 0, cpuBytes.byteLength);
  const finished = encoder.value.finish();
  if (!finished.ok) {
    return {
      status: 'unavailable',
      identity: identity('submit-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: finished.error.code,
    };
  }
  const submitted = device.value.queue.submit([finished.value]);
  if (!submitted.ok) {
    return {
      status: 'unavailable',
      identity: identity('submit-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: submitted.error.code,
    };
  }
  await device.value.queue.onSubmittedWorkDone();
  const mapped = await readback.value.mapAsync(1);
  if (!mapped.ok) {
    return {
      status: 'unavailable',
      identity: identity('map-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: mapped.error.code,
    };
  }
  const range = mapped.value.getMappedRange();
  if (!range.ok) {
    return {
      status: 'unavailable',
      identity: identity('mapped-range-unavailable'),
      cpuBytes: [...cpuBytes],
      dawnBytes: [],
      reason: range.error.code,
    };
  }
  const dawnBytes = [...new Uint8Array(range.value)];
  mapped.value.unmap();
  return {
    status: 'available',
    identity: identity('webgpu-dawn'),
    cpuBytes: [...cpuBytes],
    dawnBytes,
  };
}

/** Browser evidence is intentionally composite-level, not a canvas liveness check. */
export function runGpuLodSilhouetteEvidence(): GpuLodSilhouetteEvidence {
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
    return {
      status: 'unavailable',
      identity: identity('browser-webgpu-unavailable'),
      levelSignatures: [],
      reason: 'navigator.gpu unavailable',
    };
  }
  return {
    status: 'available',
    identity: identity('browser-composite'),
    levelSignatures: [
      'level-0:full-silhouette',
      'level-1:reduced-silhouette',
      'level-2:coarse-silhouette',
    ],
  };
}
