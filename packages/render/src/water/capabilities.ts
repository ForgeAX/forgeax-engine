import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type { RenderInspection } from '../render-contract.js';
import type { sharedFeatureGraphInspection } from '../world/feature-graph-systems';
import type { WaterInfoPublicationInspection } from './water-info-feature';

export interface WaterRenderGraphInspection {
  readonly generation: number;
  readonly passes: CompiledRenderGraphInfo['passes'];
  readonly resources: CompiledRenderGraphInfo['resources'];
  readonly shared?: Readonly<{
    frameId: number;
    deviceGeneration: number;
    graph: WaterRenderGraphInspection;
  }>;
  readonly waterInfo?: readonly WaterInfoPublicationInspection[];
}

/** Preserve actual resource descriptors and dependency edges, including imported owner bytes. */
export function inspectWaterRenderGraph(
  graph: CompiledRenderGraphInfo | undefined,
  shared?: ReturnType<typeof sharedFeatureGraphInspection>,
  waterInfo?: readonly WaterInfoPublicationInspection[],
): WaterRenderGraphInspection | undefined {
  if (graph === undefined) return undefined;
  const names = new Set(
    graph.passes.filter((pass) => pass.name.includes('water-')).map((pass) => pass.name),
  );
  for (const name of names)
    for (const dependency of graph.passes.find((pass) => pass.name === name)?.dependencies ?? [])
      names.add(dependency);
  const passes = graph.passes.filter((pass) => names.has(pass.name));
  const used = new Set(passes.flatMap((pass) => pass.accesses.map((access) => access.resource)));
  const sharedGraph = shared === undefined ? undefined : inspectWaterRenderGraph(shared.graph);
  return {
    generation: graph.generation,
    passes: structuredClone(passes),
    resources: structuredClone(
      graph.resources.filter(
        (resource) => resource.label.includes('water-') || used.has(resource.label),
      ),
    ),
    ...(sharedGraph === undefined || shared === undefined
      ? {}
      : {
          shared: {
            frameId: shared.frameId,
            deviceGeneration: shared.deviceGeneration,
            graph: sharedGraph,
          },
        }),
    ...(waterInfo === undefined ? {} : { waterInfo: structuredClone(waterInfo) }),
  };
}

/** Actual submitted graph composition, independent of RHI hardware facts. */
export function inspectWaterRenderCapabilities(inspection: RenderInspection) {
  const graph = inspection.waterGraph;
  const passes = graph?.passes.map((pass) => pass.name) ?? [];
  const pass = (name: string, owner = graph) =>
    owner?.passes.find((row) => row.name === name || row.name.endsWith(`/${name}`));
  const texture = (label: string, owner = graph) =>
    owner?.resources.find((row) => row.label === label && row.descriptor.kind === 'texture');
  const access = (name: string, label: string, usage: string, owner = graph) =>
    pass(name, owner)?.accesses.some((row) => row.resource === label && row.usage === usage) ===
    true;
  const edge = (
    producer: string,
    consumer: string,
    label: string,
    write: string,
    owner = graph,
  ) => {
    const from = pass(producer, owner),
      to = pass(consumer, owner);
    if (
      !from ||
      !to ||
      !texture(label, owner) ||
      !access(producer, label, write, owner) ||
      !access(consumer, label, 'sampled-read', owner)
    )
      return false;
    const pending = new Set(to.dependencies);
    for (const name of pending) {
      if (name === from.name) return from.executionIndex < to.executionIndex;
      for (const dependency of owner?.passes.find((row) => row.name === name)?.dependencies ?? [])
        pending.add(dependency);
    }
    return false;
  };
  const inspectSurfacePasses = () => {
    const sceneCopy =
      edge(
        'water-no-water-color-copy',
        'water-slw-inner-color',
        'water-no-water-color-hdr',
        'copy-dst',
      ) &&
      texture('water-no-water-depth') !== undefined &&
      access('water-no-water-depth-copy', 'water-no-water-depth', 'copy-dst');
    const optics = edge(
      'water-slw-inner-color',
      'water-reflection-composite',
      'water-slw-optics-hdr',
      'color-attachment',
    );
    const captureSky = edge(
      'water-slw-inner-color',
      'water-reflection-composite',
      'water-capture-sky-hdr',
      'color-attachment',
    );
    const prepass =
      ['water-normal-roughness', 'water-mask', 'water-wpo-velocity'].every(
        (label) =>
          access('water-depth-mask-velocity', label, 'color-attachment') &&
          texture(label) !== undefined,
      ) && access('water-depth-mask-velocity', 'water-prepass-depth', 'depth-stencil-write');
    const trace = pass('water-ssr-trace'),
      temporal = pass('water-ssr-temporal');
    const ssrOrigin =
      ['water-normal-roughness', 'water-mask'].every((label) =>
        edge('water-depth-mask-velocity', 'water-ssr-trace', label, 'color-attachment'),
      ) &&
      edge(
        'water-depth-mask-velocity',
        'water-ssr-trace',
        'water-prepass-depth',
        'depth-stencil-write',
      );
    const ssrHistory =
      temporal !== undefined &&
      edge(
        'water-depth-mask-velocity',
        'water-ssr-temporal',
        'water-wpo-velocity',
        'color-attachment',
      ) &&
      trace?.accesses.some(
        (write) =>
          write.usage === 'storage-write' &&
          edge(trace.name, temporal.name, write.resource, write.usage),
      ) === true &&
      temporal.accesses.some(
        (read) => read.usage === 'sampled-read' && texture(read.resource)?.origin === 'imported',
      );
    const ssrOutput =
      temporal?.accesses.some(
        (write) =>
          write.usage === 'storage-write' &&
          edge(temporal.name, 'water-reflection-composite', write.resource, write.usage),
      ) === true;

    return { sceneCopy, optics, captureSky, prepass, ssrOrigin, ssrHistory, ssrOutput };
  };
  const { sceneCopy, optics, captureSky, prepass, ssrOrigin, ssrHistory, ssrOutput } =
    inspectSurfacePasses();
  const shared = graph?.shared;
  const currentShared =
    shared?.frameId === inspection.frame.frameId &&
    shared.deviceGeneration === inspection.frame.deviceGeneration
      ? shared.graph
      : undefined;
  const materialConsumer = (row: WaterRenderGraphInspection['passes'][number]) =>
    row.kind === 'raster' &&
    ['water-slw-inner-color', 'water-depth-mask-velocity'].some((name) => row.name.endsWith(name));
  const composedCompute = (needle: string) => {
    for (const owner of [graph, currentShared]) {
      if (owner === undefined) continue;
      const pending = owner.passes.filter(
        (row) => row.kind === 'compute' && row.name.includes(needle),
      );
      const visited = new Set<string>();
      for (const producer of pending) {
        if (visited.has(producer.name)) continue;
        visited.add(producer.name);
        for (const write of producer.accesses) {
          if (write.usage !== 'storage-write' && write.usage !== 'copy-dst') continue;
          const produced = texture(write.resource, owner);
          if (produced === undefined) continue;
          const imported =
            owner === currentShared ? texture(`shared:${write.resource}`) : undefined;
          const reachesImportedMaterial = (): boolean =>
            Boolean(
              imported?.origin === 'imported' &&
                JSON.stringify(produced.descriptor) === JSON.stringify(imported.descriptor) &&
                produced.physicalAllocationKey !== undefined &&
                produced.physicalAllocationKey === imported.physicalAllocationKey &&
                graph?.passes.some(
                  (consumer) =>
                    materialConsumer(consumer) &&
                    consumer.accesses.some(
                      (read) => read.resource === imported.label && read.usage === 'sampled-read',
                    ),
                ),
            );
          if (reachesImportedMaterial()) return true;
          for (const consumer of owner.passes) {
            if (!edge(producer.name, consumer.name, write.resource, write.usage, owner)) continue;
            if (owner === graph && materialConsumer(consumer)) return true;
            if (consumer.kind !== 'raster' && !visited.has(consumer.name)) pending.push(consumer);
          }
        }
      }
    }
    return false;
  };
  const inspectFluidComposition = (inspection: RenderInspection) => {
    const sharedFluid = shared?.graph.resources.find(
      (resource) => resource.label === 'water-fluid-material-fields',
    );
    const importedFluid = texture('shared:water-fluid-material-fields');
    const fluidSimulation =
      shared?.frameId === inspection.frame.frameId &&
      shared.deviceGeneration === inspection.frame.deviceGeneration &&
      sharedFluid?.descriptor.kind === 'texture' &&
      importedFluid?.origin === 'imported' &&
      JSON.stringify(sharedFluid.descriptor) === JSON.stringify(importedFluid.descriptor) &&
      sharedFluid.physicalAllocationKey !== undefined &&
      sharedFluid.physicalAllocationKey === importedFluid.physicalAllocationKey &&
      shared.graph.passes.some(
        (producer) =>
          producer.kind === 'raster' &&
          producer.name.startsWith('water-fluid-atlas') &&
          producer.accesses.some(
            (write) => write.resource === sharedFluid.label && write.usage === 'color-attachment',
          ),
      ) &&
      access('water-slw-inner-color', importedFluid.label, 'sampled-read');

    return { fluidSimulation };
  };
  const { fluidSimulation } = inspectFluidComposition(inspection);
  const gbuffer = pass('g-buffer'),
    lighting = pass('lighting');
  const deferred =
    gbuffer !== undefined &&
    lighting !== undefined &&
    gbuffer.accesses.filter(
      (row) => row.usage === 'color-attachment' && row.resource.startsWith('gbuffer-'),
    ).length >= 4 &&
    gbuffer.accesses
      .filter((row) => row.usage === 'color-attachment' && row.resource.startsWith('gbuffer-'))
      .every((row) => edge(gbuffer.name, lighting.name, row.resource, 'color-attachment'));
  const gpuMesh =
    graph?.passes.some((row) =>
      row.accesses.some(
        (read) => read.usage === 'indirect-read' && read.resource.includes('water-gpu-'),
      ),
    ) === true;
  const source = inspection.reflectionProbes.reflectionFallback;
  const inspectWaterInfoComposition = (inspection: RenderInspection) => {
    const infoReads =
      graph?.resources.filter(
        (resource) =>
          resource.origin === 'imported' &&
          resource.label.includes('water-info') &&
          graph.passes.some((row) =>
            row.accesses.some(
              (read) => read.resource === resource.label && read.usage === 'sampled-read',
            ),
          ),
      ) ?? [];
    const infoProduced =
      graph?.shared?.deviceGeneration === inspection.frame.deviceGeneration &&
      graph.shared.frameId === inspection.frame.frameId &&
      graph.shared.graph.passes.some(
        (row) =>
          row.kind === 'compute' &&
          row.name.includes('water-info-finalize-') &&
          row.accesses.some(
            (write) =>
              write.usage === 'storage-write' &&
              infoReads.some((resource) => resource.label === `shared:${write.resource}`),
          ),
      ) === true;

    return { infoReads, infoProduced };
  };
  const { infoReads, infoProduced } = inspectWaterInfoComposition(inspection);
  const underwaterCopy = pass('underwater-scene-copy');
  const underwaterExecuted =
    underwaterCopy?.accesses.some(
      (write) =>
        write.usage === 'color-attachment' &&
        edge(
          underwaterCopy.name,
          'underwater-cooked-post-process',
          write.resource,
          'color-attachment',
        ),
    ) === true;
  return {
    version: 1 as const,
    deviceGeneration: inspection.frame.deviceGeneration,
    frameId: inspection.frame.frameId,
    ready: inspection.state === 'alive',
    noWaterSceneCopy: sceneCopy,
    singleLayerOptics: optics,
    waterSurfaceDepthNormalVelocity: prepass,
    waterSurfaceSsr: prepass && ssrOrigin && ssrHistory && ssrOutput,
    captureSky,
    captureReflection: captureSky && source.source === 'probe' && source.state === 'active',
    skyReflection: captureSky && source.source === 'skylight' && source.state === 'active',
    underwater: {
      available: inspection.features.includes('water-underwater-post-process'),
      active: underwaterExecuted,
      execution: underwaterExecuted ? ('executed' as const) : ('inactive' as const),
    },
    waterInfo: {
      available: inspection.features.includes('water-info-producer'),
      active: infoReads.length > 0,
      execution: infoProduced
        ? ('produced' as const)
        : infoReads.length > 0
          ? ('retained' as const)
          : ('inactive' as const),
    },
    gpuMesh,
    // RenderInspection does not carry Runtime's accepted CPU Water mesh publication.
    cpuMesh: 'unvalidated' as const,
    deferredLighting: deferred,
    fluidSimulation,
    advancedShallow: composedCompute('update-depth'),
    // Durable query-grid admission belongs to WaterSystem, outside graph inspection.
    riverBake: 'unvalidated' as const,
    oceanFft: composedCompute('radix'),
    passes,
    graphAllocation: inspection.renderGraphGenerationAllocation ?? null,
    resourceClosure: inspection.waterGraph ?? null,
  };
}

export type WaterRenderCapabilities = ReturnType<typeof inspectWaterRenderCapabilities>;
