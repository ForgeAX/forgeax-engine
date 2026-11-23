import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  Buffer,
  RhiDevice,
  TextureView,
} from '@forgeax/engine-rhi';
import {
  STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
  STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
} from '@forgeax/engine-shader';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { SKY_SH_BYTES } from '../ibl/sky-sh';
import type { PipelineState } from '../record/render-context';

export const FORWARD_HIZ_VIEW_SLOT = 27;
export const FORWARD_SCREEN_SURFACE_VIEW_SLOT = 29;
export const FORWARD_SSR_COLOR_VIEW_SLOT = 28;

export const CLUSTER_LIGHT_VIEW_SLOT = 30;
export const CLUSTER_GRID_VIEW_SLOT = 31;
export const CLUSTER_INDICES_VIEW_SLOT = 32;
export const CLUSTER_PARAMS_VIEW_SLOT = 33;
const VIEW_SKY_SH = 34;
const VIEW_SKY_DIFFUSE = 35;
export const TRANSMISSION_BACKDROP_VIEW_SLOT = 38;
const ENVIRONMENT_DFG_VIEW_SLOT = 39;
export const DIRECT_DFG_VIEW_SLOT = 40;
const TRANSMISSION_BACKDROP_VIEW_LAYOUT_ENTRY: GPUBindGroupLayoutEntry = {
  binding: TRANSMISSION_BACKDROP_VIEW_SLOT,
  visibility: GPU_SHADER_STAGE_FRAGMENT,
  texture: { sampleType: 'float', viewDimension: '2d' },
};
const DFG_VIEW_LAYOUT_ENTRIES: readonly GPUBindGroupLayoutEntry[] = [
  ENVIRONMENT_DFG_VIEW_SLOT,
  DIRECT_DFG_VIEW_SLOT,
].map((binding) => ({
  binding,
  visibility: GPU_SHADER_STAGE_FRAGMENT,
  texture: { sampleType: 'float', viewDimension: '2d' },
}));
const SKY_VIEW_ENTRIES: readonly GPUBindGroupLayoutEntry[] = [
  {
    binding: VIEW_SKY_SH,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    buffer: { type: 'uniform', minBindingSize: SKY_SH_BYTES },
  },
  {
    binding: VIEW_SKY_DIFFUSE,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    buffer: { type: 'uniform' },
  },
];

export const PLANAR_REFLECTION_VIEW_LAYOUT_ENTRIES = [
  {
    binding: STANDARD_PLANAR_REFLECTION_TEXTURE_BINDING,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
  },
  {
    binding: STANDARD_PLANAR_REFLECTION_UNIFORM_BINDING,
    visibility: GPU_SHADER_STAGE_FRAGMENT,
    buffer: { type: 'uniform' as const, hasDynamicOffset: false },
  },
] as const;

const STANDARD_VIEW_LAYOUT_ENTRIES = [
  ...SKY_VIEW_ENTRIES,
  ...PLANAR_REFLECTION_VIEW_LAYOUT_ENTRIES,
  TRANSMISSION_BACKDROP_VIEW_LAYOUT_ENTRY,
  ...DFG_VIEW_LAYOUT_ENTRIES,
];
type ViewSky = {
  readonly skySh: Buffer;
  readonly intensityBuffer: Buffer;
  readonly brdfLutView: TextureView;
};

export function directDfgViewBinding(view: TextureView): BindGroupEntry {
  return { binding: DIRECT_DFG_VIEW_SLOT, resource: { kind: 'textureView', value: view } };
}

export function skyViewBindings(sky: ViewSky): BindGroupEntry[] {
  return [
    {
      binding: VIEW_SKY_SH,
      resource: { kind: 'buffer', value: { buffer: sky.skySh, size: SKY_SH_BYTES } },
    },
    {
      binding: VIEW_SKY_DIFFUSE,
      resource: { kind: 'buffer', value: { buffer: sky.intensityBuffer } },
    },
    {
      binding: ENVIRONMENT_DFG_VIEW_SLOT,
      resource: { kind: 'textureView', value: sky.brdfLutView },
    },
  ];
}

export function clusterViewLayoutEntries(storage: boolean): GPUBindGroupLayoutEntry[] {
  return [
    ...(storage
      ? [CLUSTER_LIGHT_VIEW_SLOT, CLUSTER_GRID_VIEW_SLOT, CLUSTER_INDICES_VIEW_SLOT].map(
          (binding): GPUBindGroupLayoutEntry => ({
            binding,
            visibility: 2,
            buffer: { type: 'read-only-storage' },
          }),
        )
      : [
          {
            binding: CLUSTER_LIGHT_VIEW_SLOT,
            visibility: 2,
            texture: { sampleType: 'uint' as const, viewDimension: '2d' as const },
          },
        ]),
    { binding: CLUSTER_PARAMS_VIEW_SLOT, visibility: 2, buffer: { type: 'uniform' } },
  ];
}

const ATMOSPHERE_VIEW_TEXTURES = [
  [18, 'transmittance', '2d'],
  [19, 'multipleScattering', '2d'],
  [20, 'aerialPerspective', '3d'],
  [21, 'aerialTransmittance', '3d'],
  [23, 'distantSkyLight', '2d'],
] as const;
type AtmosphereViewTexture = (typeof ATMOSPHERE_VIEW_TEXTURES)[number];
export type AtmosphereViews = Partial<Record<AtmosphereViewTexture[1], TextureView>>;
type ViewReads = ReadonlyMap<number, number>;

export function hasStandardViewReads(reads: ViewReads | undefined): boolean {
  return (
    reads !== undefined && STANDARD_VIEW_LAYOUT_ENTRIES.some(({ binding }) => reads.has(binding))
  );
}

export function viewEntryReads(
  entries: readonly import('@forgeax/engine-types').ShaderEntryPointReads[] | undefined,
  vertex: string | undefined,
  fragment: string | null | undefined,
): ViewReads | undefined {
  const vs = entries?.find(
    (entry) => entry.stage === 'vertex' && entry.name === (vertex ?? 'vs_main'),
  );
  const fs = entries?.find((entry) => entry.stage === 'fragment' && entry.name === fragment);
  if (vs === undefined || fs === undefined) return;
  const reads = new Map<number, number>();
  for (const [entry, visibility] of [
    [vs, 1],
    [fs, 2],
  ] as const) {
    for (const { group, binding } of entry.bindings) {
      if (group === 0) reads.set(binding, (reads.get(binding) ?? 0) | visibility);
    }
  }
  return reads;
}

const viewFamilies = new WeakMap<
  BindGroupLayout,
  {
    readonly entries: readonly GPUBindGroupLayoutEntry[];
    readonly projections: Map<string, BindGroupLayout>;
    readonly slots: ReadonlySet<number>;
    readonly clusterEntries: readonly GPUBindGroupLayoutEntry[];
  }
>();
const projectedViews = new WeakMap<
  BindGroupLayout,
  {
    readonly slots: ReadonlySet<number>;
    readonly textures: readonly { readonly binding: number; readonly visibility: number }[];
  }
>();

export function retainViewLayout(
  layout: BindGroupLayout,
  entries: readonly GPUBindGroupLayoutEntry[],
  storage?: boolean,
): void {
  viewFamilies.set(layout, {
    entries,
    clusterEntries: storage === undefined ? [] : clusterViewLayoutEntries(storage),
    projections: new Map(),
    slots: new Set(entries.map(({ binding }) => binding)),
  });
}

/** Keep the two View dynamic offsets stable and project all other resources by entry reads. */
export function projectViewLayout(
  device: Pick<RhiDevice, 'createBindGroupLayout'>,
  layout: BindGroupLayout,
  reads: ViewReads,
): BindGroupLayout {
  const family = viewFamilies.get(layout);
  if (family === undefined) return layout;
  const entries = family.entries.flatMap((entry) => {
    if (entry.buffer?.hasDynamicOffset === true) return [entry];
    const visibility = reads.get(entry.binding);
    return visibility === undefined ? [] : [{ ...entry, visibility }];
  });
  for (const entry of [...family.clusterEntries, ...STANDARD_VIEW_LAYOUT_ENTRIES]) {
    const visibility = reads.get(entry.binding);
    if (visibility !== undefined) entries.push({ ...entry, visibility });
  }
  if (reads.has(FORWARD_SCREEN_SURFACE_VIEW_SLOT)) {
    entries.push({
      binding: FORWARD_SCREEN_SURFACE_VIEW_SLOT,
      visibility: 2,
      texture: { sampleType: 'float', viewDimension: '2d' },
    });
  }
  const textures = entries
    .filter(({ texture }) => texture !== undefined)
    .map(({ binding, visibility }) => Object.freeze({ binding, visibility }));
  const key = entries.map(({ binding, visibility }) => `${binding}:${visibility}`).join(',');
  const existing = family.projections.get(key);
  if (existing !== undefined) return existing;
  const projected = device.createBindGroupLayout({ label: `pbr-view[${key}]`, entries }).unwrap();
  family.projections.set(key, projected);
  projectedViews.set(projected, {
    slots: new Set(entries.map(({ binding }) => binding)),
    textures: Object.freeze(textures),
  });
  return projected;
}

/** The legacy Deferred source can arrive without entry reflection. */
export function projectAtmosphereViewLayout(
  device: Pick<RhiDevice, 'createBindGroupLayout'>,
  layout: BindGroupLayout,
  solar: boolean,
  clustered = false,
): BindGroupLayout {
  const entries = viewFamilies.get(layout)?.entries;
  if (entries === undefined) return layout;
  const reads = new Map<number, number>();
  for (const { binding, visibility } of entries) {
    if (!ATMOSPHERE_VIEW_TEXTURES.some(([slot]) => slot === binding) || (solar && binding === 18))
      reads.set(binding, visibility);
  }
  for (const { binding, visibility } of SKY_VIEW_ENTRIES) reads.set(binding, visibility);
  if (clustered)
    for (const { binding, visibility } of clusterViewLayoutEntries(true))
      reads.set(binding, visibility);
  return projectViewLayout(device, layout, reads);
}

export function viewLayoutSlots(layout: BindGroupLayout): ReadonlySet<number> | undefined {
  return projectedViews.get(layout)?.slots ?? viewFamilies.get(layout)?.slots;
}

function viewTextures(state: PipelineState, layout?: BindGroupLayout) {
  if (state.atmosphereAvailable !== true) return [];
  const slots = layout === undefined ? undefined : viewLayoutSlots(layout);
  return slots === undefined
    ? ATMOSPHERE_VIEW_TEXTURES
    : ATMOSPHERE_VIEW_TEXTURES.filter(([binding]) => slots.has(binding));
}

function viewTexture(
  state: PipelineState,
  views: AtmosphereViews | undefined,
  [, name, dimension]: AtmosphereViewTexture,
): TextureView {
  const view =
    views?.[name] ??
    (dimension === '3d' ? state.atmosphereFallbackView : state.defaultWhiteTextureView);
  if (view === undefined) throw new Error('admitted atmosphere layout has no neutral volume');
  return view;
}

/** Bind-group entries and their cache keys use the same slot projection. */
export function pushAtmosphereBindingResources(
  out: TextureView[] | object[],
  state: PipelineState,
  views?: AtmosphereViews,
  layout?: BindGroupLayout,
): void {
  for (const texture of viewTextures(state, layout)) out.push(viewTexture(state, views, texture));
}

export function atmosphereBindings(
  state: PipelineState,
  views?: AtmosphereViews,
  layout?: BindGroupLayout,
): BindGroupEntry[] {
  return viewTextures(state, layout).map((texture) => ({
    binding: texture[0],
    resource: { kind: 'textureView', value: viewTexture(state, views, texture) },
  }));
}

export function atmosphereViewLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return ATMOSPHERE_VIEW_TEXTURES.map(([binding, , viewDimension]) => ({
    binding,
    visibility: 2,
    texture: { sampleType: 'float', viewDimension },
  }));
}

/** Depth-aware material programs also evaluate the shared single-scattering visibility. */
export function atmosphereMaterialVisibilityLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [
    { binding: 3, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
    { binding: 4, visibility: 2, sampler: { type: 'comparison' } },
    {
      binding: 16,
      visibility: 2,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    },
    { binding: 17, visibility: 2, sampler: { type: 'filtering' } },
  ];
}
export function atmosphereMaterialVisibilityBindings(
  state: PipelineState,
  directional?: TextureView,
  cloud?: TextureView,
): BindGroupEntry[] {
  if (state.atmosphereAvailable !== true) return [];
  const sampler = state.perPassResources.shadowSampler;
  if (sampler === null) throw new Error('admitted atmosphere requires the shadow sampler');
  return [
    {
      binding: 3,
      resource: { kind: 'textureView', value: directional ?? state.shadowArrayFallbackTextureView },
    },
    { binding: 4, resource: { kind: 'sampler', value: sampler } },
    {
      binding: 16,
      resource: { kind: 'textureView', value: cloud ?? state.defaultWhiteTextureView },
    },
    {
      binding: 17,
      resource: { kind: 'sampler', value: state.viewLinearSampler ?? state.defaultSampler },
    },
  ];
}

const viewGroups = new WeakMap<
  BindGroup,
  {
    readonly entries: readonly BindGroupEntry[];
    readonly layout: BindGroupLayout;
    readonly sky: ViewSky | undefined;
    readonly loadDirectDfg: (() => TextureView) | undefined;
    readonly withSky: WeakMap<Buffer, WeakMap<TextureView, BindGroup>>;
    readonly projections: WeakMap<BindGroupLayout, BindGroup>;
  }
>();
const pipelineViews = new WeakMap<import('@forgeax/engine-rhi').RenderPipeline, BindGroupLayout>();

export function retainViewGroup(
  group: BindGroup,
  layout: BindGroupLayout,
  entries: readonly BindGroupEntry[],
  sky?: ViewSky,
  loadDirectDfg?: () => TextureView,
): void {
  if (viewFamilies.has(layout))
    viewGroups.set(group, {
      entries,
      layout,
      sky,
      loadDirectDfg,
      withSky: new WeakMap(),
      projections: new WeakMap(),
    });
}

/** The active sky follows the recorded View, including captured or graph-owned environments. */
export function viewWithSkylight(
  device: Pick<RhiDevice, 'createBindGroup'>,
  group: BindGroup,
  sky: ViewSky,
): BindGroup {
  const family = viewGroups.get(group);
  if (family === undefined) return group;
  const previous = family.sky;
  if (
    previous === undefined ||
    (previous.skySh === sky.skySh &&
      previous.intensityBuffer === sky.intensityBuffer &&
      previous.brdfLutView === sky.brdfLutView)
  )
    return group;
  if (previous.intensityBuffer !== sky.intensityBuffer)
    throw new Error('Skylight projections require the current View diffuse parameter buffer');
  let byLut = family.withSky.get(sky.skySh);
  const cached = byLut?.get(sky.brdfLutView);
  if (cached !== undefined) return cached;
  if (byLut === undefined) {
    byLut = new WeakMap();
    family.withSky.set(sky.skySh, byLut);
  }
  const entries = [
    ...family.entries.filter(
      ({ binding }) =>
        binding !== VIEW_SKY_SH &&
        binding !== VIEW_SKY_DIFFUSE &&
        binding !== ENVIRONMENT_DFG_VIEW_SLOT,
    ),
    ...skyViewBindings(sky),
  ];
  const slots = viewLayoutSlots(family.layout);
  const scoped = device
    .createBindGroup({
      label: 'pbr-view-skylight-bg',
      layout: family.layout,
      entries: entries.filter(({ binding }) => slots?.has(binding)),
    })
    .unwrap();
  retainViewGroup(scoped, family.layout, entries, sky, family.loadDirectDfg);
  byLut.set(sky.brdfLutView, scoped);
  return scoped;
}

export function retainPipelineView(
  pipeline: import('@forgeax/engine-rhi').RenderPipeline,
  view: BindGroupLayout | undefined,
): void {
  if (view !== undefined) pipelineViews.set(pipeline, view);
}

export function pipelineViewLayout(pipeline: import('@forgeax/engine-rhi').RenderPipeline) {
  return pipelineViews.get(pipeline);
}

export function inspectPipelineViewTextures(
  pipeline: import('@forgeax/engine-rhi').RenderPipeline,
) {
  const layout = pipelineViews.get(pipeline);
  return layout === undefined ? undefined : projectedViews.get(layout)?.textures;
}

/** Project once per physical View group and reuse that identity in native bundles. */
export function viewForPipeline(
  device: Pick<RhiDevice, 'createBindGroup'>,
  pipeline: import('@forgeax/engine-rhi').RenderPipeline,
  group: BindGroup,
): BindGroup {
  const layout = pipelineViews.get(pipeline);
  if (layout === undefined || !projectedViews.has(layout)) return group;
  const family = viewGroups.get(group);
  if (family === undefined) throw new Error('projected pipeline requires its Standard View group');
  const existing = family.projections.get(layout);
  if (existing !== undefined) return existing;
  const slots = viewLayoutSlots(layout);
  const entries = family.entries.filter(({ binding }) => slots?.has(binding));
  if (slots?.has(DIRECT_DFG_VIEW_SLOT)) {
    if (family.loadDirectDfg === undefined) throw new Error('missing View direct DFG owner');
    entries.push(directDfgViewBinding(family.loadDirectDfg()));
  }
  const projected = device
    .createBindGroup({
      label: 'pbr-view-pass-bg',
      layout,
      entries,
    })
    .unwrap();
  family.projections.set(layout, projected);
  return projected;
}
