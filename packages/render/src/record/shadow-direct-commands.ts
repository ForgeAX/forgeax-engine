import type { BindGroup, Buffer, RenderPipeline, RhiRenderCommands } from '@forgeax/engine-rhi';
import type { MeshGpuHandles, MeshGpuRange } from '../device/gpu-residency';
import { bindMeshVertexStreams } from '../device/mesh-vertex-streams';

/** A pass owns only the physical state needed for its next command. */
export class ShadowDirectCommands {
  private vertex: Buffer | undefined;
  private vertexStreams: MeshGpuHandles['vertexStreams'];
  private index: Buffer | undefined;
  private indexFormat: GPUIndexFormat | undefined;
  private material: BindGroup | undefined;
  private readonly materialOffsets = [0];
  private meshGroup: BindGroup | undefined;
  private readonly meshOffsets: number[] = [];
  private instances: BindGroup | undefined;
  count = 0;

  constructor(
    private readonly pass: RhiRenderCommands,
    private pipeline: RenderPipeline | null,
  ) {}

  draw(
    pipeline: RenderPipeline,
    mesh: MeshGpuHandles,
    material: BindGroup,
    materialOffset: number,
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
    if (this.vertex !== mesh.vertexBuffer.handle || this.vertexStreams !== mesh.vertexStreams) {
      this.vertex = mesh.vertexBuffer.handle;
      this.vertexStreams = mesh.vertexStreams;
      bindMeshVertexStreams(pass, this.vertex, this.vertexStreams);
    }
    if (
      mesh.indexed &&
      mesh.indexBuffer !== null &&
      (this.index !== mesh.indexBuffer.handle || this.indexFormat !== mesh.indexFormat)
    ) {
      this.index = mesh.indexBuffer.handle;
      this.indexFormat = mesh.indexFormat;
      pass.setIndexBuffer(this.index, this.indexFormat);
    }
    if (
      changedPipeline ||
      this.material !== material ||
      this.materialOffsets[0] !== materialOffset
    ) {
      this.material = material;
      this.materialOffsets[0] = materialOffset;
      pass.setBindGroup(1, material, this.materialOffsets);
    }
    const offsets = meshBinding.offsets;
    let bindMesh =
      changedPipeline ||
      this.meshGroup !== meshBinding.group ||
      this.meshOffsets.length !== offsets.length;
    for (let i = 0; !bindMesh && i < offsets.length; i++)
      bindMesh = this.meshOffsets[i] !== offsets[i];
    if (bindMesh) {
      this.meshGroup = meshBinding.group;
      this.meshOffsets.length = offsets.length;
      for (let i = 0; i < offsets.length; i++) this.meshOffsets[i] = offsets[i] as number;
      pass.setBindGroup(2, meshBinding.group, offsets);
    }
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
