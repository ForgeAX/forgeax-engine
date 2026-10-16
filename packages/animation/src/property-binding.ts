import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import {
  type AnimationPropertyChannel,
  type AnimationTargetIdValue,
  err,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { emitAnimationDiagnostic } from './animation-diagnostic';
import { AnimationPlayer } from './animation-player';
import { AnimationBindingError, type AnimationError } from './solver-errors';
import { isAnimationTargetId } from './target-id';

type Value = number | boolean | string | number[];
type ValueKind = 'number' | 'vector' | 'quaternion' | 'boolean' | 'string';
interface Binding {
  readonly kind: ValueKind;
  readonly width: number;
  readonly write: (value: Value) => void;
}
const bindings = new WeakMap<World, Map<EntityHandle, Map<string, Binding>>>();
const validatedSamplers = new WeakSet<object>();
const key = (target: string, name: string) => `${target}:${name}`;

function kindOf(value: unknown): ValueKind | undefined {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
    return typeof value as ValueKind;
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView)))
    return 'vector';
  return undefined;
}

function bind(
  world: World,
  player: EntityHandle,
  target: AnimationTargetIdValue,
  name: string,
  value: unknown,
  write: Binding['write'],
  quaternion = false,
): Result<() => void, AnimationError> {
  const kind = quaternion ? 'quaternion' : kindOf(value);
  if (
    !world.get(player, AnimationPlayer).ok ||
    !isAnimationTargetId(target) ||
    name.length === 0 ||
    kind === undefined ||
    (kind === 'number' && !Number.isFinite(value))
  ) {
    return err(
      new AnimationBindingError('animation-property-binding-invalid', { player, target, name }),
    );
  }
  const width =
    kind === 'vector' || kind === 'quaternion' ? (value as ArrayLike<number>).length : 1;
  if (
    (kind === 'vector' || kind === 'quaternion') &&
    Array.from(value as ArrayLike<unknown>).some(
      (entry) => typeof entry !== 'number' || !Number.isFinite(entry),
    )
  )
    return err(
      new AnimationBindingError('animation-property-binding-invalid', { player, target, name }),
    );
  if (!Number.isSafeInteger(width) || width < 1 || (kind === 'quaternion' && width !== 4))
    return err(
      new AnimationBindingError('animation-property-binding-invalid', { player, target, name }),
    );
  let players = bindings.get(world);
  if (players === undefined) {
    players = new Map();
    bindings.set(world, players);
  }
  let properties = players.get(player);
  if (properties === undefined) {
    properties = new Map();
    players.set(player, properties);
  }
  const bindingKey = key(target, name);
  if (properties.has(bindingKey))
    return err(
      new AnimationBindingError('animation-property-binding-conflict', { player, target, name }),
    );
  const binding = { kind, width, write };
  properties.set(bindingKey, binding);
  return ok(() => {
    if (properties?.get(bindingKey) === binding) properties.delete(bindingKey);
    if (properties?.size === 0) players?.delete(player);
  });
}

/** Compile a property path once. Keep the disposer for the object's lifetime. */
export function bindObjectProperty(
  world: World,
  player: EntityHandle,
  target: AnimationTargetIdValue,
  name: string,
  options: {
    readonly object: object;
    readonly path: readonly (string | number)[];
    readonly quaternion?: boolean;
  },
): Result<() => void, AnimationError> {
  let owner = options.object as Record<string | number, unknown>;
  const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  if (options.path.length === 0 || options.path.some((part) => forbidden.has(String(part))))
    return err(
      new AnimationBindingError('animation-property-binding-invalid', { player, target, name }),
    );
  for (let i = 0; i < options.path.length - 1; i++) {
    const part = options.path[i] as string | number;
    if (!Object.hasOwn(owner, part))
      return err(
        new AnimationBindingError('animation-property-binding-invalid', { player, target, name }),
      );
    const next = owner[part];
    if (next === null || typeof next !== 'object')
      return err(
        new AnimationBindingError('animation-property-binding-invalid', { player, target, name }),
      );
    owner = next as typeof owner;
  }
  const field = options.path[options.path.length - 1] as string | number;
  if (!Object.hasOwn(owner, field))
    return err(
      new AnimationBindingError('animation-property-binding-invalid', { player, target, name }),
    );
  const value = owner[field];
  const vector = kindOf(value) === 'vector';
  const length = vector ? (value as ArrayLike<number>).length : 0;
  const descriptor = Object.getOwnPropertyDescriptor(owner, field);
  if (
    (vector && Object.isFrozen(value)) ||
    (descriptor?.writable === false && descriptor.set === undefined)
  )
    return err(
      new AnimationBindingError('animation-property-binding-invalid', { player, target, name }),
    );
  return bind(
    world,
    player,
    target,
    name,
    value,
    (next) => {
      try {
        if (vector) {
          if (owner[field] !== value || (value as ArrayLike<number>).length !== length)
            throw new AnimationBindingError('animation-property-target-stale', {
              player,
              target,
              name,
            });
          const array = value as { [index: number]: number; length: number };
          for (let i = 0; i < length; i++) array[i] = (next as ArrayLike<number>)[i] as number;
        } else owner[field] = next;
      } catch (failure) {
        if (failure instanceof AnimationBindingError) throw failure;
        throw new AnimationBindingError('animation-property-target-stale', {
          player,
          target,
          name,
          cause: failure instanceof Error ? failure.message : String(failure),
        });
      }
    },
    options.quaternion,
  );
}

/** The schema and World.set own the value and change evidence, never a snapshot mutation. */
export function bindComponentProperty(
  world: World,
  player: EntityHandle,
  target: AnimationTargetIdValue,
  name: string,
  options: {
    readonly entity: EntityHandle;
    readonly component: Component;
    readonly field: string;
    readonly quaternion?: boolean;
  },
): Result<() => void, AnimationError> {
  const { entity, component, field } = options;
  const current = world.get(entity, component);
  const type = component.fields[field]?.type;
  if (
    !current.ok ||
    type === undefined ||
    !(
      type === 'string' ||
      type === 'bool' ||
      /^(?:f32|f64|[iu](?:8|16|32))$/.test(type) ||
      /^array<(?:f32|f64|[iu](?:8|16|32)),?\s*\d*>$/.test(type)
    )
  )
    return err(
      new AnimationBindingError('animation-property-binding-invalid', {
        player,
        target,
        name,
        entity,
        field,
      }),
    );
  const length = world[worldRead].getArrayLength(entity, component, field);
  return bind(
    world,
    player,
    target,
    name,
    (current.value as Record<string, unknown>)[field],
    (value) => {
      if (
        length !== undefined &&
        world[worldRead].getArrayLength(entity, component, field) !== length
      )
        throw new AnimationBindingError('animation-property-target-stale', {
          player,
          target,
          name,
          entity,
          field,
        });
      const written = world.set(entity, component, { [field]: value });
      if (!written.ok)
        throw new AnimationBindingError('animation-property-target-stale', {
          player,
          target,
          name,
          entity,
          cause: written.error.code,
        });
    },
    options.quaternion,
  );
}

export interface PropertyAccumulator {
  readonly channel: AnimationPropertyChannel;
  readonly clip: number;
  readonly channelIndex: number;
  readonly binding: Binding;
  values: number[];
  weight: number;
  discrete: Value;
  strongest: number;
}
export function accumulateProperty(
  world: World,
  player: EntityHandle,
  channel: AnimationPropertyChannel,
  time: number,
  weight: number,
  accumulators: Map<string, PropertyAccumulator>,
  clip: number,
  channelIndex: number,
  sample: (
    sampler: {
      input: Float32Array;
      output: Float32Array;
      interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
    },
    time: number,
    property: 'rotation' | 'weights',
  ) => number[] | undefined,
): void {
  const bindingKey = key(channel.targetId, channel.binding);
  const binding = bindings.get(world)?.get(player)?.get(bindingKey);
  if (binding === undefined)
    throw new AnimationBindingError('animation-property-binding-missing', {
      player,
      target: channel.targetId,
      name: channel.binding,
    });
  const { input, output, interpolation } = channel.sampler;
  if (!validatedSamplers.has(channel.sampler)) {
    if (
      input.some(
        (value, index) =>
          !Number.isFinite(value) || (index > 0 && value <= (input[index - 1] as number)),
      ) ||
      (output instanceof Float32Array
        ? output.some((value) => !Number.isFinite(value))
        : output.some((value) => typeof value !== typeof output[0]))
    )
      throw new AnimationBindingError('animation-property-sampler-invalid', {
        player,
        target: channel.targetId,
        name: channel.binding,
      });
    validatedSamplers.add(channel.sampler);
  }
  if (
    (binding.kind === 'string' && typeof output[0] !== 'string') ||
    (binding.kind === 'boolean' && typeof output[0] !== 'boolean')
  )
    throw new AnimationBindingError('animation-property-sampler-invalid', {
      player,
      target: channel.targetId,
      name: channel.binding,
    });
  if (!(output instanceof Float32Array) && interpolation !== 'STEP')
    throw new AnimationBindingError('animation-property-sampler-invalid', {
      player,
      target: channel.targetId,
      name: channel.binding,
    });
  if (
    input.length === 0 ||
    output.length !== input.length * binding.width * (interpolation === 'CUBICSPLINE' ? 3 : 1) ||
    (binding.kind === 'string' || binding.kind === 'boolean') !== !(output instanceof Float32Array)
  )
    throw new AnimationBindingError('animation-property-sampler-invalid', {
      player,
      target: channel.targetId,
      name: channel.binding,
    });
  let acc = accumulators.get(bindingKey);
  if (acc === undefined) {
    acc = {
      channel,
      clip,
      channelIndex,
      binding,
      values: new Array<number>(binding.width).fill(0),
      weight: 0,
      discrete: 0,
      strongest: -1,
    };
    accumulators.set(bindingKey, acc);
  }
  if (!(output instanceof Float32Array)) {
    let low = 0;
    let high = input.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((input[mid] as number) <= time) low = mid + 1;
      else high = mid;
    }
    if (weight > acc.strongest) {
      acc.discrete = output[Math.max(0, low - 1)] as string | boolean;
      acc.strongest = weight;
    }
    return;
  }
  const values = sample(
    { input, output, interpolation },
    time,
    binding.kind === 'quaternion' ? 'rotation' : 'weights',
  );
  if (values === undefined || values.some((value) => !Number.isFinite(value)))
    throw new AnimationBindingError('animation-property-sampler-invalid', {
      player,
      target: channel.targetId,
      name: channel.binding,
    });
  const sign =
    binding.kind === 'quaternion' &&
    acc.weight > 0 &&
    values.reduce((dot, value, i) => dot + value * (acc?.values[i] ?? 0), 0) < 0
      ? -1
      : 1;
  for (let i = 0; i < values.length; i++)
    acc.values[i] = (acc.values[i] ?? 0) + weight * sign * (values[i] ?? 0);
  acc.weight += weight;
}

export function writeProperties(
  world: World,
  player: EntityHandle,
  accumulators: Map<string, PropertyAccumulator>,
): void {
  for (const {
    binding,
    values,
    weight,
    discrete,
    channel,
    clip,
    channelIndex,
  } of accumulators.values()) {
    try {
      if (binding.kind === 'string' || binding.kind === 'boolean') {
        binding.write(discrete);
        continue;
      }
      const divisor = binding.kind === 'quaternion' ? Math.hypot(...values) : weight;
      if (divisor <= 0) continue;
      for (let i = 0; i < values.length; i++) values[i] = (values[i] ?? 0) / divisor;
      binding.write(binding.kind === 'number' ? (values[0] as number) : values);
    } catch (failure) {
      reportPropertyFailure(world, player, channel, clip, channelIndex, failure);
    }
  }
}

export function clearPropertyBindings(world: World): void {
  bindings.delete(world);
}

export function reportPropertyFailure(
  world: World,
  player: EntityHandle,
  channel: AnimationPropertyChannel,
  clip: number,
  channelIndex: number,
  failure: unknown,
): void {
  if (!(failure instanceof AnimationBindingError)) throw failure;
  emitAnimationDiagnostic(world, {
    code: 'animation-property-invalid',
    hint: failure.hint,
    detail: {
      player,
      clip,
      channel: channelIndex,
      targetId: channel.targetId,
      binding: channel.binding,
      property: 'property',
      reason: 'property-invalid',
      cause: failure.code,
    },
  });
}
