import {
  DynamicGeometryError,
  type FrameReceipt,
  type PreparedPublishedMeshResidency,
  type Renderer,
  type RenderPublicationIdentity,
} from '@forgeax/engine-render';
import {
  type CompletedMeshConsumption,
  MESH_CONSUMPTION_LANES,
  MESH_RESIDENCY_REQUEST_LIMIT,
  type MeshResidencyFailure,
  type MeshResidencyRequest,
  type MeshResidencyResponse,
} from './render-worker-protocol';
import { serializableDetail } from './worker-error';

interface Request {
  readonly prepared: Promise<PreparedPublishedMeshResidency | undefined>;
  readonly entity: number | undefined;
  lease?: PreparedPublishedMeshResidency;
  release?: Promise<void>;
  evict?: boolean;
}

/** Transport leases only. Candidate and World admission remain in the source realm. */
export class RenderMeshResidency {
  private readonly requests = new Map<number, Request>();
  private readonly credits = new Set<Request>();
  private disposed = false;
  private lastRequest = 0;
  private consumedBindings = new Float64Array(0);
  constructor(
    private readonly renderer: Renderer,
    private readonly identity: RenderPublicationIdentity,
    private readonly post: (message: MeshResidencyResponse) => void,
  ) {}

  async receive(message: MeshResidencyRequest): Promise<void> {
    const identity = message.kind === 'mesh-prepare' ? message.input : message.identity;
    const respond = (result: MeshResidencyResponse['result']) =>
      this.post({
        kind: message.kind === 'mesh-prepare' ? 'mesh-ready' : 'mesh-released',
        requestId: message.requestId,
        identity: this.identity,
        result,
      });
    const fail = (error: MeshResidencyFailure) => {
      respond({
        ok: false,
        error: {
          code: error.code,
          expected: error.expected,
          hint: error.hint,
          ...('detail' in error ? { detail: serializableDetail(error.detail) } : {}),
          ...('actual' in error ? { actual: serializableDetail(error.actual) } : {}),
        },
      });
    };
    if (
      this.disposed ||
      identity.source !== this.identity.source ||
      identity.epoch !== this.identity.epoch
    ) {
      fail(
        new DynamicGeometryError(
          'dynamic-geometry-gpu-not-ready',
          'mesh preparation belongs to the active publication receiver',
          'discard stale preparation and retry after Render readiness',
        ),
      );
      return;
    }
    if (!Number.isSafeInteger(message.requestId) || message.requestId < 1) {
      fail(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'request ID is a positive safe integer',
          'repair the source mesh request',
        ),
      );
      return;
    }
    if (message.kind === 'mesh-release') {
      await this.release(message.requestId, message.evict);
      respond({
        ok: true,
        deviceGeneration:
          this.renderer.currentDeviceGeneration?.() ??
          this.renderer.inspect().frame.deviceGeneration,
      });
      return;
    }
    if (
      message.requestId <= this.lastRequest ||
      (message.entity !== undefined && !Number.isSafeInteger(message.entity))
    ) {
      fail(
        new DynamicGeometryError(
          'dynamic-geometry-invalid',
          'mesh request IDs are fresh and entities are safe integers',
          'repair the source mesh request',
        ),
      );
      return;
    }
    this.lastRequest = message.requestId;
    const pending = this.credits.size;
    if (pending >= MESH_RESIDENCY_REQUEST_LIMIT) {
      fail(
        new DynamicGeometryError(
          'dynamic-geometry-budget-exceeded',
          'mesh transport fits its bounded outstanding request capacity',
          'wait for a preparation release before requesting more meshes',
          {
            reason: 'retained-count',
            used: pending,
            requested: 1,
            limit: MESH_RESIDENCY_REQUEST_LIMIT,
            actual: pending,
          },
        ),
      );
      return;
    }
    let resolve!: (lease: PreparedPublishedMeshResidency | undefined) => void;
    const request: Request = {
      prepared: new Promise<PreparedPublishedMeshResidency | undefined>((done) => {
        resolve = done;
      }),
      entity: message.entity,
    };
    this.requests.set(message.requestId, request);
    this.credits.add(request);
    try {
      // The native Worker message owns this clone. Shared buffers are still
      // detected and copied by the Renderer before becoming prepared storage.
      const result = await this.renderer.preparePublishedMeshResidency(message.input, 'received');
      if (!result.ok) {
        resolve(undefined);
        fail(result.error);
        this.requests.delete(message.requestId);
        this.credits.delete(request);
        return;
      }
      request.lease = result.value;
      resolve(result.value);
      if (this.disposed || request.release !== undefined) {
        await this.release(message.requestId, this.disposed || request.evict !== false);
        return;
      }
      if (request.entity !== undefined) this.credits.delete(request);
      respond({ ok: true, deviceGeneration: result.value.deviceGeneration });
    } catch (cause) {
      resolve(undefined);
      // An unexpected throw cannot attest that physical allocation was undone.
      // The Worker failure owner faults paired source recovery and drains disposal.
      throw cause;
    }
  }

  private release(requestId: number, evict = true): Promise<void> {
    const request = this.requests.get(requestId);
    if (request === undefined) return Promise.resolve();
    if (request.release !== undefined) {
      if (evict && request.evict === false) {
        request.evict = true;
        request.lease?.release(true);
      }
      return request.release;
    }
    request.evict = evict;
    this.credits.add(request);
    request.release = (async () => {
      const lease = await request.prepared;
      await lease?.release(request.evict);
      this.requests.delete(requestId);
      this.credits.delete(request);
    })();
    return request.release;
  }

  consumed(receipt: FrameReceipt, sourceFixedStep: number): CompletedMeshConsumption {
    let used = 0;
    this.requests.forEach((request, requestId) => {
      if (
        request.release !== undefined ||
        request.lease === undefined ||
        request.entity === undefined
      )
        return;
      const lane = request.lease.recordStageLane(receipt, request.entity);
      if (lane.ok && lane.value !== undefined) {
        if (used + 2 > this.consumedBindings.length) {
          const grown = new Float64Array(Math.max(16, this.consumedBindings.length * 2));
          grown.set(this.consumedBindings);
          this.consumedBindings = grown;
        }
        this.consumedBindings[used++] = requestId;
        this.consumedBindings[used++] = MESH_CONSUMPTION_LANES.indexOf(lane.value);
      }
    });
    return {
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      sourceFixedStep,
      // GPU completion can trail a successor draw; transport owns this copy.
      bindings: this.consumedBindings.slice(0, used),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.consumedBindings = new Float64Array(0);
    const results = await Promise.allSettled(
      [...this.requests.keys()].map((id) => this.release(id)),
    );
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }
}
