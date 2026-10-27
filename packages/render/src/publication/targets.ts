import { createRenderTargetHost, type RenderTargetHost } from '../assembly/render-target-host';
import { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import type {
  RenderTarget,
  RenderTargetDescriptor,
  RenderTargetTextureSource,
  RenderTargetTextureSourceOptions,
} from '../targets/contracts';
import { resolveRenderTargetMaterialSource } from '../targets/material-source';
import { isCanvasTextureSource, type MaterialTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import { renderTextureSourceKey } from '../textures/source-token';
import type { RenderPublication } from './contract';
import { RenderPublicationError } from './contract';
import type { PreparedRenderPublication } from './receiver';

/** Author descriptions synchronously; the consuming Renderer owns physical resources. */
export type RenderTargetAuthoring = Pick<
  RenderTargetHost,
  | 'createRenderTarget'
  | 'resizeRenderTarget'
  | 'createRenderTargetTextureSource'
  | 'destroyRenderTarget'
>;
export interface PublishedRenderTarget {
  readonly id: number;
  readonly token: RenderTarget;
  readonly descriptor: RenderTargetDescriptor;
}
export interface PublishedRenderTargetSource {
  readonly token: RenderTargetTextureSource;
  readonly target: RenderTarget;
  readonly options: RenderTargetTextureSourceOptions;
}
export class RenderPublicationTargetOwner {
  private readonly host = createRenderTargetHost();
  private readonly ids = new WeakMap<object, number>();
  private nextId = 0;
  readonly authoring: RenderTargetAuthoring = this.host;
  snapshot(): readonly PublishedRenderTarget[] {
    return this.host.descriptions().map(({ target, descriptor }) => {
      let id = this.ids.get(target);
      if (id === undefined) {
        id = ++this.nextId;
        this.ids.set(target, id);
      }
      return { id, token: target, descriptor };
    });
  }
  dispose(): void {
    this.host.dispose();
  }
}

export function publicationTargetSources(
  materials: RenderPublication['materials'],
): readonly PublishedRenderTargetSource[] {
  const sources = new Map<string, PublishedRenderTargetSource>();
  for (const { value: material } of materials) {
    for (const source of material.textureSources?.values() ?? []) {
      if (
        isCanvasTextureSource(source) ||
        isExternalTextureSource(source) ||
        sources.has(renderTextureSourceKey(source))
      )
        continue;
      const binding = resolveRenderTargetMaterialSource(source);
      if (binding === undefined)
        throw new RenderPublicationError({
          reason: 'shape',
          subject: 'unknown material target source',
        });
      sources.set(renderTextureSourceKey(source), {
        token: source,
        target: binding.target,
        options: {
          aspect: 'color',
          dimension: binding.view.dimension,
          mipLevel: binding.view.mipLevel,
        },
      });
    }
  }
  return [...sources.values()];
}

interface ReceivedTarget {
  readonly target: RenderTarget;
  descriptor: RenderTargetDescriptor;
  readonly sources: Map<string, RenderTargetTextureSource>;
}

/** Translate logical references once at receive time; no source GPU handle crosses realms. */
export class RenderPublicationTargetReceiver {
  private readonly targets = new Map<number, ReceivedTarget>();
  /** Receiver-owned source key -> publisher source key, for materials accepted in earlier packets. */
  private readonly origins = new Map<string, { readonly key: string; readonly target: number }>();
  constructor(private readonly host: RenderTargetAuthoring) {}
  /** The publisher key an accepted (already rebound) material source was published under. */
  originKey(key: string): string | undefined {
    return this.origins.get(key)?.key;
  }
  apply(input: PreparedRenderPublication): PreparedRenderPublication {
    const packet = input.packet;
    if (packet.targets.length === 0 && packet.targetSources.length === 0 && this.targets.size === 0)
      return input;
    const tokens = new Map<RenderTarget, RenderTarget>();
    const records = new Map<RenderTarget, ReceivedTarget>();
    const ids = new Map<RenderTarget, number>();
    const active = new Set(packet.targets.map((row) => row.id));
    for (const [id, record] of this.targets)
      if (!active.has(id)) {
        const destroyed = this.host.destroyRenderTarget(record.target);
        if (!destroyed.ok) throw destroyed.error;
        this.targets.delete(id);
        for (const [key, origin] of this.origins)
          if (origin.target === id) this.origins.delete(key);
      }
    for (const row of packet.targets) {
      let record = this.targets.get(row.id);
      if (record === undefined) {
        const created = this.host.createRenderTarget(row.descriptor);
        if (!created.ok) throw created.error;
        record = { target: created.value, descriptor: row.descriptor, sources: new Map() };
        this.targets.set(row.id, record);
      } else if (JSON.stringify(record.descriptor) !== JSON.stringify(row.descriptor)) {
        const resized = this.host.resizeRenderTarget(record.target, row.descriptor);
        if (!resized.ok) throw resized.error;
        record.descriptor = row.descriptor;
        record.sources.clear();
      }
      tokens.set(row.token, record.target);
      records.set(row.token, record);
      ids.set(row.token, row.id);
    }
    const resolve = (token: RenderTarget): RenderTarget => {
      const target = tokens.get(token);
      if (target === undefined)
        throw new RenderPublicationError({ reason: 'shape', subject: 'missing target descriptor' });
      return target;
    };
    const sources = new Map<string, RenderTargetTextureSource>();
    for (const row of packet.targetSources) {
      const record = records.get(row.target);
      if (record === undefined)
        throw new RenderPublicationError({ reason: 'shape', subject: 'missing material target' });
      const key = JSON.stringify(row.options);
      let source = record.sources.get(key);
      if (source === undefined) {
        const created = this.host.createRenderTargetTextureSource(record.target, row.options);
        if (!created.ok) throw created.error;
        source = created.value;
        record.sources.set(key, source);
      }
      sources.set(renderTextureSourceKey(row.token), source);
      this.origins.set(renderTextureSourceKey(source), {
        key: renderTextureSourceKey(row.token),
        target: ids.get(row.target) as number,
      });
    }
    const camera = <T extends { readonly target?: RenderTarget }>(row: T): T =>
      row.target === undefined ? row : { ...row, target: resolve(row.target) };
    const rebound = new Map<MaterialResource, MaterialResource>();
    const rebind = (material: MaterialResource): MaterialResource => {
      const existing = rebound.get(material);
      if (existing !== undefined) return existing;
      if (material.snapshot.textureSources === undefined) return material;
      const textureSources = new Map<string, MaterialTextureSource>(
        [...material.snapshot.textureSources].map(([name, token]) => {
          if (isCanvasTextureSource(token) || isExternalTextureSource(token))
            return [name, token] as const;
          const key = renderTextureSourceKey(token);
          const source = sources.get(key) ?? sources.get(this.originKey(key) ?? key);
          if (source === undefined)
            throw new RenderPublicationError({
              reason: 'shape',
              subject: 'missing material target source',
            });
          return [name, source] as const;
        }),
      );
      const resource = MaterialResource.from({ ...material.snapshot, textureSources });
      rebound.set(material, resource);
      return resource;
    };
    const materialUpdates = input.materialUpdates.map(rebind);
    // Rows without a rebound material stay the same object; only rebound rows are copied.
    const snapshots = new Map<number, RenderableSnapshot>();
    const renderables = input.frame.renderables.map((row) => {
      const materials = row.materials.map(rebind);
      if (materials.every((material, index) => material === row.materials[index])) return row;
      const first = row.materials.indexOf(row.material);
      const rebound = {
        ...row,
        materials,
        material: materials[Math.max(0, first)] ?? row.material,
      };
      snapshots.set(row.entityKey, rebound);
      return rebound;
    });
    return {
      ...input,
      materialUpdates,
      frame: {
        ...input.frame,
        renderables,
        cameras: input.frame.cameras.map(camera),
        auxiliaryCameras: input.frame.auxiliaryCameras.map(camera),
        cubeCameras: input.frame.cubeCameras.map(camera),
      },
      operations: input.operations.map((operation) => {
        if (operation.kind === 'remove' || operation.snapshot === undefined) return operation;
        const snapshot = snapshots.get(operation.entityKey);
        return snapshot === undefined ? operation : { ...operation, snapshot };
      }),
    };
  }
}
