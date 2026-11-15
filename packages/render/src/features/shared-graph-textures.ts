import type {
  CompiledRenderGraph,
  GraphTextureDescriptor,
  GraphTextureViewDescriptor,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import {
  type RenderFeatureGraphTextureTargets,
  retainImportedGraphTextureTarget,
} from './graph-texture-targets';
import type { RenderFeaturePlanExecutionPass } from './host';
import type { RenderFeatureTargetHandle } from './targets';

export interface SharedGraphTextureExport {
  readonly name: string;
  readonly label: string;
  readonly descriptor: GraphTextureDescriptor;
  readonly view: GraphTextureViewDescriptor;
  readonly scope: string;
  readonly target?: RenderFeatureTargetHandle;
}
export interface SharedGraphTexturePublication {
  readonly graph: CompiledRenderGraph<RenderGraphFrame>;
  readonly textures: readonly SharedGraphTextureExport[];
  readonly passes: ReadonlySet<RenderFeaturePlanExecutionPass>;
  readonly topologyKey: string;
}
const publications = new WeakMap<object, SharedGraphTexturePublication>();

/** The shared graph owns exports through the complete frame's submission fence. */
export function publishSharedGraphTextures(
  owner: object,
  publication: SharedGraphTexturePublication | undefined,
): void {
  if (publication === undefined) publications.delete(owner);
  else publications.set(owner, publication);
}
export function sharedGraphTextures(
  owner: object | undefined,
): SharedGraphTexturePublication | undefined {
  return owner === undefined ? undefined : publications.get(owner);
}

function exportIdentity({
  name,
  label,
  scope,
  descriptor,
  view,
  target,
}: SharedGraphTextureExport) {
  return [
    name,
    label,
    scope,
    descriptor,
    view,
    target?.allocationScope,
    target?.allocationKey,
    target?.producerIdentity,
    target?.materialSource,
  ];
}

/** One semantic export has one complete physical/view shape, independently of pass multiplicity. */
export function canonicalSharedGraphTextures(
  textures: readonly SharedGraphTextureExport[],
): readonly SharedGraphTextureExport[] {
  const exports = new Map<string, { entry: SharedGraphTextureExport; signature: string }>();
  for (const entry of textures) {
    const key = JSON.stringify([entry.scope, entry.name]);
    const signature = JSON.stringify(exportIdentity(entry));
    const previous = exports.get(key);
    if (previous !== undefined && previous.signature !== signature)
      throw new Error(`Shared graph export is ambiguous: ${key}`);
    if (previous === undefined) exports.set(key, { entry, signature });
  }
  return [...exports]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value.entry);
}

export function sharedGraphTextureTopology(textures: readonly SharedGraphTextureExport[]): string {
  return JSON.stringify(textures.map(exportIdentity));
}

function sharedTextureResolver<Frame extends RenderGraphFrame>(
  read: (frame: Frame) => SharedGraphTexturePublication | undefined,
  label: string,
  topologyKey: string,
) {
  return (frame: Frame) => {
    const current = read(frame);
    if (current?.topologyKey !== topologyKey)
      throw new Error(`Shared graph export topology changed: ${label}`);
    const physical = current.graph.getColorTargetTexture(label);
    if (physical === undefined) throw new Error(`Shared graph export is unavailable: ${label}`);
    return physical;
  };
}

/** Import only physical textures; graph handles never cross builder ownership. */
export function importSharedGraphTextures<Frame extends RenderGraphFrame>(
  builder: RenderGraphBuilder<Frame>,
  publication: SharedGraphTexturePublication | undefined,
  targets: RenderFeatureGraphTextureTargets,
  read?: (frame: Frame) => SharedGraphTexturePublication | undefined,
) {
  const result = new Map<
    string,
    { view: import('@forgeax/engine-render-graph').GraphTextureView; format: TextureFormat }
  >();
  if (publication === undefined) return result;
  const imported = new Map<string, import('@forgeax/engine-render-graph').GraphTexture>();
  for (const entry of publication.textures) {
    let texture = imported.get(entry.label);
    if (texture === undefined) {
      if (publication.graph.getColorTargetTexture(entry.label) === undefined)
        throw new Error(`Shared graph export is unavailable: ${entry.label}`);
      texture = builder
        .importTexture(
          `shared:${entry.label}`,
          { ...entry.descriptor, usage: entry.descriptor.usage ?? 0x04 },
          sharedTextureResolver(read ?? (() => publication), entry.label, publication.topologyKey),
        )
        .unwrap();
      imported.set(entry.label, texture);
    }
    const view = builder.view(texture, entry.view).unwrap();
    result.set(`${entry.scope}:${entry.name}`, {
      view,
      format: entry.view.format ?? entry.descriptor.format,
    });
    if (entry.target !== undefined)
      retainImportedGraphTextureTarget(targets, entry.target, {
        texture,
        view,
        label: `shared:${entry.label}`,
        scope: entry.scope,
      });
  }
  return result;
}
