import type {
  BindGroup,
  BindGroupDescriptor,
  BindGroupEntry,
  BindGroupLayout,
  RenderPipeline,
  RhiDevice,
} from '@forgeax/engine-rhi';
import type { ShaderEntryPointReads } from '@forgeax/engine-types';
import type { SkylightBindGroupResources } from '../ibl/skylight-bind-group';
import { bindGroupChainLeaf } from '../record/mesh-ssbo';

const REFLECTION_TEXTURE = 32;
const REFLECTION_SAMPLER = 33;
const REFLECTION_PARAMS = 34;
const reflectionEntries: readonly GPUBindGroupLayoutEntry[] = [
  {
    binding: REFLECTION_TEXTURE,
    visibility: 2,
    texture: { sampleType: 'float', viewDimension: '2d' },
  },
  { binding: REFLECTION_SAMPLER, visibility: 2, sampler: { type: 'filtering' } },
  { binding: REFLECTION_PARAMS, visibility: 2, buffer: { type: 'uniform' } },
];
export type PrimitiveReflection = Pick<
  SkylightBindGroupResources,
  'prefilterView' | 'prefilterSampler' | 'intensityBuffer'
>;

export function samePrimitiveReflection(
  left: PrimitiveReflection | undefined,
  right: PrimitiveReflection | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.prefilterView === right.prefilterView &&
      left.prefilterSampler === right.prefilterSampler &&
      left.intensityBuffer === right.intensityBuffer)
  );
}

export type ReflectionLayout = {
  readonly base: BindGroupLayout;
  readonly layout: BindGroupLayout;
  readonly slots: ReadonlySet<number>;
};

const baseLayouts = new WeakMap<BindGroupLayout, Map<number, ReflectionLayout>>();
const pipelines = new WeakMap<RenderPipeline, ReflectionLayout>();
const primitiveGroups = new WeakMap<BindGroup, BindGroupDescriptor>();
const groupCache = new WeakMap<object, unknown>();

export function primitiveReflectionReads(
  entries: readonly ShaderEntryPointReads[] | undefined,
  fragment: string | null | undefined,
): number {
  const reads = entries?.find((entry) => entry.stage === 'fragment' && entry.name === fragment);
  let mask = 0;
  for (const { group, binding } of reads?.bindings ?? []) {
    if (group === 2 && binding >= REFLECTION_TEXTURE && binding <= REFLECTION_PARAMS)
      mask |= 1 << (binding - REFLECTION_TEXTURE);
  }
  return mask;
}

export function projectPrimitiveReflectionLayout(
  device: Pick<RhiDevice, 'createBindGroupLayout'>,
  base: BindGroupLayout,
  entries: readonly GPUBindGroupLayoutEntry[],
  mask: number,
): ReflectionLayout {
  let byReads = baseLayouts.get(base);
  if (byReads === undefined) {
    byReads = new Map();
    baseLayouts.set(base, byReads);
  }
  const cached = byReads.get(mask);
  if (cached !== undefined) return cached;
  const selected = reflectionEntries.filter((_, index) => (mask & (1 << index)) !== 0);
  const layout = device
    .createBindGroupLayout({
      label: 'pbr-primitive-reflection-bgl',
      entries: [...entries, ...selected],
    })
    .unwrap();
  const result = { base, layout, slots: new Set(selected.map(({ binding }) => binding)) };
  byReads.set(mask, result);
  return result;
}

/** Keep geometry windows and offsets in their existing owner; decorate only entries read. */
export function createPrimitiveBindGroup(
  device: Pick<RhiDevice, 'createBindGroup'>,
  descriptor: BindGroupDescriptor,
) {
  const result = device.createBindGroup(descriptor);
  if (result.ok) primitiveGroups.set(result.value, descriptor);
  return result;
}

export function retainPipelinePrimitiveReflection(
  pipeline: RenderPipeline,
  layout: ReflectionLayout | undefined,
): void {
  if (layout !== undefined) pipelines.set(pipeline, layout);
}

export function primitiveForPipeline(
  device: Pick<RhiDevice, 'createBindGroup'>,
  pipeline: RenderPipeline,
  base: BindGroup,
  reflection: PrimitiveReflection | undefined,
): BindGroup {
  const layout = pipelines.get(pipeline);
  if (layout === undefined) return base;
  if (reflection === undefined) throw new Error('Primitive reflection resources are required');
  return primitiveWithReflection(device, base, layout, reflection);
}

function primitiveWithReflection(
  device: Pick<RhiDevice, 'createBindGroup'>,
  base: BindGroup,
  layout: ReflectionLayout,
  reflection: PrimitiveReflection,
): BindGroup {
  const descriptor = primitiveGroups.get(base);
  if (descriptor === undefined) throw new Error('The primitive binding has no geometry receipt');
  const slots = layout.slots;
  const keys: object[] = [base, layout.layout];
  if (slots.has(REFLECTION_TEXTURE)) keys.push(reflection.prefilterView);
  if (slots.has(REFLECTION_SAMPLER)) keys.push(reflection.prefilterSampler);
  if (slots.has(REFLECTION_PARAMS)) keys.push(reflection.intensityBuffer);
  const cache = bindGroupChainLeaf(groupCache, keys);
  const cached = cache.get('primitive-reflection');
  if (cached !== undefined) return cached;
  const extra: BindGroupEntry[] = [
    {
      binding: REFLECTION_TEXTURE,
      resource: { kind: 'textureView', value: reflection.prefilterView },
    },
    {
      binding: REFLECTION_SAMPLER,
      resource: { kind: 'sampler', value: reflection.prefilterSampler },
    },
    {
      binding: REFLECTION_PARAMS,
      resource: { kind: 'buffer', value: { buffer: reflection.intensityBuffer } },
    },
  ];
  const group = device
    .createBindGroup({
      label: 'pbr-primitive-reflection-bg',
      layout: layout.layout,
      entries: [...descriptor.entries, ...extra.filter(({ binding }) => slots.has(binding))],
    })
    .unwrap();
  cache.set('primitive-reflection', group);
  return group;
}
