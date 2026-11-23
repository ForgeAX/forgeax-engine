import {
  type GraphAccess,
  type GraphPassPreparation,
  type GraphResourceResolver,
  type GraphTextureView,
  type RasterGraphPass,
  type RenderGraphBuilder,
  RenderGraphError,
  type RenderGraphNativeCommands,
  type RenderGraphNativePass,
  type SubgraphPass,
  sameGraphTexture,
} from '@forgeax/engine-render-graph';
import type { RenderPassDescriptor, TextureView } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { SceneRasterWriter } from '../typed-render-graph-primitives';

type Frame = RenderPipelineFrame;
interface DrawStage extends GraphPassPreparation {
  readonly name: string;
  readonly enabled?: ((frame: Frame) => boolean) | undefined;
  readonly appendNames?: SubgraphPass<Frame>['appendPassNames'];
  readonly profilePasses?: SubgraphPass<Frame>['profilePasses'];
  readonly record: RenderGraphNativeCommands<Frame>;
}

function borrowed<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Scene draw requires a currently recording view');
  return value;
}

function invalidStage(name: string, expected: string): Result<never, RenderGraphError> {
  return err(
    new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected,
      hint: 'declare additional attachments with their producing display stage',
      detail: { passName: name, resourceLabel: 'scene-color-draws', field: 'ports', expected },
    }),
  );
}

/** All sorted scene draws load the same single-sample color and depth. Transmission,
 * material-depth copies and OIT can interleave private images between these draws.
 * The shared attachments and declared read-only scene inputs cross the recording boundary. */
export class SceneColorDraws implements SceneRasterWriter {
  private readonly stages: DrawStage[] = [];
  private readonly ports: GraphAccess[] = [];
  private frame: Frame | undefined;
  private resolver: GraphResourceResolver | undefined;
  private colorView: TextureView | undefined;
  private depthView: TextureView | undefined;
  private readonly attachments: Pick<
    RenderPassDescriptor,
    'colorAttachments' | 'depthStencilAttachment'
  >;

  constructor(
    private readonly color: GraphTextureView,
    private readonly depth: GraphTextureView,
  ) {
    const current = this;
    this.attachments = {
      colorAttachments: [
        {
          get view() {
            return borrowed(current.colorView);
          },
          loadOp: 'load',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        get view() {
          return borrowed(current.depthView);
        },
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        stencilLoadOp: 'load',
        stencilStoreOp: 'store',
      },
    };
  }

  admitsRead(access: GraphAccess): boolean {
    switch (access.usage) {
      case 'sampled-read':
      case 'uniform-read':
      case 'storage-read':
      case 'vertex-read':
      case 'index-read':
      case 'indirect-read':
        return (
          !sameGraphTexture(this.color, access.resource) &&
          !sameGraphTexture(this.depth, access.resource)
        );
      default:
        return false;
    }
  }

  private addPorts(name: string, accesses: readonly GraphAccess[]): Result<void, RenderGraphError> {
    for (const access of accesses) {
      const { resource, usage } = access;
      const supported =
        resource === this.color
          ? usage === 'color-attachment' || usage === 'copy-src'
          : resource === this.depth
            ? usage === 'depth-stencil-write' || usage === 'copy-src'
            : this.admitsRead(access);
      if (!supported)
        return invalidStage(
          name,
          'a shared scene attachment, a before-draw copy, or an independent read-only input',
        );
      if (!this.ports.some((port) => port.resource === resource && port.usage === usage))
        this.ports.push(access);
    }
    return ok(undefined);
  }

  addRasterPass(name: string, descriptor: RasterGraphPass<Frame>): Result<void, RenderGraphError> {
    const color = descriptor.colorAttachments[0];
    const depth = descriptor.depthStencilAttachment;
    const encode = descriptor.encodeDirect;
    if (
      descriptor.colorAttachments.length !== 1 ||
      color?.view !== this.color ||
      color.loadOp !== 'load' ||
      color.storeOp !== 'store' ||
      color.resolveTarget !== undefined ||
      color.depthSlice !== undefined ||
      depth?.view !== this.depth ||
      depth.depthLoadOp !== 'load' ||
      depth.depthStoreOp !== 'store' ||
      depth.depthReadOnly ||
      depth.stencilLoadOp !== 'load' ||
      depth.stencilStoreOp !== 'store' ||
      depth.stencilReadOnly ||
      descriptor.occlusionQuerySet !== undefined ||
      encode === undefined
    )
      return invalidStage(
        name,
        'a direct current draw loading and storing scene color, depth and stencil',
      );
    const ports = this.addPorts(name, descriptor.accesses);
    if (!ports.ok) return ports;
    const work: RenderGraphNativePass = {
      kind: 'raster',
      name,
      descriptor: { label: name, ...this.attachments },
      encode: (pass) => {
        encode(pass, borrowed(this.frame), borrowed(this.resolver));
      },
    };
    this.stages.push({
      name,
      enabled: descriptor.executeIf,
      profilePasses: () => [work],
      ...(descriptor.preparedResourcesCurrent
        ? { preparedResourcesCurrent: descriptor.preparedResourcesCurrent }
        : {}),
      ...(descriptor.prepareResources ? { prepareResources: descriptor.prepareResources } : {}),
      record(_frame, _resources, issue, recording) {
        issue(recording, work);
      },
    });
    return ok(undefined);
  }

  addSubgraphPass(name: string, descriptor: SubgraphPass<Frame>): Result<void, RenderGraphError> {
    if (descriptor.child !== undefined)
      return invalidStage(name, 'current physical commands with explicit attachment ports');
    const ports = this.addPorts(name, descriptor.accesses);
    if (!ports.ok) return ports;
    this.stages.push({
      name,
      enabled: descriptor.executeIf,
      appendNames: descriptor.appendPassNames,
      profilePasses: descriptor.profilePasses,
      ...(descriptor.preparedResourcesCurrent
        ? { preparedResourcesCurrent: descriptor.preparedResourcesCurrent }
        : {}),
      ...(descriptor.prepareResources ? { prepareResources: descriptor.prepareResources } : {}),
      record:
        descriptor.commandsDirect ??
        ((frame, resources, issue, recording) =>
          descriptor.commands({ frame, resources, execute: (work) => issue(recording, work) })),
    });
    return ok(undefined);
  }

  install(graph: RenderGraphBuilder<Frame>, name: string): Result<void, RenderGraphError> {
    const stages = this.stages;
    const prepare = stages.filter(
      (stage) => stage.prepareResources || stage.preparedResourcesCurrent,
    );
    return graph.addSubgraphPass(name, {
      accesses: this.ports,
      profilePasses: () => stages.flatMap((stage) => stage.profilePasses?.() ?? []),
      ...(prepare.length === 0
        ? {}
        : {
            preparedResourcesCurrent: () =>
              prepare.every((stage) => stage.preparedResourcesCurrent?.() !== false),
            *prepareResources(resources, current) {
              for (const stage of prepare) {
                if (!current()) return;
                if (stage.prepareResources) yield* stage.prepareResources(resources, current);
              }
            },
          }),
      appendPassNames(frame, names) {
        for (const stage of stages)
          if (stage.appendNames) stage.appendNames(frame, names);
          else names.push(stage.name);
      },
      commandsDirect: (frame, resources, issue, recording) => {
        this.frame = frame;
        this.resolver = resources;
        try {
          this.colorView = resources.textureView(this.color).unwrap();
          this.depthView = resources.textureView(this.depth).unwrap();
          for (const stage of stages)
            if (stage.enabled?.(frame) !== false) stage.record(frame, resources, issue, recording);
        } finally {
          this.frame = this.resolver = this.colorView = this.depthView = undefined;
        }
      },
    });
  }
}
