// Evidence entry exports the same bundled identities consumed by the ordinary scene.

export { createPrograms } from 'virtual:forgeax/plugin-programs/engine';
export { AnimationPlayer, animationPlugin } from '@forgeax/engine/animation';
export { skeletalMotionPlugin } from '@forgeax/engine/animation/skeletal-motion';
export { createApp } from '@forgeax/engine/app';
export { FixedUpdate, Update, World } from '@forgeax/engine/ecs';
export { createBoxGeometry } from '@forgeax/engine/geometry';
export { quat } from '@forgeax/engine/math';
export { Collider, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
export { Camera, MeshFilter, renderComponentsPlugin } from '@forgeax/engine/render';
export { attachRecorder } from '@forgeax/engine/rhi-debug';
export * as backend from '@forgeax/engine/rhi-webgpu';
export { constructRuntimeRendererHost } from '@forgeax/engine/runtime/internal/renderer-host';
export { scenePlugin, Transform } from '@forgeax/engine/scene';
export { skinningPlugin } from '@forgeax/engine/skinning';
export { loadSkeletalMotionScene } from './skeletal-motion-scene';

export { default as physics3d } from '@forgeax/engine/physics-rapier3d';
