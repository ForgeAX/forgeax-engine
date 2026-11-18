export { default as Storage3DTexture } from 'three/src/renderers/common/Storage3DTexture.js';
export { default as StorageArrayTexture } from 'three/src/renderers/common/StorageArrayTexture.js';
export { default as StorageTexture } from 'three/src/renderers/common/StorageTexture.js';
// Preserve the pinned upstream CPU/data constructors without bundling a GPU renderer.

export { default as IESSpotLight } from 'three/src/lights/webgpu/IESSpotLight.js';
export { default as ProjectorLight } from 'three/src/lights/webgpu/ProjectorLight.js';
export { default as Line2NodeMaterial } from 'three/src/materials/nodes/Line2NodeMaterial.js';
export { default as MeshPhongNodeMaterial } from 'three/src/materials/nodes/MeshPhongNodeMaterial.js';
export { default as MeshSSSNodeMaterial } from 'three/src/materials/nodes/MeshSSSNodeMaterial.js';
export { default as MeshToonNodeMaterial } from 'three/src/materials/nodes/MeshToonNodeMaterial.js';
export { default as ShadowNodeMaterial } from 'three/src/materials/nodes/ShadowNodeMaterial.js';
export { default as VolumeNodeMaterial } from 'three/src/materials/nodes/VolumeNodeMaterial.js';
export { default as BufferAttributeNode } from 'three/src/nodes/accessors/BufferAttributeNode.js';
export { default as BufferNode } from 'three/src/nodes/accessors/BufferNode.js';
export { default as BuiltinNode } from 'three/src/nodes/accessors/BuiltinNode.js';
export { default as ClippingNode } from 'three/src/nodes/accessors/ClippingNode.js';
export { default as CubeTextureNode } from 'three/src/nodes/accessors/CubeTextureNode.js';
export { default as MaterialNode } from 'three/src/nodes/accessors/MaterialNode.js';
export { default as ModelNode } from 'three/src/nodes/accessors/ModelNode.js';
export { default as Object3DNode } from 'three/src/nodes/accessors/Object3DNode.js';
export { default as PointUVNode } from 'three/src/nodes/accessors/PointUVNode.js';
export { default as ReferenceAttributeNode } from 'three/src/nodes/accessors/ReferenceAttributeNode.js';
export { default as ReferenceElementNode } from 'three/src/nodes/accessors/ReferenceElementNode.js';
export { default as RendererReferenceNode } from 'three/src/nodes/accessors/RendererReferenceNode.js';
export { default as StorageTexture3DNode } from 'three/src/nodes/accessors/StorageTexture3DNode.js';
export { default as StorageTextureNode } from 'three/src/nodes/accessors/StorageTextureNode.js';
export { default as Texture3DNode } from 'three/src/nodes/accessors/Texture3DNode.js';
export { default as TextureNode } from 'three/src/nodes/accessors/TextureNode.js';
export { default as TextureSizeNode } from 'three/src/nodes/accessors/TextureSizeNode.js';
export { default as UniformArrayNode } from 'three/src/nodes/accessors/UniformArrayNode.js';
export { default as VelocityNode } from 'three/src/nodes/accessors/VelocityNode.js';
export { default as VertexColorNode } from 'three/src/nodes/accessors/VertexColorNode.js';
export { default as ExpressionNode } from 'three/src/nodes/code/ExpressionNode.js';
export { default as FunctionCallNode } from 'three/src/nodes/code/FunctionCallNode.js';
export { default as ArrayNode } from 'three/src/nodes/core/ArrayNode.js';
export { default as BypassNode } from 'three/src/nodes/core/BypassNode.js';
export { default as ConstNode } from 'three/src/nodes/core/ConstNode.js';
export { default as ContextNode } from 'three/src/nodes/core/ContextNode.js';
export {
  defaultBuildStages,
  defaultShaderStages,
  NodeAccess,
  NodeShaderStage,
  NodeType,
  NodeUpdateType,
  shaderStages,
  vectorComponents,
} from 'three/src/nodes/core/constants.js';
export { default as IndexNode } from 'three/src/nodes/core/IndexNode.js';
export { default as InputNode } from 'three/src/nodes/core/InputNode.js';
export { default as InspectorNode } from 'three/src/nodes/core/InspectorNode.js';
export { default as IsolateNode } from 'three/src/nodes/core/IsolateNode.js';
export { default as LightingModel } from 'three/src/nodes/core/LightingModel.js';
export { default as MRTNode } from 'three/src/nodes/core/MRTNode.js';
export { default as Node } from 'three/src/nodes/core/Node.js';
export { default as NodeAttribute } from 'three/src/nodes/core/NodeAttribute.js';
export { default as NodeCache } from 'three/src/nodes/core/NodeCache.js';
export { default as NodeCode } from 'three/src/nodes/core/NodeCode.js';
export { default as NodeError } from 'three/src/nodes/core/NodeError.js';
export { default as NodeUniform } from 'three/src/nodes/core/NodeUniform.js';
export * as NodeUtils from 'three/src/nodes/core/NodeUtils.js';
export { default as NodeVar } from 'three/src/nodes/core/NodeVar.js';
export { default as NodeVarying } from 'three/src/nodes/core/NodeVarying.js';
export { default as OutputStructNode } from 'three/src/nodes/core/OutputStructNode.js';
export { default as OverrideContextNode } from 'three/src/nodes/core/OverrideContextNode.js';
export { default as ParameterNode } from 'three/src/nodes/core/ParameterNode.js';
export { default as PropertyNode } from 'three/src/nodes/core/PropertyNode.js';
export { default as StackNode } from 'three/src/nodes/core/StackNode.js';
export { default as StructTypeNode } from 'three/src/nodes/core/StructTypeNode.js';
export { default as SubBuildNode } from 'three/src/nodes/core/SubBuildNode.js';
export { default as TempNode } from 'three/src/nodes/core/TempNode.js';
export { default as UniformGroupNode } from 'three/src/nodes/core/UniformGroupNode.js';
export { default as UniformNode } from 'three/src/nodes/core/UniformNode.js';
export { default as VarNode } from 'three/src/nodes/core/VarNode.js';
export { default as VaryingNode } from 'three/src/nodes/core/VaryingNode.js';
export { default as BumpMapNode } from 'three/src/nodes/display/BumpMapNode.js';
export { default as ColorSpaceNode } from 'three/src/nodes/display/ColorSpaceNode.js';
export { default as FrontFacingNode } from 'three/src/nodes/display/FrontFacingNode.js';
export { default as NormalMapNode } from 'three/src/nodes/display/NormalMapNode.js';
export { default as PassNode } from 'three/src/nodes/display/PassNode.js';
export { default as RenderOutputNode } from 'three/src/nodes/display/RenderOutputNode.js';
export { default as ScreenNode } from 'three/src/nodes/display/ScreenNode.js';
export { default as ToneMappingNode } from 'three/src/nodes/display/ToneMappingNode.js';
export { default as ToonOutlinePassNode } from 'three/src/nodes/display/ToonOutlinePassNode.js';
export { default as ViewportDepthNode } from 'three/src/nodes/display/ViewportDepthNode.js';
export { default as ViewportDepthTextureNode } from 'three/src/nodes/display/ViewportDepthTextureNode.js';
export { default as ViewportSharedTextureNode } from 'three/src/nodes/display/ViewportSharedTextureNode.js';
export { default as ViewportTextureNode } from 'three/src/nodes/display/ViewportTextureNode.js';
export { default as PhongLightingModel } from 'three/src/nodes/functions/PhongLightingModel.js';
export { default as PhysicalLightingModel } from 'three/src/nodes/functions/PhysicalLightingModel.js';
export { default as RangeNode } from 'three/src/nodes/geometry/RangeNode.js';
export { default as AtomicFunctionNode } from 'three/src/nodes/gpgpu/AtomicFunctionNode.js';
export { default as BarrierNode } from 'three/src/nodes/gpgpu/BarrierNode.js';
export { default as ComputeBuiltinNode } from 'three/src/nodes/gpgpu/ComputeBuiltinNode.js';
export { default as SubgroupFunctionNode } from 'three/src/nodes/gpgpu/SubgroupFunctionNode.js';
export { default as WorkgroupInfoNode } from 'three/src/nodes/gpgpu/WorkgroupInfoNode.js';
export { default as AmbientLightNode } from 'three/src/nodes/lighting/AmbientLightNode.js';
export { default as AnalyticLightNode } from 'three/src/nodes/lighting/AnalyticLightNode.js';
export { default as AONode } from 'three/src/nodes/lighting/AONode.js';
export { default as BasicEnvironmentNode } from 'three/src/nodes/lighting/BasicEnvironmentNode.js';
export { default as BasicLightMapNode } from 'three/src/nodes/lighting/BasicLightMapNode.js';
export { default as DirectionalLightNode } from 'three/src/nodes/lighting/DirectionalLightNode.js';
export { default as EnvironmentNode } from 'three/src/nodes/lighting/EnvironmentNode.js';
export { default as HemisphereLightNode } from 'three/src/nodes/lighting/HemisphereLightNode.js';
export { default as IESSpotLightNode } from 'three/src/nodes/lighting/IESSpotLightNode.js';
export { default as IrradianceNode } from 'three/src/nodes/lighting/IrradianceNode.js';
export { default as LightingContextNode } from 'three/src/nodes/lighting/LightingContextNode.js';
export { default as LightingNode } from 'three/src/nodes/lighting/LightingNode.js';
export { default as LightProbeNode } from 'three/src/nodes/lighting/LightProbeNode.js';
export { default as LightsNode } from 'three/src/nodes/lighting/LightsNode.js';
export { default as PointLightNode } from 'three/src/nodes/lighting/PointLightNode.js';
export { default as ProjectorLightNode } from 'three/src/nodes/lighting/ProjectorLightNode.js';
export { default as RectAreaLightNode } from 'three/src/nodes/lighting/RectAreaLightNode.js';
export { default as ShadowBaseNode } from 'three/src/nodes/lighting/ShadowBaseNode.js';
export { default as SpotLightNode } from 'three/src/nodes/lighting/SpotLightNode.js';
export { default as BitcastNode } from 'three/src/nodes/math/BitcastNode.js';
export { default as BitcountNode } from 'three/src/nodes/math/BitcountNode.js';
export { default as ConditionalNode } from 'three/src/nodes/math/ConditionalNode.js';
export { default as MathNode } from 'three/src/nodes/math/MathNode.js';
export { default as OperatorNode } from 'three/src/nodes/math/OperatorNode.js';
export { default as Packed4x8IntegerNode } from 'three/src/nodes/math/Packed4x8IntegerNode.js';
export { default as PackFloatNode } from 'three/src/nodes/math/PackFloatNode.js';
export { default as UnpackFloatNode } from 'three/src/nodes/math/UnpackFloatNode.js';
export { default as PMREMNode } from 'three/src/nodes/pmrem/PMREMNode.js';
export { default as ArrayElementNode } from 'three/src/nodes/utils/ArrayElementNode.js';
export { default as ConvertNode } from 'three/src/nodes/utils/ConvertNode.js';
export { default as CubeMapNode } from 'three/src/nodes/utils/CubeMapNode.js';
export { default as DebugNode } from 'three/src/nodes/utils/DebugNode.js';
export { default as FlipNode } from 'three/src/nodes/utils/FlipNode.js';
export { default as LoopNode } from 'three/src/nodes/utils/LoopNode.js';
export { default as MaxMipLevelNode } from 'three/src/nodes/utils/MaxMipLevelNode.js';
export { default as ReflectorNode } from 'three/src/nodes/utils/ReflectorNode.js';
export { default as RotateNode } from 'three/src/nodes/utils/RotateNode.js';
export { default as SampleNode } from 'three/src/nodes/utils/SampleNode.js';
export { default as SplitNode } from 'three/src/nodes/utils/SplitNode.js';
export { ClippingGroup } from 'three/src/objects/ClippingGroup.js';
export { default as BlendMode } from 'three/src/renderers/common/BlendMode.js';
export { default as BundleGroup } from 'three/src/renderers/common/BundleGroup.js';
export { default as CanvasTarget } from 'three/src/renderers/common/CanvasTarget.js';
export { default as CubeRenderTarget } from 'three/src/renderers/common/CubeRenderTarget.js';
export { default as InspectorBase } from 'three/src/renderers/common/InspectorBase.js';
export { default as ReadbackBuffer } from 'three/src/renderers/common/ReadbackBuffer.js';
export * from 'three/src/Three.Core.js';
export { JoinNode, MemberNode, NodeFrame, SetNode } from './node-authoring';
export {
  AssignNode,
  AttributeNode,
  CodeNode,
  FunctionNode,
  FunctionOverloadingNode,
  MaterialReferenceNode,
  StructNode,
} from './node-code';
export { ComputeNode, StorageArrayElementNode, StorageBufferNode } from './node-compute';
export { NodeFunctionInput, StackTrace } from './node-descriptors';
export { EventNode, type EventNodeType } from './node-events';
export { BasicNodeLibrary, StandardNodeLibrary } from './node-library';
export { Lighting } from './node-lighting';
export { NodeLoader, NodeMaterialLoader, NodeObjectLoader } from './node-loaders';
export { NodeMaterialInstance, Sprite } from './node-material-instance';
export {
  LineBasicNodeMaterial,
  LineDashedNodeMaterial,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshMatcapNodeMaterial,
  MeshNormalNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  NodeMaterial,
  PointsNodeMaterial,
  SpriteNodeMaterial,
} from './node-materials';
export { NodeMaterialObserver, type NodeMaterialObserverContext } from './node-observer';
export { GLSLNodeParser } from './node-parser';
export { RTTNode } from './node-rtt';
export { PointShadowNode, ShadowNode } from './node-shadow';
export { ReferenceBaseNode, ReferenceNode, UserDataNode } from './reference-nodes';
export * as RendererUtils from './renderer-utils';
export {
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
} from './storage-attributes';
export * as TSL from './tsl';
