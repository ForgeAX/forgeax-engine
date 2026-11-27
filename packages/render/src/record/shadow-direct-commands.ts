import type { BindGroup, Buffer, RenderPipeline, RhiRenderCommands } from '@forgeax/engine-rhi';
import type { MeshGpuHandles, MeshGpuRange } from '../device/gpu-residency';
import { PassMeshVertexBindings } from '../device/mesh-vertex-streams';
import { PassMeshBindGroup } from './geometry-bind-offsets';

/** A pass owns only the physical state needed for its next command. */
export class ShadowDirectCommands {
  private readonly vertices: PassMeshVertexBindings;
  private index: Buffer | undefined;
  private indexFormat: GPUIndexFormat | undefined;
  private material: BindGroup | undefined;
  private materialOffset: number | undefined;
  private readonly bindOffsetWord = new Uint32Array(1);
  private readonly meshGroups: PassMeshBindGroup;
  private instances: BindGroup | undefined;
  count = 0;

  constructor(
    private readonly pass: RhiRenderCommands,
    private pipeline: RenderPipeline | null,
  ) {
    this.vertices = new PassMeshVertexBindings(pass);
    this.meshGroups = new PassMeshBindGroup(pass, this.bindOffsetWord);
  }

  draw(
    pipeline: RenderPipeline,
    mesh: MeshGpuHandles,
    material: BindGroup,
    materialOffset: number | undefined,
    meshBinding: { readonly group: BindGroup; readonly offsets: readonly number[] },
    instances: BindGroup,
    range: MeshGpuRange,
    instanceCount: number,
    firstInstance: number,
  ): void {
    const pass = this.pass;
    const changedPipeline = this.pipeline !== pipeline;
    if (changedPipeline) {
      pass.setPipeline(pipeline);
      this.pipeline = pipeline;
    }
    this.vertices.bind(mesh.vertexBuffer.handle, mesh.vertexStreams, pipeline);
    if (
      mesh.indexed &&
      mesh.indexBuffer !== null &&
      (this.index !== mesh.indexBuffer.handle || this.indexFormat !== mesh.indexFormat)
    ) {
      this.index = mesh.indexBuffer.handle;
      this.indexFormat = mesh.indexFormat;
      pass.setIndexBuffer(this.index, this.indexFormat);
    }
    if (changedPipeline || this.material !== material || this.materialOffset !== materialOffset) {
      this.material = material;
      this.materialOffset = materialOffset;
      if (materialOffset === undefined) pass.setBindGroup(1, material);
      else {
        this.bindOffsetWord[0] = materialOffset;
        pass.setBindGroup(1, material, this.bindOffsetWord, 0, 1);
      }
    }
    this.meshGroups.bind(meshBinding.group, meshBinding.offsets, changedPipeline);
    if (changedPipeline || this.instances !== instances) {
      this.instances = instances;
      pass.setBindGroup(3, instances);
    }
    if (mesh.indexed)
      pass.drawIndexed(range.count, instanceCount, range.first, range.baseVertex, firstInstance);
    else pass.draw(range.count, instanceCount, range.first, firstInstance);
    this.count++;
  }
}
