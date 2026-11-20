import {
  assetDataBytes,
  type MeshPresentationInput,
} from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import {
  type DynamicGeometryCandidate,
  DynamicGeometryError,
  type DynamicGeometryReceipt,
  type RenderPublicationIdentity,
} from '@forgeax/engine-render';
import {
  type DynamicGeometryResidencyPort,
  type MeshPipelinePreparation,
  meshTransfers,
} from '@forgeax/engine-render/internal';
import { err, type MeshAsset, ok } from '@forgeax/engine-types';
import {
  type CompletedMeshConsumption,
  MESH_CONSUMPTION_LANES,
  MESH_RESIDENCY_REQUEST_LIMIT,
  type MeshResidencyFailure,
  type MeshResidencyRequest,
  type MeshResidencyResponse,
} from './render-worker-protocol';

type Prepared = Awaited<ReturnType<DynamicGeometryResidencyPort['prepare']>>;
type MeshInput = Parameters<DynamicGeometryResidencyPort['prepare']>[0];
type MeshPreparation =
  | MeshInput
  | (Omit<MeshInput, 'mesh'> & { readonly deferredMesh: MeshPresentationInput });
type DynamicGeometryRecordStageLane = NonNullable<DynamicGeometryReceipt['recordStageLane']>;
type Session = RenderPublicationIdentity & {
  readonly generation: number;
  post(message: MeshResidencyRequest, transfers?: readonly ArrayBuffer[]): void;
  acknowledgePrograms?(programs: MeshPipelinePreparation['programs']): void;
};
interface Request {
  readonly session: Session;
  readonly prepared: Promise<Prepared>;
  readonly entity: number | undefined;
  readonly meshHandle: number;
  readonly revision: number;
  readonly recoverable: boolean;
  readiness: 'pending' | 'ready' | 'retired';
  handoff?: (() => void) | undefined;
  consumedCompletion?: number;
  consumedOrder?: number;
  consumedLane?: DynamicGeometryRecordStageLane;
  ended?: DynamicGeometryError;
  failure?: DynamicGeometryError;
  receiverDisposed?: true;
  finish(result: Prepared): void;
  fail(cause: unknown): void;
  release?: {
    readonly promise: Promise<void>;
    evict: boolean;
    resolve(): void;
    reject(cause: unknown): void;
  };
}
const unavailable = (detail?: unknown) =>
  new DynamicGeometryError(
    'dynamic-geometry-gpu-not-ready',
    'the prepared mesh belongs to the active Render Worker publication session',
    'retain source assets until preparation or release finishes; retry after Render readiness',
    { actual: detail },
  );

function preparationError(error: MeshResidencyFailure): DynamicGeometryError {
  let code: DynamicGeometryError['code'];
  switch (error.code) {
    case 'render-publication-invalid':
    case 'mesh-residency-invalid-handle':
      code = 'dynamic-geometry-invalid';
      break;
    case 'mesh-residency-world-not-attached':
      code = 'dynamic-geometry-world-not-attached';
      break;
    case 'mesh-residency-budget-exceeded':
      code = 'dynamic-geometry-budget-exceeded';
      break;
    case 'mesh-residency-gpu-failed':
      code = 'dynamic-geometry-gpu-failed';
      break;
    case 'mesh-residency-gpu-not-ready':
      code = 'dynamic-geometry-gpu-not-ready';
      break;
    default:
      code = error.code;
  }
  return new DynamicGeometryError(code, error.expected, error.hint, { actual: error });
}

/** One request per receiver GPU lease, with no copy of source candidate lifecycle. */
export class SourceMeshResidency implements DynamicGeometryResidencyPort {
  readonly maxConcurrentPreparations = MESH_RESIDENCY_REQUEST_LIMIT;
  private readonly requests = new Map<number, Request>();
  private readonly credits = new Set<Request>();
  private sequence = 0;
  private readonly byEntity = new Map<number | undefined, Map<number, Request>>();
  private completion = 0;
  private fixedStep: number | undefined;
  private currentnessRevision: object = Object.freeze({});
  private currentness:
    | {
        source: Session['source'];
        epoch: number;
        generation: number;
        revision: object;
        token: object;
      }
    | undefined;
  constructor(
    private readonly world: World,
    private readonly session: () => Session | undefined,
  ) {}
  get hasUnreleasedMeshes(): boolean {
    return this.requests.size !== 0;
  }
  get requiresRetirementAcknowledgement(): boolean {
    for (const request of this.requests.values()) if (!request.recoverable) return true;
    return false;
  }
  currentnessToken(): object | undefined {
    const session = this.session();
    if (session === undefined) return undefined;
    const previous = this.currentness;
    if (
      previous?.source === session.source &&
      previous.epoch === session.epoch &&
      previous.generation === session.generation &&
      previous.revision === this.currentnessRevision
    )
      return previous.token;
    const token = Object.freeze({});
    this.currentness = {
      source: session.source,
      epoch: session.epoch,
      generation: session.generation,
      revision: this.currentnessRevision,
      token,
    };
    return token;
  }

  prepare = async (
    input: MeshPreparation,
    options?: Parameters<DynamicGeometryResidencyPort['prepare']>[1] & {
      /** The asset owner can reproduce these exact bytes after transport loss. */
      readonly recoverable?: boolean;
    },
  ): ReturnType<DynamicGeometryResidencyPort['prepare']> => {
    const signal = options?.signal;
    const session = this.session();
    if (input.world !== this.world || session === undefined || signal?.aborted)
      return Promise.resolve(err(unavailable('source is not ready or request was cancelled')));
    let pending = this.credits.size;
    while (options?.waitForCapacity && pending >= MESH_RESIDENCY_REQUEST_LIMIT) {
      // Existing in-flight preparations and release fences own these credits.
      // A held standalone lease has no automatic completion: retain refusal.
      const completions = [...this.credits].flatMap((request) =>
        request.release
          ? [request.release.promise]
          : request.readiness === 'pending'
            ? [request.prepared.then(() => {})]
            : [],
      );
      if (completions.length === 0) break;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        signal?.addEventListener('abort', abort, { once: true });
        void Promise.race(completions).then(
          () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
          (cause) => {
            signal?.removeEventListener('abort', abort);
            reject(cause);
          },
        );
      });
      const current = this.session();
      if (
        signal?.aborted ||
        current?.source !== session.source ||
        current.epoch !== session.epoch ||
        current.generation !== session.generation
      )
        return err(
          unavailable('source changed or preparation was cancelled while waiting for capacity'),
        );
      pending = this.credits.size;
    }
    if (pending >= MESH_RESIDENCY_REQUEST_LIMIT)
      return Promise.resolve(
        err(
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
        ),
      );
    let bytes = 'deferredMesh' in input ? input.deferredMesh.bytes : undefined;
    if ('mesh' in input && options?.transfers?.length) {
      try {
        bytes = assetDataBytes(input.mesh, undefined, 'receive');
      } catch (cause) {
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-invalid',
            'transferable Mesh content is plain data with private binary storage',
            'prepare a private copy before transferring Mesh residency',
            { actual: cause },
          ),
        );
      }
    }
    const requestId = ++this.sequence;
    const postMesh = (mesh: MeshAsset, transfers: readonly ArrayBuffer[] | undefined) =>
      session.post(
        {
          kind: 'mesh-prepare',
          requestId,
          input: {
            source: session.source,
            epoch: session.epoch,
            meshHandle: input.meshHandle,
            revision: input.assetRevision,
            mesh,
            ...(input.pipelinePreparation === undefined
              ? {}
              : { pipelinePreparation: input.pipelinePreparation }),
          },
          ...(input.entity === undefined ? {} : { entity: input.entity }),
          ...(bytes === undefined ? {} : { reserved: true }),
        },
        transfers,
      );
    const handoff = () => {
      if ('mesh' in input) postMesh(input.mesh, options?.transfers);
      else {
        const mesh = input.deferredMesh.capture();
        postMesh(mesh, meshTransfers(mesh));
      }
    };
    let resolve!: (result: Prepared) => void;
    let reject!: (cause: unknown) => void;
    const prepared = new Promise<Prepared>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    let finished = false;
    const settle = (resolve: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      request.handoff = undefined;
      resolve();
    };
    let programs = input.pipelinePreparation?.programs;
    const finish = (result: Prepared) =>
      settle(() => {
        const delivered = programs;
        programs = undefined;
        // receive() admits success only after checking this exact session and
        // device generation; cancelled and failed requests never reach this ACK.
        if (result.ok && delivered !== undefined) session.acknowledgePrograms?.(delivered);
        resolve(result);
      });
    const fail = (cause: unknown) =>
      settle(() => {
        programs = undefined;
        reject(cause);
      });
    const cancel = () => {
      // Cancellation still drains the receiver allocation; its request ID is
      // retained until release ACK, including ready arriving after cancellation.
      void this.release(requestId).catch(fail);
    };
    const timer = setTimeout(cancel, 30_000);
    const request: Request = {
      session,
      prepared,
      entity: input.entity,
      meshHandle: Number(input.meshHandle),
      revision: input.assetRevision,
      recoverable: options?.recoverable === true,
      readiness: 'pending',
      finish,
      fail,
    };
    this.requests.set(requestId, request);
    let entityRequests = this.byEntity.get(request.entity);
    if (entityRequests === undefined) {
      entityRequests = new Map();
      this.byEntity.set(request.entity, entityRequests);
    }
    entityRequests.set(requestId, request);
    this.credits.add(request);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (bytes === undefined) handoff();
      else {
        request.handoff = handoff;
        session.post({
          kind: 'mesh-reserve',
          requestId,
          identity: { source: session.source, epoch: session.epoch },
          bytes,
        });
      }
    } catch (cause) {
      request.ended = unavailable(cause);
      this.requests.delete(requestId);
      this.forgetConsumption(requestId, request);
      this.credits.delete(request);
      fail(cause);
    }
    return prepared;
  };

  receive(message: MeshResidencyResponse): void {
    const request = this.requests.get(message.requestId);
    if (
      request === undefined ||
      message.identity.source !== request.session.source ||
      message.identity.epoch !== request.session.epoch
    )
      return;
    if (message.kind === 'mesh-released') {
      this.acknowledgeRelease(message.requestId, request, message.result);
      return;
    }
    if (message.kind === 'mesh-retired') {
      this.noteRetirement(message.requestId, request, message.result);
      return;
    }
    if (request.release !== undefined || request.readiness !== 'pending') return;
    if ((message.kind === 'mesh-reserved') !== (request.handoff !== undefined)) return;
    const current = this.session();
    if (
      !message.result.ok ||
      current === undefined ||
      current.source !== request.session.source ||
      current.epoch !== request.session.epoch ||
      current.generation !== request.session.generation ||
      message.result.deviceGeneration !== request.session.generation
    ) {
      request.failure = message.result.ok
        ? unavailable('stale ready response')
        : preparationError(message.result.error);
      void this.release(message.requestId).catch(request.fail);
      return;
    }
    if (message.kind === 'mesh-reserved') {
      const handoff = request.handoff;
      request.handoff = undefined;
      try {
        handoff?.();
      } catch (cause) {
        request.failure = unavailable(cause);
        void this.release(message.requestId).catch(request.fail);
      }
      return;
    }
    request.readiness = 'ready';
    this.currentnessRevision = Object.freeze({});
    if (request.entity !== undefined) this.credits.delete(request);
    request.finish(
      ok({
        isCurrent: () => {
          const live = this.session();
          return (
            request.readiness === 'ready' &&
            request.release === undefined &&
            request.ended === undefined &&
            live?.source === request.session.source &&
            live.epoch === request.session.epoch &&
            live.generation === request.session.generation
          );
        },
        release: (evict) => this.release(message.requestId, request, evict),
      }),
    );
  }

  private noteRetirement(
    requestId: number,
    request: Request,
    result: MeshResidencyResponse['result'],
  ): void {
    if (
      request.readiness !== 'ready' ||
      !result.ok ||
      result.deviceGeneration !== request.session.generation
    )
      return;
    request.readiness = 'retired';
    this.currentnessRevision = Object.freeze({});
    this.forgetConsumption(requestId, request);
  }

  private acknowledgeRelease(
    requestId: number,
    request: Request,
    result: MeshResidencyResponse['result'],
  ): void {
    if (request.release === undefined) return;
    this.requests.delete(requestId);
    this.credits.delete(request);
    this.forgetConsumption(requestId, request);
    const failure = result.ok
      ? result.deviceGeneration === request.session.generation
        ? undefined
        : unavailable('stale release generation')
      : preparationError(result.error);
    if (failure === undefined) {
      request.finish(
        err(request.failure ?? unavailable('mesh preparation was cancelled or released')),
      );
      request.release.resolve();
    } else {
      request.fail(failure);
      request.release.reject(failure);
    }
  }

  private release(
    requestId: number,
    retained = this.requests.get(requestId),
    evict = true,
  ): Promise<void> {
    const request = retained;
    if (request === undefined) return Promise.resolve();
    if (request.receiverDisposed) return Promise.resolve();
    if (request.release !== undefined) {
      if (evict && !request.release.evict) {
        request.release.evict = true;
        try {
          request.session.post({
            kind: 'mesh-release',
            requestId,
            evict: true,
            identity: { source: request.session.source, epoch: request.session.epoch },
          });
        } catch (cause) {
          request.release.reject(unavailable(cause));
        }
      }
      return request.release.promise;
    }
    if (request.ended !== undefined) return Promise.reject(request.ended);
    request.handoff = undefined;
    if (evict) request.readiness = 'retired';
    this.currentnessRevision = Object.freeze({});
    this.credits.add(request);
    this.forgetConsumption(requestId, request);
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const timer = setTimeout(() => {
      this.requests.delete(requestId);
      this.forgetConsumption(requestId, request);
      this.credits.delete(request);
      request.ended = unavailable('mesh release fence timed out');
      request.fail(request.ended);
      reject(request.ended);
    }, 30_000);
    request.release = {
      promise,
      evict,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    };
    try {
      request.session.post({
        kind: 'mesh-release',
        requestId,
        evict,
        identity: { source: request.session.source, epoch: request.session.epoch },
      });
    } catch (cause) {
      this.requests.delete(requestId);
      this.forgetConsumption(requestId, request);
      this.credits.delete(request);
      request.release.reject(unavailable(cause));
    }
    return promise;
  }

  complete(proof: CompletedMeshConsumption): void {
    this.completion++;
    this.fixedStep = undefined;
    const session = this.session();
    if (
      session === undefined ||
      proof.deviceGeneration !== session.generation ||
      proof.bindings.length % 2 !== 0
    )
      return;
    this.fixedStep = proof.sourceFixedStep;
    let order = 0;
    for (let index = 0; index < proof.bindings.length; index += 2) {
      const lane = MESH_CONSUMPTION_LANES[proof.bindings[index + 1] ?? -1];
      if (lane === undefined) continue;
      const request = this.requests.get(proof.bindings[index] ?? -1);
      if (
        request?.readiness === 'ready' &&
        request.release === undefined &&
        request.session.source === session.source &&
        request.session.epoch === session.epoch &&
        request.session.generation === session.generation
      ) {
        if (request.consumedCompletion !== this.completion) request.consumedOrder = order++;
        request.consumedCompletion = this.completion;
        request.consumedLane = lane;
      }
    }
  }
  private forgetConsumption(requestId: number, request: Request): void {
    const bindings = this.byEntity.get(request.entity);
    bindings?.delete(requestId);
    if (bindings?.size === 0) this.byEntity.delete(request.entity);
  }
  /** The current receiver attests this exact version is still adoptable. */
  holdsPrepared(meshHandle: number, revision: number): boolean {
    const live = this.session();
    if (live === undefined) return false;
    for (const request of this.requests.values()) {
      if (
        request.readiness === 'ready' &&
        request.meshHandle === meshHandle &&
        request.revision === revision &&
        request.ended === undefined &&
        request.failure === undefined &&
        !request.release?.evict &&
        live.source === request.session.source &&
        live.epoch === request.session.epoch &&
        live.generation === request.session.generation
      )
        return true;
    }
    return false;
  }
  publishedFixedStep(world: World): number | undefined {
    return world === this.world ? this.fixedStep : undefined;
  }
  recordStageLane(candidate: DynamicGeometryCandidate): DynamicGeometryRecordStageLane | undefined {
    if (candidate.world !== this.world) return undefined;
    const bindings = this.byEntity.get(candidate.entity);
    if (bindings === undefined) return undefined;
    let lane: DynamicGeometryRecordStageLane | undefined;
    let order = Number.POSITIVE_INFINITY;
    for (const request of bindings.values()) {
      if (
        request.consumedCompletion === this.completion &&
        request.consumedOrder !== undefined &&
        request.consumedOrder < order &&
        request.meshHandle === Number(candidate.meshHandle)
      ) {
        lane = request.consumedLane;
        order = request.consumedOrder;
      }
    }
    return lane;
  }
  clear(cause: unknown): void {
    this.currentnessRevision = Object.freeze({});
    const error = unavailable(cause);
    for (const request of this.requests.values()) {
      request.readiness = 'retired';
      request.ended = error;
      if (request.receiverDisposed) {
        request.finish(err(request.failure ?? error));
        request.release?.resolve();
      } else {
        request.fail(error);
        request.release?.reject(error);
      }
    }
    this.requests.clear();
    this.credits.clear();
    this.byEntity.clear();
    this.fixedStep = undefined;
  }
  /** Only a successful receiver disposal ACK proves all its allocations released. */
  confirmRetirement(): void {
    for (const request of this.requests.values()) request.receiverDisposed = true;
    this.clear('Render Worker retirement confirmed');
  }
  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.requests.keys()].map((id) => this.release(id)),
    );
    this.clear('source mesh transport disposed');
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }
}
