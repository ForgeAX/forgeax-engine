import { err, ok, type Result } from '@forgeax/engine-types';
import type { ParticleChannelSource } from './code-source.js';
import type {
  VfxEffectContract,
  VfxEffectContractError,
  VfxValue,
  VfxValueMap,
  VfxValueType,
} from './effect-contract.js';

export interface VfxChannelPayload {
  readonly position: readonly [number, number, number];
  readonly strength: number;
}

export interface VfxChannelInput {
  readonly channel: string;
  readonly payload: VfxChannelPayload;
  readonly sequence: number;
  readonly tick?: number;
}

export interface VfxChannelCounters {
  readonly queued: number;
  readonly produced: number;
  readonly consumed: number;
  readonly dropped: number;
  readonly overflow: number;
  readonly fanOut: number;
  readonly recursionDepth: number;
  readonly lastSequence: number;
}

export interface VfxInstanceParent<Values extends VfxValueMap> {
  readonly fingerprint: string;
  readonly defaults: Values;
}

export interface VfxInstanceOptions<Values extends VfxValueMap> {
  readonly parent?: VfxInstanceParent<Values>;
  readonly initialValues?: Partial<Values>;
  readonly channels?: readonly ParticleChannelSource[];
}

export interface VfxInstanceCommitOptions {
  readonly seed: number;
  readonly tick: number;
}

export interface VfxReplayInput<Values extends VfxValueMap> {
  readonly seed: number;
  readonly tick: number;
  readonly generation: number;
  readonly sequence: number;
  readonly fingerprint: string;
  readonly payload: Uint8Array;
  readonly values: Values;
  readonly channelInputs: readonly VfxChannelInput[];
  readonly droppedCount: number;
}

export interface VfxInstanceCommit<Values extends VfxValueMap> {
  readonly seed: number;
  readonly tick: number;
  readonly generation: number;
  readonly sequence: number;
  readonly values: Values;
  readonly parameterBlock: Uint8Array;
  readonly canonicalPayload: Uint8Array;
  readonly replayInput: VfxReplayInput<Values>;
  readonly patchCount: number;
  readonly channelInputs: readonly VfxChannelInput[];
  readonly droppedCount: number;
}

export interface VfxInstanceError {
  readonly code:
    | VfxEffectContractError['code']
    | 'vfx-instance-parent-mismatch'
    | 'vfx-instance-replay-mismatch'
    | 'vfx-channel-invalid'
    | 'vfx-channel-overflow';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string; readonly actual?: unknown };
}

type InstanceResult<T> = Result<T, VfxInstanceError>;

function failure(
  code: VfxInstanceError['code'],
  path: string,
  expected: string,
  hint: string,
  actual?: unknown,
): InstanceResult<never> {
  return err({
    code,
    expected,
    hint,
    detail: actual === undefined ? { path } : { path, actual },
  });
}

function allFields<Values extends VfxValueMap>(
  contract: VfxEffectContract<Values>,
): readonly { readonly name: string; readonly type: VfxValueType }[] {
  return [...contract.reflection.parameters.fields, ...contract.reflection.custom.fields];
}

function normalizeValue(type: VfxValueType, value: VfxValue): VfxValue {
  const normalize = (component: number): number => {
    if (type === 'i32' || type === 'u32') return Math.trunc(component);
    return Math.fround(component);
  };
  return typeof value === 'number' ? normalize(value) : value.map(normalize);
}

function canonicalBytes<Values extends VfxValueMap>(
  contract: VfxEffectContract<Values>,
  values: Values,
): Uint8Array {
  const fields = allFields(contract)
    .map((field) => ({ name: field.name, type: field.type, value: values[field.name] }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((field) => ({
      name: field.name,
      type: field.type,
      value: field.value === undefined ? undefined : normalizeValue(field.type, field.value),
    }));
  return new TextEncoder().encode(JSON.stringify({ fields }));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function cloneValue(value: VfxValue): VfxValue {
  return typeof value === 'number' ? value : [...value];
}

function cloneValues<Values extends VfxValueMap>(values: Values): Values {
  const clone: Record<string, VfxValue> = {};
  for (const [name, value] of Object.entries(values)) clone[name] = cloneValue(value);
  return Object.freeze(clone) as Values;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function validChannelPayload(payload: unknown): payload is VfxChannelPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  const position = value.position;
  return (
    Array.isArray(position) &&
    position.length === 3 &&
    position.every((component) => typeof component === 'number' && Number.isFinite(component)) &&
    typeof value.strength === 'number' &&
    Number.isFinite(value.strength)
  );
}

function withTick(input: VfxChannelInput, tick: number): VfxChannelInput {
  const result = { ...input } as VfxChannelInput & { tick: number };
  Object.defineProperty(result, 'tick', { value: tick, enumerable: false });
  return Object.freeze(result);
}

export class ParticleEffectInstance<Values extends VfxValueMap = VfxValueMap> {
  readonly contract: VfxEffectContract<Values>;
  #values: Values;
  #generation = 0;
  #sequence = 0;
  #pendingPatches: Partial<Values>[] = [];
  #pendingChannels: VfxChannelInput[] = [];
  #channelCapacities = new Map<string, number>([['impact', 32]]);
  #droppedCount = 0;

  constructor(contract: VfxEffectContract<Values>, options: VfxInstanceOptions<Values> = {}) {
    this.contract = contract;
    if (
      options.parent?.fingerprint !== undefined &&
      options.parent.fingerprint !== contract.fingerprint
    ) {
      throw new TypeError(
        `ParticleEffectInstance parent fingerprint ${options.parent.fingerprint} does not match ${contract.fingerprint}`,
      );
    }
    const parentDefaults = options.parent?.defaults ?? contract.defaults;
    const initial = { ...parentDefaults, ...options.initialValues };
    const checked = contract.createValues(initial);
    if (!checked.ok) throw new TypeError(checked.error.hint);
    this.#values = cloneValues(checked.value);
    for (const channel of options.channels ?? []) {
      this.#channelCapacities.set(channel.id, channel.capacity);
    }
  }

  get values(): Values {
    return this.#values;
  }

  get generation(): number {
    return this.#generation;
  }

  get pendingPatchCount(): number {
    return this.#pendingPatches.length;
  }

  setChannelCapacity(channel: string, capacity: number): void {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('channel capacity must be a positive integer');
    }
    this.#channelCapacities.set(channel, capacity);
  }

  submit(input: VfxChannelInput): InstanceResult<void> {
    if (
      typeof input.channel !== 'string' ||
      input.channel.length === 0 ||
      !Number.isInteger(input.sequence) ||
      input.sequence < 0 ||
      !validChannelPayload(input.payload)
    ) {
      return failure(
        'vfx-channel-invalid',
        `channels.${input.channel || 'unknown'}`,
        'a named channel with a finite impact payload and non-negative integer sequence',
        'repair the typed channel payload before the next FixedUpdate',
      );
    }
    const capacity = this.#channelCapacities.get(input.channel) ?? 32;
    if (this.#pendingChannels.length >= capacity) {
      this.#droppedCount += 1;
      return failure(
        'vfx-channel-overflow',
        `channels.${input.channel}`,
        `at most ${capacity} pending inputs for this channel`,
        'reduce the input rate or increase the reflected channel capacity and recook',
        input.sequence,
      );
    }
    this.#pendingChannels.push(
      Object.freeze({
        channel: input.channel,
        payload: Object.freeze({
          position: [...input.payload.position] as [number, number, number],
          strength: input.payload.strength,
        }),
        sequence: input.sequence,
      }),
    );
    return ok(undefined);
  }

  patch(patch: Partial<Values>): InstanceResult<void> {
    const candidate: VfxValueMap = { ...this.#values, ...patch };
    const checked = this.contract.validateValues(candidate);
    if (!checked.ok) return checked;
    this.#pendingPatches.push(Object.freeze({ ...patch }));
    return ok(undefined);
  }

  commit(options: VfxInstanceCommitOptions): InstanceResult<VfxInstanceCommit<Values>> {
    const candidate: VfxValueMap = { ...this.#values };
    for (const patch of this.#pendingPatches) Object.assign(candidate, patch);
    const checked = this.contract.validateValues(candidate);
    if (!checked.ok) return checked;
    const nextValues = cloneValues(checked.value);
    const packed = this.contract.pack(nextValues);
    if (!packed.ok) return packed;
    const patchCount = this.#pendingPatches.length;
    const droppedCount = this.#droppedCount;
    const channelInputs = Object.freeze(
      [...this.#pendingChannels]
        .sort((left, right) => left.sequence - right.sequence)
        .map((input) => withTick(input, options.tick)),
    );
    this.#pendingPatches = [];
    this.#pendingChannels = [];
    this.#droppedCount = 0;
    if (patchCount > 0) this.#generation += 1;
    this.#values = nextValues;
    const canonicalPayload = canonicalBytes(this.contract, nextValues);
    const sequence = this.#sequence++;
    const replayInput: VfxReplayInput<Values> = Object.freeze({
      seed: options.seed,
      tick: options.tick,
      generation: this.#generation,
      sequence,
      fingerprint: this.contract.fingerprint,
      payload: cloneBytes(canonicalPayload),
      values: nextValues,
      channelInputs,
      droppedCount,
    });
    return ok({
      seed: options.seed,
      tick: options.tick,
      generation: this.#generation,
      sequence,
      values: nextValues,
      parameterBlock: cloneBytes(packed.value),
      canonicalPayload,
      replayInput,
      patchCount,
      channelInputs,
      droppedCount,
    });
  }

  replay(input: VfxReplayInput<Values>): InstanceResult<VfxInstanceCommit<Values>> {
    if (input.fingerprint !== this.contract.fingerprint) {
      return failure(
        'vfx-instance-replay-mismatch',
        'replay.fingerprint',
        this.contract.fingerprint,
        'replay the input with the matching cooked effect contract',
        input.fingerprint,
      );
    }
    const checked = this.contract.validateValues(input.values);
    if (!checked.ok) return checked;
    const canonicalPayload = canonicalBytes(this.contract, checked.value);
    if (!sameBytes(canonicalPayload, input.payload)) {
      return failure(
        'vfx-instance-replay-mismatch',
        'replay.payload',
        'canonical payload bytes for replay.values',
        'record and replay normalized values from the same fixed-tick input',
      );
    }
    const packed = this.contract.pack(checked.value);
    if (!packed.ok) return packed;
    this.#values = cloneValues(checked.value);
    this.#generation = input.generation;
    this.#sequence = Math.max(this.#sequence, input.sequence + 1);
    this.#pendingPatches = [];
    this.#pendingChannels = [...input.channelInputs].map((channel) =>
      withTick(channel, input.tick),
    );
    this.#droppedCount = 0;
    const values = this.#values;
    const replayInput: VfxReplayInput<Values> = Object.freeze({
      ...input,
      payload: cloneBytes(input.payload),
      values,
      channelInputs: this.#pendingChannels,
      droppedCount: input.droppedCount,
    });
    return ok({
      seed: input.seed,
      tick: input.tick,
      generation: input.generation,
      sequence: input.sequence,
      values,
      parameterBlock: cloneBytes(packed.value),
      canonicalPayload,
      replayInput,
      patchCount: 0,
      channelInputs: this.#pendingChannels,
      droppedCount: input.droppedCount,
    });
  }
}

export function createParticleEffectInstance<Values extends VfxValueMap>(
  contract: VfxEffectContract<Values>,
  options: VfxInstanceOptions<Values> = {},
): ParticleEffectInstance<Values> {
  return new ParticleEffectInstance(contract, options);
}
