import type { RenderFeatureWork } from '@forgeax/engine-render';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '@forgeax/engine-render/internal';

type Resource = RenderFeatureWork['resources'][number];
type BufferResource = Extract<Resource, { readonly kind: 'buffer' }>;
type Bindings = Extract<Resource, { readonly kind: 'compute-bindings' }>;
type ArenaBuffer = Omit<BufferResource, 'uploads'> & {
  uploads?: { offset: number; data: ArrayBufferView }[];
};
export interface VfxArenaInstance {
  readonly prefix: string;
  readonly owner: string;
  readonly program: string;
}
export interface VfxArenaRange {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly owner: string;
  readonly source: string;
  readonly scope: string;
  readonly layout: Layout;
  readonly slot: number;
}
type Range = VfxArenaRange;
function retainedStride(size: number, alignment: number, elementStride: number): number {
  if (!Number.isSafeInteger(elementStride) || elementStride <= 0) return NaN;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const multiple = (alignment / gcd(alignment, elementStride)) * elementStride;
  return Math.ceil(size / multiple) * multiple;
}

function arenaBufferLimit(
  limits: Readonly<Partial<GPUSupportedLimits>> | undefined,
  usage: BufferResource['usage'],
): number {
  const maximum = limits?.maxBufferSize ?? 256 * 1024 * 1024;
  return usage.includes('storage')
    ? Math.min(maximum, limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024)
    : maximum;
}

interface Layout {
  readonly id: number;
  readonly size: number;
  readonly stride: number;
  readonly capacity: number;
  readonly usage: BufferResource['usage'];
  readonly slots: (Range | undefined)[];
  lastUsed: number;
}

function remapEntries<T>(entries: readonly T[], remap: (entry: T) => T): readonly T[] {
  let changed: T[] | undefined;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as T;
    const mapped = remap(entry);
    if (changed === undefined && mapped !== entry) changed = entries.slice(0, index);
    changed?.push(mapped);
  }
  return changed ?? entries;
}

/** Fixed slabs never relocate live simulation state when the roster grows. */
export function createVfxInstanceArena() {
  let generation: number | undefined;
  let serial = 0;
  let nextId = 0;
  const layouts = new Map<string, Layout>();
  const leases = new Map<string, Range>();
  let bindingLayouts = new Map<
    string,
    { readonly source: Bindings; readonly resource: Bindings }
  >();
  type FrameInput = {
    readonly liveOwners: ReadonlySet<string>;
    readonly generation: number;
    readonly limits?: Readonly<Partial<GPUSupportedLimits>>;
  };
  let retainedScopes: Map<string, Map<string, Range>> | undefined;
  const begin = (input: FrameInput) => {
    if (generation !== input.generation) {
      generation = input.generation;
      layouts.clear();
      leases.clear();
      bindingLayouts.clear();
      nextId = 0;
    }
    serial += 1;
    leases.forEach((lease, key) => {
      if (input.liveOwners.has(lease.owner)) return;
      lease.layout.slots[lease.slot] = undefined;
      leases.delete(key);
    });
  };
  const pack = (input: {
    readonly work: readonly RenderFeatureWork[];
    readonly instances: readonly VfxArenaInstance[];
    readonly liveOwners: ReadonlySet<string>;
    readonly generation: number;
    /** Consume stock per-frame commands; never pass cached or borrowed commands. */
    readonly transferPasses?: boolean;
    readonly limits?: Readonly<Partial<GPUSupportedLimits>>;
  }): readonly RenderFeatureWork[] => {
    if (retainedScopes === undefined) begin(input);
    const instances = new Map<string, VfxArenaInstance>();
    for (const row of input.instances) instances.set(row.prefix, row);
    const instanceFor = (name: string) => {
      const marker = name.indexOf('.e-');
      const end = marker < 0 ? -1 : name.indexOf('.', marker + 3);
      if (end >= 0) return instances.get(name.slice(0, end));
      // Internal tests and non-stock naming keep the exact prefix boundary.
      return input.instances.find((row) => name.startsWith(`${row.prefix}.`));
    };
    const retained = retainedScopes;
    retainedScopes = undefined;
    const shared = retained?.get('frame') ?? new Map<string, Range>();
    const nextBindingLayouts: typeof bindingLayouts = new Map();
    const packed = input.work.map((work): RenderFeatureWork => {
      const scope = work.scope === 'frame' ? 'frame' : `view:${work.scope.view}`;
      const local =
        work.scope === 'frame' ? shared : (retained?.get(scope) ?? new Map<string, Range>());
      const arenas = new Map<string, ArenaBuffer>();
      const resources: Resource[] = [];
      for (const resource of work.resources) {
        if (resource.kind !== 'buffer') continue;
        const instance = instanceFor(resource.name);
        const alignment = resource.usage.includes('uniform')
          ? (input.limits?.minUniformBufferOffsetAlignment ?? 256)
          : (input.limits?.minStorageBufferOffsetAlignment ?? 256);
        const stride = Math.ceil(resource.size / alignment) * alignment;
        const capacity = Math.min(
          16,
          Math.floor(arenaBufferLimit(input.limits, resource.usage) / stride),
        );
        // Unknown/provider resources retain ordinary admission and observation.
        if (
          instance === undefined ||
          !Number.isSafeInteger(resource.size) ||
          resource.size <= 0 ||
          !Number.isSafeInteger(stride) ||
          stride <= 0 ||
          capacity < 2 ||
          resource.uploads !== undefined ||
          (resource.data !== undefined &&
            (resource.data.byteLength > resource.size || resource.data.byteLength % 4 !== 0))
        ) {
          resources.push(resource);
          continue;
        }
        const leaseKey = `${scope}:${resource.name}`;
        let range = leases.get(leaseKey);
        if (
          range !== undefined &&
          (range.size !== resource.size ||
            range.layout.usage.length !== resource.usage.length ||
            !resource.usage.every((usage, index) => usage === range?.layout.usage[index]))
        ) {
          range.layout.slots[range.slot] = undefined;
          leases.delete(leaseKey);
          range = undefined;
        }
        if (range === undefined) {
          const role = resource.name.slice(instance.prefix.length);
          const layoutKey = JSON.stringify([
            instance.program,
            scope,
            role,
            resource.size,
            resource.usage,
          ]);
          let layout = layouts.get(layoutKey);
          if (layout === undefined) {
            layout = {
              id: nextId++,
              size: resource.size,
              stride,
              capacity,
              usage: [...resource.usage],
              slots: [],
              lastUsed: serial,
            };
            layouts.set(layoutKey, layout);
          }
          let slot = layout.slots.indexOf(undefined);
          if (slot < 0) slot = layout.slots.length;
          range = {
            name: `vfx.arena-${layout.id}.slab-${Math.floor(slot / layout.capacity)}`,
            offset: (slot % layout.capacity) * layout.stride,
            size: resource.size,
            owner: instance.owner,
            source: resource.name,
            scope,
            layout,
            slot,
          };
          layout.slots[slot] = range;
          leases.set(leaseKey, range);
        }
        range.layout.lastUsed = serial;
        local.set(resource.name, range);
        let arena = arenas.get(range.name);
        if (arena === undefined) {
          arena = {
            kind: 'buffer',
            name: range.name,
            size: range.layout.stride * range.layout.capacity,
            usage: range.layout.usage,
          };
          arenas.set(range.name, arena);
        }
        if (resource.data !== undefined) {
          arena.uploads ??= [];
          arena.uploads.push({ offset: range.offset, data: resource.data });
        }
      }
      const range = (name: string) =>
        local.get(name) ?? (work.scope === 'frame' ? undefined : shared.get(name));
      const at = (name: string, offset = 0, size?: number) => {
        const mapped = range(name);
        if (
          mapped !== undefined &&
          (!Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > mapped.size ||
            (size !== undefined &&
              (!Number.isSafeInteger(size) || size <= 0 || size > mapped.size - offset)))
        ) {
          // Internal stock declarations must not gain access to a neighbouring slot.
          throw new RangeError(`Invalid owned VFX arena range: ${name}`);
        }
        return mapped;
      };
      for (const arena of arenas.values()) resources.push(arena);
      for (const resource of work.resources) {
        if (resource.kind === 'buffer') continue;
        if (resource.kind === 'compute-bindings') {
          if (!resource.entries.some((entry) => range(entry.resource) !== undefined)) {
            resources.push(resource);
            continue;
          }
          const previous = bindingLayouts.get(`${scope}:${resource.name}`);
          if (
            previous?.source === resource &&
            resource.entries.every((entry, index) => {
              const mapped = at(entry.resource, entry.offset, entry.size);
              const old = previous.resource.entries[index];
              return (
                old !== undefined &&
                old.resource === (mapped?.name ?? entry.resource) &&
                (old.offset ?? 0) === (mapped?.offset ?? 0) + (entry.offset ?? 0) &&
                old.size ===
                  (entry.size ??
                    (mapped === undefined ? undefined : mapped.size - (entry.offset ?? 0)))
              );
            })
          ) {
            resources.push(previous.resource);
            nextBindingLayouts.set(`${scope}:${resource.name}`, previous);
            continue;
          }
          const next: Bindings = {
            ...resource,
            entries: resource.entries.map((entry) => {
              const mapped = at(entry.resource, entry.offset, entry.size);
              return mapped === undefined
                ? entry
                : {
                    ...entry,
                    resource: mapped.name,
                    offset: mapped.offset + (entry.offset ?? 0),
                    size: entry.size ?? mapped.size - (entry.offset ?? 0),
                  };
            }),
          };
          const owned = isOwnedRenderFeatureProgramData(resource)
            ? ownRenderFeatureProgramData(next)
            : next;
          resources.push(owned);
          if (isOwnedRenderFeatureProgramData(resource))
            nextBindingLayouts.set(`${scope}:${resource.name}`, {
              source: resource,
              resource: owned,
            });
        } else if (
          (resource.kind === 'vertex-data' || resource.kind === 'index-data') &&
          resource.buffer !== undefined
        ) {
          const mapped = at(resource.buffer, resource.offset, resource.size);
          resources.push(
            mapped === undefined
              ? resource
              : {
                  ...resource,
                  buffer: mapped.name,
                  offset: mapped.offset + (resource.offset ?? 0),
                  size: resource.size ?? mapped.size - (resource.offset ?? 0),
                },
          );
        } else if (resource.kind === 'graphics-bindings') {
          let values: Record<string, unknown> | undefined;
          for (const key of ['runtime', 'instances']) {
            const name = resource.values[key];
            const mapped = typeof name === 'string' ? range(name) : undefined;
            if (mapped !== undefined) {
              values ??= { ...resource.values };
              values[key] = mapped.name;
            }
          }
          resources.push(
            values === undefined
              ? resource
              : { ...resource, values: values as typeof resource.values },
          );
        } else resources.push(resource);
      }
      const passes = remapEntries(work.passes, (pass) => {
        if (pass.kind === 'copy') {
          const copies = remapEntries(pass.copies, (copy) => {
            const source = at(copy.source, copy.sourceOffset, copy.size),
              destination = at(copy.destination, copy.destinationOffset, copy.size);
            if (input.transferPasses && (source !== undefined || destination !== undefined)) {
              const owned = copy as { -readonly [Key in keyof typeof copy]: (typeof copy)[Key] };
              owned.source = source?.name ?? copy.source;
              owned.destination = destination?.name ?? copy.destination;
              owned.sourceOffset = (source?.offset ?? 0) + (copy.sourceOffset ?? 0);
              owned.destinationOffset = (destination?.offset ?? 0) + (copy.destinationOffset ?? 0);
              return owned;
            }
            return source === undefined && destination === undefined
              ? copy
              : {
                  ...copy,
                  source: source?.name ?? copy.source,
                  destination: destination?.name ?? copy.destination,
                  sourceOffset: (source?.offset ?? 0) + (copy.sourceOffset ?? 0),
                  destinationOffset: (destination?.offset ?? 0) + (copy.destinationOffset ?? 0),
                };
          });
          return copies === pass.copies ? pass : { ...pass, copies };
        }
        if (pass.kind === 'compute') {
          const dispatches = remapEntries(pass.dispatches, (dispatch) => {
            if (dispatch.kind !== 'indirect') return dispatch;
            const mapped = at(dispatch.resource, dispatch.offset, 12);
            if (input.transferPasses && mapped !== undefined) {
              const owned = dispatch as {
                -readonly [Key in keyof typeof dispatch]: (typeof dispatch)[Key];
              };
              owned.resource = mapped.name;
              owned.offset = mapped.offset + dispatch.offset;
              return owned;
            }
            return mapped === undefined
              ? dispatch
              : { ...dispatch, resource: mapped.name, offset: mapped.offset + dispatch.offset };
          });
          return dispatches === pass.dispatches ? pass : { ...pass, dispatches };
        }
        const draws = remapEntries(pass.draws, (draw) => {
          if (draw.draw.kind !== 'draw-indirect' && draw.draw.kind !== 'draw-indexed-indirect')
            return draw;
          const mapped = at(
            draw.draw.resource,
            draw.draw.offset,
            draw.draw.kind === 'draw-indirect' ? 16 : 20,
          );
          if (input.transferPasses && mapped !== undefined) {
            const owned = draw.draw as {
              -readonly [Key in keyof typeof draw.draw]: (typeof draw.draw)[Key];
            };
            owned.resource = mapped.name;
            owned.offset = mapped.offset + (draw.draw.offset ?? 0);
            return draw;
          }
          return mapped === undefined
            ? draw
            : {
                ...draw,
                draw: {
                  ...draw.draw,
                  resource: mapped.name,
                  offset: mapped.offset + (draw.draw.offset ?? 0),
                },
              };
        });
        return draws === pass.draws ? pass : { ...pass, draws };
      });
      if (work.scope === 'frame')
        local.forEach((value, name) => {
          shared.set(name, value);
        });
      return { ...work, resources, passes };
    });
    layouts.forEach((layout, key) => {
      if (
        layout.lastUsed > serial - 8 ||
        layout.slots.some((slot) => slot !== undefined && input.liveOwners.has(slot.owner))
      )
        return;
      layouts.delete(key);
      leases.forEach((lease, name) => {
        if (lease.layout === layout) leases.delete(name);
      });
    });
    bindingLayouts = nextBindingLayouts;
    return packed;
  };
  return Object.assign(pack, {
    discardRetainedFrame: () => {
      retainedScopes = undefined;
    },
    beginRetainedFrame: (input: FrameInput) => {
      begin(input);
      const scopes = new Map<string, Map<string, Range>>();
      retainedScopes = scopes;
      const retain = (entries: readonly Range[]) => {
        if (
          entries.some(
            (range) =>
              leases.get(`${range.scope}:${range.source}`) !== range ||
              !input.liveOwners.has(range.owner),
          )
        )
          return false;
        for (const range of entries) {
          range.layout.lastUsed = serial;
          let ranges = scopes.get(range.scope);
          if (ranges === undefined) {
            ranges = new Map();
            scopes.set(range.scope, ranges);
          }
          ranges.set(range.source, range);
        }
        return true;
      };
      return {
        retain,
        supports: (size: number, usage: BufferResource['usage'], elementStride = 4) => {
          const alignment = usage.includes('uniform')
            ? (input.limits?.minUniformBufferOffsetAlignment ?? 256)
            : (input.limits?.minStorageBufferOffsetAlignment ?? 256);
          const stride = retainedStride(size, alignment, elementStride);
          return (
            Number.isSafeInteger(size) &&
            size > 0 &&
            Number.isSafeInteger(stride) &&
            stride > 0 &&
            Math.floor(arenaBufferLimit(input.limits, usage) / stride) >= 2
          );
        },
        acquire: (
          instance: VfxArenaInstance,
          name: string,
          size: number,
          usage: BufferResource['usage'],
          scope = 'frame',
          elementStride = 4,
        ): Range => {
          if (!Number.isSafeInteger(elementStride) || elementStride <= 0)
            throw new RangeError('Invalid retained VFX element stride');
          const alignment = usage.includes('uniform')
            ? (input.limits?.minUniformBufferOffsetAlignment ?? 256)
            : (input.limits?.minStorageBufferOffsetAlignment ?? 256);
          const stride = retainedStride(size, alignment, elementStride);
          const key = `${scope}:${name}`;
          let range = leases.get(key);
          if (
            range !== undefined &&
            range.size === size &&
            range.layout.stride === stride &&
            range.owner === instance.owner &&
            range.layout.usage.length === usage.length &&
            usage.every((item, index) => item === range?.layout.usage[index])
          ) {
            retain([range]);
            return range;
          }
          if (range !== undefined) {
            range.layout.slots[range.slot] = undefined;
            leases.delete(key);
          }
          const capacity = Math.min(16, Math.floor(arenaBufferLimit(input.limits, usage) / stride));
          if (
            !Number.isSafeInteger(size) ||
            size <= 0 ||
            !Number.isSafeInteger(stride) ||
            stride <= 0 ||
            capacity < 2
          )
            throw new RangeError('Invalid retained VFX arena layout');
          const layoutKey = JSON.stringify([
            instance.program,
            scope,
            name.slice(instance.prefix.length),
            size,
            stride,
            usage,
          ]);
          let layout = layouts.get(layoutKey);
          if (layout === undefined) {
            layout = {
              id: nextId++,
              size,
              stride,
              capacity,
              usage: [...usage],
              slots: [],
              lastUsed: serial,
            };
            layouts.set(layoutKey, layout);
          }
          let slot = layout.slots.indexOf(undefined);
          if (slot < 0) slot = layout.slots.length;
          range = {
            name: `vfx.arena-${layout.id}.slab-${Math.floor(slot / layout.capacity)}`,
            offset: (slot % layout.capacity) * stride,
            size,
            owner: instance.owner,
            source: name,
            scope,
            layout,
            slot,
          };
          layout.slots[slot] = range;
          leases.set(key, range);
          retain([range]);
          return range;
        },
        declaration: (range: Range): BufferResource => ({
          kind: 'buffer',
          name: range.name,
          size: range.layout.stride * range.layout.capacity,
          usage: range.layout.usage,
        }),
      };
    },
  });
}
