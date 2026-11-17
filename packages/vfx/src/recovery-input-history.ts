import type { EntityHandle } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { VfxGpuTickIntent } from './gpu-runtime.js';

export interface VfxGpuRecoveryError {
  readonly code:
    | 'vfx-recovery-history-overflow'
    | 'vfx-recovery-history-start-missing'
    | 'vfx-recovery-history-incomplete';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly player: EntityHandle;
    readonly emitterId: string;
    readonly maxRecords?: number;
    readonly maxPayloadBytes?: number;
  };
}
interface History {
  readonly playCycle: number;
  readonly fingerprint: string;
  readonly inputs: VfxGpuTickIntent[];
  error: VfxGpuRecoveryError | undefined;
}
/** This is submitted *author input*, not a CPU copy of any GPU particle state.
 * Full cycles are retained; a capacity limit fails closed instead of truncating
 * a live cycle or substituting current parameters for historical commands. */
export class VfxRecoveryInputHistory {
  readonly #players = new Map<EntityHandle, Map<string, History>>();
  readonly #buffers = new Map<ArrayBufferLike, { references: number; bytes: number }>();
  #payloadBytes = 0;
  constructor(
    readonly maxRecords: number,
    readonly maxPayloadBytes: number,
    private readonly retain: (intent: VfxGpuTickIntent) => void,
    private readonly release: (intent: VfxGpuTickIntent) => void,
  ) {
    if (
      !Number.isSafeInteger(maxRecords) ||
      maxRecords < 1 ||
      !Number.isSafeInteger(maxPayloadBytes) ||
      maxPayloadBytes < 1
    )
      throw new RangeError('VFX recovery history budgets must be positive safe integers');
  }
  #error(intent: VfxGpuTickIntent, code: VfxGpuRecoveryError['code']): VfxGpuRecoveryError {
    return {
      code,
      expected: 'the complete submitted author-input cycle for exact GPU recovery',
      hint: 'retain the complete cycle within its declared budget; reset a transient pool only after all authored lifetimes have expired',
      detail: {
        player: intent.player,
        emitterId: intent.emitter.id,
        maxRecords: this.maxRecords,
        maxPayloadBytes: this.maxPayloadBytes,
      },
    };
  }
  #uniqueBuffers(intent: VfxGpuTickIntent): ArrayBufferLike[] {
    const buffers: ArrayBufferLike[] = [
      intent.parameterBlock.buffer,
      intent.canonicalPayload.buffer,
    ];
    const context = intent.recoveryContext;
    if (context) {
      buffers.push(context.localToWorld.buffer);
      for (const resource of context.dataInterfaces ?? []) {
        for (const value of [resource.resource?.value, resource.recovery?.resource.value]) {
          if (ArrayBuffer.isView(value)) buffers.push(value.buffer);
          else if (value instanceof ArrayBuffer) buffers.push(value);
        }
      }
    }
    return [...new Set(buffers)];
  }
  append(intent: VfxGpuTickIntent): Result<void, VfxGpuRecoveryError> {
    let emitters = this.#players.get(intent.player);
    if (!emitters) {
      emitters = new Map();
      this.#players.set(intent.player, emitters);
    }
    let history = emitters.get(intent.emitter.id);
    if (
      history &&
      (intent.reset ||
        history.playCycle !== intent.playCycle ||
        history.fingerprint !== intent.programFingerprint)
    ) {
      this.clear(intent.player, intent.emitter.id);
      emitters = this.#players.get(intent.player) ?? new Map();
      this.#players.set(intent.player, emitters);
      history = undefined;
    }
    if (!history) {
      history = {
        playCycle: intent.playCycle,
        fingerprint: intent.programFingerprint,
        inputs: [],
        error: undefined,
      };
      emitters.set(intent.emitter.id, history);
    }
    if (history.error) return err(history.error);
    if (intent.recoveryContext?.error) {
      history.error = {
        ...this.#error(intent, 'vfx-recovery-history-incomplete'),
        expected: intent.recoveryContext.error.expected,
        hint: intent.recoveryContext.error.hint,
      };
      return err(history.error);
    }
    if (history.inputs.length === 0 && !intent.reset) {
      history.error = this.#error(intent, 'vfx-recovery-history-start-missing');
      return err(history.error);
    }
    if ((history.inputs.at(-1)?.sequence ?? -1) >= intent.sequence) return ok(undefined);
    const buffers = this.#uniqueBuffers(intent),
      added = buffers.reduce(
        (bytes, buffer) => bytes + (this.#buffers.has(buffer) ? 0 : buffer.byteLength),
        0,
      );
    if (
      history.inputs.length >= this.maxRecords ||
      this.#payloadBytes + added > this.maxPayloadBytes
    ) {
      history.error = this.#error(intent, 'vfx-recovery-history-overflow');
      return err(history.error);
    }
    for (const buffer of buffers) {
      const old = this.#buffers.get(buffer);
      if (old) old.references++;
      else {
        this.#buffers.set(buffer, { references: 1, bytes: buffer.byteLength });
        this.#payloadBytes += buffer.byteLength;
      }
    }
    history.inputs.push(intent);
    this.retain(intent);
    return ok(undefined);
  }
  inputs(
    player: EntityHandle,
    emitterId: string,
  ): Result<readonly VfxGpuTickIntent[], VfxGpuRecoveryError> {
    const history = this.#players.get(player)?.get(emitterId);
    if (history?.error) return err(history.error);
    return ok(Object.freeze([...(history?.inputs ?? [])]));
  }
  clear(player: EntityHandle, emitterId?: string): void {
    const emitters = this.#players.get(player);
    if (!emitters) return;
    const keys = emitterId === undefined ? [...emitters.keys()] : [emitterId];
    for (const key of keys) {
      const h = emitters.get(key);
      if (!h) continue;
      for (const intent of h.inputs) {
        for (const buffer of this.#uniqueBuffers(intent)) {
          const entry = this.#buffers.get(buffer);
          if (entry && --entry.references === 0) {
            this.#buffers.delete(buffer);
            this.#payloadBytes -= entry.bytes;
          }
        }
        this.release(intent);
      }
      emitters.delete(key);
    }
    if (emitters.size === 0) this.#players.delete(player);
  }
}

/** Pool recovery must consume exact inputs. Ordinary effects retain the existing
 * quantized recovery contract. Entry identity is the closed compiler ABI. */
export function requiresExactVfxRecovery(intent: Pick<VfxGpuTickIntent, 'emitter'>): boolean {
  return intent.emitter.reflection.entryPoints.includes('forgeax_vfx_pool_allocate_main');
}
export function exactVfxRecoveryInputs<T extends Omit<VfxGpuTickIntent, 'effect' | 'forceFields'>>(
  latest: T,
  inputs: readonly T[],
): Result<readonly T[], VfxGpuRecoveryError> {
  const fail = (code: VfxGpuRecoveryError['code']) =>
    err({
      code,
      expected: 'a complete exact submitted input history ending at the retained intent',
      hint: 'republish the source history; never substitute current inputs or quantize a persistent pool',
      detail: { player: latest.player, emitterId: latest.emitter.id },
    } as VfxGpuRecoveryError);
  const first = inputs[0];
  if (!first?.reset) return fail('vfx-recovery-history-start-missing');
  let previous = -1;
  for (const input of inputs) {
    if (
      input.player !== latest.player ||
      input.emitter.id !== latest.emitter.id ||
      input.playCycle !== latest.playCycle ||
      input.programFingerprint !== latest.programFingerprint ||
      input.sequence <= previous ||
      !Number.isFinite(input.delta) ||
      input.delta < 0
    )
      return fail('vfx-recovery-history-incomplete');
    previous = input.sequence;
  }
  if (inputs.at(-1)?.sequence !== latest.sequence) return fail('vfx-recovery-history-incomplete');
  return ok(Object.freeze(inputs.map((input) => Object.freeze({ ...input, recovering: true }))));
}
