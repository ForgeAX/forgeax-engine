import { createHash } from 'node:crypto';
import type { DevKitAppOptions } from '../plugin-build.js';

type Manifest = NonNullable<DevKitAppOptions['pipelineLibrary']>;
type Render = Manifest['renderPipelines'][number];
type Compute = Manifest['computePipelines'][number];

function identity(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === 'number' && !Number.isFinite(child))
      throw new Error('Pipeline descriptor must contain finite values');
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return child;
    return Object.fromEntries(
      Object.keys(child)
        .sort()
        .map((key) => [key, (child as Record<string, unknown>)[key]]),
    );
  });
}

function semantic<T extends { label?: string }>(value: T): Omit<T, 'label'> {
  const { label: _label, ...rest } = value;
  return rest;
}

function reference<T>(values: readonly T[], index: number, kind: string): T {
  if (!Number.isSafeInteger(index) || index < 0 || index >= values.length)
    throw new Error(`Missing pipeline ${kind} ${index}`);
  return values[index] as T;
}

function unique<T>(values: readonly T[], key: (value: T) => string) {
  const keys = new Map<string, number>(),
    out: T[] = [],
    indices: number[] = [];
  for (const value of values) {
    const id = key(value);
    let index = keys.get(id);
    if (index === undefined) {
      index = out.length;
      keys.set(id, index);
      out.push(value);
    }
    indices.push(index);
  }
  return { values: out, indices };
}

function projections(manifest: Manifest) {
  const aliases = new Map<string, number>();
  for (const row of manifest.computeEntryModules ?? []) {
    reference(manifest.shaders, row.module, 'shader');
    reference(manifest.shaders, row.specializedModule, 'shader');
    const key = `${row.module}:${row.entryPoint}`,
      previous = aliases.get(key);
    if (previous !== undefined && previous !== row.specializedModule)
      throw new Error('Conflicting compute entry projection');
    aliases.set(key, row.specializedModule);
  }
  return aliases;
}

/** Content identity matches the device library: labels are diagnostic, explicit
 * state remains explicit, binding order is canonical, and entry aliases apply. */
function recipeKeys(manifest: Manifest) {
  const shaders = manifest.shaders.map((row) =>
    createHash('sha256').update(row.code).digest('hex'),
  );
  const groups = manifest.bindGroupLayouts.map((row) =>
    identity({
      ...semantic(row),
      entries: Array.from(row.entries).sort((a, b) => a.binding - b.binding),
    }),
  );
  const layouts = manifest.pipelineLayouts.map((row) =>
    row.map((id) => reference(groups, id, 'bind group layout')),
  );
  const aliases = projections(manifest);
  const layout = (id: number | 'auto') =>
    id === 'auto' ? 'auto' : reference(layouts, id, 'layout');
  const stage = (row: Render['vertex'] | Compute['compute']) => ({
    ...row,
    module: reference(shaders, row.module, 'shader'),
  });
  return {
    shaders,
    groups,
    layouts,
    render: (row: Render) =>
      identity({
        ...semantic(row),
        layout: layout(row.layout),
        vertex: stage(row.vertex),
        ...(row.fragment === undefined ? {} : { fragment: stage(row.fragment) }),
      }),
    compute: (row: Compute) =>
      identity({
        ...semantic(row),
        layout: layout(row.layout),
        compute: stage({
          ...row.compute,
          module:
            row.compute.entryPoint === undefined
              ? row.compute.module
              : (aliases.get(`${row.compute.module}:${row.compute.entryPoint}`) ??
                row.compute.module),
        }),
      }),
  };
}

function retainDependencies<T>(
  rows: readonly T[],
  keys: readonly string[],
  used: ReadonlySet<number>,
  startup: ReadonlySet<string>,
) {
  const values: T[] = [],
    indices = new Map<number, number>();
  rows.forEach((row, index) => {
    if (!used.has(index) && startup.has(reference(keys, index, 'dependency identity'))) return;
    indices.set(index, values.length);
    values.push(row);
  });
  return {
    values,
    index: (old: number) => {
      const next = indices.get(old);
      if (next === undefined) throw new Error(`Referenced startup dependency removed: ${old}`);
      return next;
    },
  };
}

/** Only completed startup can own an omitted dependency. Unrelated unused rows
 * and all ordinary-request projection aliases remain available. */
function omitStartupDependencies(
  input: Manifest,
  keys: ReturnType<typeof recipeKeys>,
  startup: ReturnType<typeof recipeKeys>,
): Manifest {
  const usedShaders = new Set<number>(),
    usedLayouts = new Set<number>();
  for (const row of input.renderPipelines) {
    usedShaders.add(row.vertex.module);
    if (row.fragment !== undefined) usedShaders.add(row.fragment.module);
    if (row.layout !== 'auto') usedLayouts.add(row.layout);
  }
  for (const row of input.computePipelines) {
    usedShaders.add(row.compute.module);
    if (row.layout !== 'auto') usedLayouts.add(row.layout);
  }
  for (const row of input.computeEntryModules ?? []) {
    usedShaders.add(row.module);
    usedShaders.add(row.specializedModule);
  }
  const shaders = retainDependencies(
    input.shaders,
    keys.shaders,
    usedShaders,
    new Set(startup.shaders),
  );
  const layouts = retainDependencies(
    input.pipelineLayouts,
    keys.layouts.map(identity),
    usedLayouts,
    new Set(startup.layouts.map(identity)),
  );
  const usedGroups = new Set(layouts.values.flat());
  const groups = retainDependencies(
    input.bindGroupLayouts,
    keys.groups,
    usedGroups,
    new Set(startup.groups),
  );
  if (
    shaders.values.length === input.shaders.length &&
    layouts.values.length === input.pipelineLayouts.length &&
    groups.values.length === input.bindGroupLayouts.length
  )
    return input;
  const layout = (index: number | 'auto') => (index === 'auto' ? 'auto' : layouts.index(index));
  return {
    ...input,
    shaders: shaders.values,
    bindGroupLayouts: groups.values,
    pipelineLayouts: layouts.values.map((row) => row.map(groups.index)),
    renderPipelines: input.renderPipelines.map((row) => ({
      ...row,
      layout: layout(row.layout),
      vertex: { ...row.vertex, module: shaders.index(row.vertex.module) },
      ...(row.fragment === undefined
        ? {}
        : { fragment: { ...row.fragment, module: shaders.index(row.fragment.module) } }),
    })),
    computePipelines: input.computePipelines.map((row) => ({
      ...row,
      layout: layout(row.layout),
      compute: { ...row.compute, module: shaders.index(row.compute.module) },
    })),
    ...(input.computeEntryModules === undefined
      ? {}
      : {
          computeEntryModules: input.computeEntryModules.map((row) => ({
            ...row,
            module: shaders.index(row.module),
            specializedModule: shaders.index(row.specializedModule),
          })),
        }),
  };
}

/** Fold exact aliases, preserving first occurrence and every declared variant.
 * Original-source entry aliases stay available for future ordinary requests.
 * An optional completed startup manifest removes only exact background overlap. */
export function normalizePipelineLibrary(input: Manifest, startup?: Manifest): Manifest {
  const shaders = unique(input.shaders, (row) => row.code);
  let reordered = false;
  const groups = unique(
    input.bindGroupLayouts.map((row) => {
      const entries = Array.from(row.entries),
        sorted = [...entries].sort((a, b) => a.binding - b.binding);
      reordered ||=
        !Array.isArray(row.entries) || sorted.some((entry, index) => entry !== entries[index]);
      return { ...row, entries: sorted };
    }),
    (row) => identity(semantic(row)),
  );
  const layouts = unique(
    input.pipelineLayouts.map((row) =>
      row.map((id) => reference(groups.indices, id, 'bind group layout')),
    ),
    identity,
  );
  const shader = (id: number) => reference(shaders.indices, id, 'shader');
  const layout = (id: number | 'auto') =>
    id === 'auto' ? 'auto' : reference(layouts.indices, id, 'layout');
  const mapped: Manifest = {
    ...input,
    shaders: shaders.values,
    bindGroupLayouts: groups.values,
    pipelineLayouts: layouts.values,
    renderPipelines: input.renderPipelines.map((row) => ({
      ...row,
      layout: layout(row.layout),
      vertex: { ...row.vertex, module: shader(row.vertex.module) },
      ...(row.fragment === undefined
        ? {}
        : { fragment: { ...row.fragment, module: shader(row.fragment.module) } }),
    })),
    computePipelines: input.computePipelines.map((row) => ({
      ...row,
      layout: layout(row.layout),
      compute: { ...row.compute, module: shader(row.compute.module) },
    })),
    ...(input.computeEntryModules === undefined
      ? {}
      : {
          computeEntryModules: unique(
            input.computeEntryModules.map((row) => ({
              ...row,
              module: shader(row.module),
              specializedModule: shader(row.specializedModule),
            })),
            identity,
          ).values,
        }),
  };
  const keys = recipeKeys(mapped),
    prior = startup === undefined ? undefined : recipeKeys(startup);
  const startupRender = new Set(startup && prior ? startup.renderPipelines.map(prior.render) : []);
  const startupCompute = new Set(
    startup && prior ? startup.computePipelines.map(prior.compute) : [],
  );
  const renderPipelines = unique(mapped.renderPipelines, keys.render).values.filter(
    (row) => !startupRender.has(keys.render(row)),
  );
  const computePipelines = unique(mapped.computePipelines, keys.compute).values.filter(
    (row) => !startupCompute.has(keys.compute(row)),
  );
  const changed =
    reordered ||
    shaders.values.length !== input.shaders.length ||
    groups.values.length !== input.bindGroupLayouts.length ||
    layouts.values.length !== input.pipelineLayouts.length ||
    renderPipelines.length !== input.renderPipelines.length ||
    computePipelines.length !== input.computePipelines.length ||
    mapped.computeEntryModules?.length !== input.computeEntryModules?.length;
  const normalized = changed ? { ...mapped, renderPipelines, computePipelines } : input;
  return prior === undefined ? normalized : omitStartupDependencies(normalized, keys, prior);
}
