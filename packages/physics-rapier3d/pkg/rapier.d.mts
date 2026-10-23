/* tslint:disable */
/* eslint-disable */

declare class RawBroadPhase {
    free(): void;
    [Symbol.dispose](): void;
    castRay(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, rayOrig: RawVector, rayDir: RawVector, maxToi: number, solid: boolean, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): RawRayColliderHit | undefined;
    castRayAndGetNormal(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, rayOrig: RawVector, rayDir: RawVector, maxToi: number, solid: boolean, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): RawRayColliderIntersection | undefined;
    castShape(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, shapePos: RawVector, shapeRot: RawRotation, shapeVel: RawVector, shape: RawShape, target_distance: number, maxToi: number, stop_at_penetration: boolean, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): RawColliderShapeCastHit | undefined;
    collidersWithAabbIntersectingAabb(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, aabbCenter: RawVector, aabbHalfExtents: RawVector, callback: Function): void;
    intersectionWithShape(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, shapePos: RawVector, shapeRot: RawRotation, shape: RawShape, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): number | undefined;
    intersectionsWithPoint(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, point: RawVector, callback: Function, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): void;
    intersectionsWithRay(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, rayOrig: RawVector, rayDir: RawVector, maxToi: number, solid: boolean, callback: Function, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): void;
    intersectionsWithShape(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, shapePos: RawVector, shapeRot: RawRotation, shape: RawShape, callback: Function, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): void;
    constructor();
    projectPoint(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, point: RawVector, solid: boolean, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): RawPointColliderProjection | undefined;
    projectPointAndGetFeature(narrow_phase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, point: RawVector, filter_flags: number, filter_groups: number | null | undefined, filter_exclude_collider: number | null | undefined, filter_exclude_rigid_body: number | null | undefined, filter_predicate: Function): RawPointColliderProjection | undefined;
}

declare class RawCCDSolver {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
}

declare class RawColliderSet {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bind one authored collider instance to a native geometry identity and scale.
     */
    bindSharedGeometry(collider: number, geometry: number, scale: RawVector): boolean;
    /**
     * The collision types enabled for this collider.
     */
    coActiveCollisionTypes(handle: number): number;
    /**
     * The events enabled for this collider.
     */
    coActiveEvents(handle: number): number;
    /**
     * The physics hooks enabled for this collider.
     */
    coActiveHooks(handle: number): number;
    coCastCollider(handle: number, collider1Vel: RawVector, collider2handle: number, collider2Vel: RawVector, target_distance: number, max_toi: number, stop_at_penetration: boolean): RawColliderShapeCastHit | undefined;
    coCastRay(handle: number, rayOrig: RawVector, rayDir: RawVector, maxToi: number, solid: boolean): number;
    coCastRayAndGetNormal(handle: number, rayOrig: RawVector, rayDir: RawVector, maxToi: number, solid: boolean): RawRayIntersection | undefined;
    coCastShape(handle: number, colliderVel: RawVector, shape2: RawShape, shape2Pos: RawVector, shape2Rot: RawRotation, shape2Vel: RawVector, target_distance: number, maxToi: number, stop_at_penetration: boolean): RawShapeCastHit | undefined;
    /**
     * The collision groups of this collider.
     */
    coCollisionGroups(handle: number): number;
    coCombineVoxelStates(handle1: number, handle2: number, shift_x: number, shift_y: number, shift_z: number): void;
    coContactCollider(handle: number, collider2handle: number, prediction: number): RawShapeContact | undefined;
    /**
     * The total force magnitude beyond which a contact force event can be emitted.
     */
    coContactForceEventThreshold(handle: number): number;
    coContactShape(handle: number, shape2: RawShape, shapePos2: RawVector, shapeRot2: RawRotation, prediction: number): RawShapeContact | undefined;
    coContactSkin(handle: number): number;
    coContainsPoint(handle: number, point: RawVector): boolean;
    /**
     * Copies occupied storage and applies a local edit without touching the source collider.
     */
    coCopyVoxels(handle: number, removed: Int32Array, added: Int32Array): RawShape;
    /**
     * The density of this collider.
     */
    coDensity(handle: number): number;
    /**
     * The friction coefficient of this collider.
     */
    coFriction(handle: number): number;
    coFrictionCombineRule(handle: number): number;
    /**
     * The half-extents of this collider if it has a cuboid shape.
     *
     * Returns `false` if it doesn’t have a cuboid shape.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    coHalfExtents(handle: number, scratch_buffer: Float32Array): boolean;
    /**
     * The half height of this collider if it is a capsule, cylinder, or cone shape.
     */
    coHalfHeight(handle: number): number | undefined;
    /**
     * The outward normal of this collider if it has a half-space shape.
     *
     * Returns `false` if it doesn’t have a half-space shape.
     */
    coHalfspaceNormal(handle: number, scratch_buffer: Float32Array): boolean;
    coHasSharedGeometry(collider: number): boolean;
    coHeightFieldFlags(handle: number): number | undefined;
    /**
     * The height of this heightfield if it is one.
     */
    coHeightfieldHeights(handle: number): Float32Array | undefined;
    /**
     * The number of columns on this heightfield's height matrix, if it is one.
     */
    coHeightfieldNCols(handle: number): number | undefined;
    /**
     * The number of rows on this heightfield's height matrix, if it is one.
     */
    coHeightfieldNRows(handle: number): number | undefined;
    /**
     * The scaling factor applied to this heightfield if it is one.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    coHeightfieldScale(handle: number, scratch_buffer: Float32Array): boolean;
    /**
     * The indices of this triangle mesh, polyline, or convex polyhedron, if it is one.
     *
     * For convex polyhedra, the indices refer to the convex hull recomputed with
     * `try_convex_hull` (matching `coVertices`), not to the original input mesh.
     */
    coIndices(handle: number): Uint32Array | undefined;
    coIntersectsRay(handle: number, rayOrig: RawVector, rayDir: RawVector, maxToi: number): boolean;
    coIntersectsShape(handle: number, shape2: RawShape, shapePos2: RawVector, shapeRot2: RawRotation): boolean;
    coIsEnabled(handle: number): boolean;
    /**
     * Is this collider a sensor?
     */
    coIsSensor(handle: number): boolean;
    /**
     * The mass of this collider.
     */
    coMass(handle: number): number;
    /**
     * The unique integer identifier of the collider this collider is attached to.
     */
    coParent(handle: number): number | undefined;
    coProjectPoint(handle: number, point: RawVector, solid: boolean): RawPointProjection;
    coPropagateVoxelChange(handle1: number, handle2: number, ix: number, iy: number, iz: number, shift_x: number, shift_y: number, shift_z: number): void;
    /**
     * The radius of this collider if it is a ball, capsule, cylinder, or cone shape.
     */
    coRadius(handle: number): number | undefined;
    /**
     * The restitution coefficient of this collider.
     */
    coRestitution(handle: number): number;
    coRestitutionCombineRule(handle: number): number;
    /**
     * The world-space orientation of this collider.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    coRotation(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The orientation of this collider relative to its parent rigid-body.
     *
     * Returns `false` if it doesn’t have a parent.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    coRotationWrtParent(handle: number, scratch_buffer: Float32Array): boolean;
    /**
     * The radius of the round edges of this collider.
     */
    coRoundRadius(handle: number): number | undefined;
    coSetActiveCollisionTypes(handle: number, types: number): void;
    coSetActiveEvents(handle: number, events: number): void;
    coSetActiveHooks(handle: number, hooks: number): void;
    coSetCollisionGroups(handle: number, groups: number): void;
    coSetContactForceEventThreshold(handle: number, threshold: number): void;
    coSetContactSkin(handle: number, contact_skin: number): void;
    coSetDensity(handle: number, density: number): void;
    coSetEnabled(handle: number, enabled: boolean): void;
    coSetFriction(handle: number, friction: number): void;
    coSetFrictionCombineRule(handle: number, rule: number): void;
    /**
     * Set the half-extents of this collider if it has a cuboid shape.
     */
    coSetHalfExtents(handle: number, newHalfExtents: RawVector): void;
    /**
     * Set the half height of this collider if it is a capsule, cylinder, or cone shape.
     */
    coSetHalfHeight(handle: number, newHalfheight: number): void;
    coSetMass(handle: number, mass: number): void;
    coSetMassProperties(handle: number, mass: number, centerOfMass: RawVector, principalAngularInertia: RawVector, angularInertiaFrame: RawRotation): void;
    /**
     * Set the radius of this collider if it is a ball, capsule, cylinder, or cone shape.
     */
    coSetRadius(handle: number, newRadius: number): void;
    coSetRestitution(handle: number, restitution: number): void;
    coSetRestitutionCombineRule(handle: number, rule: number): void;
    /**
     * Sets the rotation quaternion of this collider.
     *
     * This does nothing if a zero quaternion is provided.
     *
     * # Parameters
     * - `x`: the first vector component of the quaternion.
     * - `y`: the second vector component of the quaternion.
     * - `z`: the third vector component of the quaternion.
     * - `w`: the scalar component of the quaternion.
     * - `wakeUp`: forces the collider to wake-up so it is properly affected by forces if it
     * wasn't moving before modifying its position.
     */
    coSetRotation(handle: number, x: number, y: number, z: number, w: number): void;
    coSetRotationWrtParent(handle: number, x: number, y: number, z: number, w: number): void;
    /**
     * Set the radius of the round edges of this collider.
     */
    coSetRoundRadius(handle: number, newBorderRadius: number): void;
    coSetSensor(handle: number, is_sensor: boolean): void;
    coSetShape(handle: number, shape: RawShape): void;
    coSetSolverGroups(handle: number, groups: number): void;
    /**
     * Sets the translation of this collider.
     *
     * # Parameters
     * - `x`: the world-space position of the collider along the `x` axis.
     * - `y`: the world-space position of the collider along the `y` axis.
     * - `z`: the world-space position of the collider along the `z` axis.
     * - `wakeUp`: forces the collider to wake-up so it is properly affected by forces if it
     * wasn't moving before modifying its position.
     */
    coSetTranslation(handle: number, x: number, y: number, z: number): void;
    coSetTranslationWrtParent(handle: number, x: number, y: number, z: number): void;
    coSetVoxel(handle: number, ix: number, iy: number, iz: number, filled: boolean): void;
    /**
     * Applies one homogeneous edit batch, returning the number of changed cells.
     */
    coSetVoxels(handle: number, coords: Int32Array, filled: boolean): number;
    coShape(handle: number): RawShape;
    /**
     * The type of the shape of this collider.
     */
    coShapeType(handle: number): RawShapeType;
    /**
     * The solver groups of this collider.
     */
    coSolverGroups(handle: number): number;
    /**
     * The world-space translation of this collider.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    coTranslation(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The translation of this collider relative to its parent rigid-body.
     *
     * Returns `false` if it doesn’t have a parent.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    coTranslationWrtParent(handle: number, scratch_buffer: Float32Array): boolean;
    coTriMeshFlags(handle: number): number | undefined;
    /**
     * The vertices of this triangle mesh, polyline, convex polyhedron, segment, triangle or convex polyhedron, if it is one.
     *
     * For convex polyhedra, this returns the vertices of a convex hull recomputed with
     * `try_convex_hull`, so they may differ in count and order from the points the shape
     * was built from. This guarantees the result can be used to reconstruct the shape.
     */
    coVertices(handle: number): Float32Array | undefined;
    /**
     * The volume of this collider.
     */
    coVolume(handle: number): number;
    coVoxelData(handle: number): Int32Array | undefined;
    coVoxelSize(handle: number): RawVector | undefined;
    contains(handle: number): boolean;
    createCollider(enabled: boolean, shape: RawShape, translation: RawVector, rotation: RawRotation, massPropsMode: number, mass: number, centerOfMass: RawVector, principalAngularInertia: RawVector, angularInertiaFrame: RawRotation, density: number, friction: number, restitution: number, frictionCombineRule: number, restitutionCombineRule: number, isSensor: boolean, collisionGroups: number, solverGroups: number, activeCollisionTypes: number, activeHooks: number, activeEvents: number, contactForceEventThreshold: number, contactSkin: number, hasParent: boolean, parent: number, bodies: RawRigidBodySet): number | undefined;
    /**
     * Create one immutable geometry root, independently of collider instances.
     */
    createSharedGeometry(shape: RawShape): number;
    /**
     * Applies the given JavaScript function to the integer handle of each collider managed by this collider set.
     *
     * # Parameters
     * - `f(handle)`: the function to apply to the integer handle of each collider managed by this collider set. Called as `f(handle)`.
     */
    forEachColliderHandle(f: Function): void;
    /**
     * Checks if a collider with the given integer handle exists.
     */
    isHandleValid(handle: number): boolean;
    len(): number;
    constructor();
    /**
     * Removes a collider from this set and wake-up the rigid-body it is attached to.
     */
    remove(handle: number, islands: RawIslandManager, bodies: RawRigidBodySet, wakeUp: boolean): void;
    /**
     * Retire a geometry only after its actual collider bindings have retired.
     */
    removeSharedGeometry(geometry: number): boolean;
    /**
     * Replace one geometry root; instance rows and sleeping bodies are untouched here.
     */
    replaceSharedGeometry(geometry: number, shape: RawShape): boolean;
    /**
     * Capture an existing native shape for one real collider admission, without re-uploading geometry.
     */
    sharedGeometryShape(geometry: number, scale: RawVector): RawShape | undefined;
    /**
     * Regional Terrain adoption preserves old shape captures and untouched blocks.
     */
    writeSharedHeightfield(geometry: number, indices: Uint32Array, values: Float32Array): boolean;
}

declare class RawColliderShapeCastHit {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    colliderHandle(): number;
    getComponents(scratch_buffer: Float32Array): void;
}

declare class RawContactForceEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The first collider involved in the contact.
     */
    collider1(): number;
    /**
     * The second collider involved in the contact.
     */
    collider2(): number;
    /**
     * The world-space (unit) direction of the force with strongest magnitude.
     */
    max_force_direction(scratch_buffer: Float32Array): void;
    /**
     * The magnitude of the largest force at a contact point of this contact pair.
     */
    max_force_magnitude(): number;
    /**
     * The sum of all the forces between the two colliders.
     */
    total_force(scratch_buffer: Float32Array): void;
    /**
     * The sum of the magnitudes of each force between the two colliders.
     *
     * Note that this is **not** the same as the magnitude of `self.total_force`.
     * Here we are summing the magnitude of all the forces, instead of taking
     * the magnitude of their sum.
     */
    total_force_magnitude(): number;
}

declare class RawContactManifold {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    contact_dist(i: number): number;
    contact_fid1(i: number): number;
    contact_fid2(i: number): number;
    contact_impulse(i: number): number;
    contact_local_p1(i: number, scratch_buffer: Float32Array): boolean;
    contact_local_p2(i: number, scratch_buffer: Float32Array): boolean;
    contact_tangent_impulse_x(i: number): number;
    contact_tangent_impulse_y(i: number): number;
    friction(): number;
    local_n1(scratch_buffer: Float32Array): void;
    local_n2(scratch_buffer: Float32Array): void;
    normal(scratch_buffer: Float32Array): void;
    num_contacts(): number;
    num_solver_contacts(): number;
    restitution(): number;
    solver_contact_dist(i: number): number;
    solver_contact_impulse(i: number): number;
    solver_contact_point(bodies: RawRigidBodySet, i: number, scratch_buffer: Float32Array): boolean;
    solver_contact_tangent_velocity(i: number, scratch_buffer: Float32Array): void;
    subshape1(): number;
    subshape2(): number;
}

declare class RawContactPair {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    collider1(): number;
    collider2(): number;
    contactManifold(i: number): RawContactManifold | undefined;
    has_solver_contact(flipped: boolean, filter_normal: boolean, x: number, y: number, z: number, minimum_dot: number): boolean;
    numContactManifolds(): number;
}

/**
 * The vertex/index buffers of a convex polyhedron’s convex hull.
 */
declare class RawConvexMeshData {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    indices: Uint32Array;
    vertices: Float32Array;
}

declare class RawDebugRenderPipeline {
    free(): void;
    [Symbol.dispose](): void;
    colors(): Float32Array;
    constructor();
    render(bodies: RawRigidBodySet, colliders: RawColliderSet, impulse_joints: RawImpulseJointSet, multibody_joints: RawMultibodyJointSet, narrow_phase: RawNarrowPhase, filter_flags: number, filter_predicate: Function): void;
    vertices(): Float32Array;
}

declare class RawDeserializedWorld {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    takeBodies(): RawRigidBodySet | undefined;
    takeBroadPhase(): RawBroadPhase | undefined;
    takeColliders(): RawColliderSet | undefined;
    takeGravity(): RawVector | undefined;
    takeImpulseJoints(): RawImpulseJointSet | undefined;
    takeIntegrationParameters(): RawIntegrationParameters | undefined;
    takeIslandManager(): RawIslandManager | undefined;
    takeMultibodyJoints(): RawMultibodyJointSet | undefined;
    takeNarrowPhase(): RawNarrowPhase | undefined;
}

/**
 * A structure responsible for collecting events generated
 * by the physics engine.
 */
declare class RawEventQueue {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Removes all events contained by this collector.
     */
    clear(): void;
    /**
     * Applies the given javascript closure on each collision event of this collector, then clear
     * the internal collision event buffer.
     *
     * # Parameters
     * - `f(handle1, handle2, started)`:  JavaScript closure applied to each collision event. The
     * closure should take three arguments: two integers representing the handles of the colliders
     * involved in the collision, and a boolean indicating if the collision started (true) or stopped
     * (false).
     */
    drainCollisionEvents(f: Function): void;
    drainContactForceEvents(f: Function): void;
    /**
     * Creates a new event collector.
     *
     * # Parameters
     * - `autoDrain`: setting this to `true` is strongly recommended. If true, the collector will
     * be automatically drained before each `world.step(collector)`. If false, the collector will
     * keep all events in memory unless it is manually drained/cleared; this may lead to unbounded use of
     * RAM if no drain is performed.
     */
    constructor(autoDrain: boolean);
}

declare enum RawFeatureType {
    Vertex = 0,
    Edge = 1,
    Face = 2,
    Unknown = 3,
}

declare class RawGenericJoint {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Creates a new joint descriptor that builds a Fixed joint.
     *
     * A fixed joint removes all the degrees of freedom between the affected bodies.
     */
    static fixed(anchor1: RawVector, axes1: RawRotation, anchor2: RawVector, axes2: RawRotation): RawGenericJoint;
    /**
     * Creates a new joint descriptor that builds generic joints.
     *
     * Generic joints allow arbitrary axes of freedom to be selected
     * for the joint from the available 6 degrees of freedom.
     */
    static generic(anchor1: RawVector, anchor2: RawVector, axis: RawVector, lockedAxes: number): RawGenericJoint | undefined;
    /**
     * Creates a new joint descriptor that builds a Prismatic joint.
     *
     * A prismatic joint removes all the degrees of freedom between the
     * affected bodies, except for the translation along one axis.
     *
     * Returns `None` if any of the provided axes cannot be normalized.
     */
    static prismatic(anchor1: RawVector, anchor2: RawVector, axis: RawVector, limitsEnabled: boolean, limitsMin: number, limitsMax: number): RawGenericJoint | undefined;
    /**
     * Create a new joint descriptor that builds Revolute joints.
     *
     * A revolute joint removes all degrees of freedom between the affected
     * bodies except for the rotation along one axis.
     */
    static revolute(anchor1: RawVector, anchor2: RawVector, axis: RawVector): RawGenericJoint | undefined;
    /**
     * Create a new joint descriptor that builds Revolute joints with
     * independent local axes for each attached rigid-body.
     *
     * This is equivalent to a revolute generic joint with all linear axes
     * locked and only angular X free, but it preserves the local hinge axis
     * on each body instead of assuming they are identical.
     */
    static revoluteWithAxes(anchor1: RawVector, anchor2: RawVector, axis1: RawVector, axis2: RawVector): RawGenericJoint | undefined;
    static rope(length: number, anchor1: RawVector, anchor2: RawVector): RawGenericJoint;
    /**
     * Create a new joint descriptor that builds spherical joints.
     *
     * A spherical joints allows three relative rotational degrees of freedom
     * by preventing any relative translation between the anchors of the
     * two attached rigid-bodies.
     */
    static spherical(anchor1: RawVector, anchor2: RawVector): RawGenericJoint;
    static spring(rest_length: number, stiffness: number, damping: number, anchor1: RawVector, anchor2: RawVector): RawGenericJoint;
}

declare class RawImpulseJointSet {
    free(): void;
    [Symbol.dispose](): void;
    contains(handle: number): boolean;
    createJoint(params: RawGenericJoint, parent1: number, parent2: number, wake_up: boolean): number;
    /**
     * Applies the given JavaScript function to the integer handle of each joint attached to the given rigid-body.
     *
     * # Parameters
     * - `f(handle)`: the function to apply to the integer handle of each joint attached to the rigid-body. Called as `f(collider)`.
     */
    forEachJointAttachedToRigidBody(body: number, f: Function): void;
    /**
     * Applies the given JavaScript function to the integer handle of each joint managed by this physics world.
     *
     * # Parameters
     * - `f(handle)`: the function to apply to the integer handle of each joint managed by this set. Called as `f(collider)`.
     */
    forEachJointHandle(f: Function): void;
    /**
     * The position of the second anchor of this joint.
     *
     * The second anchor gives the position of the points application point on the
     * local frame of the second rigid-body it is attached to.
     */
    jointAnchor1(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The position of the second anchor of this joint.
     *
     * The second anchor gives the position of the points application point on the
     * local frame of the second rigid-body it is attached to.
     */
    jointAnchor2(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The unique integer identifier of the first rigid-body this joint it attached to.
     */
    jointBodyHandle1(handle: number): number;
    /**
     * The unique integer identifier of the second rigid-body this joint is attached to.
     */
    jointBodyHandle2(handle: number): number;
    jointConfigureMotor(handle: number, axis: RawJointAxis, targetPos: number, targetVel: number, stiffness: number, damping: number): void;
    jointConfigureMotorModel(handle: number, axis: RawJointAxis, model: RawMotorModel): void;
    jointConfigureMotorPosition(handle: number, axis: RawJointAxis, targetPos: number, stiffness: number, damping: number): void;
    jointConfigureMotorVelocity(handle: number, axis: RawJointAxis, targetVel: number, factor: number): void;
    /**
     * Are contacts between the rigid-bodies attached by this joint enabled?
     */
    jointContactsEnabled(handle: number): boolean;
    /**
     * The angular part of the joint’s local frame relative to the first rigid-body it is attached to.
     */
    jointFrameX1(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The angular part of the joint’s local frame relative to the second rigid-body it is attached to.
     */
    jointFrameX2(handle: number, scratch_buffer: Float32Array): void;
    /**
     * Are the limits for this joint enabled?
     */
    jointLimitsEnabled(handle: number, axis: RawJointAxis): boolean;
    /**
     * If this is a prismatic joint, returns its upper limit.
     */
    jointLimitsMax(handle: number, axis: RawJointAxis): number;
    /**
     * Return the lower limit along the given joint axis.
     */
    jointLimitsMin(handle: number, axis: RawJointAxis): number;
    /**
     * Sets the position of the first local anchor
     */
    jointSetAnchor1(handle: number, newPos: RawVector): void;
    /**
     * Sets the position of the second local anchor
     */
    jointSetAnchor2(handle: number, newPos: RawVector): void;
    /**
     * Sets whether contacts are enabled between the rigid-bodies attached by this joint.
     */
    jointSetContactsEnabled(handle: number, enabled: boolean): void;
    /**
     * Sets the angular part of the joint's local frame relative to the first rigid-body.
     */
    jointSetFrameX1(handle: number, newRot: RawRotation): void;
    /**
     * Sets the angular part of the joint's local frame relative to the second rigid-body.
     */
    jointSetFrameX2(handle: number, newRot: RawRotation): void;
    /**
     * Enables and sets the joint limits
     */
    jointSetLimits(handle: number, axis: RawJointAxis, min: number, max: number): void;
    /**
     * Sets the full local frame (anchor + rotation) for the first rigid-body attachment.
     */
    jointSetLocalFrame1(handle: number, anchor: RawVector, rot: RawRotation): void;
    /**
     * Sets the full local frame (anchor + rotation) for the second rigid-body attachment.
     */
    jointSetLocalFrame2(handle: number, anchor: RawVector, rot: RawRotation): void;
    jointSetMotorMaxForce(handle: number, axis: RawJointAxis, maxForce: number): void;
    /**
     * The type of this joint.
     */
    jointType(handle: number): RawJointType;
    len(): number;
    constructor();
    remove(handle: number, wakeUp: boolean): void;
}

declare class RawIntegrationParameters {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    readonly contact_erp: number;
    dt: number;
    lengthUnit: number;
    maxCcdSubsteps: number;
    normalizedAllowedLinearError: number;
    normalizedPredictionDistance: number;
    numInternalPgsIterations: number;
    numSolverIterations: number;
    set contact_natural_frequency(value: number);
}

declare class RawIslandManager {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Applies the given JavaScript function to the integer handle of each active rigid-body
     * managed by this island manager.
     *
     * After a short time of inactivity, a rigid-body is automatically deactivated ("asleep") by
     * the physics engine in order to save computational power. A sleeping rigid-body never moves
     * unless it is moved manually by the user.
     *
     * # Parameters
     * - `f(handle)`: the function to apply to the integer handle of each active rigid-body managed by this
     *   set. Called as `f(collider)`.
     */
    forEachActiveRigidBodyHandle(f: Function): void;
    constructor();
}

declare enum RawJointAxis {
    LinX = 0,
    LinY = 1,
    LinZ = 2,
    AngX = 3,
    AngY = 4,
    AngZ = 5,
}

declare enum RawJointType {
    Revolute = 0,
    Fixed = 1,
    Prismatic = 2,
    Rope = 3,
    Spring = 4,
    Spherical = 5,
    Generic = 6,
}

declare enum RawMotorModel {
    AccelerationBased = 0,
    ForceBased = 1,
}

declare class RawMultibodyJointSet {
    free(): void;
    [Symbol.dispose](): void;
    contains(handle: number): boolean;
    createJoint(params: RawGenericJoint, parent1: number, parent2: number, wakeUp: boolean): number;
    /**
     * Applies the given JavaScript function to the integer handle of each joint attached to the given rigid-body.
     *
     * # Parameters
     * - `f(handle)`: the function to apply to the integer handle of each joint attached to the rigid-body. Called as `f(collider)`.
     */
    forEachJointAttachedToRigidBody(body: number, f: Function): void;
    /**
     * Applies the given JavaScript function to the integer handle of each joint managed by this physics world.
     *
     * # Parameters
     * - `f(handle)`: the function to apply to the integer handle of each joint managed by this set. Called as `f(collider)`.
     */
    forEachJointHandle(f: Function): void;
    /**
     * The position of the first anchor of this joint.
     *
     * The first anchor gives the position of the points application point on the
     * local frame of the first rigid-body it is attached to.
     */
    jointAnchor1(handle: number): RawVector;
    /**
     * The position of the second anchor of this joint.
     *
     * The second anchor gives the position of the points application point on the
     * local frame of the second rigid-body it is attached to.
     */
    jointAnchor2(handle: number): RawVector;
    /**
     * Are contacts between the rigid-bodies attached by this joint enabled?
     */
    jointContactsEnabled(handle: number): boolean;
    /**
     * The angular part of the joint’s local frame relative to the first rigid-body it is attached to.
     */
    jointFrameX1(handle: number): RawRotation;
    /**
     * The angular part of the joint’s local frame relative to the second rigid-body it is attached to.
     */
    jointFrameX2(handle: number): RawRotation;
    /**
     * Are the limits for this joint enabled?
     */
    jointLimitsEnabled(handle: number, axis: RawJointAxis): boolean;
    /**
     * If this is a prismatic joint, returns its upper limit.
     */
    jointLimitsMax(handle: number, axis: RawJointAxis): number;
    /**
     * Return the lower limit along the given joint axis.
     */
    jointLimitsMin(handle: number, axis: RawJointAxis): number;
    /**
     * Sets whether contacts are enabled between the rigid-bodies attached by this joint.
     */
    jointSetContactsEnabled(handle: number, enabled: boolean): void;
    /**
     * The type of this joint.
     */
    jointType(handle: number): RawJointType;
    constructor();
    remove(handle: number, wakeUp: boolean): void;
}

declare class RawNarrowPhase {
    free(): void;
    [Symbol.dispose](): void;
    contact_pair(handle1: number, handle2: number, solver: boolean): RawContactPair | undefined;
    contact_pairs_with(handle1: number, f: Function): void;
    intersection_pair(handle1: number, handle2: number): boolean;
    intersection_pairs_with(handle1: number, f: Function): void;
    constructor();
}

declare class RawPhysicsPipeline {
    free(): void;
    [Symbol.dispose](): void;
    is_profiler_enabled(): boolean;
    constructor();
    set_profiler_enabled(enabled: boolean): void;
    step(gravity: RawVector, integrationParameters: RawIntegrationParameters, islands: RawIslandManager, broadPhase: RawBroadPhase, narrowPhase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, joints: RawImpulseJointSet, articulations: RawMultibodyJointSet, ccd_solver: RawCCDSolver): void;
    stepWithEvents(gravity: RawVector, integrationParameters: RawIntegrationParameters, islands: RawIslandManager, broadPhase: RawBroadPhase, narrowPhase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, joints: RawImpulseJointSet, articulations: RawMultibodyJointSet, ccd_solver: RawCCDSolver, eventQueue: RawEventQueue, hookObject: object, hookFilterContactPair?: Function | null, hookFilterIntersectionPair?: Function | null): void;
    timing_broad_phase(): number;
    timing_ccd(): number;
    timing_ccd_broad_phase(): number;
    timing_ccd_narrow_phase(): number;
    timing_ccd_solver(): number;
    timing_ccd_toi_computation(): number;
    timing_collision_detection(): number;
    timing_island_construction(): number;
    timing_narrow_phase(): number;
    timing_solver(): number;
    timing_step(): number;
    timing_user_changes(): number;
    timing_velocity_assembly(): number;
    timing_velocity_resolution(): number;
    timing_velocity_update(): number;
    timing_velocity_writeback(): number;
}

declare class RawPointColliderProjection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    colliderHandle(): number;
    featureId(): number | undefined;
    featureType(): RawFeatureType;
    isInside(): boolean;
    /**
     * Writes the projected point components into the given scratch buffer.
     */
    point(scratch_buffer: Float32Array): void;
}

declare class RawPointProjection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    isInside(): boolean;
    /**
     * Writes the projected point components into the given scratch buffer.
     */
    point(scratch_buffer: Float32Array): void;
}

declare class RawRayColliderHit {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    colliderHandle(): number;
    timeOfImpact(): number;
}

declare class RawRayColliderIntersection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    colliderHandle(): number;
    featureId(): number | undefined;
    featureType(): RawFeatureType;
    /**
     * Writes the hit normal components into the given scratch buffer.
     */
    normal(scratch_buffer: Float32Array): void;
    time_of_impact(): number;
}

declare class RawRayIntersection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    featureId(): number | undefined;
    featureType(): RawFeatureType;
    /**
     * Writes the hit normal components into the given scratch buffer.
     */
    normal(scratch_buffer: Float32Array): void;
    time_of_impact(): number;
}

declare class RawRigidBodySet {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Checks if a rigid-body with the given integer handle exists.
     */
    contains(handle: number): boolean;
    createRigidBody(enabled: boolean, translation: RawVector, rotation: RawRotation, gravityScale: number, mass: number, massOnly: boolean, centerOfMass: RawVector, linvel: RawVector, angvel: RawVector, principalAngularInertia: RawVector, angularInertiaFrame: RawRotation, translationEnabledX: boolean, translationEnabledY: boolean, translationEnabledZ: boolean, rotationEnabledX: boolean, rotationEnabledY: boolean, rotationEnabledZ: boolean, linearDamping: number, angularDamping: number, rb_type: RawRigidBodyType, canSleep: boolean, sleeping: boolean, softCcdPrediction: number, ccdEnabled: boolean, dominanceGroup: number, additional_solver_iterations: number): number;
    /**
     * Applies the given JavaScript function to the integer handle of each rigid-body managed by this set.
     *
     * # Parameters
     * - `f(handle)`: the function to apply to the integer handle of each rigid-body managed by this set. Called as `f(collider)`.
     */
    forEachRigidBodyHandle(f: Function): void;
    /**
     * The number of rigid-bodies on this set.
     */
    len(): number;
    constructor();
    propagateModifiedBodyPositionsToColliders(colliders: RawColliderSet): void;
    /**
     * Adds a force at the center-of-mass of this rigid-body.
     *
     * # Parameters
     * - `force`: the world-space force to apply on the rigid-body.
     * - `wakeUp`: should the rigid-body be automatically woken-up?
     */
    rbAddForce(handle: number, force: RawVector, wakeUp: boolean): void;
    /**
     * Adds a force at the given world-space point of this rigid-body.
     *
     * # Parameters
     * - `force`: the world-space force to apply on the rigid-body.
     * - `point`: the world-space point where the impulse is to be applied on the rigid-body.
     * - `wakeUp`: should the rigid-body be automatically woken-up?
     */
    rbAddForceAtPoint(handle: number, force: RawVector, point: RawVector, wakeUp: boolean): void;
    /**
     * Adds a torque at the center-of-mass of this rigid-body.
     *
     * # Parameters
     * - `torque`: the world-space torque to apply on the rigid-body.
     * - `wakeUp`: should the rigid-body be automatically woken-up?
     */
    rbAddTorque(handle: number, torque: RawVector, wakeUp: boolean): void;
    rbAdditionalSolverIterations(handle: number): number;
    /**
     * The angular damping coefficient of this rigid-body.
     */
    rbAngularDamping(handle: number): number;
    /**
     * The angular velocity of this rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbAngvel(handle: number, scratch_buffer: Float32Array): void;
    /**
     * Applies an impulse at the center-of-mass of this rigid-body.
     *
     * # Parameters
     * - `impulse`: the world-space impulse to apply on the rigid-body.
     * - `wakeUp`: should the rigid-body be automatically woken-up?
     */
    rbApplyImpulse(handle: number, impulse: RawVector, wakeUp: boolean): void;
    /**
     * Applies an impulse at the given world-space point of this rigid-body.
     *
     * # Parameters
     * - `impulse`: the world-space impulse to apply on the rigid-body.
     * - `point`: the world-space point where the impulse is to be applied on the rigid-body.
     * - `wakeUp`: should the rigid-body be automatically woken-up?
     */
    rbApplyImpulseAtPoint(handle: number, impulse: RawVector, point: RawVector, wakeUp: boolean): void;
    /**
     * Applies an impulsive torque at the center-of-mass of this rigid-body.
     *
     * # Parameters
     * - `torque impulse`: the world-space torque impulse to apply on the rigid-body.
     * - `wakeUp`: should the rigid-body be automatically woken-up?
     */
    rbApplyTorqueImpulse(handle: number, torque_impulse: RawVector, wakeUp: boolean): void;
    /**
     * The status of this rigid-body: fixed, dynamic, or kinematic.
     */
    rbBodyType(handle: number): RawRigidBodyType;
    /**
     * Retrieves the `i-th` collider attached to this rigid-body.
     *
     * # Parameters
     * - `at`: The index of the collider to retrieve. Must be a number in `[0, this.numColliders()[`.
     *         This index is **not** the same as the unique identifier of the collider.
     */
    rbCollider(handle: number, at: number): number;
    rbDominanceGroup(handle: number): number;
    /**
     * The effective world-space angular inertia (that takes the potential rotation locking into account) of
     * this rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbEffectiveAngularInertia(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The inverse mass taking into account translation locking.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbEffectiveInvMass(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The world-space inverse angular inertia tensor of the rigid-body,
     * taking into account rotation locking.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbEffectiveWorldInvInertia(handle: number, scratch_buffer: Float32Array): void;
    rbEnableCcd(handle: number, enabled: boolean): void;
    rbGravityScale(handle: number): number;
    /**
     * The inverse of the mass of a rigid-body.
     *
     * If this is zero, the rigid-body is assumed to have infinite mass.
     */
    rbInvMass(handle: number): number;
    /**
     * The inverse of the principal angular inertia of the rigid-body.
     *
     * Components set to zero are assumed to be infinite along the corresponding principal axis.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbInvPrincipalInertia(handle: number, scratch_buffer: Float32Array): void;
    /**
     * Is Continuous Collision Detection enabled for this rigid-body?
     */
    rbIsCcdEnabled(handle: number): boolean;
    /**
     * Is this rigid-body dynamic?
     */
    rbIsDynamic(handle: number): boolean;
    rbIsEnabled(handle: number): boolean;
    /**
     * Is this rigid-body fixed?
     */
    rbIsFixed(handle: number): boolean;
    /**
     * Is this rigid-body kinematic?
     */
    rbIsKinematic(handle: number): boolean;
    /**
     * Is the velocity of this rigid-body not zero?
     */
    rbIsMoving(handle: number): boolean;
    /**
     * Is this rigid-body sleeping?
     */
    rbIsSleeping(handle: number): boolean;
    /**
     * The linear damping coefficient of this rigid-body.
     */
    rbLinearDamping(handle: number): number;
    /**
     * The linear velocity of this rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbLinvel(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The center of mass of a rigid-body expressed in its local-space.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbLocalCom(handle: number, scratch_buffer: Float32Array): void;
    rbLockRotations(handle: number, locked: boolean, wake_up: boolean): void;
    rbLockTranslations(handle: number, locked: boolean, wake_up: boolean): void;
    /**
     * The mass of this rigid-body.
     */
    rbMass(handle: number): number;
    /**
     * The world-space predicted orientation of this rigid-body.
     *
     * If this rigid-body is kinematic this value is set by the `setNextKinematicRotation`
     * method and is used for estimating the kinematic body velocity at the next timestep.
     * For non-kinematic bodies, this value is currently unspecified.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbNextRotation(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The world-space predicted translation of this rigid-body.
     *
     * If this rigid-body is kinematic this value is set by the `setNextKinematicTranslation`
     * method and is used for estimating the kinematic body velocity at the next timestep.
     * For non-kinematic bodies, this value is currently unspecified.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbNextTranslation(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The number of colliders attached to this rigid-body.
     */
    rbNumColliders(handle: number): number;
    /**
     * The angular inertia along the principal inertia axes of the rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbPrincipalInertia(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The principal vectors of the local angular inertia tensor of the rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbPrincipalInertiaLocalFrame(handle: number, scratch_buffer: Float32Array): void;
    rbRecomputeMassPropertiesFromColliders(handle: number, colliders: RawColliderSet): void;
    /**
     * Resets to zero all user-added forces added to this rigid-body.
     */
    rbResetForces(handle: number, wakeUp: boolean): void;
    /**
     * Resets to zero all user-added torques added to this rigid-body.
     */
    rbResetTorques(handle: number, wakeUp: boolean): void;
    /**
     * The world-space orientation of this rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbRotation(handle: number, scratch_buffer: Float32Array): void;
    rbSetAdditionalMass(handle: number, mass: number, wake_up: boolean): void;
    rbSetAdditionalMassProperties(handle: number, mass: number, centerOfMass: RawVector, principalAngularInertia: RawVector, angularInertiaFrame: RawRotation, wake_up: boolean): void;
    rbSetAdditionalSolverIterations(handle: number, iters: number): void;
    rbSetAngularDamping(handle: number, factor: number): void;
    /**
     * Sets the angular velocity of this rigid-body.
     */
    rbSetAngvel(handle: number, angvel: RawVector, wakeUp: boolean): void;
    /**
     * Set a new status for this rigid-body: fixed, dynamic, or kinematic.
     */
    rbSetBodyType(handle: number, status: RawRigidBodyType, wake_up: boolean): void;
    rbSetDominanceGroup(handle: number, group: number): void;
    rbSetEnabled(handle: number, enabled: boolean): void;
    rbSetEnabledRotations(handle: number, allow_x: boolean, allow_y: boolean, allow_z: boolean, wake_up: boolean): void;
    rbSetEnabledTranslations(handle: number, allow_x: boolean, allow_y: boolean, allow_z: boolean, wake_up: boolean): void;
    rbSetGravityScale(handle: number, factor: number, wakeUp: boolean): void;
    rbSetLinearDamping(handle: number, factor: number): void;
    /**
     * Sets the linear velocity of this rigid-body.
     */
    rbSetLinvel(handle: number, linvel: RawVector, wakeUp: boolean): void;
    /**
     * If this rigid body is kinematic, sets its future rotation after the next timestep integration.
     *
     * This should be used instead of `rigidBody.setRotation` to make the dynamic object
     * interacting with this kinematic body behave as expected. Internally, Rapier will compute
     * an artificial velocity for this rigid-body from its current position and its next kinematic
     * position. This velocity will be used to compute forces on dynamic bodies interacting with
     * this body.
     *
     * # Parameters
     * - `x`: the first vector component of the quaternion.
     * - `y`: the second vector component of the quaternion.
     * - `z`: the third vector component of the quaternion.
     * - `w`: the scalar component of the quaternion.
     */
    rbSetNextKinematicRotation(handle: number, x: number, y: number, z: number, w: number): void;
    /**
     * If this rigid body is kinematic, sets its future translation after the next timestep integration.
     *
     * This should be used instead of `rigidBody.setTranslation` to make the dynamic object
     * interacting with this kinematic body behave as expected. Internally, Rapier will compute
     * an artificial velocity for this rigid-body from its current position and its next kinematic
     * position. This velocity will be used to compute forces on dynamic bodies interacting with
     * this body.
     *
     * # Parameters
     * - `x`: the world-space position of the rigid-body along the `x` axis.
     * - `y`: the world-space position of the rigid-body along the `y` axis.
     * - `z`: the world-space position of the rigid-body along the `z` axis.
     */
    rbSetNextKinematicTranslation(handle: number, x: number, y: number, z: number): void;
    /**
     * Sets the rotation quaternion of this rigid-body.
     *
     * This does nothing if a zero quaternion is provided.
     *
     * # Parameters
     * - `x`: the first vector component of the quaternion.
     * - `y`: the second vector component of the quaternion.
     * - `z`: the third vector component of the quaternion.
     * - `w`: the scalar component of the quaternion.
     * - `wakeUp`: forces the rigid-body to wake-up so it is properly affected by forces if it
     * wasn't moving before modifying its position.
     */
    rbSetRotation(handle: number, x: number, y: number, z: number, w: number, wakeUp: boolean): void;
    rbSetSoftCcdPrediction(handle: number, prediction: number): void;
    /**
     * Sets the translation of this rigid-body.
     *
     * # Parameters
     * - `x`: the world-space position of the rigid-body along the `x` axis.
     * - `y`: the world-space position of the rigid-body along the `y` axis.
     * - `z`: the world-space position of the rigid-body along the `z` axis.
     * - `wakeUp`: forces the rigid-body to wake-up so it is properly affected by forces if it
     * wasn't moving before modifying its position.
     */
    rbSetTranslation(handle: number, x: number, y: number, z: number, wakeUp: boolean): void;
    /**
     * Sets the user-defined 32-bit integer of this rigid-body.
     *
     * # Parameters
     * - `data`: an arbitrary user-defined 32-bit integer.
     */
    rbSetUserData(handle: number, data: number): void;
    /**
     * Put the given rigid-body to sleep.
     */
    rbSleep(handle: number): void;
    rbSoftCcdPrediction(handle: number): number;
    /**
     * The world-space translation of this rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbTranslation(handle: number, scratch_buffer: Float32Array): void;
    /**
     * An arbitrary user-defined 32-bit integer
     */
    rbUserData(handle: number): number;
    /**
     * Retrieves the constant force(s) the user added to this rigid-body.
     * Returns zero if the rigid-body is not dynamic.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbUserForce(handle: number, scratch_buffer: Float32Array): void;
    /**
     * Retrieves the constant torque(s) the user added to this rigid-body.
     * Returns zero if the rigid-body is not dynamic.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbUserTorque(handle: number, scratch_buffer: Float32Array): void;
    /**
     * The velocity of the given world-space point on this rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbVelocityAtPoint(handle: number, point: RawVector, scratch_buffer: Float32Array): void;
    /**
     * Wakes this rigid-body up.
     *
     * A dynamic rigid-body that does not move during several consecutive frames will
     * be put to sleep by the physics engine, i.e., it will stop being simulated in order
     * to avoid useless computations.
     * This method forces a sleeping rigid-body to wake-up. This is useful, e.g., before modifying
     * the position of a dynamic body so that it is properly simulated afterwards.
     */
    rbWakeUp(handle: number): void;
    /**
     * The world-space center of mass of the rigid-body.
     *
     * # Parameters
     * - `scratch_buffer`: The array to be populated.
     */
    rbWorldCom(handle: number, scratch_buffer: Float32Array): void;
    remove(handle: number, islands: RawIslandManager, colliders: RawColliderSet, joints: RawImpulseJointSet, articulations: RawMultibodyJointSet): void;
}

declare enum RawRigidBodyType {
    Dynamic = 0,
    Fixed = 1,
    KinematicPositionBased = 2,
    KinematicVelocityBased = 3,
}

/**
 * A rotation quaternion.
 */
declare class RawRotation {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The identity quaternion.
     */
    static identity(): RawRotation;
    constructor(x: number, y: number, z: number, w: number);
    /**
     * The `w` component of this quaternion.
     */
    readonly w: number;
    /**
     * The `x` component of this quaternion.
     */
    readonly x: number;
    /**
     * The `y` component of this quaternion.
     */
    readonly y: number;
    /**
     * The `z` component of this quaternion.
     */
    readonly z: number;
}

declare class RawSdpMatrix3 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Row major list of the upper-triangular part of the symmetric matrix.
     */
    elements(): Float32Array;
}

declare class RawSerializationPipeline {
    free(): void;
    [Symbol.dispose](): void;
    deserializeAll(data: Uint8Array): RawDeserializedWorld | undefined;
    constructor();
    serializeAll(gravity: RawVector, integrationParameters: RawIntegrationParameters, islands: RawIslandManager, broadPhase: RawBroadPhase, narrowPhase: RawNarrowPhase, bodies: RawRigidBodySet, colliders: RawColliderSet, impulse_joints: RawImpulseJointSet, multibody_joints: RawMultibodyJointSet): Uint8Array | undefined;
}

declare class RawShape {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static ball(radius: number): RawShape;
    static capsule(halfHeight: number, radius: number): RawShape;
    castRay(shapePos: RawVector, shapeRot: RawRotation, rayOrig: RawVector, rayDir: RawVector, maxToi: number, solid: boolean): number;
    castRayAndGetNormal(shapePos: RawVector, shapeRot: RawRotation, rayOrig: RawVector, rayDir: RawVector, maxToi: number, solid: boolean): RawRayIntersection | undefined;
    castShape(shapePos1: RawVector, shapeRot1: RawRotation, shapeVel1: RawVector, shape2: RawShape, shapePos2: RawVector, shapeRot2: RawRotation, shapeVel2: RawVector, target_distance: number, maxToi: number, stop_at_penetration: boolean): RawShapeCastHit | undefined;
    static compound(shapes: RawShape[], positions: Float32Array, rotations: Float32Array): RawShape;
    compoundLen(): number | undefined;
    compoundRotation(index: number): RawRotation | undefined;
    compoundShape(index: number): RawShape | undefined;
    compoundTranslation(index: number): RawVector | undefined;
    static cone(halfHeight: number, radius: number): RawShape;
    contactShape(shapePos1: RawVector, shapeRot1: RawRotation, shape2: RawShape, shapePos2: RawVector, shapeRot2: RawRotation, prediction: number): RawShapeContact | undefined;
    containsPoint(shapePos: RawVector, shapeRot: RawRotation, point: RawVector): boolean;
    static convexDecomposition(vertices: Float32Array, indices: Uint32Array): RawShape | undefined;
    static convexDecompositionWithParams(vertices: Float32Array, indices: Uint32Array, params: RawVHACDParameters): RawShape | undefined;
    static convexHull(points: Float32Array): RawShape | undefined;
    static convexMesh(vertices: Float32Array, indices: Uint32Array): RawShape | undefined;
    /**
     * The vertices and indices of the convex hull of this convex polyhedron, recomputed
     * with `try_convex_hull` so that the result can always be fed back to
     * `RawShape::convexMesh`.
     *
     * This computes the convex hull only once, unlike calling both `vertices()` and
     * `indices()`.
     */
    convexMeshData(): RawConvexMeshData | undefined;
    static cuboid(hx: number, hy: number, hz: number): RawShape;
    static cylinder(halfHeight: number, radius: number): RawShape;
    halfExtents(): RawVector | undefined;
    halfHeight(): number | undefined;
    static halfspace(normal: RawVector): RawShape;
    halfspaceNormal(): RawVector | undefined;
    heightFieldFlags(): number | undefined;
    static heightfield(nrows: number, ncols: number, heights: Float32Array, scale: RawVector, flags: number): RawShape;
    heightfieldHeights(): Float32Array | undefined;
    heightfieldNCols(): number | undefined;
    heightfieldNRows(): number | undefined;
    heightfieldScale(): RawVector | undefined;
    indices(): Uint32Array | undefined;
    intersectsRay(shapePos: RawVector, shapeRot: RawRotation, rayOrig: RawVector, rayDir: RawVector, maxToi: number): boolean;
    intersectsShape(shapePos1: RawVector, shapeRot1: RawRotation, shape2: RawShape, shapePos2: RawVector, shapeRot2: RawRotation): boolean;
    static polyline(vertices: Float32Array, indices: Uint32Array): RawShape;
    projectPoint(shapePos: RawVector, shapeRot: RawRotation, point: RawVector, solid: boolean): RawPointProjection;
    radius(): number | undefined;
    static roundCone(halfHeight: number, radius: number, borderRadius: number): RawShape;
    static roundConvexHull(points: Float32Array, borderRadius: number): RawShape | undefined;
    static roundConvexMesh(vertices: Float32Array, indices: Uint32Array, borderRadius: number): RawShape | undefined;
    static roundCuboid(hx: number, hy: number, hz: number, borderRadius: number): RawShape;
    static roundCylinder(halfHeight: number, radius: number, borderRadius: number): RawShape;
    roundRadius(): number | undefined;
    static roundTriangle(p1: RawVector, p2: RawVector, p3: RawVector, borderRadius: number): RawShape;
    static segment(p1: RawVector, p2: RawVector): RawShape;
    shapeType(): RawShapeType;
    triMeshFlags(): number | undefined;
    static triangle(p1: RawVector, p2: RawVector, p3: RawVector): RawShape;
    static trimesh(vertices: Float32Array, indices: Uint32Array, flags: number): RawShape | undefined;
    /**
     * The vertices of this shape, if it is vertex-based.
     *
     * For convex polyhedra, this returns the vertices of a convex hull recomputed with
     * `try_convex_hull` (so they may differ in count and order from the points the shape
     * was built from), ensuring the result can be fed back to `RawShape::convexMesh`.
     * If both `vertices` and `indices` are needed, prefer `convexMeshData` which computes
     * the convex hull only once.
     */
    vertices(): Float32Array | undefined;
    voxelData(): Int32Array | undefined;
    static voxelRegions(voxel_size: RawVector, regions: Int32Array): RawShape;
    voxelSize(): RawVector | undefined;
    static voxels(voxel_size: RawVector, grid_coords: Int32Array): RawShape;
    static voxelsFromPoints(voxel_size: RawVector, points: Float32Array): RawShape;
}

declare class RawShapeCastHit {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    getComponents(scratch_buffer: Float32Array): void;
}

declare class RawShapeContact {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Writes the contact components into the given scratch buffer.
     *
     * Layout: `[distance, point1, point2, normal1, normal2]`.
     */
    getComponents(scratch_buffer: Float32Array): void;
}

declare enum RawShapeType {
    Ball = 0,
    Cuboid = 1,
    Capsule = 2,
    Segment = 3,
    Polyline = 4,
    Triangle = 5,
    TriMesh = 6,
    HeightField = 7,
    Compound = 8,
    ConvexPolyhedron = 9,
    Cylinder = 10,
    Cone = 11,
    RoundCuboid = 12,
    RoundTriangle = 13,
    RoundCylinder = 14,
    RoundCone = 15,
    RoundConvexPolyhedron = 16,
    HalfSpace = 17,
    Voxels = 18,
}

/**
 * Parameters for VHACD convex decomposition algorithm
 */
declare class RawVHACDParameters {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    alpha: number;
    beta: number;
    concavity: number;
    convex_hull_approximation: boolean;
    convex_hull_downsampling: number;
    max_convex_hulls: number;
    plane_downsampling: number;
    resolution: number;
}

/**
 * A vector.
 */
declare class RawVector {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Creates a new 3D vector from its two components.
     *
     * # Parameters
     * - `x`: the `x` component of this 3D vector.
     * - `y`: the `y` component of this 3D vector.
     * - `z`: the `z` component of this 3D vector.
     */
    constructor(x: number, y: number, z: number);
    /**
     * Create a new 3D vector from this vector with its components rearranged as `{x, y, z}`.
     *
     * This will effectively return a copy of `this`. This method exist for completeness with the
     * other swizzling functions.
     */
    xyz(): RawVector;
    /**
     * Create a new 3D vector from this vector with its components rearranged as `{x, z, y}`.
     */
    xzy(): RawVector;
    /**
     * Create a new 3D vector from this vector with its components rearranged as `{y, x, z}`.
     */
    yxz(): RawVector;
    /**
     * Create a new 3D vector from this vector with its components rearranged as `{y, z, x}`.
     */
    yzx(): RawVector;
    /**
     * Creates a new vector filled with zeros.
     */
    static zero(): RawVector;
    /**
     * Create a new 3D vector from this vector with its components rearranged as `{z, x, y}`.
     */
    zxy(): RawVector;
    /**
     * Create a new 3D vector from this vector with its components rearranged as `{z, y, x}`.
     */
    zyx(): RawVector;
    /**
     * The `x` component of this vector.
     */
    x: number;
    /**
     * The `y` component of this vector.
     */
    y: number;
    /**
     * The `z` component of this vector.
     */
    z: number;
}

declare const scratchBuffer: Float32Array<ArrayBuffer>;
interface Vector {
    x: number;
    y: number;
    z: number;
}
/**
 * A 3D vector.
 */
declare class Vector3 implements Vector {
    x: number;
    y: number;
    z: number;
    constructor(x: number, y: number, z: number);
}
declare class VectorOps {
    static new(x: number, y: number, z: number): Vector;
    static intoRaw(v: Vector): RawVector;
    static zeros(): Vector;
    static fromBuffer(buffer: Float32Array, target?: Vector): Vector;
    static fromRaw(raw: RawVector): Vector;
    static copy(out: Vector, input: Vector): void;
}
interface Rotation {
    x: number;
    y: number;
    z: number;
    w: number;
}
/**
 * A quaternion.
 */
declare class Quaternion implements Rotation {
    x: number;
    y: number;
    z: number;
    w: number;
    constructor(x: number, y: number, z: number, w: number);
}
declare class RotationOps {
    static identity(): Rotation;
    static fromBuffer(buffer: Float32Array, target?: Rotation): Rotation;
    static fromRaw(raw: RawRotation): Rotation;
    static intoRaw(rot: Rotation): RawRotation;
    static copy(out: Rotation, input: Rotation): void;
}
/**
 * A 3D symmetric-positive-definite matrix.
 */
declare class SdpMatrix3 {
    /**
     * Row major list of the upper-triangular part of the symmetric matrix.
     */
    elements: Float32Array;
    /**
     * Matrix element at row 1, column 1.
     */
    get m11(): number;
    /**
     * Matrix element at row 1, column 2.
     */
    get m12(): number;
    /**
     * Matrix element at row 2, column 1.
     */
    get m21(): number;
    /**
     * Matrix element at row 1, column 3.
     */
    get m13(): number;
    /**
     * Matrix element at row 3, column 1.
     */
    get m31(): number;
    /**
     * Matrix element at row 2, column 2.
     */
    get m22(): number;
    /**
     * Matrix element at row 2, column 3.
     */
    get m23(): number;
    /**
     * Matrix element at row 3, column 2.
     */
    get m32(): number;
    /**
     * Matrix element at row 3, column 3.
     */
    get m33(): number;
    constructor(elements: Float32Array);
}
declare class SdpMatrix3Ops {
    static fromBuffer(buffer: Float32Array, target?: SdpMatrix3): SdpMatrix3;
    static fromRaw(raw: RawSdpMatrix3): SdpMatrix3;
}

/**
 * The contact info between two shapes.
 */
declare class ShapeContact {
    /**
     * Distance between the two contact points.
     * If this is negative, this contact represents a penetration.
     */
    distance: number;
    /**
     * Position of the contact on the first shape.
     */
    point1: Vector;
    /**
     * Position of the contact on the second shape.
     */
    point2: Vector;
    /**
     * Contact normal, pointing towards the exterior of the first shape.
     */
    normal1: Vector;
    /**
     * Contact normal, pointing towards the exterior of the second shape.
     * If these contact data are expressed in world-space, this normal is equal to -normal1.
     */
    normal2: Vector;
    constructor(dist: number, point1: Vector, point2: Vector, normal1: Vector, normal2: Vector);
    /**
     * @param raw - The raw contact returned by the WASM query. It is freed by this method.
     * @param target - If provided, this object is populated and returned instead of
     * allocating a new one.
     */
    static fromBuffer(raw: RawShapeContact, target?: ShapeContact): ShapeContact;
}

/**
 * Flags indicating what events are enabled for colliders.
 */
declare enum ActiveEvents {
    NONE = 0,
    /**
     * Enable collision events.
     */
    COLLISION_EVENTS = 1,
    /**
     * Enable contact force events.
     */
    CONTACT_FORCE_EVENTS = 2
}
/**
 * Event occurring when the sum of the magnitudes of the
 * contact forces between two colliders exceed a threshold.
 *
 * This object should **not** be stored anywhere. Its properties can only be
 * read from within the closure given to `EventHandler.drainContactForceEvents`.
 */
declare class TempContactForceEvent {
    raw: RawContactForceEvent;
    free(): void;
    /**
     * The first collider involved in the contact.
     */
    collider1(): ColliderHandle;
    /**
     * The second collider involved in the contact.
     */
    collider2(): ColliderHandle;
    /**
     * The sum of all the forces between the two colliders.
     */
    totalForce(target?: Vector): Vector;
    /**
     * The sum of the magnitudes of each force between the two colliders.
     *
     * Note that this is **not** the same as the magnitude of `self.total_force`.
     * Here we are summing the magnitude of all the forces, instead of taking
     * the magnitude of their sum.
     */
    totalForceMagnitude(): number;
    /**
     * The world-space (unit) direction of the force with strongest magnitude.
     */
    maxForceDirection(target?: Vector): Vector;
    /**
     * The magnitude of the largest force at a contact point of this contact pair.
     */
    maxForceMagnitude(): number;
}
/**
 * A structure responsible for collecting events generated
 * by the physics engine.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `eventQueue.free()`
 * once you are done using it.
 */
declare class EventQueue {
    raw: RawEventQueue;
    /**
     * Creates a new event collector.
     *
     * @param autoDrain -setting this to `true` is strongly recommended. If true, the collector will
     * be automatically drained before each `world.step(collector)`. If false, the collector will
     * keep all events in memory unless it is manually drained/cleared; this may lead to unbounded use of
     * RAM if no drain is performed.
     */
    constructor(autoDrain: boolean, raw?: RawEventQueue);
    /**
     * Release the WASM memory occupied by this event-queue.
     */
    free(): void;
    /**
     * Applies the given javascript closure on each collision event of this collector, then clear
     * the internal collision event buffer.
     *
     * @param f - JavaScript closure applied to each collision event. The
     * closure must take three arguments: two integers representing the handles of the colliders
     * involved in the collision, and a boolean indicating if the collision started (true) or stopped
     * (false).
     */
    drainCollisionEvents(f: (handle1: ColliderHandle, handle2: ColliderHandle, started: boolean) => void): void;
    /**
     * Applies the given javascript closure on each contact force event of this collector, then clear
     * the internal collision event buffer.
     *
     * @param f - JavaScript closure applied to each collision event. The
     *            closure must take one `TempContactForceEvent` argument.
     */
    drainContactForceEvents(f: (event: TempContactForceEvent) => void): void;
    /**
     * Removes all events contained by this collector
     */
    clear(): void;
}

declare enum ActiveHooks {
    NONE = 0,
    FILTER_CONTACT_PAIRS = 1,
    FILTER_INTERSECTION_PAIRS = 2
}
declare enum SolverFlags {
    EMPTY = 0,
    COMPUTE_IMPULSE = 1
}
interface PhysicsHooks {
    /**
     * Function that determines if contacts computation should happen between two colliders, and how the
     * constraints solver should behave for these contacts.
     *
     * This will only be executed and taken into account if at least one of the involved colliders contains the
     * `ActiveHooks.FILTER_CONTACT_PAIR` flag in its active hooks.
     *
     * @param collider1 − Handle of the first collider involved in the potential contact.
     * @param collider2 − Handle of the second collider involved in the potential contact.
     * @param body1 − Handle of the first body involved in the potential contact.
     * @param body2 − Handle of the second body involved in the potential contact.
     */
    filterContactPair(collider1: ColliderHandle, collider2: ColliderHandle, body1: RigidBodyHandle, body2: RigidBodyHandle): SolverFlags | null;
    /**
     * Function that determines if intersection computation should happen between two colliders (where at least
     * one is a sensor).
     *
     * This will only be executed and taken into account if `one of the involved colliders contains the
     * `ActiveHooks.FILTER_INTERSECTION_PAIR` flag in its active hooks.
     *
     * @param collider1 − Handle of the first collider involved in the potential contact.
     * @param collider2 − Handle of the second collider involved in the potential contact.
     * @param body1 − Handle of the first body involved in the potential contact.
     * @param body2 − Handle of the second body involved in the potential contact.
     */
    filterIntersectionPair(collider1: ColliderHandle, collider2: ColliderHandle, body1: RigidBodyHandle, body2: RigidBodyHandle): boolean;
}

declare class PhysicsPipeline {
    raw: RawPhysicsPipeline;
    free(): void;
    constructor(raw?: RawPhysicsPipeline);
    step(gravity: Vector, integrationParameters: IntegrationParameters, islands: IslandManager, broadPhase: BroadPhase, narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, impulseJoints: ImpulseJointSet, multibodyJoints: MultibodyJointSet, ccdSolver: CCDSolver, eventQueue?: EventQueue, hooks?: PhysicsHooks): void;
}

/**
 * Flags for excluding whole sets of colliders from a scene query.
 */
declare enum QueryFilterFlags {
    /**
     * Exclude from the query any collider attached to a fixed rigid-body and colliders with no rigid-body attached.
     */
    EXCLUDE_FIXED = 1,
    /**
     * Exclude from the query any collider attached to a dynamic rigid-body.
     */
    EXCLUDE_KINEMATIC = 2,
    /**
     * Exclude from the query any collider attached to a kinematic rigid-body.
     */
    EXCLUDE_DYNAMIC = 4,
    /**
     * Exclude from the query any collider that is a sensor.
     */
    EXCLUDE_SENSORS = 8,
    /**
     * Exclude from the query any collider that is not a sensor.
     */
    EXCLUDE_SOLIDS = 16,
    /**
     * Excludes all colliders not attached to a dynamic rigid-body.
     */
    ONLY_DYNAMIC = 3,
    /**
     * Excludes all colliders not attached to a kinematic rigid-body.
     */
    ONLY_KINEMATIC = 5,
    /**
     * Exclude all colliders attached to a non-fixed rigid-body
     * (this will not exclude colliders not attached to any rigid-body).
     */
    ONLY_FIXED = 6
}

/**
 * A pipeline for serializing the physics scene.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `serializationPipeline.free()`
 * once you are done using it (and all the rigid-bodies it created).
 */
declare class SerializationPipeline {
    raw: RawSerializationPipeline;
    /**
     * Release the WASM memory occupied by this serialization pipeline.
     */
    free(): void;
    constructor(raw?: RawSerializationPipeline);
    /**
     * Serialize a complete physics state into a single byte array.
     * @param gravity - The current gravity affecting the simulation.
     * @param integrationParameters - The integration parameters of the simulation.
     * @param broadPhase - The broad-phase of the simulation.
     * @param narrowPhase - The narrow-phase of the simulation.
     * @param bodies - The rigid-bodies taking part into the simulation.
     * @param colliders - The colliders taking part into the simulation.
     * @param impulseJoints - The impulse joints taking part into the simulation.
     * @param multibodyJoints - The multibody joints taking part into the simulation.
     */
    serializeAll(gravity: Vector, integrationParameters: IntegrationParameters, islands: IslandManager, broadPhase: BroadPhase, narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, impulseJoints: ImpulseJointSet, multibodyJoints: MultibodyJointSet): Uint8Array;
    /**
     * Deserialize the complete physics state from a single byte array.
     *
     * @param data - The byte array to deserialize.
     */
    deserializeAll(data: Uint8Array): World;
}

/**
 * The vertex and color buffers for debug-rendering the physics scene.
 */
declare class DebugRenderBuffers {
    /**
     * The lines to render. This is a flat array containing all the lines
     * to render. Each line is described as two consecutive point. Each
     * point is described as two (in 2D) or three (in 3D) consecutive
     * floats. For example, in 2D, the array: `[1, 2, 3, 4, 5, 6, 7, 8]`
     * describes the two segments `[[1, 2], [3, 4]]` and `[[5, 6], [7, 8]]`.
     */
    vertices: Float32Array;
    /**
     * The color buffer. There is one color per vertex, and each color
     * has four consecutive components (in RGBA format).
     */
    colors: Float32Array;
    constructor(vertices: Float32Array, colors: Float32Array);
}
/**
 * A pipeline for rendering the physics scene.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `debugRenderPipeline.free()`
 * once you are done using it (and all the rigid-bodies it created).
 */
declare class DebugRenderPipeline {
    raw: RawDebugRenderPipeline;
    vertices: Float32Array;
    colors: Float32Array;
    /**
     * Release the WASM memory occupied by this serialization pipeline.
     */
    free(): void;
    constructor(raw?: RawDebugRenderPipeline);
    render(bodies: RigidBodySet, colliders: ColliderSet, impulse_joints: ImpulseJointSet, multibody_joints: MultibodyJointSet, narrow_phase: NarrowPhase, filterFlags?: QueryFilterFlags, filterPredicate?: (collider: Collider) => boolean): void;
}

/**
 * A collision between the character and an obstacle hit on its path.
 */
declare class CharacterCollision {
    /** The collider involved in the collision. Null if the collider no longer exists in the physics world. */
    collider: Collider | null;
    /** The translation delta applied to the character before this collision took place. */
    translationDeltaApplied: Vector;
    /** The translation delta the character would move after this collision if there is no other obstacles. */
    translationDeltaRemaining: Vector;
    /** The time-of-impact between the character and the obstacles. */
    toi: number;
    /** The world-space contact point on the collider when the collision happens. */
    witness1: Vector;
    /** The local-space contact point on the character when the collision happens. */
    witness2: Vector;
    /** The world-space outward contact normal on the collider when the collision happens. */
    normal1: Vector;
    /** The local-space outward contact normal on the character when the collision happens. */
    normal2: Vector;
}
/**
 * A character controller for controlling kinematic bodies and parentless colliders by hitting
 * and sliding against obstacles.
 */
declare class KinematicCharacterController {
    private raw;
    private rawCharacterCollision;
    private params;
    private broadPhase;
    private narrowPhase;
    private bodies;
    private colliders;
    private _applyImpulsesToDynamicBodies;
    private _characterMass;
    constructor(offset: number, params: IntegrationParameters, broadPhase: BroadPhase, narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet);
    /** @internal */
    free(): void;
    /**
     * The direction that goes "up". Used to determine where the floor is, and the floor’s angle.
     */
    up(): Vector;
    /**
     * Sets the direction that goes "up". Used to determine where the floor is, and the floor’s angle.
     */
    setUp(vector: Vector): void;
    applyImpulsesToDynamicBodies(): boolean;
    setApplyImpulsesToDynamicBodies(enabled: boolean): void;
    /**
     * Returns the custom value of the character mass, if it was set by `this.setCharacterMass`.
     */
    characterMass(): number | null;
    /**
     * Set the mass of the character to be used for impulse resolution if `self.applyImpulsesToDynamicBodies`
     * is set to `true`.
     *
     * If no character mass is set explicitly (or if it is set to `null`) it is automatically assumed to be equal
     * to the mass of the rigid-body the character collider is attached to; or equal to 0 if the character collider
     * isn’t attached to any rigid-body.
     *
     * @param mass - The mass to set.
     */
    setCharacterMass(mass: number | null): void;
    /**
     * A small gap to preserve between the character and its surroundings.
     *
     * This value should not be too large to avoid visual artifacts, but shouldn’t be too small
     * (must not be zero) to improve numerical stability of the character controller.
     */
    offset(): number;
    /**
     * Sets a small gap to preserve between the character and its surroundings.
     *
     * This value should not be too large to avoid visual artifacts, but shouldn’t be too small
     * (must not be zero) to improve numerical stability of the character controller.
     */
    setOffset(value: number): void;
    normalNudgeFactor(): number;
    setNormalNudgeFactor(value: number): void;
    /**
     * Is sliding against obstacles enabled?
     */
    slideEnabled(): boolean;
    /**
     * Enable or disable sliding against obstacles.
     */
    setSlideEnabled(enabled: boolean): void;
    /**
     * The maximum step height a character can automatically step over.
     */
    autostepMaxHeight(): number | null;
    /**
     * The minimum width of free space that must be available after stepping on a stair.
     */
    autostepMinWidth(): number | null;
    /**
     * Can the character automatically step over dynamic bodies too?
     */
    autostepIncludesDynamicBodies(): boolean | null;
    /**
     * Is automatically stepping over small objects enabled?
     */
    autostepEnabled(): boolean;
    /**
     * Enabled automatically stepping over small objects.
     *
     * @param maxHeight - The maximum step height a character can automatically step over.
     * @param minWidth - The minimum width of free space that must be available after stepping on a stair.
     * @param includeDynamicBodies - Can the character automatically step over dynamic bodies too?
     */
    enableAutostep(maxHeight: number, minWidth: number, includeDynamicBodies: boolean): void;
    /**
     * Disable automatically stepping over small objects.
     */
    disableAutostep(): void;
    /**
     * The maximum angle (radians) between the floor’s normal and the `up` vector that the
     * character is able to climb.
     */
    maxSlopeClimbAngle(): number;
    /**
     * Sets the maximum angle (radians) between the floor’s normal and the `up` vector that the
     * character is able to climb.
     */
    setMaxSlopeClimbAngle(angle: number): void;
    /**
     * The minimum angle (radians) between the floor’s normal and the `up` vector before the
     * character starts to slide down automatically.
     */
    minSlopeSlideAngle(): number;
    /**
     * Sets the minimum angle (radians) between the floor’s normal and the `up` vector before the
     * character starts to slide down automatically.
     */
    setMinSlopeSlideAngle(angle: number): void;
    /**
     * If snap-to-ground is enabled, should the character be automatically snapped to the ground if
     * the distance between the ground and its feet are smaller than the specified threshold?
     */
    snapToGroundDistance(): number | null;
    /**
     * Enables automatically snapping the character to the ground if the distance between
     * the ground and its feet are smaller than the specified threshold.
     */
    enableSnapToGround(distance: number): void;
    /**
     * Disables automatically snapping the character to the ground.
     */
    disableSnapToGround(): void;
    /**
     * Is automatically snapping the character to the ground enabled?
     */
    snapToGroundEnabled(): boolean;
    /**
     * Computes the movement the given collider is able to execute after hitting and sliding on obstacles.
     *
     * @param collider - The collider to move.
     * @param desiredTranslationDelta - The desired collider movement.
     * @param filterFlags - Flags for excluding whole subsets of colliders from the obstacles taken into account.
     * @param filterGroups - Groups for excluding colliders with incompatible collision groups from the obstacles
     *                       taken into account.
     * @param filterPredicate - Any collider for which this closure returns `false` will be excluded from the
     *                          obstacles taken into account.
     */
    computeColliderMovement(collider: Collider, desiredTranslationDelta: Vector, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterPredicate?: (collider: Collider) => boolean): void;
    /**
     * The movement computed by the last call to `this.computeColliderMovement`.
     */
    computedMovement(target?: Vector): Vector;
    /**
     * The result of ground detection computed by the last call to `this.computeColliderMovement`.
     */
    computedGrounded(): boolean;
    /**
     * The number of collisions against obstacles detected along the path of the last call
     * to `this.computeColliderMovement`.
     */
    numComputedCollisions(): number;
    /**
     * Returns the collision against one of the obstacles detected along the path of the last
     * call to `this.computeColliderMovement`.
     *
     * @param i - The i-th collision will be returned.
     * @param out - If this argument is set, it will be filled with the collision information.
     */
    computedCollision(i: number, out?: CharacterCollision): CharacterCollision | null;
}

/**
 * An enum representing the possible joint axes controlled by a PidController.
 * They can be ORed together, like:
 * PidAxesMask.LinX || PidAxesMask.LinY
 * to get a pid controller that only constraints the translational X and Y axes.
 *
 * Possible axes are:
 *
 * - `X`: X translation axis
 * - `Y`: Y translation axis
 * - `Z`: Z translation axis
 * - `AngX`: X angular rotation axis (3D only)
 * - `AngY`: Y angular rotation axis (3D only)
 * - `AngZ`: Z angular rotation axis
 */
declare enum PidAxesMask {
    None = 0,
    LinX = 1,
    LinY = 2,
    LinZ = 4,
    AngX = 8,
    AngY = 16,
    AngZ = 32,
    AllLin = 7,
    AllAng = 56,
    All = 63
}
/**
 * A controller for controlling dynamic bodies using the
 * Proportional-Integral-Derivative correction model.
 */
declare class PidController {
    private raw;
    private params;
    private bodies;
    constructor(params: IntegrationParameters, bodies: RigidBodySet, kp: number, ki: number, kd: number, axes: PidAxesMask);
    /** @internal */
    free(): void;
    setKp(kp: number, axes: PidAxesMask): void;
    setKi(ki: number, axes: PidAxesMask): void;
    setKd(kd: number, axes: PidAxesMask): void;
    setAxes(axes: PidAxesMask): void;
    resetIntegrals(): void;
    applyLinearCorrection(body: RigidBody, targetPosition: Vector, targetLinvel: Vector): void;
    applyAngularCorrection(body: RigidBody, targetRotation: Rotation, targetAngVel: Vector): void;
    linearCorrection(body: RigidBody, targetPosition: Vector, targetLinvel: Vector, target?: Vector): Vector;
    angularCorrection(body: RigidBody, targetRotation: Rotation, targetAngVel: Vector, target?: Vector): Vector;
}

/**
 * A character controller to simulate vehicles using ray-casting for the wheels.
 */
declare class DynamicRayCastVehicleController {
    private raw;
    private broadPhase;
    private narrowPhase;
    private bodies;
    private colliders;
    private _chassis;
    constructor(chassis: RigidBody, broadPhase: BroadPhase, narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet);
    /** @internal */
    free(): void;
    /**
     * Updates the vehicle’s velocity based on its suspension, engine force, and brake.
     *
     * This directly updates the velocity of its chassis rigid-body.
     *
     * @param dt - Time increment used to integrate forces.
     * @param filterFlags - Flag to exclude categories of objects from the wheels’ ray-cast.
     * @param filterGroups - Only colliders compatible with these groups will be hit by the wheels’ ray-casts.
     * @param filterPredicate - Callback to filter out which collider will be hit by the wheels’ ray-casts.
     */
    updateVehicle(dt: number, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterPredicate?: (collider: Collider) => boolean): void;
    /**
     * The current forward speed of the vehicle.
     */
    currentVehicleSpeed(): number;
    /**
     * The rigid-body used as the chassis.
     */
    chassis(): RigidBody;
    /**
     * The chassis’ local _up_ direction (`0 = x, 1 = y, 2 = z`).
     */
    get indexUpAxis(): number;
    /**
     * Sets the chassis’ local _up_ direction (`0 = x, 1 = y, 2 = z`).
     */
    set indexUpAxis(axis: number);
    /**
     * The chassis’ local _forward_ direction (`0 = x, 1 = y, 2 = z`).
     */
    get indexForwardAxis(): number;
    /**
     * Sets the chassis’ local _forward_ direction (`0 = x, 1 = y, 2 = z`).
     */
    set setIndexForwardAxis(axis: number);
    /**
     * Adds a new wheel attached to this vehicle.
     * @param chassisConnectionCs  - The position of the wheel relative to the chassis.
     * @param directionCs - The direction of the wheel’s suspension, relative to the chassis. The ray-casting will
     *                      happen following this direction to detect the ground.
     * @param axleCs - The wheel’s axle axis, relative to the chassis.
     * @param suspensionRestLength - The rest length of the wheel’s suspension spring.
     * @param radius - The wheel’s radius.
     */
    addWheel(chassisConnectionCs: Vector, directionCs: Vector, axleCs: Vector, suspensionRestLength: number, radius: number): void;
    /**
     * The number of wheels attached to this vehicle.
     */
    numWheels(): number;
    /**
     * The position of the i-th wheel, relative to the chassis.
     *
     * @param {number} i
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    wheelChassisConnectionPointCs(i: number, target?: Vector): Vector | null;
    /**
     * Sets the position of the i-th wheel, relative to the chassis.
     */
    setWheelChassisConnectionPointCs(i: number, value: Vector): void;
    /**
     * The rest length of the i-th wheel’s suspension spring.
     */
    wheelSuspensionRestLength(i: number): number | null;
    /**
     * Sets the rest length of the i-th wheel’s suspension spring.
     */
    setWheelSuspensionRestLength(i: number, value: number): void;
    /**
     * The maximum distance the i-th wheel suspension can travel before and after its resting length.
     */
    wheelMaxSuspensionTravel(i: number): number | null;
    /**
     * Sets the maximum distance the i-th wheel suspension can travel before and after its resting length.
     */
    setWheelMaxSuspensionTravel(i: number, value: number): void;
    /**
     * The i-th wheel’s radius.
     */
    wheelRadius(i: number): number | null;
    /**
     * Sets the i-th wheel’s radius.
     */
    setWheelRadius(i: number, value: number): void;
    /**
     * The i-th wheel’s suspension stiffness.
     *
     * Increase this value if the suspension appears to not push the vehicle strong enough.
     */
    wheelSuspensionStiffness(i: number): number | null;
    /**
     * Sets the i-th wheel’s suspension stiffness.
     *
     * Increase this value if the suspension appears to not push the vehicle strong enough.
     */
    setWheelSuspensionStiffness(i: number, value: number): void;
    /**
     * The i-th wheel’s suspension’s damping when it is being compressed.
     */
    wheelSuspensionCompression(i: number): number | null;
    /**
     * The i-th wheel’s suspension’s damping when it is being compressed.
     */
    setWheelSuspensionCompression(i: number, value: number): void;
    /**
     * The i-th wheel’s suspension’s damping when it is being released.
     *
     * Increase this value if the suspension appears to overshoot.
     */
    wheelSuspensionRelaxation(i: number): number | null;
    /**
     * Sets the i-th wheel’s suspension’s damping when it is being released.
     *
     * Increase this value if the suspension appears to overshoot.
     */
    setWheelSuspensionRelaxation(i: number, value: number): void;
    /**
     * The maximum force applied by the i-th wheel’s suspension.
     */
    wheelMaxSuspensionForce(i: number): number | null;
    /**
     * Sets the maximum force applied by the i-th wheel’s suspension.
     */
    setWheelMaxSuspensionForce(i: number, value: number): void;
    /**
     * The maximum amount of braking impulse applied on the i-th wheel to slow down the vehicle.
     */
    wheelBrake(i: number): number | null;
    /**
     * Set the maximum amount of braking impulse applied on the i-th wheel to slow down the vehicle.
     */
    setWheelBrake(i: number, value: number): void;
    /**
     * The steering angle (radians) for the i-th wheel.
     */
    wheelSteering(i: number): number | null;
    /**
     * Sets the steering angle (radians) for the i-th wheel.
     */
    setWheelSteering(i: number, value: number): void;
    /**
     * The forward force applied by the i-th wheel on the chassis.
     */
    wheelEngineForce(i: number): number | null;
    /**
     * Sets the forward force applied by the i-th wheel on the chassis.
     */
    setWheelEngineForce(i: number, value: number): void;
    /**
     * The direction of the i-th wheel’s suspension, relative to the chassis.
     *
     * The ray-casting will happen following this direction to detect the ground.
     *
     * @param {number} i
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    wheelDirectionCs(i: number, target?: Vector): Vector | null;
    /**
     * Sets the direction of the i-th wheel’s suspension, relative to the chassis.
     *
     * The ray-casting will happen following this direction to detect the ground.
     */
    setWheelDirectionCs(i: number, value: Vector): void;
    /**
     * The i-th wheel’s axle axis, relative to the chassis.
     *
     * The axis index defined as 0 = X, 1 = Y, 2 = Z.
     *
     * @param {number} i
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    wheelAxleCs(i: number, target?: Vector): Vector | null;
    /**
     * Sets the i-th wheel’s axle axis, relative to the chassis.
     *
     * The axis index defined as 0 = X, 1 = Y, 2 = Z.
     */
    setWheelAxleCs(i: number, value: Vector): void;
    /**
     * Parameter controlling how much traction the tire has.
     *
     * The larger the value, the more instantaneous braking will happen (with the risk of
     * causing the vehicle to flip if it’s too strong).
     */
    wheelFrictionSlip(i: number): number | null;
    /**
     * Sets the parameter controlling how much traction the tire has.
     *
     * The larger the value, the more instantaneous braking will happen (with the risk of
     * causing the vehicle to flip if it’s too strong).
     */
    setWheelFrictionSlip(i: number, value: number): void;
    /**
     * The multiplier of friction between a tire and the collider it’s on top of.
     *
     * The larger the value, the stronger side friction will be.
     */
    wheelSideFrictionStiffness(i: number): number | null;
    /**
     * The multiplier of friction between a tire and the collider it’s on top of.
     *
     * The larger the value, the stronger side friction will be.
     */
    setWheelSideFrictionStiffness(i: number, value: number): void;
    /**
     *  The i-th wheel’s current rotation angle (radians) on its axle.
     */
    wheelRotation(i: number): number | null;
    /**
     *  The forward impulses applied by the i-th wheel on the chassis.
     */
    wheelForwardImpulse(i: number): number | null;
    /**
     *  The side impulses applied by the i-th wheel on the chassis.
     */
    wheelSideImpulse(i: number): number | null;
    /**
     *  The force applied by the i-th wheel suspension.
     */
    wheelSuspensionForce(i: number): number | null;
    /**
     *  The (world-space) contact normal between the i-th wheel and the floor.
     *
     * @param {number} i
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    wheelContactNormal(i: number, target?: Vector): Vector | null;
    /**
     *  The (world-space) point hit by the wheel’s ray-cast for the i-th wheel.
     *
     * @param {number} i
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    wheelContactPoint(i: number, target?: Vector): Vector | null;
    /**
     *  The suspension length for the i-th wheel.
     */
    wheelSuspensionLength(i: number): number | null;
    /**
     *  The (world-space) starting point of the ray-cast for the i-th wheel.
     *
     * @param {number} i
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    wheelHardPoint(i: number, target?: Vector): Vector | null;
    /**
     *  Is the i-th wheel in contact with the ground?
     */
    wheelIsInContact(i: number): boolean;
    /**
     *  The collider hit by the ray-cast for the i-th wheel.
     */
    wheelGroundObject(i: number): Collider | null;
}

/**
 * The physics world.
 *
 * This contains all the data-structures necessary for creating and simulating
 * bodies with contacts, joints, and external forces.
 */
declare class World {
    gravity: Vector;
    integrationParameters: IntegrationParameters;
    islands: IslandManager;
    broadPhase: BroadPhase;
    narrowPhase: NarrowPhase;
    bodies: RigidBodySet;
    colliders: ColliderSet;
    impulseJoints: ImpulseJointSet;
    multibodyJoints: MultibodyJointSet;
    ccdSolver: CCDSolver;
    physicsPipeline: PhysicsPipeline;
    serializationPipeline: SerializationPipeline;
    debugRenderPipeline: DebugRenderPipeline;
    characterControllers: Set<KinematicCharacterController>;
    pidControllers: Set<PidController>;
    vehicleControllers: Set<DynamicRayCastVehicleController>;
    /**
     * Release the WASM memory occupied by this physics world.
     *
     * All the fields of this physics world will be freed as well,
     * so there is no need to call their `.free()` methods individually.
     */
    free(): void;
    constructor(gravity: Vector, rawIntegrationParameters?: RawIntegrationParameters, rawIslands?: RawIslandManager, rawBroadPhase?: RawBroadPhase, rawNarrowPhase?: RawNarrowPhase, rawBodies?: RawRigidBodySet, rawColliders?: RawColliderSet, rawImpulseJoints?: RawImpulseJointSet, rawMultibodyJoints?: RawMultibodyJointSet, rawCCDSolver?: RawCCDSolver, rawPhysicsPipeline?: RawPhysicsPipeline, rawSerializationPipeline?: RawSerializationPipeline, rawDebugRenderPipeline?: RawDebugRenderPipeline);
    static fromRaw(raw: RawDeserializedWorld): World;
    /**
     * Takes a snapshot of this world.
     *
     * Use `World.restoreSnapshot` to create a new physics world with a state identical to
     * the state when `.takeSnapshot()` is called.
     */
    takeSnapshot(): Uint8Array;
    /**
     * Creates a new physics world from a snapshot.
     *
     * This new physics world will be an identical copy of the snapshoted physics world.
     */
    static restoreSnapshot(data: Uint8Array): World;
    /**
     * Computes all the lines (and their colors) needed to render the scene.
     *
     * @param filterFlags - Flags for excluding whole subsets of colliders from rendering.
     * @param filterPredicate - Any collider for which this closure returns `false` will be excluded from the
     *                          debug rendering.
     */
    debugRender(filterFlags?: QueryFilterFlags, filterPredicate?: (collider: Collider) => boolean): DebugRenderBuffers;
    /**
     * Advance the simulation by one time step.
     *
     * All events generated by the physics engine are ignored.
     *
     * @param EventQueue - (optional) structure responsible for collecting
     *   events generated by the physics engine.
     */
    step(eventQueue?: EventQueue, hooks?: PhysicsHooks): void;
    /**
     * Update colliders positions after rigid-bodies moved.
     *
     * When a rigid-body moves, the positions of the colliders attached to it need to be updated. This update is
     * generally automatically done at the beginning and the end of each simulation step with World.step.
     * If the positions need to be updated without running a simulation step this method can be called manually.
     */
    propagateModifiedBodyPositionsToColliders(): void;
    /**
     * The current simulation timestep.
     */
    get timestep(): number;
    /**
     * Sets the new simulation timestep.
     *
     * The simulation timestep governs by how much the physics state of the world will
     * be integrated. A simulation timestep should:
     * - be as small as possible. Typical values evolve around 0.016 (assuming the chosen unit is milliseconds,
     * corresponds to the time between two frames of a game running at 60FPS).
     * - not vary too much during the course of the simulation. A timestep with large variations may
     * cause instabilities in the simulation.
     *
     * @param dt - The timestep length, in seconds.
     */
    set timestep(dt: number);
    /**
     * The approximate size of most dynamic objects in the scene.
     *
     * See the documentation of the `World.lengthUnit` setter for further details.
     */
    get lengthUnit(): number;
    /**
     * The approximate size of most dynamic objects in the scene.
     *
     * This value is used internally to estimate some length-based tolerance. In particular, the
     * values `IntegrationParameters.allowedLinearError`,
     * `IntegrationParameters.maxPenetrationCorrection`,
     * `IntegrationParameters.predictionDistance`, `RigidBodyActivation.linearThreshold`
     * are scaled by this value implicitly.
     *
     * This value can be understood as the number of units-per-meter in your physical world compared
     * to a human-sized world in meter. For example, in a 2d game, if your typical object size is 100
     * pixels, set the `[`Self::length_unit`]` parameter to 100.0. The physics engine will interpret
     * it as if 100 pixels is equivalent to 1 meter in its various internal threshold.
     * (default `1.0`).
     */
    set lengthUnit(unitsPerMeter: number);
    /**
     * The number of solver iterations run by the constraints solver for calculating forces (default: `4`).
     */
    get numSolverIterations(): number;
    /**
     * Sets the number of solver iterations run by the constraints solver for calculating forces (default: `4`).
     *
     * The greater this value is, the most rigid and realistic the physics simulation will be.
     * However a greater number of iterations is more computationally intensive.
     *
     * @param niter - The new number of solver iterations.
     */
    set numSolverIterations(niter: number);
    /**
     * Number of internal Project Gauss Seidel (PGS) iterations run at each solver iteration (default: `1`).
     */
    get numInternalPgsIterations(): number;
    /**
     * Sets the Number of internal Project Gauss Seidel (PGS) iterations run at each solver iteration (default: `1`).
     *
     * Increasing this parameter will improve stability of the simulation. It will have a lesser effect than
     * increasing `numSolverIterations` but is also less computationally expensive.
     *
     * @param niter - The new number of internal PGS iterations.
     */
    set numInternalPgsIterations(niter: number);
    /**
     * The number of substeps continuous collision-detection can run (default: `1`).
     */
    get maxCcdSubsteps(): number;
    /**
     * Sets the number of substeps continuous collision-detection can run (default: `1`).
     *
     * CCD operates using a "motion clamping" mechanism where all fast-moving object trajectories will
     * be truncated to their first impact on their path. The number of CCD substeps beyond 1 indicate how
     * many times that trajectory will be updated and continued after a hit. This can results in smoother
     * paths, but at a significant computational cost.
     *
     * @param niter - The new maximum number of CCD substeps. Setting to `0` disables CCD entirely.
     */
    set maxCcdSubsteps(substeps: number);
    /**
     * Creates a new rigid-body from the given rigid-body descriptor.
     *
     * @param body - The description of the rigid-body to create.
     */
    createRigidBody(body: RigidBodyDesc): RigidBody;
    /**
     * Creates a new character controller.
     *
     * @param offset - The artificial gap added between the character’s chape and its environment.
     */
    createCharacterController(offset: number): KinematicCharacterController;
    /**
     * Removes a character controller from this world.
     *
     * @param controller - The character controller to remove.
     */
    removeCharacterController(controller: KinematicCharacterController): void;
    /**
     * Creates a new PID (Proportional-Integral-Derivative) controller.
     *
     * @param kp - The Proportional gain applied to the instantaneous linear position errors.
     *             This is usually set to a multiple of the inverse of simulation step time
     *             (e.g. `60` if the delta-time is `1.0 / 60.0`).
     * @param ki - The linear gain applied to the Integral part of the PID controller.
     * @param kd - The Derivative gain applied to the instantaneous linear velocity errors.
     *             This is usually set to a value in `[0.0, 1.0]` where `0.0` implies no damping
     *             (no correction of velocity errors) and `1.0` implies complete damping (velocity errors
     *             are corrected in a single simulation step).
     * @param axes - The axes affected by this controller.
     *               Only coordinate axes with a bit flags set to `true` will be taken into
     *               account when calculating the errors and corrections.
     */
    createPidController(kp: number, ki: number, kd: number, axes: PidAxesMask): PidController;
    /**
     * Removes a PID controller from this world.
     *
     * @param controller - The PID controller to remove.
     */
    removePidController(controller: PidController): void;
    /**
     * Creates a new vehicle controller.
     *
     * @param chassis - The rigid-body used as the chassis of the vehicle controller. When the vehicle
     *                  controller is updated, it will change directly the rigid-body’s velocity. This
     *                  rigid-body must be a dynamic or kinematic-velocity-based rigid-body.
     */
    createVehicleController(chassis: RigidBody): DynamicRayCastVehicleController;
    /**
     * Removes a vehicle controller from this world.
     *
     * @param controller - The vehicle controller to remove.
     */
    removeVehicleController(controller: DynamicRayCastVehicleController): void;
    /**
     * Creates a new collider.
     *
     * @param desc - The description of the collider.
     * @param parent - The rigid-body this collider is attached to.
     */
    createCollider(desc: ColliderDesc, parent?: RigidBody): Collider;
    /** Creates independent voxel geometry from a source and local XYZ edits.
     * Descriptor pose/contact/mass policy applies; its geometry is replaced by
     * the copied voxel shape. The source is never mutated, even on cancellation. */
    createColliderFromVoxelEdits(desc: ColliderDesc, source: Collider, removed: Int32Array, added: Int32Array, parent?: RigidBody): Collider;
    /**
     * Creates a new impulse joint from the given joint descriptor.
     *
     * @param params - The description of the joint to create.
     * @param parent1 - The first rigid-body attached to this joint.
     * @param parent2 - The second rigid-body attached to this joint.
     * @param wakeUp - Should the attached rigid-bodies be awakened?
     */
    createImpulseJoint(params: JointData, parent1: RigidBody, parent2: RigidBody, wakeUp: boolean): ImpulseJoint;
    /**
     * Creates a new multibody joint from the given joint descriptor.
     *
     * @param params - The description of the joint to create.
     * @param parent1 - The first rigid-body attached to this joint.
     * @param parent2 - The second rigid-body attached to this joint.
     * @param wakeUp - Should the attached rigid-bodies be awakened?
     */
    createMultibodyJoint(params: JointData, parent1: RigidBody, parent2: RigidBody, wakeUp: boolean): MultibodyJoint;
    /**
     * Retrieves a rigid-body from its handle.
     *
     * @param handle - The integer handle of the rigid-body to retrieve.
     */
    getRigidBody(handle: RigidBodyHandle): RigidBody;
    /**
     * Retrieves a collider from its handle.
     *
     * @param handle - The integer handle of the collider to retrieve.
     */
    getCollider(handle: ColliderHandle): Collider;
    /**
     * Retrieves an impulse joint from its handle.
     *
     * @param handle - The integer handle of the impulse joint to retrieve.
     */
    getImpulseJoint(handle: ImpulseJointHandle): ImpulseJoint;
    /**
     * Retrieves an multibody joint from its handle.
     *
     * @param handle - The integer handle of the multibody joint to retrieve.
     */
    getMultibodyJoint(handle: MultibodyJointHandle): MultibodyJoint;
    /**
     * Removes the given rigid-body from this physics world.
     *
     * This will remove this rigid-body as well as all its attached colliders and joints.
     * Every other bodies touching or attached by joints to this rigid-body will be woken-up.
     *
     * @param body - The rigid-body to remove.
     */
    removeRigidBody(body: RigidBody): void;
    /**
     * Removes the given collider from this physics world.
     *
     * @param collider - The collider to remove.
     * @param wakeUp - If set to `true`, the rigid-body this collider is attached to will be awaken.
     */
    removeCollider(collider: Collider, wakeUp: boolean): void;
    /**
     * Removes the given impulse joint from this physics world.
     *
     * @param joint - The impulse joint to remove.
     * @param wakeUp - If set to `true`, the rigid-bodies attached by this joint will be awaken.
     */
    removeImpulseJoint(joint: ImpulseJoint, wakeUp: boolean): void;
    /**
     * Removes the given multibody joint from this physics world.
     *
     * @param joint - The multibody joint to remove.
     * @param wakeUp - If set to `true`, the rigid-bodies attached by this joint will be awaken.
     */
    removeMultibodyJoint(joint: MultibodyJoint, wakeUp: boolean): void;
    /**
     * Applies the given closure to each collider managed by this physics world.
     *
     * @param f(collider) - The function to apply to each collider managed by this physics world. Called as `f(collider)`.
     */
    forEachCollider(f: (collider: Collider) => void): void;
    /**
     * Applies the given closure to each rigid-body managed by this physics world.
     *
     * @param f(body) - The function to apply to each rigid-body managed by this physics world. Called as `f(collider)`.
     */
    forEachRigidBody(f: (body: RigidBody) => void): void;
    /**
     * Applies the given closure to each active rigid-body managed by this physics world.
     *
     * After a short time of inactivity, a rigid-body is automatically deactivated ("asleep") by
     * the physics engine in order to save computational power. A sleeping rigid-body never moves
     * unless it is moved manually by the user.
     *
     * @param f - The function to apply to each active rigid-body managed by this physics world. Called as `f(collider)`.
     */
    forEachActiveRigidBody(f: (body: RigidBody) => void): void;
    /**
     * Find the closest intersection between a ray and the physics world.
     *
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     * @param filter - The callback to filter out which collider will be hit.
     */
    castRay(ray: Ray, maxToi: number, solid: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): RayColliderHit | null;
    /**
     * Find the closest intersection between a ray and the physics world.
     *
     * This also computes the normal at the hit point.
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     */
    castRayAndGetNormal(ray: Ray, maxToi: number, solid: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): RayColliderIntersection | null;
    /**
     * Cast a ray and collects all the intersections between a ray and the scene.
     *
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     * @param callback - The callback called once per hit (in no particular order) between a ray and a collider.
     *   If this callback returns `false`, then the cast will stop and no further hits will be detected/reported.
     */
    intersectionsWithRay(ray: Ray, maxToi: number, solid: boolean, callback: (intersect: RayColliderIntersection) => boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): void;
    /**
     * Gets the handle of up to one collider intersecting the given shape.
     *
     * @param shapePos - The position of the shape used for the intersection test.
     * @param shapeRot - The orientation of the shape used for the intersection test.
     * @param shape - The shape used for the intersection test.
     * @param groups - The bit groups and filter associated to the ray, in order to only
     *   hit the colliders with collision groups compatible with the ray's group.
     */
    intersectionWithShape(shapePos: Vector, shapeRot: Rotation, shape: Shape, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): Collider | null;
    /**
     * Find the projection of a point on the closest collider.
     *
     * @param point - The point to project.
     * @param solid - If this is set to `true` then the collider shapes are considered to
     *   be plain (if the point is located inside of a plain shape, its projection is the point
     *   itself). If it is set to `false` the collider shapes are considered to be hollow
     *   (if the point is located inside of an hollow shape, it is projected on the shape's
     *   boundary).
     * @param groups - The bit groups and filter associated to the point to project, in order to only
     *   project on colliders with collision groups compatible with the ray's group.
     */
    projectPoint(point: Vector, solid: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): PointColliderProjection | null;
    /**
     * Find the projection of a point on the closest collider.
     *
     * @param point - The point to project.
     * @param groups - The bit groups and filter associated to the point to project, in order to only
     *   project on colliders with collision groups compatible with the ray's group.
     */
    projectPointAndGetFeature(point: Vector, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): PointColliderProjection | null;
    /**
     * Find all the colliders containing the given point.
     *
     * @param point - The point used for the containment test.
     * @param groups - The bit groups and filter associated to the point to test, in order to only
     *   test on colliders with collision groups compatible with the ray's group.
     * @param callback - A function called with the handles of each collider with a shape
     *   containing the `point`.
     */
    intersectionsWithPoint(point: Vector, callback: (handle: Collider) => boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): void;
    /**
     * Casts a shape at a constant linear velocity and retrieve the first collider it hits.
     * This is similar to ray-casting except that we are casting a whole shape instead of
     * just a point (the ray origin).
     *
     * @param shapePos - The initial position of the shape to cast.
     * @param shapeRot - The initial rotation of the shape to cast.
     * @param shapeVel - The constant velocity of the shape to cast (i.e. the cast direction).
     * @param shape - The shape to cast.
     * @param targetDistance − If the shape moves closer to this distance from a collider, a hit
     *                         will be returned.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the distance traveled by the shape to `shapeVel.norm() * maxToi`.
     * @param stopAtPenetration - If set to `false`, the linear shape-cast won’t immediately stop if
     *   the shape is penetrating another shape at its starting point **and** its trajectory is such
     *   that it’s on a path to exit that penetration state.
     * @param groups - The bit groups and filter associated to the shape to cast, in order to only
     *   test on colliders with collision groups compatible with this group.
     */
    castShape(shapePos: Vector, shapeRot: Rotation, shapeVel: Vector, shape: Shape, targetDistance: number, maxToi: number, stopAtPenetration: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): ColliderShapeCastHit | null;
    /**
     * Retrieve all the colliders intersecting the given shape.
     *
     * @param shapePos - The position of the shape to test.
     * @param shapeRot - The orientation of the shape to test.
     * @param shape - The shape to test.
     * @param groups - The bit groups and filter associated to the shape to test, in order to only
     *   test on colliders with collision groups compatible with this group.
     * @param callback - A function called with the handles of each collider intersecting the `shape`.
     */
    intersectionsWithShape(shapePos: Vector, shapeRot: Rotation, shape: Shape, callback: (collider: Collider) => boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: Collider, filterExcludeRigidBody?: RigidBody, filterPredicate?: (collider: Collider) => boolean): void;
    /**
     * Finds the handles of all the colliders with an AABB intersecting the given AABB.
     *
     * @param aabbCenter - The center of the AABB to test.
     * @param aabbHalfExtents - The half-extents of the AABB to test.
     * @param callback - The callback that will be called with the handles of all the colliders
     *                   currently intersecting the given AABB.
     */
    collidersWithAabbIntersectingAabb(aabbCenter: Vector, aabbHalfExtents: Vector, callback: (handle: Collider) => boolean): void;
    /**
     * Enumerates all the colliders potentially in contact with the given collider.
     *
     * @param collider1 - The second collider involved in the contact.
     * @param f - Closure that will be called on each collider that is in contact with `collider1`.
     */
    contactPairsWith(collider1: Collider, f: (collider2: Collider) => void): void;
    /**
     * Enumerates all the colliders intersecting the given colliders, assuming one of them
     * is a sensor.
     */
    intersectionPairsWith(collider1: Collider, f: (collider2: Collider) => void): void;
    /**
     * Iterates through all the contact manifolds between the given pair of colliders.
     *
     * @param collider1 - The first collider involved in the contact.
     * @param collider2 - The second collider involved in the contact.
     * @param f - Closure that will be called on each contact manifold between the two colliders. If the second argument
     *            passed to this closure is `true`, then the contact manifold data is flipped, i.e., methods like `localNormal1`
     *            actually apply to the `collider2` and fields like `localNormal2` apply to the `collider1`.
     */
    contactPair(collider1: Collider, collider2: Collider, f: (manifold: TempContactManifold, flipped: boolean) => void): void;
    /**
     * Returns `true` if `collider1` and `collider2` intersect and at least one of them is a sensor.
     * @param collider1 − The first collider involved in the intersection.
     * @param collider2 − The second collider involved in the intersection.
     */
    intersectionPair(collider1: Collider, collider2: Collider): boolean;
    /**
     * Sets whether internal performance profiling is enabled (default: false).
     *
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    set profilerEnabled(enabled: boolean);
    /**
     * Indicates if the internal performance profiling is enabled.
     *
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    get profilerEnabled(): boolean;
    /**
     * The time spent in milliseconds by the last step to run the entire simulation step.
     *
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingStep(): number;
    /**
     * The time spent in milliseconds by the last step to run the collision-detection
     * (broad-phase + narrow-phase).
     *
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingCollisionDetection(): number;
    /**
     * The time spent in milliseconds by the last step to run the broad-phase.
     *
     * This timing is included in `timingCollisionDetection`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingBroadPhase(): number;
    /**
     * The time spent in milliseconds by the last step to run the narrow-phase.
     *
     * This timing is included in `timingCollisionDetection`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingNarrowPhase(): number;
    /**
     * The time spent in milliseconds by the last step to run the constraint solver.
     *
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingSolver(): number;
    /**
     * The time spent in milliseconds by the last step to run the constraint
     * initialization.
     *
     * This timing is included in `timingSolver`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingVelocityAssembly(): number;
    /**
     * The time spent in milliseconds by the last step to run the constraint
     * resolution.
     *
     * This timing is included in `timingSolver`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingVelocityResolution(): number;
    /**
     * The time spent in milliseconds by the last step to run the rigid-body
     * velocity update.
     *
     * This timing is included in `timingSolver`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingVelocityUpdate(): number;
    /**
     * The time spent in milliseconds by writing rigid-body velocities
     * calculated by the solver back into the rigid-bodies.
     *
     * This timing is included in `timingSolver`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingVelocityWriteback(): number;
    /**
     * The total time spent in CCD detection and resolution.
     *
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingCcd(): number;
    /**
     * The total time spent searching for the continuous hits during CCD.
     *
     * This timing is included in `timingCcd`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingCcdToiComputation(): number;
    /**
     * The total time spent in the broad-phase during CCD.
     *
     * This timing is included in `timingCcd`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingCcdBroadPhase(): number;
    /**
     * The total time spent in the narrow-phase during CCD.
     *
     * This timing is included in `timingCcd`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingCcdNarrowPhase(): number;
    /**
     * The total time spent in the constraints resolution during CCD.
     *
     * This timing is included in `timingCcd`.
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingCcdSolver(): number;
    /**
     * The total time spent in the islands calculation during CCD.
     *
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingIslandConstruction(): number;
    /**
     * The total time spent propagating detected user changes.
     *
     * Only works if the internal profiler is enabled with `World.profilerEnabled = true`.
     */
    timingUserChanges(): number;
}

/**
 * Pairwise filtering using bit masks.
 *
 * This filtering method is based on two 16-bit values:
 * - The interaction groups (the 16 left-most bits of `self.0`).
 * - The interaction mask (the 16 right-most bits of `self.0`).
 *
 * An interaction is allowed between two filters `a` and `b` two conditions
 * are met simultaneously:
 * - The interaction groups of `a` has at least one bit set to `1` in common with the interaction mask of `b`.
 * - The interaction groups of `b` has at least one bit set to `1` in common with the interaction mask of `a`.
 * In other words, interactions are allowed between two filter iff. the following condition is met:
 *
 * ```
 * ((a >> 16) & b) != 0 && ((b >> 16) & a) != 0
 * ```
 */
type InteractionGroups = number;

declare enum FeatureType {
    Vertex = 0,
    Edge = 1,
    Face = 2,
    Unknown = 3
}

/**
 * A ray. This is a directed half-line.
 */
declare class Ray {
    /**
     * The starting point of the ray.
     */
    origin: Vector;
    /**
     * The direction of propagation of the ray.
     */
    dir: Vector;
    /**
     * Builds a ray from its origin and direction.
     *
     * @param origin - The ray's starting point.
     * @param dir - The ray's direction of propagation.
     */
    constructor(origin: Vector, dir: Vector);
    pointAt(t: number): Vector;
}
/**
 * The intersection between a ray and a collider.
 */
declare class RayIntersection {
    /**
     * The time-of-impact of the ray with the collider.
     *
     * The hit point is obtained from the ray's origin and direction: `origin + dir * timeOfImpact`.
     */
    timeOfImpact: number;
    /**
     * The normal of the collider at the hit point.
     */
    normal: Vector;
    /**
     * The type of the geometric feature the point was projected on.
     */
    featureType: FeatureType;
    /**
     * The id of the geometric feature the point was projected on.
     */
    featureId: number | undefined;
    constructor(timeOfImpact: number, normal: Vector, featureType?: FeatureType, featureId?: number);
    /**
     * @param raw - The raw intersection returned by the WASM query. It is freed by this method.
     * @param target - If provided, this object is populated and returned instead of
     * allocating a new one.
     */
    static fromBuffer(raw: RawRayIntersection, target?: RayIntersection): RayIntersection;
}
/**
 * The intersection between a ray and a collider (includes the collider handle).
 */
declare class RayColliderIntersection {
    /**
     * The collider hit by the ray.
     */
    collider: Collider;
    /**
     * The time-of-impact of the ray with the collider.
     *
     * The hit point is obtained from the ray's origin and direction: `origin + dir * timeOfImpact`.
     */
    timeOfImpact: number;
    /**
     * The normal of the collider at the hit point.
     */
    normal: Vector;
    /**
     * The type of the geometric feature the point was projected on.
     */
    featureType: FeatureType;
    /**
     * The id of the geometric feature the point was projected on.
     */
    featureId: number | undefined;
    constructor(collider: Collider, timeOfImpact: number, normal: Vector, featureType?: FeatureType, featureId?: number);
    /**
     * @param colliderSet - The set the hit collider belongs to.
     * @param raw - The raw intersection returned by the WASM query. It is freed by this method.
     * @param target - If provided, this object is populated and returned instead of
     * allocating a new one.
     */
    static fromBuffer(colliderSet: ColliderSet, raw: RawRayColliderIntersection, target?: RayColliderIntersection): RayColliderIntersection;
}
/**
 * The time of impact between a ray and a collider.
 */
declare class RayColliderHit {
    /**
     * The handle of the collider hit by the ray.
     */
    collider: Collider;
    /**
     * The time-of-impact of the ray with the collider.
     *
     * The hit point is obtained from the ray's origin and direction: `origin + dir * timeOfImpact`.
     */
    timeOfImpact: number;
    constructor(collider: Collider, timeOfImpact: number);
    static fromRaw(colliderSet: ColliderSet, raw: RawRayColliderHit): RayColliderHit;
}

/**
 * The intersection between a ray and a collider.
 */
declare class ShapeCastHit {
    /**
     * The time of impact of the two shapes.
     */
    time_of_impact: number;
    /**
     * The local-space contact point on the first shape, at
     * the time of impact.
     */
    witness1: Vector;
    /**
     * The local-space contact point on the second shape, at
     * the time of impact.
     */
    witness2: Vector;
    /**
     * The local-space normal on the first shape, at
     * the time of impact.
     */
    normal1: Vector;
    /**
     * The local-space normal on the second shape, at
     * the time of impact.
     */
    normal2: Vector;
    constructor(time_of_impact: number, witness1: Vector, witness2: Vector, normal1: Vector, normal2: Vector);
    static fromBuffer(collider: Collider, buffer: Float32Array, target?: ShapeCastHit): ShapeCastHit;
}
/**
 * The intersection between a ray and a collider.
 */
declare class ColliderShapeCastHit extends ShapeCastHit {
    /**
     * The handle of the collider hit by the ray.
     */
    collider: Collider;
    constructor(collider: Collider, time_of_impact: number, witness1: Vector, witness2: Vector, normal1: Vector, normal2: Vector);
    static fromBuffer(collider: Collider, buffer: Float32Array, target?: ColliderShapeCastHit): ColliderShapeCastHit;
}

/**
 * Parameters for VHACD convex decomposition algorithm.
 *
 * All parameters are optional. When not specified, default values from the
 * underlying Rapier/Parry library are used.
 */
interface VHACDParameters {
    /**
     * Controls the bias toward clipping along symmetry planes.
     * Range: [0.0, 1.0]
     */
    alpha?: number;
    /**
     * Controls the bias toward clipping along revolution planes.
     * Range: [0.0, 1.0]
     * Useful for objects with cylindrical or rotational features.
     */
    beta?: number;
    /**
     * Controls maximum allowed deviation from convexity.
     * Range: [0.0, 1.0]
     * Lower values create more convex parts for a tighter fit.
     */
    concavity?: number;
    /**
     * Controls the granularity of searching optimal clipping planes.
     * Lower values test more planes (slower but more accurate).
     */
    planeDownsampling?: number;
    /**
     * Controls the precision of convex hull generation.
     * Lower values use more voxels for hull computation.
     */
    convexHullDownsampling?: number;
    /**
     * Maximum number of convex parts to generate.
     * Limits part count during decomposition.
     */
    maxConvexHulls?: number;
    /**
     * Voxel grid resolution for decomposition.
     * Higher resolution captures more detail but is slower.
     */
    resolution?: number;
    /**
     * Whether to use approximate convex hulls for better performance.
     * Faster method with minimal impact on quality.
     */
    convexHullApproximation?: boolean;
}
/**
 * Flags affecting whether collision-detection happens between two colliders
 * depending on the type of rigid-bodies they are attached to.
 */
declare enum ActiveCollisionTypes {
    /**
     * Enable collision-detection between a collider attached to a dynamic body
     * and another collider attached to a dynamic body.
     */
    DYNAMIC_DYNAMIC = 1,
    /**
     * Enable collision-detection between a collider attached to a dynamic body
     * and another collider attached to a kinematic body.
     */
    DYNAMIC_KINEMATIC = 12,
    /**
     * Enable collision-detection between a collider attached to a dynamic body
     * and another collider attached to a fixed body (or not attached to any body).
     */
    DYNAMIC_FIXED = 2,
    /**
     * Enable collision-detection between a collider attached to a kinematic body
     * and another collider attached to a kinematic body.
     */
    KINEMATIC_KINEMATIC = 52224,
    /**
     * Enable collision-detection between a collider attached to a kinematic body
     * and another collider attached to a fixed body (or not attached to any body).
     */
    KINEMATIC_FIXED = 8704,
    /**
     * Enable collision-detection between a collider attached to a fixed body (or
     * not attached to any body) and another collider attached to a fixed body (or
     * not attached to any body).
     */
    FIXED_FIXED = 32,
    /**
     * The default active collision types, enabling collisions between a dynamic body
     * and another body of any type, but not enabling collisions between two non-dynamic bodies.
     */
    DEFAULT = 15,
    /**
     * Enable collisions between any kind of rigid-bodies (including between two non-dynamic bodies).
     */
    ALL = 60943
}
/**
 * The integer identifier of a collider added to a `ColliderSet`.
 */
type ColliderHandle = number;
/**
 * A geometric entity that can be attached to a body so it can be affected
 * by contacts and proximity queries.
 */
declare class Collider {
    private colliderSet;
    readonly handle: ColliderHandle;
    private _shape;
    private _parent;
    constructor(colliderSet: ColliderSet, handle: ColliderHandle, parent: RigidBody | null, shape?: Shape);
    /** @internal */
    finalizeDeserialization(bodies: RigidBodySet): void;
    private ensureShapeIsCached;
    /**
     * The shape of this collider.
     */
    get shape(): Shape;
    /**
     * Set the internal cached JS shape to null.
     *
     * This can be useful if you want to free some memory (assuming you are not
     * holding any other references to the shape object), or in order to force
     * the recalculation of the JS shape (the next time the `shape` getter is
     * accessed) from the WASM source of truth.
     */
    clearShapeCache(): void;
    /**
     * Checks if this collider is still valid (i.e. that it has
     * not been deleted from the collider set yet).
     */
    isValid(): boolean;
    /**
     * The world-space translation of this collider.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    translation(target?: Vector): Vector;
    /**
     * The translation of this collider relative to its parent rigid-body.
     *
     * Returns `null` if the collider doesn’t have a parent rigid-body.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    translationWrtParent(target?: Vector): Vector | null;
    /**
     * The world-space orientation of this collider.
     *
     * @param {Rotation?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    rotation(target?: Rotation): Rotation;
    /**
     * The orientation of this collider relative to its parent rigid-body.
     *
     * Returns `null` if the collider doesn’t have a parent rigid-body.
     *
     * @param {Rotation?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    rotationWrtParent(target?: Rotation): Rotation | null;
    /**
     * Is this collider a sensor?
     */
    isSensor(): boolean;
    /**
     * Sets whether this collider is a sensor.
     * @param isSensor - If `true`, the collider will be a sensor.
     */
    setSensor(isSensor: boolean): void;
    /**
     * Sets the new shape of the collider.
     * @param shape - The collider’s new shape.
     */
    setShape(shape: Shape): void;
    /**
     * Sets whether this collider is enabled or not.
     *
     * @param enabled - Set to `false` to disable this collider (its parent rigid-body won’t be disabled automatically by this).
     */
    setEnabled(enabled: boolean): void;
    /**
     * Is this collider enabled?
     */
    isEnabled(): boolean;
    /**
     * Sets the restitution coefficient of the collider to be created.
     *
     * @param restitution - The restitution coefficient in `[0, 1]`. A value of 0 (the default) means no bouncing behavior
     *                   while 1 means perfect bouncing (though energy may still be lost due to numerical errors of the
     *                   constraints solver).
     */
    setRestitution(restitution: number): void;
    /**
     * Sets the friction coefficient of the collider to be created.
     *
     * @param friction - The friction coefficient. Must be greater or equal to 0. This is generally smaller than 1. The
     *                   higher the coefficient, the stronger friction forces will be for contacts with the collider
     *                   being built.
     */
    setFriction(friction: number): void;
    /**
     * Gets the rule used to combine the friction coefficients of two colliders
     * colliders involved in a contact.
     */
    frictionCombineRule(): CoefficientCombineRule;
    /**
     * Sets the rule used to combine the friction coefficients of two colliders
     * colliders involved in a contact.
     *
     * @param rule − The combine rule to apply.
     */
    setFrictionCombineRule(rule: CoefficientCombineRule): void;
    /**
     * Gets the rule used to combine the restitution coefficients of two colliders
     * colliders involved in a contact.
     */
    restitutionCombineRule(): CoefficientCombineRule;
    /**
     * Sets the rule used to combine the restitution coefficients of two colliders
     * colliders involved in a contact.
     *
     * @param rule − The combine rule to apply.
     */
    setRestitutionCombineRule(rule: CoefficientCombineRule): void;
    /**
     * Sets the collision groups used by this collider.
     *
     * Two colliders will interact iff. their collision groups are compatible.
     * See the documentation of `InteractionGroups` for details on the used bit pattern.
     *
     * @param groups - The collision groups used for the collider being built.
     */
    setCollisionGroups(groups: InteractionGroups): void;
    /**
     * Sets the solver groups used by this collider.
     *
     * Forces between two colliders in contact will be computed iff their solver
     * groups are compatible.
     * See the documentation of `InteractionGroups` for details on the used bit pattern.
     *
     * @param groups - The solver groups used for the collider being built.
     */
    setSolverGroups(groups: InteractionGroups): void;
    /**
     * Sets the contact skin for this collider.
     *
     * See the documentation of `ColliderDesc.setContactSkin` for additional details.
     */
    contactSkin(): number;
    /**
     * Sets the contact skin for this collider.
     *
     * See the documentation of `ColliderDesc.setContactSkin` for additional details.
     *
     * @param thickness - The contact skin thickness.
     */
    setContactSkin(thickness: number): void;
    /**
     * Get the physics hooks active for this collider.
     */
    activeHooks(): ActiveHooks;
    /**
     * Set the physics hooks active for this collider.
     *
     * Use this to enable custom filtering rules for contact/intersecstion pairs involving this collider.
     *
     * @param activeHooks - The hooks active for contact/intersection pairs involving this collider.
     */
    setActiveHooks(activeHooks: ActiveHooks): void;
    /**
     * The events active for this collider.
     */
    activeEvents(): ActiveEvents;
    /**
     * Set the events active for this collider.
     *
     * Use this to enable contact and/or intersection event reporting for this collider.
     *
     * @param activeEvents - The events active for contact/intersection pairs involving this collider.
     */
    setActiveEvents(activeEvents: ActiveEvents): void;
    /**
     * Gets the collision types active for this collider.
     */
    activeCollisionTypes(): ActiveCollisionTypes;
    /**
     * Sets the total force magnitude beyond which a contact force event can be emitted.
     *
     * @param threshold - The new force threshold.
     */
    setContactForceEventThreshold(threshold: number): void;
    /**
     * The total force magnitude beyond which a contact force event can be emitted.
     */
    contactForceEventThreshold(): number;
    /**
     * Set the collision types active for this collider.
     *
     * @param activeCollisionTypes - The hooks active for contact/intersection pairs involving this collider.
     */
    setActiveCollisionTypes(activeCollisionTypes: ActiveCollisionTypes): void;
    /**
     * Sets the uniform density of this collider.
     *
     * This will override any previous mass-properties set by `this.setDensity`,
     * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
     * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
     *
     * The mass and angular inertia of this collider will be computed automatically based on its
     * shape.
     */
    setDensity(density: number): void;
    /**
     * Sets the mass of this collider.
     *
     * This will override any previous mass-properties set by `this.setDensity`,
     * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
     * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
     *
     * The angular inertia of this collider will be computed automatically based on its shape
     * and this mass value.
     */
    setMass(mass: number): void;
    /**
     * Sets the mass of this collider.
     *
     * This will override any previous mass-properties set by `this.setDensity`,
     * `this.setMass`, `this.setMassProperties`, `ColliderDesc.density`,
     * `ColliderDesc.mass`, or `ColliderDesc.massProperties` for this collider.
     */
    setMassProperties(mass: number, centerOfMass: Vector, principalAngularInertia: Vector, angularInertiaLocalFrame: Rotation): void;
    /**
     * Sets the translation of this collider.
     *
     * @param tra - The world-space position of the collider.
     */
    setTranslation(tra: Vector): void;
    /**
     * Sets the translation of this collider relative to its parent rigid-body.
     *
     * Does nothing if this collider isn't attached to a rigid-body.
     *
     * @param tra - The new translation of the collider relative to its parent.
     */
    setTranslationWrtParent(tra: Vector): void;
    /**
     * Sets the rotation quaternion of this collider.
     *
     * This does nothing if a zero quaternion is provided.
     *
     * @param rotation - The rotation to set.
     */
    setRotation(rot: Rotation): void;
    /**
     * Sets the rotation quaternion of this collider relative to its parent rigid-body.
     *
     * This does nothing if a zero quaternion is provided or if this collider isn't
     * attached to a rigid-body.
     *
     * @param rotation - The rotation to set.
     */
    setRotationWrtParent(rot: Rotation): void;
    /**
     * The type of the shape of this collider.
     */
    shapeType(): ShapeType;
    /**
     * The half-extents of this collider if it is a cuboid shape.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    halfExtents(target?: Vector): Vector | null;
    /**
     * Sets the half-extents of this collider if it is a cuboid shape.
     *
     * @param newHalfExtents - desired half extents.
     */
    setHalfExtents(newHalfExtents: Vector): void;
    /**
     * The radius of this collider if it is a ball, cylinder, capsule, or cone shape.
     */
    radius(): number;
    /**
     * Sets the radius of this collider if it is a ball, cylinder, capsule, or cone shape.
     *
     * @param newRadius - desired radius.
     */
    setRadius(newRadius: number): void;
    /**
     * The radius of the round edges of this collider if it is a round cylinder.
     */
    roundRadius(): number;
    /**
     * Sets the radius of the round edges of this collider if it has round edges.
     *
     * @param newBorderRadius - desired round edge radius.
     */
    setRoundRadius(newBorderRadius: number): void;
    /**
     * The half height of this collider if it is a cylinder, capsule, or cone shape.
     */
    halfHeight(): number;
    /**
     * Sets the half height of this collider if it is a cylinder, capsule, or cone shape.
     *
     * @param newHalfheight - desired half height.
     */
    setHalfHeight(newHalfheight: number): void;
    /**
     * If this collider has a Voxels shape, this will mark the voxel at the
     * given grid coordinates as filled or empty (depending on the `filled`
     * argument).
     *
     * Each input value is assumed to be an integer.
     *
     * The operation is O(1), unless the provided coordinates are out of the
     * bounds of the currently allocated internal grid in which case the grid
     * will be grown automatically.
     */
    setVoxel(ix: number, iy: number, iz: number, filled: boolean): void;
    /** Applies a homogeneous XYZ edit batch and returns the number of changed voxels. */
    setVoxels(coords: Int32Array, filled: boolean): number;
    /**
     * If this and `voxels2` are voxel colliders, and a voxel from `this` was
     * modified with `setVoxel`, this will ensure that a
     * moving object transitioning across the boundaries of these colliders
     * won’t suffer from the "internal edges" artifact.
     *
     * The indices `ix, iy, iz` indicate the integer coordinates of the voxel in
     * the local coordinate frame of `this`.
     *
     * If the voxels in `voxels2` live in a different coordinate space from `this`,
     * then the `shift_*` argument indicate the distance, in voxel units, between
     * the origin of `this` to the origin of `voxels2`.
     *
     * This method is intended to be called between `this` and all the other
     * voxels colliders with a domain intersecting `this` or sharing a domain
     * boundary. This is an incremental maintenance of the effect of
     * `combineVoxelStates`.
     */
    propagateVoxelChange(voxels2: Collider, ix: number, iy: number, iz: number, shift_x: number, shift_y: number, shift_z: number): void;
    /**
     * If this and `voxels2` are voxel colliders, this will ensure that a
     * moving object transitioning across the boundaries of these colliders
     * won’t suffer from the "internal edges" artifact.
     *
     * If the voxels in `voxels2` live in a different coordinate space from `this`,
     * then the `shift_*` argument indicate the distance, in voxel units, between
     * the origin of `this` to the origin of `voxels2`.
     *
     * This method is intended to be called once between all pairs of voxels
     * colliders with intersecting domains or shared boundaries.
     *
     * If either voxels collider is then modified with `setVoxel`, the
     * `propagateVoxelChange` method must be called to maintain the coupling
     * between the voxels shapes after the modification.
     */
    combineVoxelStates(voxels2: Collider, shift_x: number, shift_y: number, shift_z: number): void;
    /**
     * If this collider has a triangle mesh, polyline, convex polygon, or convex polyhedron shape,
     * this returns the vertex buffer of said shape.
     */
    vertices(): Float32Array;
    /**
     * If this collider has a triangle mesh, polyline, or convex polyhedron shape,
     * this returns the index buffer of said shape.
     */
    indices(): Uint32Array | undefined;
    /**
     * If this collider has a heightfield shape, this returns the heights buffer of
     * the heightfield.
     * In 3D, the returned height matrix is provided in column-major order.
     */
    heightfieldHeights(): Float32Array;
    /**
     * If this collider has a heightfield shape, this returns the scale
     * applied to it.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    heightfieldScale(target?: Vector): Vector | null;
    /**
     * If this collider has a heightfield shape, this returns the number of
     * rows of its height matrix.
     */
    heightfieldNRows(): number;
    /**
     * If this collider has a heightfield shape, this returns the number of
     * columns of its height matrix.
     */
    heightfieldNCols(): number;
    /**
     * The rigid-body this collider is attached to.
     */
    parent(): RigidBody | null;
    /**
     * The friction coefficient of this collider.
     */
    friction(): number;
    /**
     * The restitution coefficient of this collider.
     */
    restitution(): number;
    /**
     * The density of this collider.
     */
    density(): number;
    /**
     * The mass of this collider.
     */
    mass(): number;
    /**
     * The volume of this collider.
     */
    volume(): number;
    /**
     * The collision groups of this collider.
     */
    collisionGroups(): InteractionGroups;
    /**
     * The solver groups of this collider.
     */
    solverGroups(): InteractionGroups;
    /**
     * Tests if this collider contains a point.
     *
     * @param point - The point to test.
     */
    containsPoint(point: Vector): boolean;
    /**
     * Find the projection of a point on this collider.
     *
     * @param point - The point to project.
     * @param solid - If this is set to `true` then the collider shapes are considered to
     *   be plain (if the point is located inside of a plain shape, its projection is the point
     *   itself). If it is set to `false` the collider shapes are considered to be hollow
     *   (if the point is located inside of an hollow shape, it is projected on the shape's
     *   boundary).
     */
    projectPoint(point: Vector, solid: boolean, target?: PointProjection): PointProjection | null;
    /**
     * Tests if this collider intersects the given ray.
     *
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     */
    intersectsRay(ray: Ray, maxToi: number): boolean;
    /**
     * Computes the smallest time between this and the given shape under translational movement are separated by a distance smaller or equal to distance.
     *
     * @param collider1Vel - The constant velocity of the current shape to cast (i.e. the cast direction).
     * @param shape2 - The shape to cast against.
     * @param shape2Pos - The position of the second shape.
     * @param shape2Rot - The rotation of the second shape.
     * @param shape2Vel - The constant velocity of the second shape.
     * @param targetDistance − If the shape moves closer to this distance from a collider, a hit
     *                         will be returned.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the distance traveled by the shape to `collider1Vel.norm() * maxToi`.
     * @param stopAtPenetration - If set to `false`, the linear shape-cast won’t immediately stop if
     *   the shape is penetrating another shape at its starting point **and** its trajectory is such
     *   that it’s on a path to exit that penetration state.
     * @param {ShapeCastHit?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    castShape(collider1Vel: Vector, shape2: Shape, shape2Pos: Vector, shape2Rot: Rotation, shape2Vel: Vector, targetDistance: number, maxToi: number, stopAtPenetration: boolean, target?: ShapeCastHit): ShapeCastHit | null;
    /**
     * Computes the smallest time between this and the given collider under translational movement are separated by a distance smaller or equal to distance.
     *
     * @param collider1Vel - The constant velocity of the current collider to cast (i.e. the cast direction).
     * @param collider2 - The collider to cast against.
     * @param collider2Vel - The constant velocity of the second collider.
     * @param targetDistance − If the shape moves closer to this distance from a collider, a hit
     *                         will be returned.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the distance traveled by the shape to `shapeVel.norm() * maxToi`.
     * @param stopAtPenetration - If set to `false`, the linear shape-cast won’t immediately stop if
     *   the shape is penetrating another shape at its starting point **and** its trajectory is such
     *   that it’s on a path to exit that penetration state.
     * @param {ColliderShapeCastHit?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    castCollider(collider1Vel: Vector, collider2: Collider, collider2Vel: Vector, targetDistance: number, maxToi: number, stopAtPenetration: boolean, target?: ColliderShapeCastHit): ColliderShapeCastHit | null;
    intersectsShape(shape2: Shape, shapePos2: Vector, shapeRot2: Rotation): boolean;
    /**
     * Computes one pair of contact points between the shape owned by this collider and the given shape.
     *
     * @param shape2 - The second shape.
     * @param shape2Pos - The initial position of the second shape.
     * @param shape2Rot - The rotation of the second shape.
     * @param prediction - The prediction value, if the shapes are separated by a distance greater than this value, test will fail.
     * @returns `null` if the shapes are separated by a distance greater than prediction, otherwise contact details. The result is given in world-space.
     */
    contactShape(shape2: Shape, shape2Pos: Vector, shape2Rot: Rotation, prediction: number, target?: ShapeContact): ShapeContact | null;
    /**
     * Computes one pair of contact points between the collider and the given collider.
     *
     * @param collider2 - The second collider.
     * @param prediction - The prediction value, if the shapes are separated by a distance greater than this value, test will fail.
     * @returns `null` if the shapes are separated by a distance greater than prediction, otherwise contact details. The result is given in world-space.
     */
    contactCollider(collider2: Collider, prediction: number, target?: ShapeContact): ShapeContact | null;
    /**
     * Find the closest intersection between a ray and this collider.
     *
     * This also computes the normal at the hit point.
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @returns The time-of-impact between this collider and the ray, or `-1` if there is no intersection.
     */
    castRay(ray: Ray, maxToi: number, solid: boolean): number;
    /**
     * Find the closest intersection between a ray and this collider.
     *
     * This also computes the normal at the hit point.
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     */
    castRayAndGetNormal(ray: Ray, maxToi: number, solid: boolean, target?: RayIntersection): RayIntersection | null;
}
declare enum MassPropsMode {
    Density = 0,
    Mass = 1,
    MassProps = 2
}
/** Native geometry reference used only for shared collider admission. */
interface SharedColliderGeometry {
    readonly type: "shared";
    readonly geometry: number;
    readonly scale: Vector;
}
declare class ColliderDesc {
    enabled: boolean;
    shape: Shape | SharedColliderGeometry;
    massPropsMode: MassPropsMode;
    mass: number;
    centerOfMass: Vector;
    principalAngularInertia: Vector;
    angularInertiaLocalFrame: Rotation;
    density: number;
    friction: number;
    restitution: number;
    rotation: Rotation;
    translation: Vector;
    isSensor: boolean;
    collisionGroups: InteractionGroups;
    solverGroups: InteractionGroups;
    frictionCombineRule: CoefficientCombineRule;
    restitutionCombineRule: CoefficientCombineRule;
    activeEvents: ActiveEvents;
    activeHooks: ActiveHooks;
    activeCollisionTypes: ActiveCollisionTypes;
    contactForceEventThreshold: number;
    contactSkin: number;
    /**
     * Initializes a collider descriptor from the collision shape.
     *
     * @param shape - The shape of the collider being built.
     */
    constructor(shape: Shape | SharedColliderGeometry);
    /**
     * Create a new collider descriptor with a ball shape.
     *
     * @param radius - The radius of the ball.
     */
    static ball(radius: number): ColliderDesc;
    /**
     * Create a new collider descriptor with a capsule shape.
     *
     * @param halfHeight - The half-height of the capsule, along the `y` axis.
     * @param radius - The radius of the capsule basis.
     */
    static capsule(halfHeight: number, radius: number): ColliderDesc;
    /**
     * Creates a new segment shape.
     *
     * @param a - The first point of the segment.
     * @param b - The second point of the segment.
     */
    static segment(a: Vector, b: Vector): ColliderDesc;
    /**
     * Creates a new triangle shape.
     *
     * @param a - The first point of the triangle.
     * @param b - The second point of the triangle.
     * @param c - The third point of the triangle.
     */
    static triangle(a: Vector, b: Vector, c: Vector): ColliderDesc;
    /**
     * Creates a new triangle shape with round corners.
     *
     * @param a - The first point of the triangle.
     * @param b - The second point of the triangle.
     * @param c - The third point of the triangle.
     * @param borderRadius - The radius of the borders of this triangle. In 3D,
     *   this is also equal to half the thickness of the triangle.
     */
    static roundTriangle(a: Vector, b: Vector, c: Vector, borderRadius: number): ColliderDesc;
    /**
     * Creates a new collider descriptor with a polyline shape.
     *
     * @param vertices - The coordinates of the polyline's vertices.
     * @param indices - The indices of the polyline's segments. If this is `undefined` or `null`,
     *    the vertices are assumed to describe a line strip.
     */
    static polyline(vertices: Float32Array, indices?: Uint32Array | null): ColliderDesc;
    /**
     * Creates a new collider descriptor with a shape made of voxels.
     *
     * @param data - Defines the set of voxels. If this is a `Int32Array` then
     *               each voxel is defined from its (signed) grid coordinates,
     *               with 3 (resp 2) contiguous integers per voxel in 3D (resp 2D).
     *               If this is a `Float32Array`, each voxel will be such that
     *               they contain at least one point from this array (where each
     *               point is defined from 3 (resp 2) contiguous numbers per point
     *               in 3D (resp 2D).
     * @param voxelSize - The size of each voxel.
     */
    static voxels(voxels: Float32Array | Int32Array, voxelSize: Vector): ColliderDesc;
    /** Creates a voxel collider from the union of half-open integer grid regions. */
    static voxelRegions(regions: Int32Array, voxelSize: Vector): ColliderDesc;
    /**
     * Creates a new collider descriptor with a triangle mesh shape.
     *
     * @param vertices - The coordinates of the triangle mesh's vertices.
     * @param indices - The indices of the triangle mesh's triangles.
     */
    static trimesh(vertices: Float32Array, indices: Uint32Array, flags?: TriMeshFlags): ColliderDesc;
    /**
     * Creates a new collider descriptor with a cuboid shape.
     *
     * @param hx - The half-width of the rectangle along its local `x` axis.
     * @param hy - The half-width of the rectangle along its local `y` axis.
     * @param hz - The half-width of the rectangle along its local `z` axis.
     */
    static cuboid(hx: number, hy: number, hz: number): ColliderDesc;
    /**
     * Creates a new collider descriptor with a rectangular shape with round borders.
     *
     * @param hx - The half-width of the rectangle along its local `x` axis.
     * @param hy - The half-width of the rectangle along its local `y` axis.
     * @param hz - The half-width of the rectangle along its local `z` axis.
     * @param borderRadius - The radius of the cuboid's borders.
     */
    static roundCuboid(hx: number, hy: number, hz: number, borderRadius: number): ColliderDesc;
    /**
     * Creates a new collider descriptor with a heightfield shape.
     *
     * @param nrows − The number of rows in the heights matrix.
     * @param ncols - The number of columns in the heights matrix.
     * @param heights - The heights of the heightfield along its local `y` axis,
     *                  provided as a matrix stored in column-major order.
     * @param scale - The scale factor applied to the heightfield.
     */
    static heightfield(nrows: number, ncols: number, heights: Float32Array, scale: Vector, flags?: HeightFieldFlags): ColliderDesc;
    /**
     * Create a new collider descriptor with a cylinder shape.
     *
     * @param halfHeight - The half-height of the cylinder, along the `y` axis.
     * @param radius - The radius of the cylinder basis.
     */
    static cylinder(halfHeight: number, radius: number): ColliderDesc;
    /**
     * Create a new collider descriptor with a cylinder shape with rounded corners.
     *
     * @param halfHeight - The half-height of the cylinder, along the `y` axis.
     * @param radius - The radius of the cylinder basis.
     * @param borderRadius - The radius of the cylinder's rounded edges and vertices.
     */
    static roundCylinder(halfHeight: number, radius: number, borderRadius: number): ColliderDesc;
    /**
     * Create a new collider descriptor with a cone shape.
     *
     * @param halfHeight - The half-height of the cone, along the `y` axis.
     * @param radius - The radius of the cone basis.
     */
    static cone(halfHeight: number, radius: number): ColliderDesc;
    /**
     * Create a new collider descriptor with a cone shape with rounded corners.
     *
     * @param halfHeight - The half-height of the cone, along the `y` axis.
     * @param radius - The radius of the cone basis.
     * @param borderRadius - The radius of the cone's rounded edges and vertices.
     */
    static roundCone(halfHeight: number, radius: number, borderRadius: number): ColliderDesc;
    /**
     * Computes the convex-hull of the given points and use the resulting
     * convex polyhedron as the shape for this new collider descriptor.
     *
     * @param points - The point that will be used to compute the convex-hull.
     */
    static convexHull(points: Float32Array): ColliderDesc | null;
    /**
     * Creates a new collider descriptor that uses the given set of points assumed
     * to form a convex polyline (no convex-hull computation will be done).
     *
     * @param vertices - The vertices of the convex polyline.
     */
    static convexMesh(vertices: Float32Array, indices?: Uint32Array | null): ColliderDesc | null;
    /**
     * Computes the convex-hull of the given points and use the resulting
     * convex polyhedron as the shape for this new collider descriptor. A
     * border is added to that convex polyhedron to give it round corners.
     *
     * @param points - The point that will be used to compute the convex-hull.
     * @param borderRadius - The radius of the round border added to the convex polyhedron.
     */
    static roundConvexHull(points: Float32Array, borderRadius: number): ColliderDesc | null;
    /**
     * Creates a new collider descriptor that uses the given set of points assumed
     * to form a round convex polyline (no convex-hull computation will be done).
     *
     * @param vertices - The vertices of the convex polyline.
     * @param borderRadius - The radius of the round border added to the convex polyline.
     */
    static roundConvexMesh(vertices: Float32Array, indices: Uint32Array | null, borderRadius: number): ColliderDesc | null;
    /**
     * Creates a new collider descriptor with a compound shape.
     *
     * @param shapes - The array of shapes composing this compound. Must not be empty, and
     *                 must not contain other compound shapes (nested compound shapes are
     *                 not allowed).
     * @param positions - The array of positions for each shape (relative to the compound's origin).
     * @param rotations - The array of rotations for each shape (relative to the compound's orientation).
     */
    static compound(shapes: Shape[], positions: Vector[], rotations: Rotation[]): ColliderDesc;
    /**
     * Creates a new collider descriptor with a compound shape automatically created
     * from a convex decomposition of the given triangle mesh (in 3D) or polyline (in 2D).
     *
     * @param vertices - The coordinates of the mesh's vertices.
     * @param indices - The indices of the mesh's triangles (in 3D) or segments (in 2D).
     * @param params - Optional VHACD parameters to control the decomposition.
     * @returns The collider descriptor, or `null` if the decomposition did not produce
     *          any convex part (e.g. if the input mesh is degenerate).
     */
    static convexDecomposition(vertices: Float32Array, indices: Uint32Array, params?: VHACDParameters): ColliderDesc | null;
    /**
     * Sets the position of the collider to be created relative to the rigid-body it is attached to.
     */
    setTranslation(x: number, y: number, z: number): ColliderDesc;
    /**
     * Sets the rotation of the collider to be created relative to the rigid-body it is attached to.
     *
     * @param rot - The rotation of the collider to be created relative to the rigid-body it is attached to.
     */
    setRotation(rot: Rotation): ColliderDesc;
    /**
     * Sets whether or not the collider being created is a sensor.
     *
     * A sensor collider does not take part of the physics simulation, but generates
     * proximity events.
     *
     * @param sensor - Set to `true` of the collider built is to be a sensor.
     */
    setSensor(sensor: boolean): ColliderDesc;
    /**
     * Sets whether the created collider will be enabled or disabled.
     * @param enabled − If set to `false` the collider will be disabled at creation.
     */
    setEnabled(enabled: boolean): ColliderDesc;
    /**
     * Sets the contact skin of the collider.
     *
     * The contact skin acts as if the collider was enlarged with a skin of width `skin_thickness`
     * around it, keeping objects further apart when colliding.
     *
     * A non-zero contact skin can increase performance, and in some cases, stability. However
     * it creates a small gap between colliding object (equal to the sum of their skin). If the
     * skin is sufficiently small, this might not be visually significant or can be hidden by the
     * rendering assets.
     */
    setContactSkin(thickness: number): ColliderDesc;
    /**
     * Sets the density of the collider being built.
     *
     * The mass and angular inertia tensor will be computed automatically based on this density and the collider’s shape.
     *
     * @param density - The density to set, must be greater or equal to 0. A density of 0 means that this collider
     *                  will not affect the mass or angular inertia of the rigid-body it is attached to.
     */
    setDensity(density: number): ColliderDesc;
    /**
     * Sets the mass of the collider being built.
     *
     * The angular inertia tensor will be computed automatically based on this mass and the collider’s shape.
     *
     * @param mass - The mass to set, must be greater or equal to 0.
     */
    setMass(mass: number): ColliderDesc;
    /**
     * Sets the mass properties of the collider being built.
     *
     * This replaces the mass-properties automatically computed from the collider's density and shape.
     * These mass-properties will be added to the mass-properties of the rigid-body this collider will be attached to.
     *
     * @param mass − The mass of the collider to create.
     * @param centerOfMass − The center-of-mass of the collider to create.
     * @param principalAngularInertia − The initial principal angular inertia of the collider to create.
     *                                  These are the eigenvalues of the angular inertia matrix.
     * @param angularInertiaLocalFrame − The initial local angular inertia frame of the collider to create.
     *                                   These are the eigenvectors of the angular inertia matrix.
     */
    setMassProperties(mass: number, centerOfMass: Vector, principalAngularInertia: Vector, angularInertiaLocalFrame: Rotation): ColliderDesc;
    /**
     * Sets the restitution coefficient of the collider to be created.
     *
     * @param restitution - The restitution coefficient in `[0, 1]`. A value of 0 (the default) means no bouncing behavior
     *                   while 1 means perfect bouncing (though energy may still be lost due to numerical errors of the
     *                   constraints solver).
     */
    setRestitution(restitution: number): ColliderDesc;
    /**
     * Sets the friction coefficient of the collider to be created.
     *
     * @param friction - The friction coefficient. Must be greater or equal to 0. This is generally smaller than 1. The
     *                   higher the coefficient, the stronger friction forces will be for contacts with the collider
     *                   being built.
     */
    setFriction(friction: number): ColliderDesc;
    /**
     * Sets the rule used to combine the friction coefficients of two colliders
     * colliders involved in a contact.
     *
     * @param rule − The combine rule to apply.
     */
    setFrictionCombineRule(rule: CoefficientCombineRule): ColliderDesc;
    /**
     * Sets the rule used to combine the restitution coefficients of two colliders
     * colliders involved in a contact.
     *
     * @param rule − The combine rule to apply.
     */
    setRestitutionCombineRule(rule: CoefficientCombineRule): ColliderDesc;
    /**
     * Sets the collision groups used by this collider.
     *
     * Two colliders will interact iff. their collision groups are compatible.
     * See the documentation of `InteractionGroups` for details on the used bit pattern.
     *
     * @param groups - The collision groups used for the collider being built.
     */
    setCollisionGroups(groups: InteractionGroups): ColliderDesc;
    /**
     * Sets the solver groups used by this collider.
     *
     * Forces between two colliders in contact will be computed iff their solver
     * groups are compatible.
     * See the documentation of `InteractionGroups` for details on the used bit pattern.
     *
     * @param groups - The solver groups used for the collider being built.
     */
    setSolverGroups(groups: InteractionGroups): ColliderDesc;
    /**
     * Set the physics hooks active for this collider.
     *
     * Use this to enable custom filtering rules for contact/intersecstion pairs involving this collider.
     *
     * @param activeHooks - The hooks active for contact/intersection pairs involving this collider.
     */
    setActiveHooks(activeHooks: ActiveHooks): ColliderDesc;
    /**
     * Set the events active for this collider.
     *
     * Use this to enable contact and/or intersection event reporting for this collider.
     *
     * @param activeEvents - The events active for contact/intersection pairs involving this collider.
     */
    setActiveEvents(activeEvents: ActiveEvents): ColliderDesc;
    /**
     * Set the collision types active for this collider.
     *
     * @param activeCollisionTypes - The hooks active for contact/intersection pairs involving this collider.
     */
    setActiveCollisionTypes(activeCollisionTypes: ActiveCollisionTypes): ColliderDesc;
    /**
     * Sets the total force magnitude beyond which a contact force event can be emitted.
     *
     * @param threshold - The force threshold to set.
     */
    setContactForceEventThreshold(threshold: number): ColliderDesc;
}

/**
 * The projection of a point on a collider.
 */
declare class PointProjection {
    /**
     * The projection of the point on the collider.
     */
    point: Vector;
    /**
     * Is the point inside of the collider?
     */
    isInside: boolean;
    constructor(point: Vector, isInside: boolean);
    /**
     * @param raw - The raw projection returned by the WASM query. It is freed by this method.
     * @param target - If provided, this object is populated and returned instead of
     * allocating a new one.
     */
    static fromBuffer(raw: RawPointProjection, target?: PointProjection): PointProjection;
}
/**
 * The projection of a point on a collider (includes the collider handle).
 */
declare class PointColliderProjection {
    /**
     * The collider hit by the ray.
     */
    collider: Collider;
    /**
     * The projection of the point on the collider.
     */
    point: Vector;
    /**
     * Is the point inside of the collider?
     */
    isInside: boolean;
    /**
     * The type of the geometric feature the point was projected on.
     */
    featureType: FeatureType;
    /**
     * The id of the geometric feature the point was projected on.
     */
    featureId: number | undefined;
    constructor(collider: Collider, point: Vector, isInside: boolean, featureType?: FeatureType, featureId?: number);
    /**
     * @param colliderSet - The set the projected-on collider belongs to.
     * @param raw - The raw projection returned by the WASM query. It is freed by this method.
     * @param target - If provided, this object is populated and returned instead of
     * allocating a new one.
     */
    static fromBuffer(colliderSet: ColliderSet, raw: RawPointColliderProjection, target?: PointColliderProjection): PointColliderProjection;
}

declare abstract class Shape {
    abstract intoRaw(): RawShape;
    /**
     * The concrete type of this shape.
     */
    abstract get type(): ShapeType;
    /**
     * instant mode without cache
     */
    static fromRaw(rawSet: RawColliderSet, handle: ColliderHandle): Shape;
    static fromRawShape(rawShape: RawShape): Shape;
    /**
     * Computes the time of impact between two moving shapes.
     * @param shapePos1 - The initial position of this shape.
     * @param shapeRot1 - The rotation of this shape.
     * @param shapeVel1 - The velocity of this shape.
     * @param shape2 - The second moving shape.
     * @param shapePos2 - The initial position of the second shape.
     * @param shapeRot2 - The rotation of the second shape.
     * @param shapeVel2 - The velocity of the second shape.
     * @param targetDistance − If the shape moves closer to this distance from a collider, a hit
     *                         will be returned.
     * @param maxToi - The maximum time when the impact can happen.
     * @param stopAtPenetration - If set to `false`, the linear shape-cast won’t immediately stop if
     *   the shape is penetrating another shape at its starting point **and** its trajectory is such
     *   that it’s on a path to exit that penetration state.
     * @param {ShapeCastHit?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     * @returns If the two moving shapes collider at some point along their trajectories, this returns the
     *  time at which the two shape collider as well as the contact information during the impact. Returns
     *  `null` if the two shapes never collide along their paths.
     */
    castShape(shapePos1: Vector, shapeRot1: Rotation, shapeVel1: Vector, shape2: Shape, shapePos2: Vector, shapeRot2: Rotation, shapeVel2: Vector, targetDistance: number, maxToi: number, stopAtPenetration: boolean, target?: ShapeCastHit): ShapeCastHit | null;
    /**
     * Tests if this shape intersects another shape.
     *
     * @param shapePos1 - The position of this shape.
     * @param shapeRot1 - The rotation of this shape.
     * @param shape2  - The second shape to test.
     * @param shapePos2 - The position of the second shape.
     * @param shapeRot2 - The rotation of the second shape.
     * @returns `true` if the two shapes intersect, `false` if they don’t.
     */
    intersectsShape(shapePos1: Vector, shapeRot1: Rotation, shape2: Shape, shapePos2: Vector, shapeRot2: Rotation): boolean;
    /**
     * Computes one pair of contact points between two shapes.
     *
     * @param shapePos1 - The initial position of this sahpe.
     * @param shapeRot1 - The rotation of this shape.
     * @param shape2 - The second shape.
     * @param shapePos2 - The initial position of the second shape.
     * @param shapeRot2 - The rotation of the second shape.
     * @param prediction - The prediction value, if the shapes are separated by a distance greater than this value, test will fail.
     * @returns `null` if the shapes are separated by a distance greater than prediction, otherwise contact details. The result is given in world-space.
     */
    contactShape(shapePos1: Vector, shapeRot1: Rotation, shape2: Shape, shapePos2: Vector, shapeRot2: Rotation, prediction: number, target?: ShapeContact): ShapeContact | null;
    containsPoint(shapePos: Vector, shapeRot: Rotation, point: Vector): boolean;
    projectPoint(shapePos: Vector, shapeRot: Rotation, point: Vector, solid: boolean, target?: PointProjection): PointProjection;
    intersectsRay(ray: Ray, shapePos: Vector, shapeRot: Rotation, maxToi: number): boolean;
    castRay(ray: Ray, shapePos: Vector, shapeRot: Rotation, maxToi: number, solid: boolean): number;
    castRayAndGetNormal(ray: Ray, shapePos: Vector, shapeRot: Rotation, maxToi: number, solid: boolean, target?: RayIntersection): RayIntersection;
}
/**
 * An enumeration representing the type of a shape.
 */
declare enum ShapeType {
    Ball = 0,
    Cuboid = 1,
    Capsule = 2,
    Segment = 3,
    Polyline = 4,
    Triangle = 5,
    TriMesh = 6,
    HeightField = 7,
    Compound = 8,
    ConvexPolyhedron = 9,
    Cylinder = 10,
    Cone = 11,
    RoundCuboid = 12,
    RoundTriangle = 13,
    RoundCylinder = 14,
    RoundCone = 15,
    RoundConvexPolyhedron = 16,
    HalfSpace = 17,
    Voxels = 18
}
/**
 * Flags controlling the behavior of some operations involving heightfields.
 */
declare enum HeightFieldFlags {
    /**
     * If set, a special treatment will be applied to contact manifold calculation to eliminate
     * or fix contacts normals that could lead to incorrect bumps in physics simulation (especially
     * on flat surfaces).
     *
     * This is achieved by taking into account adjacent triangle normals when computing contact
     * points for a given triangle.
     */
    FIX_INTERNAL_EDGES = 1
}
/**
 * Flags controlling the behavior of the triangle mesh creation and of some
 * operations involving triangle meshes.
 */
declare enum TriMeshFlags {
    /**
     * If set, any triangle that results in a failing half-hedge topology computation will be deleted.
     */
    DELETE_BAD_TOPOLOGY_TRIANGLES = 4,
    /**
     * If set, the trimesh will be assumed to be oriented (with outward normals).
     *
     * The pseudo-normals of its vertices and edges will be computed.
     */
    ORIENTED = 8,
    /**
     * If set, the duplicate vertices of the trimesh will be merged.
     *
     * Two vertices with the exact same coordinates will share the same entry on the
     * vertex buffer and the index buffer is adjusted accordingly.
     */
    MERGE_DUPLICATE_VERTICES = 16,
    /**
     * If set, the triangles sharing two vertices with identical index values will be removed.
     *
     * Because of the way it is currently implemented, this methods implies that duplicate
     * vertices will be merged. It will no longer be the case in the future once we decouple
     * the computations.
     */
    DELETE_DEGENERATE_TRIANGLES = 32,
    /**
     * If set, two triangles sharing three vertices with identical index values (in any order)
     * will be removed.
     *
     * Because of the way it is currently implemented, this methods implies that duplicate
     * vertices will be merged. It will no longer be the case in the future once we decouple
     * the computations.
     */
    DELETE_DUPLICATE_TRIANGLES = 64,
    /**
     * If set, a special treatment will be applied to contact manifold calculation to eliminate
     * or fix contacts normals that could lead to incorrect bumps in physics simulation
     * (especially on flat surfaces).
     *
     * This is achieved by taking into account adjacent triangle normals when computing contact
     * points for a given triangle.
     *
     * /!\ NOT SUPPORTED IN THE 2D VERSION OF RAPIER.
     */
    FIX_INTERNAL_EDGES = 144
}
/**
 * A shape that is a sphere in 3D and a circle in 2D.
 */
declare class Ball extends Shape {
    readonly type = ShapeType.Ball;
    /**
     * The balls radius.
     */
    radius: number;
    /**
     * Creates a new ball with the given radius.
     * @param radius - The balls radius.
     */
    constructor(radius: number);
    intoRaw(): RawShape;
}
declare class HalfSpace extends Shape {
    readonly type = ShapeType.HalfSpace;
    /**
     * The outward normal of the half-space.
     */
    normal: Vector;
    /**
     * Creates a new halfspace delimited by an infinite plane.
     *
     * @param normal - The outward normal of the plane.
     */
    constructor(normal: Vector);
    intoRaw(): RawShape;
}
/**
 * A shape that is a box in 3D and a rectangle in 2D.
 */
declare class Cuboid extends Shape {
    readonly type = ShapeType.Cuboid;
    /**
     * The half extent of the cuboid along each coordinate axis.
     */
    halfExtents: Vector;
    /**
     * Creates a new 3D cuboid.
     * @param hx - The half width of the cuboid.
     * @param hy - The half height of the cuboid.
     * @param hz - The half depth of the cuboid.
     */
    constructor(hx: number, hy: number, hz: number);
    intoRaw(): RawShape;
}
/**
 * A shape that is a box in 3D and a rectangle in 2D, with round corners.
 */
declare class RoundCuboid extends Shape {
    readonly type = ShapeType.RoundCuboid;
    /**
     * The half extent of the cuboid along each coordinate axis.
     */
    halfExtents: Vector;
    /**
     * The radius of the cuboid's round border.
     */
    borderRadius: number;
    /**
     * Creates a new 3D cuboid.
     * @param hx - The half width of the cuboid.
     * @param hy - The half height of the cuboid.
     * @param hz - The half depth of the cuboid.
     * @param borderRadius - The radius of the borders of this cuboid. This will
     *   effectively increase the half-extents of the cuboid by this radius.
     */
    constructor(hx: number, hy: number, hz: number, borderRadius: number);
    intoRaw(): RawShape;
}
/**
 * A shape that is a capsule.
 */
declare class Capsule extends Shape {
    readonly type = ShapeType.Capsule;
    /**
     * The radius of the capsule's basis.
     */
    radius: number;
    /**
     * The capsule's half height, along the `y` axis.
     */
    halfHeight: number;
    /**
     * Creates a new capsule with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     */
    constructor(halfHeight: number, radius: number);
    intoRaw(): RawShape;
}
/**
 * A shape that is a segment.
 */
declare class Segment extends Shape {
    readonly type = ShapeType.Segment;
    /**
     * The first point of the segment.
     */
    a: Vector;
    /**
     * The second point of the segment.
     */
    b: Vector;
    /**
     * Creates a new segment shape.
     * @param a - The first point of the segment.
     * @param b - The second point of the segment.
     */
    constructor(a: Vector, b: Vector);
    intoRaw(): RawShape;
}
/**
 * A shape that is a segment.
 */
declare class Triangle extends Shape {
    readonly type = ShapeType.Triangle;
    /**
     * The first point of the triangle.
     */
    a: Vector;
    /**
     * The second point of the triangle.
     */
    b: Vector;
    /**
     * The second point of the triangle.
     */
    c: Vector;
    /**
     * Creates a new triangle shape.
     *
     * @param a - The first point of the triangle.
     * @param b - The second point of the triangle.
     * @param c - The third point of the triangle.
     */
    constructor(a: Vector, b: Vector, c: Vector);
    intoRaw(): RawShape;
}
/**
 * A shape that is a triangle with round borders and a non-zero thickness.
 */
declare class RoundTriangle extends Shape {
    readonly type = ShapeType.RoundTriangle;
    /**
     * The first point of the triangle.
     */
    a: Vector;
    /**
     * The second point of the triangle.
     */
    b: Vector;
    /**
     * The second point of the triangle.
     */
    c: Vector;
    /**
     * The radius of the triangles's rounded edges and vertices.
     * In 3D, this is also equal to half the thickness of the round triangle.
     */
    borderRadius: number;
    /**
     * Creates a new triangle shape with round corners.
     *
     * @param a - The first point of the triangle.
     * @param b - The second point of the triangle.
     * @param c - The third point of the triangle.
     * @param borderRadius - The radius of the borders of this triangle. In 3D,
     *   this is also equal to half the thickness of the triangle.
     */
    constructor(a: Vector, b: Vector, c: Vector, borderRadius: number);
    intoRaw(): RawShape;
}
/**
 * A shape that is a triangle mesh.
 */
declare class Polyline extends Shape {
    readonly type = ShapeType.Polyline;
    /**
     * The vertices of the polyline.
     */
    vertices: Float32Array;
    /**
     * The indices of the segments.
     */
    indices: Uint32Array;
    /**
     * Creates a new polyline shape.
     *
     * @param vertices - The coordinates of the polyline's vertices.
     * @param indices - The indices of the polyline's segments. If this is `null` or not provided, then
     *    the vertices are assumed to form a line strip.
     */
    constructor(vertices: Float32Array, indices?: Uint32Array);
    intoRaw(): RawShape;
}
/**
 * A shape made of voxels.
 */
declare class Voxels extends Shape {
    readonly type = ShapeType.Voxels;
    /**
     * The points or grid coordinates used to initialize the voxels.
     */
    data: Float32Array | Int32Array;
    /**
     * The dimensions of each voxel.
     */
    voxelSize: Vector;
    /**
     * Creates a new shape made of voxels.
     *
     * @param data - Defines the set of voxels. If this is a `Int32Array` then
     *               each voxel is defined from its (signed) grid coordinates,
     *               with 3 (resp 2) contiguous integers per voxel in 3D (resp 2D).
     *               If this is a `Float32Array`, each voxel will be such that
     *               they contain at least one point from this array (where each
     *               point is defined from 3 (resp 2) contiguous numbers per point
     *               in 3D (resp 2D).
     * @param voxelSize - The size of each voxel.
     */
    constructor(data: Float32Array | Int32Array, voxelSize: Vector);
    /** Half-open [minX,minY,minZ,maxX,maxY,maxZ] regions, when constructed compactly. */
    regions?: Int32Array;
    /** Constructs a union of regions without allocating one XYZ triple per voxel. */
    static fromRegions(regions: Int32Array, voxelSize: Vector): Voxels;
    intoRaw(): RawShape;
}
/**
 * A compound shape, consisting of multiple sub-shapes with relative positions.
 */
declare class Compound extends Shape {
    readonly type = ShapeType.Compound;
    /**
     * The shapes composing this compound shape.
     */
    shapes: Shape[];
    /**
     * The positions of each sub-shape relative to the compound's origin.
     */
    positions: Vector[];
    /**
     * The rotations of each sub-shape relative to the compound's orientation.
     */
    rotations: Rotation[];
    /**
     * Creates a new compound shape.
     *
     * @param shapes - The array of shapes composing this compound. Must not be empty,
     *                 and must not contain other compound shapes (nested compound shapes
     *                 are not allowed).
     * @param positions - The array of positions for each shape.
     * @param rotations - The array of rotations for each shape.
     */
    constructor(shapes: Shape[], positions: Vector[], rotations: Rotation[]);
    /**
     * Reconstructs a compound shape from its raw representation.
     *
     * This takes ownership of `rawShape` and always frees it before returning.
     */
    static fromRawShape(rawShape: RawShape): Compound;
    intoRaw(): RawShape;
}
/**
 * A shape that is a triangle mesh.
 */
declare class TriMesh extends Shape {
    readonly type = ShapeType.TriMesh;
    /**
     * The vertices of the triangle mesh.
     */
    vertices: Float32Array;
    /**
     * The indices of the triangles.
     */
    indices: Uint32Array;
    /**
     * The triangle mesh flags.
     */
    flags: TriMeshFlags;
    /**
     * Creates a new triangle mesh shape.
     *
     * @param vertices - The coordinates of the triangle mesh's vertices.
     * @param indices - The indices of the triangle mesh's triangles.
     */
    constructor(vertices: Float32Array, indices: Uint32Array, flags?: TriMeshFlags);
    intoRaw(): RawShape;
}
/**
 * A shape that is a convex polygon.
 */
declare class ConvexPolyhedron extends Shape {
    readonly type = ShapeType.ConvexPolyhedron;
    /**
     * The vertices of the convex polygon.
     */
    vertices: Float32Array;
    /**
     * The indices of the convex polygon.
     */
    indices?: Uint32Array | null;
    /**
     * Creates a new convex polygon shape.
     *
     * @param vertices - The coordinates of the convex polygon's vertices.
     * @param indices - The index buffer of this convex mesh. If this is `null`
     *   or `undefined`, the convex-hull of the input vertices will be computed
     *   automatically. Otherwise, it will be assumed that the mesh you provide
     *   is already convex.
     */
    constructor(vertices: Float32Array, indices?: Uint32Array | null);
    intoRaw(): RawShape;
}
/**
 * A shape that is a convex polygon.
 */
declare class RoundConvexPolyhedron extends Shape {
    readonly type = ShapeType.RoundConvexPolyhedron;
    /**
     * The vertices of the convex polygon.
     */
    vertices: Float32Array;
    /**
     * The indices of the convex polygon.
     */
    indices?: Uint32Array;
    /**
     * The radius of the convex polyhedron's rounded edges and vertices.
     */
    borderRadius: number;
    /**
     * Creates a new convex polygon shape.
     *
     * @param vertices - The coordinates of the convex polygon's vertices.
     * @param indices - The index buffer of this convex mesh. If this is `null`
     *   or `undefined`, the convex-hull of the input vertices will be computed
     *   automatically. Otherwise, it will be assumed that the mesh you provide
     *   is already convex.
     * @param borderRadius - The radius of the borders of this convex polyhedron.
     */
    constructor(vertices: Float32Array, indices: Uint32Array | null | undefined, borderRadius: number);
    intoRaw(): RawShape;
}
/**
 * A shape that is a heightfield.
 */
declare class Heightfield extends Shape {
    readonly type = ShapeType.HeightField;
    /**
     * The number of rows in the heights matrix.
     */
    nrows: number;
    /**
     * The number of columns in the heights matrix.
     */
    ncols: number;
    /**
     * The heights of the heightfield along its local `y` axis,
     * provided as a matrix stored in column-major order.
     */
    heights: Float32Array;
    /**
     * The dimensions of the heightfield's local `x,z` plane.
     */
    scale: Vector;
    /**
     * Flags applied to the heightfield.
     */
    flags: HeightFieldFlags;
    /**
     * Creates a new heightfield shape.
     *
     * @param nrows − The number of rows in the heights matrix.
     * @param ncols - The number of columns in the heights matrix.
     * @param heights - The heights of the heightfield along its local `y` axis,
     *                  provided as a matrix stored in column-major order.
     * @param scale - The dimensions of the heightfield's local `x,z` plane.
     */
    constructor(nrows: number, ncols: number, heights: Float32Array, scale: Vector, flags?: HeightFieldFlags);
    intoRaw(): RawShape;
}
/**
 * A shape that is a 3D cylinder.
 */
declare class Cylinder extends Shape {
    readonly type = ShapeType.Cylinder;
    /**
     * The radius of the cylinder's basis.
     */
    radius: number;
    /**
     * The cylinder's half height, along the `y` axis.
     */
    halfHeight: number;
    /**
     * Creates a new cylinder with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     */
    constructor(halfHeight: number, radius: number);
    intoRaw(): RawShape;
}
/**
 * A shape that is a 3D cylinder with round corners.
 */
declare class RoundCylinder extends Shape {
    readonly type = ShapeType.RoundCylinder;
    /**
     * The radius of the cylinder's basis.
     */
    radius: number;
    /**
     * The cylinder's half height, along the `y` axis.
     */
    halfHeight: number;
    /**
     * The radius of the cylinder's rounded edges and vertices.
     */
    borderRadius: number;
    /**
     * Creates a new cylinder with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     * @param borderRadius - The radius of the borders of this cylinder.
     */
    constructor(halfHeight: number, radius: number, borderRadius: number);
    intoRaw(): RawShape;
}
/**
 * A shape that is a 3D cone.
 */
declare class Cone extends Shape {
    readonly type = ShapeType.Cone;
    /**
     * The radius of the cone's basis.
     */
    radius: number;
    /**
     * The cone's half height, along the `y` axis.
     */
    halfHeight: number;
    /**
     * Creates a new cone with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     */
    constructor(halfHeight: number, radius: number);
    intoRaw(): RawShape;
}
/**
 * A shape that is a 3D cone with round corners.
 */
declare class RoundCone extends Shape {
    readonly type = ShapeType.RoundCone;
    /**
     * The radius of the cone's basis.
     */
    radius: number;
    /**
     * The cone's half height, along the `y` axis.
     */
    halfHeight: number;
    /**
     * The radius of the cylinder's rounded edges and vertices.
     */
    borderRadius: number;
    /**
     * Creates a new cone with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     * @param borderRadius - The radius of the borders of this cone.
     */
    constructor(halfHeight: number, radius: number, borderRadius: number);
    intoRaw(): RawShape;
}

/**
 * A set of rigid bodies that can be handled by a physics pipeline.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `colliderSet.free()`
 * once you are done using it (and all the rigid-bodies it created).
 */
declare class ColliderSet {
    raw: RawColliderSet;
    private map;
    /** Create one native geometry identity, shared by independently authored colliders. */
    createSharedGeometry(shape: Shape): number;
    /** Replace one geometry root at the next native physics boundary. */
    writeSharedHeightfield(geometry: number, indices: Uint32Array, values: Float32Array): boolean;
    replaceSharedGeometry(geometry: number, shape: Shape): boolean;
    /** Bind one collider instance; geometry edits never enumerate these bindings. */
    bindSharedGeometry(collider: ColliderHandle, geometry: number, scale: Vector): boolean;
    /** Return false if actual collider bindings still retain this geometry. */
    removeSharedGeometry(geometry: number): boolean;
    /**
     * Release the WASM memory occupied by this collider set.
     */
    free(): void;
    constructor(raw?: RawColliderSet);
    /** @internal */
    castClosure<Res>(f?: (collider: Collider) => Res): (handle: ColliderHandle) => Res | undefined;
    /** @internal */
    finalizeDeserialization(bodies: RigidBodySet): void;
    /**
     * Creates a new collider and return its integer handle.
     *
     * @param bodies - The set of bodies where the collider's parent can be found.
     * @param desc - The collider's description.
     * @param parentHandle - The integer handle of the rigid-body this collider is attached to.
     */
    createCollider(bodies: RigidBodySet, desc: ColliderDesc, parentHandle: RigidBodyHandle, voxelEdits?: {
        source: Collider;
        removed: Int32Array;
        added: Int32Array;
    }): Collider;
    /**
     * Remove a collider from this set.
     *
     * @param handle - The integer handle of the collider to remove.
     * @param bodies - The set of rigid-body containing the rigid-body the collider is attached to.
     * @param wakeUp - If `true`, the rigid-body the removed collider is attached to will be woken-up automatically.
     */
    remove(handle: ColliderHandle, islands: IslandManager, bodies: RigidBodySet, wakeUp: boolean): void;
    /**
     * Internal function, do not call directly.
     * @param handle
     */
    unmap(handle: ImpulseJointHandle): void;
    /**
     * Gets the rigid-body with the given handle.
     *
     * @param handle - The handle of the rigid-body to retrieve.
     */
    get(handle: ColliderHandle): Collider | null;
    /**
     * The number of colliders on this set.
     */
    len(): number;
    /**
     * Does this set contain a collider with the given handle?
     *
     * @param handle - The collider handle to check.
     */
    contains(handle: ColliderHandle): boolean;
    /**
     * Applies the given closure to each collider contained by this set.
     *
     * @param f - The closure to apply.
     */
    forEach(f: (collider: Collider) => void): void;
    /**
     * Gets all colliders in the list.
     *
     * @returns collider list.
     */
    getAll(): Collider[];
}

/**
 * The narrow-phase used for precise collision-detection.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `narrowPhase.free()`
 * once you are done using it.
 */
declare class NarrowPhase {
    raw: RawNarrowPhase;
    tempManifold: TempContactManifold;
    /**
     * Release the WASM memory occupied by this narrow-phase.
     */
    free(): void;
    constructor(raw?: RawNarrowPhase);
    /**
     * Enumerates all the colliders potentially in contact with the given collider.
     *
     * @param collider1 - The second collider involved in the contact.
     * @param f - Closure that will be called on each collider that is in contact with `collider1`.
     */
    contactPairsWith(collider1: ColliderHandle, f: (collider2: ColliderHandle) => void): void;
    /**
     * Enumerates all the colliders intersecting the given colliders, assuming one of them
     * is a sensor.
     */
    intersectionPairsWith(collider1: ColliderHandle, f: (collider2: ColliderHandle) => void): void;
    /** Reads only solver adjacency; the caller admits the complete manifold roster budget. */
    contactPairHasSolverContact(collider1: ColliderHandle, collider2: ColliderHandle, maximumManifolds: number, direction?: Vector, minimumDot?: number): {
        manifoldCount: number;
        touching: boolean;
    };
    /**
     * Iterates through all the contact manifolds between the given pair of colliders.
     *
     * @param collider1 - The first collider involved in the contact.
     * @param collider2 - The second collider involved in the contact.
     * @param bodies - The set of rigid-bodies the colliders are attached to. Solver contacts are
     *                 anchored in body-local space, so this is needed to read them back in world-space.
     * @param solver - Read the actual solver roster, including composite-shape clusters.
     * @param f - Closure that will be called on each contact manifold between the two colliders. If the second argument
     *            passed to this closure is `true`, then the contact manifold data is flipped, i.e., methods like `localNormal1`
     *            actually apply to the `collider2` and fields like `localNormal2` apply to the `collider1`.
     */
    contactPair(collider1: ColliderHandle, collider2: ColliderHandle, bodies: RigidBodySet, f: (manifold: TempContactManifold, flipped: boolean) => void, solver?: boolean): void;
    /**
     * Returns `true` if `collider1` and `collider2` intersect and at least one of them is a sensor.
     * @param collider1 − The first collider involved in the intersection.
     * @param collider2 − The second collider involved in the intersection.
     */
    intersectionPair(collider1: ColliderHandle, collider2: ColliderHandle): boolean;
}
declare class TempContactManifold {
    raw: RawContactManifold;
    /** The bodies the manifold's solver contacts are anchored to. */
    bodies: RigidBodySet;
    free(): void;
    constructor(raw: RawContactManifold, bodies?: RigidBodySet);
    /**
     * The contact normal of the manifold, expressed in world-space.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    normal(target?: Vector): Vector;
    /**
     * The contact normal of the manifold, expressed in the local-space of the first shape.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    localNormal1(target?: Vector): Vector;
    /**
     * The contact normal of the manifold, expressed in the local-space of the second shape.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    localNormal2(target?: Vector): Vector;
    subshape1(): number;
    subshape2(): number;
    numContacts(): number;
    /**
     * The local-space contact point on the first shape, for the `i`-th contact.
     *
     * @param {number} i - The index of the contact to read.
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    localContactPoint1(i: number, target?: Vector): Vector | null;
    /**
     * The local-space contact point on the second shape, for the `i`-th contact.
     *
     * @param {number} i - The index of the contact to read.
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    localContactPoint2(i: number, target?: Vector): Vector | null;
    contactDist(i: number): number;
    contactFid1(i: number): number;
    contactFid2(i: number): number;
    contactImpulse(i: number): number;
    contactTangentImpulseX(i: number): number;
    contactTangentImpulseY(i: number): number;
    /** Normal impulse of this solver contact, using its native geometric-contact identity. */
    solverContactImpulse(i: number): number;
    numSolverContacts(): number;
    /**
     * The world-space position of the `i`-th solver contact point.
     *
     * @param {number} i - The index of the solver contact to read.
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    solverContactPoint(i: number, target?: Vector): Vector | null;
    solverContactDist(i: number): number;
    /**
     * The friction coefficient applied to this manifold's solver contacts. It is combined
     * once per manifold, so every solver contact of this manifold shares it.
     */
    friction(): number;
    /**
     * The restitution coefficient applied to this manifold's solver contacts. It is
     * combined once per manifold, so every solver contact of this manifold shares it.
     */
    restitution(): number;
    /**
     * The tangent (surface) velocity of the `i`-th solver contact point.
     *
     * @param {number} i - The index of the solver contact to read.
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    solverContactTangentVelocity(i: number, target?: Vector): Vector;
}

/**
 * The broad-phase used for coarse collision-detection.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `broadPhase.free()`
 * once you are done using it.
 */
declare class BroadPhase {
    raw: RawBroadPhase;
    /**
     * Release the WASM memory occupied by this broad-phase.
     */
    free(): void;
    constructor(raw?: RawBroadPhase);
    /**
     * Find the closest intersection between a ray and a set of collider.
     *
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     * @param filter - The callback to filter out which collider will be hit.
     */
    castRay(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, ray: Ray, maxToi: number, solid: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean): RayColliderHit | null;
    /**
     * Find the closest intersection between a ray and a set of collider.
     *
     * This also computes the normal at the hit point.
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     */
    castRayAndGetNormal(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, ray: Ray, maxToi: number, solid: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean, target?: RayColliderIntersection): RayColliderIntersection | null;
    /**
     * Cast a ray and collects all the intersections between a ray and the scene.
     *
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     * @param callback - The callback called once per hit (in no particular order) between a ray and a collider.
     *   If this callback returns `false`, then the cast will stop and no further hits will be detected/reported.
     */
    intersectionsWithRay(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, ray: Ray, maxToi: number, solid: boolean, callback: (intersect: RayColliderIntersection) => boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean): void;
    /**
     * Gets the handle of up to one collider intersecting the given shape.
     *
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param shapePos - The position of the shape used for the intersection test.
     * @param shapeRot - The orientation of the shape used for the intersection test.
     * @param shape - The shape used for the intersection test.
     * @param groups - The bit groups and filter associated to the ray, in order to only
     *   hit the colliders with collision groups compatible with the ray's group.
     */
    intersectionWithShape(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, shapePos: Vector, shapeRot: Rotation, shape: Shape, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean): ColliderHandle | null;
    /**
     * Find the projection of a point on the closest collider.
     *
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param point - The point to project.
     * @param solid - If this is set to `true` then the collider shapes are considered to
     *   be plain (if the point is located inside of a plain shape, its projection is the point
     *   itself). If it is set to `false` the collider shapes are considered to be hollow
     *   (if the point is located inside of an hollow shape, it is projected on the shape's
     *   boundary).
     * @param groups - The bit groups and filter associated to the point to project, in order to only
     *   project on colliders with collision groups compatible with the ray's group.
     */
    projectPoint(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, point: Vector, solid: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean, target?: PointColliderProjection): PointColliderProjection | null;
    /**
     * Find the projection of a point on the closest collider.
     *
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param point - The point to project.
     * @param groups - The bit groups and filter associated to the point to project, in order to only
     *   project on colliders with collision groups compatible with the ray's group.
     */
    projectPointAndGetFeature(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, point: Vector, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean, target?: PointColliderProjection): PointColliderProjection | null;
    /**
     * Find all the colliders containing the given point.
     *
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param point - The point used for the containment test.
     * @param groups - The bit groups and filter associated to the point to test, in order to only
     *   test on colliders with collision groups compatible with the ray's group.
     * @param callback - A function called with the handles of each collider with a shape
     *   containing the `point`.
     */
    intersectionsWithPoint(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, point: Vector, callback: (handle: ColliderHandle) => boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean): void;
    /**
     * Casts a shape at a constant linear velocity and retrieve the first collider it hits.
     * This is similar to ray-casting except that we are casting a whole shape instead of
     * just a point (the ray origin).
     *
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param shapePos - The initial position of the shape to cast.
     * @param shapeRot - The initial rotation of the shape to cast.
     * @param shapeVel - The constant velocity of the shape to cast (i.e. the cast direction).
     * @param shape - The shape to cast.
     * @param targetDistance − If the shape moves closer to this distance from a collider, a hit
     *                       will be returned.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the distance traveled by the shape to `shapeVel.norm() * maxToi`.
     * @param stopAtPenetration - If set to `false`, the linear shape-cast won’t immediately stop if
     *   the shape is penetrating another shape at its starting point **and** its trajectory is such
     *   that it’s on a path to exit that penetration state.
     * @param groups - The bit groups and filter associated to the shape to cast, in order to only
     *   test on colliders with collision groups compatible with this group.
     * @param {ColliderShapeCastHit?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    castShape(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, shapePos: Vector, shapeRot: Rotation, shapeVel: Vector, shape: Shape, targetDistance: number, maxToi: number, stopAtPenetration: boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean, target?: ColliderShapeCastHit): ColliderShapeCastHit | null;
    /**
     * Retrieve all the colliders intersecting the given shape.
     *
     * @param colliders - The set of colliders taking part in this pipeline.
     * @param shapePos - The position of the shape to test.
     * @param shapeRot - The orientation of the shape to test.
     * @param shape - The shape to test.
     * @param groups - The bit groups and filter associated to the shape to test, in order to only
     *   test on colliders with collision groups compatible with this group.
     * @param callback - A function called with the handles of each collider intersecting the `shape`.
     */
    intersectionsWithShape(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, shapePos: Vector, shapeRot: Rotation, shape: Shape, callback: (handle: ColliderHandle) => boolean, filterFlags?: QueryFilterFlags, filterGroups?: InteractionGroups, filterExcludeCollider?: ColliderHandle, filterExcludeRigidBody?: RigidBodyHandle, filterPredicate?: (collider: ColliderHandle) => boolean): void;
    /**
     * Finds the handles of all the colliders with an AABB intersecting the given AABB.
     *
     * @param aabbCenter - The center of the AABB to test.
     * @param aabbHalfExtents - The half-extents of the AABB to test.
     * @param callback - The callback that will be called with the handles of all the colliders
     *                   currently intersecting the given AABB.
     */
    collidersWithAabbIntersectingAabb(narrowPhase: NarrowPhase, bodies: RigidBodySet, colliders: ColliderSet, aabbCenter: Vector, aabbHalfExtents: Vector, callback: (handle: ColliderHandle) => boolean): void;
}

/**
 * The integer identifier of a collider added to a `ColliderSet`.
 */
type RigidBodyHandle = number;
/**
 * The simulation status of a rigid-body.
 */
declare enum RigidBodyType {
    /**
     * A `RigidBodyType::Dynamic` body can be affected by all external forces.
     */
    Dynamic = 0,
    /**
     * A `RigidBodyType::Fixed` body cannot be affected by external forces.
     */
    Fixed = 1,
    /**
     * A `RigidBodyType::KinematicPositionBased` body cannot be affected by any external forces but can be controlled
     * by the user at the position level while keeping realistic one-way interaction with dynamic bodies.
     *
     * One-way interaction means that a kinematic body can push a dynamic body, but a kinematic body
     * cannot be pushed by anything. In other words, the trajectory of a kinematic body can only be
     * modified by the user and is independent from any contact or joint it is involved in.
     */
    KinematicPositionBased = 2,
    /**
     * A `RigidBodyType::KinematicVelocityBased` body cannot be affected by any external forces but can be controlled
     * by the user at the velocity level while keeping realistic one-way interaction with dynamic bodies.
     *
     * One-way interaction means that a kinematic body can push a dynamic body, but a kinematic body
     * cannot be pushed by anything. In other words, the trajectory of a kinematic body can only be
     * modified by the user and is independent from any contact or joint it is involved in.
     */
    KinematicVelocityBased = 3
}
/**
 * A rigid-body.
 */
declare class RigidBody {
    private rawSet;
    private colliderSet;
    readonly handle: RigidBodyHandle;
    /**
     * An arbitrary user-defined object associated with this rigid-body.
     */
    userData?: unknown;
    constructor(rawSet: RawRigidBodySet, colliderSet: ColliderSet, handle: RigidBodyHandle);
    /** @internal */
    finalizeDeserialization(colliderSet: ColliderSet): void;
    /**
     * Checks if this rigid-body is still valid (i.e. that it has
     * not been deleted from the rigid-body set yet.
     */
    isValid(): boolean;
    /**
     * Locks or unlocks the ability of this rigid-body to translate.
     *
     * @param locked - If `true`, this rigid-body will no longer translate due to forces and impulses.
     * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
     */
    lockTranslations(locked: boolean, wakeUp: boolean): void;
    /**
     * Locks or unlocks the ability of this rigid-body to rotate.
     *
     * @param locked - If `true`, this rigid-body will no longer rotate due to torques and impulses.
     * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
     */
    lockRotations(locked: boolean, wakeUp: boolean): void;
    /**
     * Locks or unlocks the ability of this rigid-body to translate along individual coordinate axes.
     *
     * @param enableX - If `false`, this rigid-body will no longer translate due to torques and impulses, along the X coordinate axis.
     * @param enableY - If `false`, this rigid-body will no longer translate due to torques and impulses, along the Y coordinate axis.
     * @param enableZ - If `false`, this rigid-body will no longer translate due to torques and impulses, along the Z coordinate axis.
     * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
     */
    setEnabledTranslations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean): void;
    /**
     * Locks or unlocks the ability of this rigid-body to translate along individual coordinate axes.
     *
     * @param enableX - If `false`, this rigid-body will no longer translate due to torques and impulses, along the X coordinate axis.
     * @param enableY - If `false`, this rigid-body will no longer translate due to torques and impulses, along the Y coordinate axis.
     * @param enableZ - If `false`, this rigid-body will no longer translate due to torques and impulses, along the Z coordinate axis.
     * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
     * @deprecated use `this.setEnabledTranslations` with the same arguments instead.
     */
    restrictTranslations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean): void;
    /**
     * Locks or unlocks the ability of this rigid-body to rotate along individual coordinate axes.
     *
     * @param enableX - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the X coordinate axis.
     * @param enableY - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the Y coordinate axis.
     * @param enableZ - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the Z coordinate axis.
     * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
     */
    setEnabledRotations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean): void;
    /**
     * Locks or unlocks the ability of this rigid-body to rotate along individual coordinate axes.
     *
     * @param enableX - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the X coordinate axis.
     * @param enableY - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the Y coordinate axis.
     * @param enableZ - If `false`, this rigid-body will no longer rotate due to torques and impulses, along the Z coordinate axis.
     * @param wakeUp - If `true`, this rigid-body will be automatically awaken if it is currently asleep.
     * @deprecated use `this.setEnabledRotations` with the same arguments instead.
     */
    restrictRotations(enableX: boolean, enableY: boolean, enableZ: boolean, wakeUp: boolean): void;
    /**
     * The dominance group, in [-127, +127] this rigid-body is part of.
     */
    dominanceGroup(): number;
    /**
     * Sets the dominance group of this rigid-body.
     *
     * @param group - The dominance group of this rigid-body. Must be a signed integer in the range [-127, +127].
     */
    setDominanceGroup(group: number): void;
    /**
     * The number of additional solver iterations that will be run for this
     * rigid-body and everything that interacts with it directly or indirectly
     * through contacts or joints.
     */
    additionalSolverIterations(): number;
    /**
     * Sets the number of additional solver iterations that will be run for this
     * rigid-body and everything that interacts with it directly or indirectly
     * through contacts or joints.
     *
     * Compared to increasing the global `World.numSolverIteration`, setting this
     * value lets you increase accuracy on only a subset of the scene, resulting in reduced
     * performance loss.
     *
     * @param iters - The new number of additional solver iterations (default: 0).
     */
    setAdditionalSolverIterations(iters: number): void;
    /**
     * Enable or disable CCD (Continuous Collision Detection) for this rigid-body.
     *
     * @param enabled - If `true`, CCD will be enabled for this rigid-body.
     */
    enableCcd(enabled: boolean): void;
    /**
     * Sets the soft-CCD prediction distance for this rigid-body.
     *
     * See the documentation of `RigidBodyDesc.setSoftCcdPrediction` for
     * additional details.
     */
    setSoftCcdPrediction(distance: number): void;
    /**
     * Gets the soft-CCD prediction distance for this rigid-body.
     *
     * See the documentation of `RigidBodyDesc.setSoftCcdPrediction` for
     * additional details.
     */
    softCcdPrediction(): number;
    /**
     * The world-space translation of this rigid-body.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    translation(target?: Vector): Vector;
    /**
     * The world-space orientation of this rigid-body.
     *
     * @param {Rotation?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    rotation(target?: Rotation): Rotation;
    /**
     * The world-space next translation of this rigid-body.
     *
     * If this rigid-body is kinematic this value is set by the `setNextKinematicTranslation`
     * method and is used for estimating the kinematic body velocity at the next timestep.
     * For non-kinematic bodies, this value is currently unspecified.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    nextTranslation(target?: Vector): Vector;
    /**
     * The world-space next orientation of this rigid-body.
     *
     * If this rigid-body is kinematic this value is set by the `setNextKinematicRotation`
     * method and is used for estimating the kinematic body velocity at the next timestep.
     * For non-kinematic bodies, this value is currently unspecified.
     *
     * @param {Rotation?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    nextRotation(target?: Rotation): Rotation;
    /**
     * Sets the translation of this rigid-body.
     *
     * @param tra - The world-space position of the rigid-body.
     * @param wakeUp - Forces the rigid-body to wake-up so it is properly affected by forces if it
     *                 wasn't moving before modifying its position.
     */
    setTranslation(tra: Vector, wakeUp: boolean): void;
    /**
     * Sets the linear velocity of this rigid-body.
     *
     * @param vel - The linear velocity to set.
     * @param wakeUp - Forces the rigid-body to wake-up if it was asleep.
     */
    setLinvel(vel: Vector, wakeUp: boolean): void;
    /**
     * The scale factor applied to the gravity affecting
     * this rigid-body.
     */
    gravityScale(): number;
    /**
     * Sets the scale factor applied to the gravity affecting
     * this rigid-body.
     *
     * @param factor - The scale factor to set. A value of 0.0 means
     *   that this rigid-body will on longer be affected by gravity.
     * @param wakeUp - Forces the rigid-body to wake-up if it was asleep.
     */
    setGravityScale(factor: number, wakeUp: boolean): void;
    /**
     * Sets the rotation quaternion of this rigid-body.
     *
     * This does nothing if a zero quaternion is provided.
     *
     * @param rotation - The rotation to set.
     * @param wakeUp - Forces the rigid-body to wake-up so it is properly affected by forces if it
     * wasn't moving before modifying its position.
     */
    setRotation(rot: Rotation, wakeUp: boolean): void;
    /**
     * Sets the angular velocity for this rigid-body.
     *
     * @param vel - The angular velocity to set.
     * @param wakeUp - Forces the rigid-body to wake-up if it was asleep.
     */
    setAngvel(vel: Vector, wakeUp: boolean): void;
    /**
     * If this rigid body is kinematic, sets its future translation after the next timestep integration.
     *
     * This should be used instead of `rigidBody.setTranslation` to make the dynamic object
     * interacting with this kinematic body behave as expected. Internally, Rapier will compute
     * an artificial velocity for this rigid-body from its current position and its next kinematic
     * position. This velocity will be used to compute forces on dynamic bodies interacting with
     * this body.
     *
     * @param t - The kinematic translation to set.
     */
    setNextKinematicTranslation(t: Vector): void;
    /**
     * If this rigid body is kinematic, sets its future rotation after the next timestep integration.
     *
     * This should be used instead of `rigidBody.setRotation` to make the dynamic object
     * interacting with this kinematic body behave as expected. Internally, Rapier will compute
     * an artificial velocity for this rigid-body from its current position and its next kinematic
     * position. This velocity will be used to compute forces on dynamic bodies interacting with
     * this body.
     *
     * @param rot - The kinematic rotation to set.
     */
    setNextKinematicRotation(rot: Rotation): void;
    /**
     * The linear velocity of this rigid-body.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    linvel(target?: Vector): Vector;
    /**
     * The velocity of the given world-space point on this rigid-body.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    velocityAtPoint(point: Vector, target?: Vector): Vector;
    /**
     * The angular velocity of this rigid-body.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    angvel(target?: Vector): Vector;
    /**
     * The mass of this rigid-body.
     */
    mass(): number;
    /**
     * The inverse mass taking into account translation locking.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    effectiveInvMass(target?: Vector): Vector;
    /**
     * The inverse of the mass of a rigid-body.
     *
     * If this is zero, the rigid-body is assumed to have infinite mass.
     */
    invMass(): number;
    /**
     * The center of mass of a rigid-body expressed in its local-space.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    localCom(target?: Vector): Vector;
    /**
     * The world-space center of mass of the rigid-body.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    worldCom(target?: Vector): Vector;
    /**
     * The inverse of the principal angular inertia of the rigid-body.
     *
     * Components set to zero are assumed to be infinite along the corresponding principal axis.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    invPrincipalInertia(target?: Vector): Vector;
    /**
     * The angular inertia along the principal inertia axes of the rigid-body.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    principalInertia(target?: Vector): Vector;
    /**
     * The principal vectors of the local angular inertia tensor of the rigid-body.
     *
     * @param {Rotation?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    principalInertiaLocalFrame(target?: Rotation): Rotation;
    /**
     * The world-space inverse angular inertia tensor of the rigid-body,
     * taking into account rotation locking.
     *
     * @param {SdpMatrix3?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    effectiveWorldInvInertia(target?: SdpMatrix3): SdpMatrix3;
    /**
     * The effective world-space angular inertia (that takes the potential rotation locking into account) of
     * this rigid-body.
     *
     * @param {SdpMatrix3?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    effectiveAngularInertia(target?: SdpMatrix3): SdpMatrix3;
    /**
     * Put this rigid body to sleep.
     *
     * A sleeping body no longer moves and is no longer simulated by the physics engine unless
     * it is waken up. It can be woken manually with `this.wakeUp()` or automatically due to
     * external forces like contacts.
     */
    sleep(): void;
    /**
     * Wakes this rigid-body up.
     *
     * A dynamic rigid-body that does not move during several consecutive frames will
     * be put to sleep by the physics engine, i.e., it will stop being simulated in order
     * to avoid useless computations.
     * This methods forces a sleeping rigid-body to wake-up. This is useful, e.g., before modifying
     * the position of a dynamic body so that it is properly simulated afterwards.
     */
    wakeUp(): void;
    /**
     * Is CCD enabled for this rigid-body?
     */
    isCcdEnabled(): boolean;
    /**
     * The number of colliders attached to this rigid-body.
     */
    numColliders(): number;
    /**
     * Retrieves the `i-th` collider attached to this rigid-body.
     *
     * @param i - The index of the collider to retrieve. Must be a number in `[0, this.numColliders()[`.
     *         This index is **not** the same as the unique identifier of the collider.
     */
    collider(i: number): Collider;
    /**
     * Sets whether this rigid-body is enabled or not.
     *
     * @param enabled - Set to `false` to disable this rigid-body and all its attached colliders.
     */
    setEnabled(enabled: boolean): void;
    /**
     * Is this rigid-body enabled?
     */
    isEnabled(): boolean;
    /**
     * The status of this rigid-body: static, dynamic, or kinematic.
     */
    bodyType(): RigidBodyType;
    /**
     * Set a new status for this rigid-body: static, dynamic, or kinematic.
     */
    setBodyType(type: RigidBodyType, wakeUp: boolean): void;
    /**
     * Is this rigid-body sleeping?
     */
    isSleeping(): boolean;
    /**
     * Is the velocity of this rigid-body not zero?
     */
    isMoving(): boolean;
    /**
     * Is this rigid-body static?
     */
    isFixed(): boolean;
    /**
     * Is this rigid-body kinematic?
     */
    isKinematic(): boolean;
    /**
     * Is this rigid-body dynamic?
     */
    isDynamic(): boolean;
    /**
     * The linear damping coefficient of this rigid-body.
     */
    linearDamping(): number;
    /**
     * The angular damping coefficient of this rigid-body.
     */
    angularDamping(): number;
    /**
     * Sets the linear damping factor applied to this rigid-body.
     *
     * @param factor - The damping factor to set.
     */
    setLinearDamping(factor: number): void;
    /**
     * Recompute the mass-properties of this rigid-bodies based on its currently attached colliders.
     */
    recomputeMassPropertiesFromColliders(): void;
    /**
     * Sets the rigid-body's additional mass.
     *
     * The total angular inertia of the rigid-body will be scaled automatically based on this additional mass. If this
     * scaling effect isn’t desired, use Self::additional_mass_properties instead of this method.
     *
     * This is only the "additional" mass because the total mass of the rigid-body is equal to the sum of this
     * additional mass and the mass computed from the colliders (with non-zero densities) attached to this rigid-body.
     *
     * That total mass (which includes the attached colliders’ contributions) will be updated at the name physics step,
     * or can be updated manually with `this.recomputeMassPropertiesFromColliders`.
     *
     * This will override any previous additional mass-properties set by `this.setAdditionalMass`,
     * `this.setAdditionalMassProperties`, `RigidBodyDesc::setAdditionalMass`, or
     * `RigidBodyDesc.setAdditionalMassfProperties` for this rigid-body.
     *
     * @param mass - The additional mass to set.
     * @param wakeUp - If `true` then the rigid-body will be woken up if it was put to sleep because it did not move for a while.
     */
    setAdditionalMass(mass: number, wakeUp: boolean): void;
    /**
     * Sets the rigid-body's additional mass-properties.
     *
     * This is only the "additional" mass-properties because the total mass-properties of the rigid-body is equal to the
     * sum of this additional mass-properties and the mass computed from the colliders (with non-zero densities) attached
     * to this rigid-body.
     *
     * That total mass-properties (which include the attached colliders’ contributions) will be updated at the name
     * physics step, or can be updated manually with `this.recomputeMassPropertiesFromColliders`.
     *
     * This will override any previous mass-properties set by `this.setAdditionalMass`,
     * `this.setAdditionalMassProperties`, `RigidBodyDesc.setAdditionalMass`, or `RigidBodyDesc.setAdditionalMassProperties`
     * for this rigid-body.
     *
     * If `wake_up` is true then the rigid-body will be woken up if it was put to sleep because it did not move for a while.
     */
    setAdditionalMassProperties(mass: number, centerOfMass: Vector, principalAngularInertia: Vector, angularInertiaLocalFrame: Rotation, wakeUp: boolean): void;
    /**
     * Sets the linear damping factor applied to this rigid-body.
     *
     * @param factor - The damping factor to set.
     */
    setAngularDamping(factor: number): void;
    /**
     * Resets to zero the user forces (but not torques) applied to this rigid-body.
     *
     * @param wakeUp - should the rigid-body be automatically woken-up?
     */
    resetForces(wakeUp: boolean): void;
    /**
     * Resets to zero the user torques applied to this rigid-body.
     *
     * @param wakeUp - should the rigid-body be automatically woken-up?
     */
    resetTorques(wakeUp: boolean): void;
    /**
     * Adds a force at the center-of-mass of this rigid-body.
     *
     * @param force - the world-space force to add to the rigid-body.
     * @param wakeUp - should the rigid-body be automatically woken-up?
     */
    addForce(force: Vector, wakeUp: boolean): void;
    /**
     * Applies an impulse at the center-of-mass of this rigid-body.
     *
     * @param impulse - the world-space impulse to apply on the rigid-body.
     * @param wakeUp - should the rigid-body be automatically woken-up?
     */
    applyImpulse(impulse: Vector, wakeUp: boolean): void;
    /**
     * Adds a torque at the center-of-mass of this rigid-body.
     *
     * @param torque - the world-space torque to add to the rigid-body.
     * @param wakeUp - should the rigid-body be automatically woken-up?
     */
    addTorque(torque: Vector, wakeUp: boolean): void;
    /**
     * Applies an impulsive torque at the center-of-mass of this rigid-body.
     *
     * @param torqueImpulse - the world-space torque impulse to apply on the rigid-body.
     * @param wakeUp - should the rigid-body be automatically woken-up?
     */
    applyTorqueImpulse(torqueImpulse: Vector, wakeUp: boolean): void;
    /**
     * Adds a force at the given world-space point of this rigid-body.
     *
     * @param force - the world-space force to add to the rigid-body.
     * @param point - the world-space point where the impulse is to be applied on the rigid-body.
     * @param wakeUp - should the rigid-body be automatically woken-up?
     */
    addForceAtPoint(force: Vector, point: Vector, wakeUp: boolean): void;
    /**
     * Applies an impulse at the given world-space point of this rigid-body.
     *
     * @param impulse - the world-space impulse to apply on the rigid-body.
     * @param point - the world-space point where the impulse is to be applied on the rigid-body.
     * @param wakeUp - should the rigid-body be automatically woken-up?
     */
    applyImpulseAtPoint(impulse: Vector, point: Vector, wakeUp: boolean): void;
    /**
     * Retrieves the constant force(s) the user added to this rigid-body
     * Returns zero if the rigid-body is not dynamic.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    userForce(target?: Vector): Vector;
    /**
     * Retrieves the constant torque(s) the user added to this rigid-body
     * Returns zero if the rigid-body is not dynamic.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    userTorque(target?: Vector): Vector;
}
declare class RigidBodyDesc {
    enabled: boolean;
    translation: Vector;
    rotation: Rotation;
    gravityScale: number;
    mass: number;
    massOnly: boolean;
    centerOfMass: Vector;
    translationsEnabledX: boolean;
    translationsEnabledY: boolean;
    linvel: Vector;
    angvel: Vector;
    principalAngularInertia: Vector;
    angularInertiaLocalFrame: Rotation;
    translationsEnabledZ: boolean;
    rotationsEnabledX: boolean;
    rotationsEnabledY: boolean;
    rotationsEnabledZ: boolean;
    linearDamping: number;
    angularDamping: number;
    status: RigidBodyType;
    canSleep: boolean;
    sleeping: boolean;
    ccdEnabled: boolean;
    softCcdPrediction: number;
    dominanceGroup: number;
    additionalSolverIterations: number;
    userData?: unknown;
    constructor(status: RigidBodyType);
    /**
     * A rigid-body descriptor used to build a dynamic rigid-body.
     */
    static dynamic(): RigidBodyDesc;
    /**
     * A rigid-body descriptor used to build a position-based kinematic rigid-body.
     */
    static kinematicPositionBased(): RigidBodyDesc;
    /**
     * A rigid-body descriptor used to build a velocity-based kinematic rigid-body.
     */
    static kinematicVelocityBased(): RigidBodyDesc;
    /**
     * A rigid-body descriptor used to build a fixed rigid-body.
     */
    static fixed(): RigidBodyDesc;
    /**
     * A rigid-body descriptor used to build a dynamic rigid-body.
     *
     * @deprecated The method has been renamed to `.dynamic()`.
     */
    static newDynamic(): RigidBodyDesc;
    /**
     * A rigid-body descriptor used to build a position-based kinematic rigid-body.
     *
     * @deprecated The method has been renamed to `.kinematicPositionBased()`.
     */
    static newKinematicPositionBased(): RigidBodyDesc;
    /**
     * A rigid-body descriptor used to build a velocity-based kinematic rigid-body.
     *
     * @deprecated The method has been renamed to `.kinematicVelocityBased()`.
     */
    static newKinematicVelocityBased(): RigidBodyDesc;
    /**
     * A rigid-body descriptor used to build a fixed rigid-body.
     *
     * @deprecated The method has been renamed to `.fixed()`.
     */
    static newStatic(): RigidBodyDesc;
    setDominanceGroup(group: number): RigidBodyDesc;
    /**
     * Sets the number of additional solver iterations that will be run for this
     * rigid-body and everything that interacts with it directly or indirectly
     * through contacts or joints.
     *
     * Compared to increasing the global `World.numSolverIteration`, setting this
     * value lets you increase accuracy on only a subset of the scene, resulting in reduced
     * performance loss.
     *
     * @param iters - The new number of additional solver iterations (default: 0).
     */
    setAdditionalSolverIterations(iters: number): RigidBodyDesc;
    /**
     * Sets whether the created rigid-body will be enabled or disabled.
     * @param enabled − If set to `false` the rigid-body will be disabled at creation.
     */
    setEnabled(enabled: boolean): RigidBodyDesc;
    /**
     * Sets the initial translation of the rigid-body to create.
     *
     * @param tra - The translation to set.
     */
    setTranslation(x: number, y: number, z: number): RigidBodyDesc;
    /**
     * Sets the initial rotation of the rigid-body to create.
     *
     * @param rot - The rotation to set.
     */
    setRotation(rot: Rotation): RigidBodyDesc;
    /**
     * Sets the scale factor applied to the gravity affecting
     * the rigid-body being built.
     *
     * @param scale - The scale factor. Set this to `0.0` if the rigid-body
     *   needs to ignore gravity.
     */
    setGravityScale(scale: number): RigidBodyDesc;
    /**
     * Sets the initial mass of the rigid-body being built, before adding colliders' contributions.
     *
     * @param mass − The initial mass of the rigid-body to create.
     */
    setAdditionalMass(mass: number): RigidBodyDesc;
    /**
     * Sets the initial linear velocity of the rigid-body to create.
     *
     * @param x - The linear velocity to set along the `x` axis.
     * @param y - The linear velocity to set along the `y` axis.
     * @param z - The linear velocity to set along the `z` axis.
     */
    setLinvel(x: number, y: number, z: number): RigidBodyDesc;
    /**
     * Sets the initial angular velocity of the rigid-body to create.
     *
     * @param vel - The angular velocity to set.
     */
    setAngvel(vel: Vector): RigidBodyDesc;
    /**
     * Sets the mass properties of the rigid-body being built.
     *
     * Note that the final mass properties of the rigid-bodies depends
     * on the initial mass-properties of the rigid-body (set by this method)
     * to which is added the contributions of all the colliders with non-zero density
     * attached to this rigid-body.
     *
     * Therefore, if you want your provided mass properties to be the final
     * mass properties of your rigid-body, don't attach colliders to it, or
     * only attach colliders with densities equal to zero.
     *
     * @param mass − The initial mass of the rigid-body to create.
     * @param centerOfMass − The initial center-of-mass of the rigid-body to create.
     * @param principalAngularInertia − The initial principal angular inertia of the rigid-body to create.
     *                                  These are the eigenvalues of the angular inertia matrix.
     * @param angularInertiaLocalFrame − The initial local angular inertia frame of the rigid-body to create.
     *                                   These are the eigenvectors of the angular inertia matrix.
     */
    setAdditionalMassProperties(mass: number, centerOfMass: Vector, principalAngularInertia: Vector, angularInertiaLocalFrame: Rotation): RigidBodyDesc;
    /**
     * Allow translation of this rigid-body only along specific axes.
     * @param translationsEnabledX - Are translations along the X axis enabled?
     * @param translationsEnabledY - Are translations along the y axis enabled?
     * @param translationsEnabledZ - Are translations along the Z axis enabled?
     */
    enabledTranslations(translationsEnabledX: boolean, translationsEnabledY: boolean, translationsEnabledZ: boolean): RigidBodyDesc;
    /**
     * Allow translation of this rigid-body only along specific axes.
     * @param translationsEnabledX - Are translations along the X axis enabled?
     * @param translationsEnabledY - Are translations along the y axis enabled?
     * @param translationsEnabledZ - Are translations along the Z axis enabled?
     * @deprecated use `this.enabledTranslations` with the same arguments instead.
     */
    restrictTranslations(translationsEnabledX: boolean, translationsEnabledY: boolean, translationsEnabledZ: boolean): RigidBodyDesc;
    /**
     * Locks all translations that would have resulted from forces on
     * the created rigid-body.
     */
    lockTranslations(): RigidBodyDesc;
    /**
     * Allow rotation of this rigid-body only along specific axes.
     * @param rotationsEnabledX - Are rotations along the X axis enabled?
     * @param rotationsEnabledY - Are rotations along the y axis enabled?
     * @param rotationsEnabledZ - Are rotations along the Z axis enabled?
     */
    enabledRotations(rotationsEnabledX: boolean, rotationsEnabledY: boolean, rotationsEnabledZ: boolean): RigidBodyDesc;
    /**
     * Allow rotation of this rigid-body only along specific axes.
     * @param rotationsEnabledX - Are rotations along the X axis enabled?
     * @param rotationsEnabledY - Are rotations along the y axis enabled?
     * @param rotationsEnabledZ - Are rotations along the Z axis enabled?
     * @deprecated use `this.enabledRotations` with the same arguments instead.
     */
    restrictRotations(rotationsEnabledX: boolean, rotationsEnabledY: boolean, rotationsEnabledZ: boolean): RigidBodyDesc;
    /**
     * Locks all rotations that would have resulted from forces on
     * the created rigid-body.
     */
    lockRotations(): RigidBodyDesc;
    /**
     * Sets the linear damping of the rigid-body to create.
     *
     * This will progressively slowdown the translational movement of the rigid-body.
     *
     * @param damping - The angular damping coefficient. Should be >= 0. The higher this
     *                  value is, the stronger the translational slowdown will be.
     */
    setLinearDamping(damping: number): RigidBodyDesc;
    /**
     * Sets the angular damping of the rigid-body to create.
     *
     * This will progressively slowdown the rotational movement of the rigid-body.
     *
     * @param damping - The angular damping coefficient. Should be >= 0. The higher this
     *                  value is, the stronger the rotational slowdown will be.
     */
    setAngularDamping(damping: number): RigidBodyDesc;
    /**
     * Sets whether or not the rigid-body to create can sleep.
     *
     * @param can - true if the rigid-body can sleep, false if it can't.
     */
    setCanSleep(can: boolean): RigidBodyDesc;
    /**
     * Sets whether or not the rigid-body is to be created asleep.
     *
     * @param can - true if the rigid-body should be in sleep, default false.
     */
    setSleeping(sleeping: boolean): RigidBodyDesc;
    /**
     * Sets whether Continuous Collision Detection (CCD) is enabled for this rigid-body.
     *
     * @param enabled - true if the rigid-body has CCD enabled.
     */
    setCcdEnabled(enabled: boolean): RigidBodyDesc;
    /**
     * Sets the maximum prediction distance Soft Continuous Collision-Detection.
     *
     * When set to 0, soft-CCD is disabled. Soft-CCD helps prevent tunneling especially of
     * slow-but-thin to moderately fast objects. The soft CCD prediction distance indicates how
     * far in the object’s path the CCD algorithm is allowed to inspect. Large values can impact
     * performance badly by increasing the work needed from the broad-phase.
     *
     * It is a generally cheaper variant of regular CCD (that can be enabled with
     * `RigidBodyDesc::setCcdEnabled` since it relies on predictive constraints instead of
     * shape-cast and substeps.
     */
    setSoftCcdPrediction(distance: number): RigidBodyDesc;
    /**
     * Sets the user-defined object of this rigid-body.
     *
     * @param userData - The user-defined object to set.
     */
    setUserData(data?: unknown): RigidBodyDesc;
}

/**
 * The integer identifier of a collider added to a `ColliderSet`.
 */
type ImpulseJointHandle = number;
/**
 * An enum grouping all possible types of joints:
 *
 * - `Revolute`: A revolute joint that removes all degrees of freedom between the affected
 *               bodies except for the rotation along one axis.
 * - `Fixed`: A fixed joint that removes all relative degrees of freedom between the affected bodies.
 * - `Prismatic`: A prismatic joint that removes all degrees of freedom between the affected
 *                bodies except for the translation along one axis.
 * - `Spherical`: (3D only) A spherical joint that removes all relative linear degrees of freedom between the affected bodies.
 * - `Generic`: (3D only) A joint with customizable degrees of freedom, allowing any of the 6 axes to be locked.
 */
declare enum JointType {
    Revolute = 0,
    Fixed = 1,
    Prismatic = 2,
    Rope = 3,
    Spring = 4,
    Spherical = 5,
    Generic = 6
}
declare enum MotorModel {
    AccelerationBased = 0,
    ForceBased = 1
}
/**
 * An enum representing a single joint axis, used to configure per-axis joint
 * properties like the motors of a spherical joint.
 */
declare enum JointAxis {
    LinX = 0,
    LinY = 1,
    LinZ = 2,
    AngX = 3,
    AngY = 4,
    AngZ = 5
}
/**
 * An enum representing the possible joint axes of a generic joint.
 * They can be ORed together, like:
 * JointAxesMask.LinX || JointAxesMask.LinY
 * to get a joint that is only free in the X and Y translational (positional) axes.
 *
 * Possible free axes are:
 *
 * - `X`: X translation axis
 * - `Y`: Y translation axis
 * - `Z`: Z translation axis
 * - `AngX`: X angular rotation axis
 * - `AngY`: Y angular rotations axis
 * - `AngZ`: Z angular rotation axis
 */
declare enum JointAxesMask {
    LinX = 1,
    LinY = 2,
    LinZ = 4,
    AngX = 8,
    AngY = 16,
    AngZ = 32
}
declare class ImpulseJoint {
    protected rawSet: RawImpulseJointSet;
    protected bodySet: RigidBodySet;
    handle: ImpulseJointHandle;
    constructor(rawSet: RawImpulseJointSet, bodySet: RigidBodySet, handle: ImpulseJointHandle);
    static newTyped(rawSet: RawImpulseJointSet, bodySet: RigidBodySet, handle: ImpulseJointHandle): ImpulseJoint;
    /** @internal */
    finalizeDeserialization(bodySet: RigidBodySet): void;
    /**
     * Checks if this joint is still valid (i.e. that it has
     * not been deleted from the joint set yet).
     */
    isValid(): boolean;
    /**
     * The first rigid-body this joint it attached to.
     */
    body1(): RigidBody;
    /**
     * The second rigid-body this joint is attached to.
     */
    body2(): RigidBody;
    /**
     * The type of this joint given as a string.
     */
    type(): JointType;
    /**
     * The rotation quaternion that aligns this joint's first local axis to the `x` axis.
     *
     * @param {Rotation?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    frameX1(target?: Rotation): Rotation;
    /**
     * The rotation matrix that aligns this joint's second local axis to the `x` axis.
     *
     * @param {Rotation?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    frameX2(target?: Rotation): Rotation;
    /**
     * The position of the first anchor of this joint.
     *
     * The first anchor gives the position of the application point on the
     * local frame of the first rigid-body it is attached to.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    anchor1(target?: Vector): Vector;
    /**
     * The position of the second anchor of this joint.
     *
     * The second anchor gives the position of the application point on the
     * local frame of the second rigid-body it is attached to.
     *
     * @param {Vector?} target - The object to be populated. If provided,
     * the function returns this object instead of creating a new one.
     */
    anchor2(target?: Vector): Vector;
    /**
     * Sets the position of the first anchor of this joint.
     *
     * The first anchor gives the position of the application point on the
     * local frame of the first rigid-body it is attached to.
     */
    setAnchor1(newPos: Vector): void;
    /**
     * Sets the position of the second anchor of this joint.
     *
     * The second anchor gives the position of the application point on the
     * local frame of the second rigid-body it is attached to.
     */
    setAnchor2(newPos: Vector): void;
    /**
     * Sets the rotation quaternion that aligns this joint's first local axis to the `x` axis.
     */
    setFrameX1(rot: Rotation): void;
    /**
     * Sets the rotation quaternion that aligns this joint's second local axis to the `x` axis.
     */
    setFrameX2(rot: Rotation): void;
    /**
     * Sets the full local frame (anchor position and rotation) for the first rigid-body attachment.
     */
    setLocalFrame1(anchor: Vector, rot: Rotation): void;
    /**
     * Sets the full local frame (anchor position and rotation) for the second rigid-body attachment.
     */
    setLocalFrame2(anchor: Vector, rot: Rotation): void;
    /**
     * Controls whether contacts are computed between colliders attached
     * to the rigid-bodies linked by this joint.
     */
    setContactsEnabled(enabled: boolean): void;
    /**
     * Indicates if contacts are enabled between colliders attached
     * to the rigid-bodies linked by this joint.
     */
    contactsEnabled(): boolean;
}
declare class UnitImpulseJoint extends ImpulseJoint {
    /**
     * The axis left free by this joint.
     */
    protected rawAxis?(): RawJointAxis;
    /**
     * Are the limits enabled for this joint?
     */
    limitsEnabled(): boolean;
    /**
     * The min limit of this joint.
     */
    limitsMin(): number;
    /**
     * The max limit of this joint.
     */
    limitsMax(): number;
    /**
     * Sets the limits of this joint.
     *
     * @param min - The minimum bound of this joint’s free coordinate.
     * @param max - The maximum bound of this joint’s free coordinate.
     */
    setLimits(min: number, max: number): void;
    configureMotorModel(model: MotorModel): void;
    setMotorMaxForce(maxForce: number): void;
    configureMotorVelocity(targetVel: number, factor: number): void;
    configureMotorPosition(targetPos: number, stiffness: number, damping: number): void;
    configureMotor(targetPos: number, targetVel: number, stiffness: number, damping: number): void;
}
declare class FixedImpulseJoint extends ImpulseJoint {
}
declare class RopeImpulseJoint extends ImpulseJoint {
}
declare class SpringImpulseJoint extends ImpulseJoint {
}
declare class PrismaticImpulseJoint extends UnitImpulseJoint {
    rawAxis(): RawJointAxis;
}
declare class RevoluteImpulseJoint extends UnitImpulseJoint {
    rawAxis(): RawJointAxis;
}
declare class GenericImpulseJoint extends ImpulseJoint {
}
declare class SphericalImpulseJoint extends ImpulseJoint {
    /**
     * Sets the motor model of one of this joint's angular axes.
     *
     * @param axis - The angular axis (`JointAxis.AngX/AngY/AngZ`) to configure.
     * @param model - The motor model to apply to that axis.
     */
    configureMotorModel(axis: JointAxis, model: MotorModel): void;
    /**
     * Sets the maximum force/torque the motor of the given angular axis can deliver.
     *
     * @param axis - The angular axis (`JointAxis.AngX/AngY/AngZ`) to configure.
     * @param maxForce - The maximum torque the axis motor can deliver.
     */
    setMotorMaxForce(axis: JointAxis, maxForce: number): void;
    /**
     * Makes the motor of the given angular axis target a specific angular velocity.
     *
     * @param axis - The angular axis (`JointAxis.AngX/AngY/AngZ`) to configure.
     * @param targetVel - The target angular velocity along the axis, in radians per second.
     * @param factor - The strength used to reach the target velocity (a damping coefficient).
     */
    configureMotorVelocity(axis: JointAxis, targetVel: number, factor: number): void;
    /**
     * Makes the motor of the given angular axis target a specific angle.
     *
     * @param axis - The angular axis (`JointAxis.AngX/AngY/AngZ`) to configure.
     * @param targetPos - The target angle along the axis, in radians.
     * @param stiffness - The spring-like stiffness used to reach the target angle.
     * @param damping - The damping applied to the axis' angular velocity.
     */
    configureMotorPosition(axis: JointAxis, targetPos: number, stiffness: number, damping: number): void;
    /**
     * Configures the motor of the given angular axis with both an angle and an
     * angular-velocity target.
     *
     * @param axis - The angular axis (`JointAxis.AngX/AngY/AngZ`) to configure.
     * @param targetPos - The target angle along the axis, in radians.
     * @param targetVel - The target angular velocity along the axis, in radians per second.
     * @param stiffness - The spring-like stiffness used to reach the target angle.
     * @param damping - The damping applied to the axis' angular velocity.
     */
    configureMotor(axis: JointAxis, targetPos: number, targetVel: number, stiffness: number, damping: number): void;
}
declare class JointData {
    anchor1: Vector;
    anchor2: Vector;
    axis: Vector;
    axis1: Vector;
    axis2: Vector;
    frame1: Rotation;
    frame2: Rotation;
    jointType: JointType;
    limitsEnabled: boolean;
    limits: Array<number>;
    axesMask: JointAxesMask;
    stiffness: number;
    damping: number;
    length: number;
    private constructor();
    /**
     * Creates a new joint descriptor that builds a Fixed joint.
     *
     * A fixed joint removes all the degrees of freedom between the affected bodies, ensuring their
     * anchor and local frames coincide in world-space.
     *
     * @param anchor1 - Point where the joint is attached on the first rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param frame1 - The reference orientation of the joint wrt. the first rigid-body.
     * @param anchor2 - Point where the joint is attached on the second rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param frame2 - The reference orientation of the joint wrt. the second rigid-body.
     */
    static fixed(anchor1: Vector, frame1: Rotation, anchor2: Vector, frame2: Rotation): JointData;
    static spring(rest_length: number, stiffness: number, damping: number, anchor1: Vector, anchor2: Vector): JointData;
    static rope(length: number, anchor1: Vector, anchor2: Vector): JointData;
    /**
     * Create a new joint descriptor that builds generic joints.
     *
     * A generic joint allows customizing its degrees of freedom
     * by supplying a mask of the joint axes that should remain locked.
     *
     * @param anchor1 - Point where the joint is attached on the first rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param anchor2 - Point where the joint is attached on the second rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param axis - The X axis of the joint, expressed in the local-space of the rigid-bodies it is attached to.
     * @param axesMask - Mask representing the locked axes of the joint. You can use logical OR to select these from
     *                   the JointAxesMask enum. For example, passing (JointAxesMask.AngX || JointAxesMask.AngY) will
     *                   create a joint locked in the X and Y rotational axes.
     */
    static generic(anchor1: Vector, anchor2: Vector, axis: Vector, axesMask: JointAxesMask): JointData;
    /**
     * Create a new joint descriptor that builds spherical joints.
     *
     * A spherical joint allows three relative rotational degrees of freedom
     * by preventing any relative translation between the anchors of the
     * two attached rigid-bodies.
     *
     * @param anchor1 - Point where the joint is attached on the first rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param anchor2 - Point where the joint is attached on the second rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     */
    static spherical(anchor1: Vector, anchor2: Vector): JointData;
    /**
     * Creates a new joint descriptor that builds a Prismatic joint.
     *
     * A prismatic joint removes all the degrees of freedom between the
     * affected bodies, except for the translation along one axis.
     *
     * @param anchor1 - Point where the joint is attached on the first rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param anchor2 - Point where the joint is attached on the second rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param axis - Axis of the joint, expressed in the local-space of the rigid-bodies it is attached to.
     */
    static prismatic(anchor1: Vector, anchor2: Vector, axis: Vector): JointData;
    /**
     * Create a new joint descriptor that builds Revolute joints.
     *
     * A revolute joint removes all degrees of freedom between the affected
     * bodies except for the rotation along one axis.
     *
     * @param anchor1 - Point where the joint is attached on the first rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param anchor2 - Point where the joint is attached on the second rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param axis - Axis of the joint, expressed in the local-space of the rigid-bodies it is attached to.
     */
    static revolute(anchor1: Vector, anchor2: Vector, axis: Vector): JointData;
    /**
     * Create a new joint descriptor that builds Revolute joints with independent
     * local axes for each attached rigid-body.
     *
     * This is useful when the same world-space hinge axis is represented by
     * different local axes on the two bodies.
     *
     * @param anchor1 - Point where the joint is attached on the first rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param anchor2 - Point where the joint is attached on the second rigid-body affected by this joint. Expressed in the
     *                  local-space of the rigid-body.
     * @param axis1 - Axis of the joint, expressed in the local-space of the first rigid-body.
     * @param axis2 - Axis of the joint, expressed in the local-space of the second rigid-body.
     */
    static revoluteWithAxes(anchor1: Vector, anchor2: Vector, axis1: Vector, axis2: Vector): JointData;
    intoRaw(): RawGenericJoint;
}

/**
 * A set of joints.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `jointSet.free()`
 * once you are done using it (and all the joints it created).
 */
declare class ImpulseJointSet {
    raw: RawImpulseJointSet;
    private map;
    /**
     * Release the WASM memory occupied by this joint set.
     */
    free(): void;
    constructor(raw?: RawImpulseJointSet);
    /** @internal */
    finalizeDeserialization(bodies: RigidBodySet): void;
    /**
     * Creates a new joint and return its integer handle.
     *
     * @param bodies - The set of rigid-bodies containing the bodies the joint is attached to.
     * @param desc - The joint's parameters.
     * @param parent1 - The handle of the first rigid-body this joint is attached to.
     * @param parent2 - The handle of the second rigid-body this joint is attached to.
     * @param wakeUp - Should the attached rigid-bodies be awakened?
     */
    createJoint(bodies: RigidBodySet, desc: JointData, parent1: RigidBodyHandle, parent2: RigidBodyHandle, wakeUp: boolean): ImpulseJoint;
    /**
     * Remove a joint from this set.
     *
     * @param handle - The integer handle of the joint.
     * @param wakeUp - If `true`, the rigid-bodies attached by the removed joint will be woken-up automatically.
     */
    remove(handle: ImpulseJointHandle, wakeUp: boolean): void;
    /**
     * Calls the given closure with the integer handle of each impulse joint attached to this rigid-body.
     *
     * @param f - The closure called with the integer handle of each impulse joint attached to the rigid-body.
     */
    forEachJointHandleAttachedToRigidBody(handle: RigidBodyHandle, f: (handle: ImpulseJointHandle) => void): void;
    /**
     * Internal function, do not call directly.
     * @param handle
     */
    unmap(handle: ImpulseJointHandle): void;
    /**
     * The number of joints on this set.
     */
    len(): number;
    /**
     * Does this set contain a joint with the given handle?
     *
     * @param handle - The joint handle to check.
     */
    contains(handle: ImpulseJointHandle): boolean;
    /**
     * Gets the joint with the given handle.
     *
     * Returns `null` if no joint with the specified handle exists.
     *
     * @param handle - The integer handle of the joint to retrieve.
     */
    get(handle: ImpulseJointHandle): ImpulseJoint | null;
    /**
     * Applies the given closure to each joint contained by this set.
     *
     * @param f - The closure to apply.
     */
    forEach(f: (joint: ImpulseJoint) => void): void;
    /**
     * Gets all joints in the list.
     *
     * @returns joint list.
     */
    getAll(): ImpulseJoint[];
}

/**
 * The integer identifier of a collider added to a `ColliderSet`.
 */
type MultibodyJointHandle = number;
declare class MultibodyJoint {
    protected rawSet: RawMultibodyJointSet;
    handle: MultibodyJointHandle;
    constructor(rawSet: RawMultibodyJointSet, handle: MultibodyJointHandle);
    static newTyped(rawSet: RawMultibodyJointSet, handle: MultibodyJointHandle): MultibodyJoint;
    /**
     * Checks if this joint is still valid (i.e. that it has
     * not been deleted from the joint set yet).
     */
    isValid(): boolean;
    /**
     * Controls whether contacts are computed between colliders attached
     * to the rigid-bodies linked by this joint.
     */
    setContactsEnabled(enabled: boolean): void;
    /**
     * Indicates if contacts are enabled between colliders attached
     * to the rigid-bodies linked by this joint.
     */
    contactsEnabled(): boolean;
}
declare class UnitMultibodyJoint extends MultibodyJoint {
    /**
     * The axis left free by this joint.
     */
    protected rawAxis?(): RawJointAxis;
}
declare class FixedMultibodyJoint extends MultibodyJoint {
}
declare class PrismaticMultibodyJoint extends UnitMultibodyJoint {
    rawAxis(): RawJointAxis;
}
declare class RevoluteMultibodyJoint extends UnitMultibodyJoint {
    rawAxis(): RawJointAxis;
}
declare class SphericalMultibodyJoint extends MultibodyJoint {
}

/**
 * A set of joints.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `jointSet.free()`
 * once you are done using it (and all the joints it created).
 */
declare class MultibodyJointSet {
    raw: RawMultibodyJointSet;
    private map;
    /**
     * Release the WASM memory occupied by this joint set.
     */
    free(): void;
    constructor(raw?: RawMultibodyJointSet);
    /**
     * Creates a new joint and return its integer handle.
     *
     * @param desc - The joint's parameters.
     * @param parent1 - The handle of the first rigid-body this joint is attached to.
     * @param parent2 - The handle of the second rigid-body this joint is attached to.
     * @param wakeUp - Should the attached rigid-bodies be awakened?
     */
    createJoint(desc: JointData, parent1: RigidBodyHandle, parent2: RigidBodyHandle, wakeUp: boolean): MultibodyJoint;
    /**
     * Remove a joint from this set.
     *
     * @param handle - The integer handle of the joint.
     * @param wake_up - If `true`, the rigid-bodies attached by the removed joint will be woken-up automatically.
     */
    remove(handle: MultibodyJointHandle, wake_up: boolean): void;
    /**
     * Internal function, do not call directly.
     * @param handle
     */
    unmap(handle: MultibodyJointHandle): void;
    /**
     * The number of joints on this set.
     */
    len(): number;
    /**
     * Does this set contain a joint with the given handle?
     *
     * @param handle - The joint handle to check.
     */
    contains(handle: MultibodyJointHandle): boolean;
    /**
     * Gets the joint with the given handle.
     *
     * Returns `null` if no joint with the specified handle exists.
     *
     * @param handle - The integer handle of the joint to retrieve.
     */
    get(handle: MultibodyJointHandle): MultibodyJoint | null;
    /**
     * Applies the given closure to each joint contained by this set.
     *
     * @param f - The closure to apply.
     */
    forEach(f: (joint: MultibodyJoint) => void): void;
    /**
     * Calls the given closure with the integer handle of each multibody joint attached to this rigid-body.
     *
     * @param f - The closure called with the integer handle of each multibody joint attached to the rigid-body.
     */
    forEachJointHandleAttachedToRigidBody(handle: RigidBodyHandle, f: (handle: MultibodyJointHandle) => void): void;
    /**
     * Gets all joints in the list.
     *
     * @returns joint list.
     */
    getAll(): MultibodyJoint[];
}

/**
 * The CCD solver responsible for resolving Continuous Collision Detection.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `ccdSolver.free()`
 * once you are done using it.
 */
declare class IslandManager {
    raw: RawIslandManager;
    /**
     * Release the WASM memory occupied by this narrow-phase.
     */
    free(): void;
    constructor(raw?: RawIslandManager);
    /**
     * Applies the given closure to the handle of each active rigid-bodies contained by this set.
     *
     * A rigid-body is active if it is not sleeping, i.e., if it moved recently.
     *
     * @param f - The closure to apply.
     */
    forEachActiveRigidBodyHandle(f: (handle: RigidBodyHandle) => void): void;
}

/**
 * A set of rigid bodies that can be handled by a physics pipeline.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `rigidBodySet.free()`
 * once you are done using it (and all the rigid-bodies it created).
 */
declare class RigidBodySet {
    raw: RawRigidBodySet;
    private map;
    /**
     * Release the WASM memory occupied by this rigid-body set.
     */
    free(): void;
    constructor(raw?: RawRigidBodySet);
    /**
     * Internal method, do not call this explicitly.
     */
    finalizeDeserialization(colliderSet: ColliderSet): void;
    /**
     * Creates a new rigid-body and return its integer handle.
     *
     * @param desc - The description of the rigid-body to create.
     */
    createRigidBody(colliderSet: ColliderSet, desc: RigidBodyDesc): RigidBody;
    /**
     * Removes a rigid-body from this set.
     *
     * This will also remove all the colliders and joints attached to the rigid-body.
     *
     * @param handle - The integer handle of the rigid-body to remove.
     * @param colliders - The set of colliders that may contain colliders attached to the removed rigid-body.
     * @param impulseJoints - The set of impulse joints that may contain joints attached to the removed rigid-body.
     * @param multibodyJoints - The set of multibody joints that may contain joints attached to the removed rigid-body.
     */
    remove(handle: RigidBodyHandle, islands: IslandManager, colliders: ColliderSet, impulseJoints: ImpulseJointSet, multibodyJoints: MultibodyJointSet): void;
    /**
     * The number of rigid-bodies on this set.
     */
    len(): number;
    /**
     * Does this set contain a rigid-body with the given handle?
     *
     * @param handle - The rigid-body handle to check.
     */
    contains(handle: RigidBodyHandle): boolean;
    /**
     * Gets the rigid-body with the given handle.
     *
     * @param handle - The handle of the rigid-body to retrieve.
     */
    get(handle: RigidBodyHandle): RigidBody | null;
    /**
     * Applies the given closure to each rigid-body contained by this set.
     *
     * @param f - The closure to apply.
     */
    forEach(f: (body: RigidBody) => void): void;
    /**
     * Applies the given closure to each active rigid-bodies contained by this set.
     *
     * A rigid-body is active if it is not sleeping, i.e., if it moved recently.
     *
     * @param f - The closure to apply.
     */
    forEachActiveRigidBody(islands: IslandManager, f: (body: RigidBody) => void): void;
    /**
     * Gets all rigid-bodies in the list.
     *
     * @returns rigid-bodies list.
     */
    getAll(): RigidBody[];
}

declare class IntegrationParameters {
    raw: RawIntegrationParameters;
    constructor(raw?: RawIntegrationParameters);
    /**
     * Free the WASM memory used by these integration parameters.
     */
    free(): void;
    /**
     * The timestep length (default: `1.0 / 60.0`)
     */
    get dt(): number;
    /**
     * The Error Reduction Parameter in `[0, 1]` is the proportion of
     * the positional error to be corrected at each time step (default: `0.2`).
     */
    get contact_erp(): number;
    get lengthUnit(): number;
    /**
     * Normalized amount of penetration the engine won’t attempt to correct (default: `0.001m`).
     *
     * This threshold considered by the physics engine is this value multiplied by the `lengthUnit`.
     */
    get normalizedAllowedLinearError(): number;
    /**
     * The maximal normalized distance separating two objects that will generate predictive contacts (default: `0.002`).
     *
     * This threshold considered by the physics engine is this value multiplied by the `lengthUnit`.
     */
    get normalizedPredictionDistance(): number;
    /**
     * The number of solver iterations run by the constraints solver for calculating forces (default: `4`).
     */
    get numSolverIterations(): number;
    /**
     * Number of internal Project Gauss Seidel (PGS) iterations run at each solver iteration (default: `1`).
     */
    get numInternalPgsIterations(): number;
    /**
     * Maximum number of substeps performed by the  solver (default: `1`).
     */
    get maxCcdSubsteps(): number;
    set dt(value: number);
    set contact_natural_frequency(value: number);
    set lengthUnit(value: number);
    set normalizedAllowedLinearError(value: number);
    set normalizedPredictionDistance(value: number);
    /**
     * Sets the number of solver iterations run by the constraints solver for calculating forces (default: `4`).
     */
    set numSolverIterations(value: number);
    /**
     * Sets the number of internal Project Gauss Seidel (PGS) iterations run at each solver iteration (default: `1`).
     */
    set numInternalPgsIterations(value: number);
    set maxCcdSubsteps(value: number);
}

/**
 * A rule applied to combine coefficients.
 *
 * Use this when configuring the `ColliderDesc` to specify
 * how friction and restitution coefficient should be combined
 * in a contact.
 */
declare enum CoefficientCombineRule {
    Average = 0,
    Min = 1,
    Multiply = 2,
    Max = 3
}

/**
 * The CCD solver responsible for resolving Continuous Collision Detection.
 *
 * To avoid leaking WASM resources, this MUST be freed manually with `ccdSolver.free()`
 * once you are done using it.
 */
declare class CCDSolver {
    raw: RawCCDSolver;
    /**
     * Release the WASM memory occupied by this narrow-phase.
     */
    free(): void;
    constructor(raw?: RawCCDSolver);
}

declare function init(): Promise<void>;

declare function version(): string;
declare function reserveMemory(extraBytesCount: number): void;

type RAPIER_ActiveCollisionTypes = ActiveCollisionTypes;
declare const RAPIER_ActiveCollisionTypes: typeof ActiveCollisionTypes;
type RAPIER_ActiveEvents = ActiveEvents;
declare const RAPIER_ActiveEvents: typeof ActiveEvents;
type RAPIER_ActiveHooks = ActiveHooks;
declare const RAPIER_ActiveHooks: typeof ActiveHooks;
type RAPIER_Ball = Ball;
declare const RAPIER_Ball: typeof Ball;
type RAPIER_BroadPhase = BroadPhase;
declare const RAPIER_BroadPhase: typeof BroadPhase;
type RAPIER_CCDSolver = CCDSolver;
declare const RAPIER_CCDSolver: typeof CCDSolver;
type RAPIER_Capsule = Capsule;
declare const RAPIER_Capsule: typeof Capsule;
type RAPIER_CharacterCollision = CharacterCollision;
declare const RAPIER_CharacterCollision: typeof CharacterCollision;
type RAPIER_CoefficientCombineRule = CoefficientCombineRule;
declare const RAPIER_CoefficientCombineRule: typeof CoefficientCombineRule;
type RAPIER_Collider = Collider;
declare const RAPIER_Collider: typeof Collider;
type RAPIER_ColliderDesc = ColliderDesc;
declare const RAPIER_ColliderDesc: typeof ColliderDesc;
type RAPIER_ColliderHandle = ColliderHandle;
type RAPIER_ColliderSet = ColliderSet;
declare const RAPIER_ColliderSet: typeof ColliderSet;
type RAPIER_ColliderShapeCastHit = ColliderShapeCastHit;
declare const RAPIER_ColliderShapeCastHit: typeof ColliderShapeCastHit;
type RAPIER_Compound = Compound;
declare const RAPIER_Compound: typeof Compound;
type RAPIER_Cone = Cone;
declare const RAPIER_Cone: typeof Cone;
type RAPIER_ConvexPolyhedron = ConvexPolyhedron;
declare const RAPIER_ConvexPolyhedron: typeof ConvexPolyhedron;
type RAPIER_Cuboid = Cuboid;
declare const RAPIER_Cuboid: typeof Cuboid;
type RAPIER_Cylinder = Cylinder;
declare const RAPIER_Cylinder: typeof Cylinder;
type RAPIER_DebugRenderBuffers = DebugRenderBuffers;
declare const RAPIER_DebugRenderBuffers: typeof DebugRenderBuffers;
type RAPIER_DebugRenderPipeline = DebugRenderPipeline;
declare const RAPIER_DebugRenderPipeline: typeof DebugRenderPipeline;
type RAPIER_DynamicRayCastVehicleController = DynamicRayCastVehicleController;
declare const RAPIER_DynamicRayCastVehicleController: typeof DynamicRayCastVehicleController;
type RAPIER_EventQueue = EventQueue;
declare const RAPIER_EventQueue: typeof EventQueue;
type RAPIER_FeatureType = FeatureType;
declare const RAPIER_FeatureType: typeof FeatureType;
type RAPIER_FixedImpulseJoint = FixedImpulseJoint;
declare const RAPIER_FixedImpulseJoint: typeof FixedImpulseJoint;
type RAPIER_FixedMultibodyJoint = FixedMultibodyJoint;
declare const RAPIER_FixedMultibodyJoint: typeof FixedMultibodyJoint;
type RAPIER_GenericImpulseJoint = GenericImpulseJoint;
declare const RAPIER_GenericImpulseJoint: typeof GenericImpulseJoint;
type RAPIER_HalfSpace = HalfSpace;
declare const RAPIER_HalfSpace: typeof HalfSpace;
type RAPIER_HeightFieldFlags = HeightFieldFlags;
declare const RAPIER_HeightFieldFlags: typeof HeightFieldFlags;
type RAPIER_Heightfield = Heightfield;
declare const RAPIER_Heightfield: typeof Heightfield;
type RAPIER_ImpulseJoint = ImpulseJoint;
declare const RAPIER_ImpulseJoint: typeof ImpulseJoint;
type RAPIER_ImpulseJointHandle = ImpulseJointHandle;
type RAPIER_ImpulseJointSet = ImpulseJointSet;
declare const RAPIER_ImpulseJointSet: typeof ImpulseJointSet;
type RAPIER_IntegrationParameters = IntegrationParameters;
declare const RAPIER_IntegrationParameters: typeof IntegrationParameters;
type RAPIER_InteractionGroups = InteractionGroups;
type RAPIER_IslandManager = IslandManager;
declare const RAPIER_IslandManager: typeof IslandManager;
type RAPIER_JointAxesMask = JointAxesMask;
declare const RAPIER_JointAxesMask: typeof JointAxesMask;
type RAPIER_JointAxis = JointAxis;
declare const RAPIER_JointAxis: typeof JointAxis;
type RAPIER_JointData = JointData;
declare const RAPIER_JointData: typeof JointData;
type RAPIER_JointType = JointType;
declare const RAPIER_JointType: typeof JointType;
type RAPIER_KinematicCharacterController = KinematicCharacterController;
declare const RAPIER_KinematicCharacterController: typeof KinematicCharacterController;
type RAPIER_MassPropsMode = MassPropsMode;
declare const RAPIER_MassPropsMode: typeof MassPropsMode;
type RAPIER_MotorModel = MotorModel;
declare const RAPIER_MotorModel: typeof MotorModel;
type RAPIER_MultibodyJoint = MultibodyJoint;
declare const RAPIER_MultibodyJoint: typeof MultibodyJoint;
type RAPIER_MultibodyJointHandle = MultibodyJointHandle;
type RAPIER_MultibodyJointSet = MultibodyJointSet;
declare const RAPIER_MultibodyJointSet: typeof MultibodyJointSet;
type RAPIER_NarrowPhase = NarrowPhase;
declare const RAPIER_NarrowPhase: typeof NarrowPhase;
type RAPIER_PhysicsHooks = PhysicsHooks;
type RAPIER_PhysicsPipeline = PhysicsPipeline;
declare const RAPIER_PhysicsPipeline: typeof PhysicsPipeline;
type RAPIER_PidAxesMask = PidAxesMask;
declare const RAPIER_PidAxesMask: typeof PidAxesMask;
type RAPIER_PidController = PidController;
declare const RAPIER_PidController: typeof PidController;
type RAPIER_PointColliderProjection = PointColliderProjection;
declare const RAPIER_PointColliderProjection: typeof PointColliderProjection;
type RAPIER_PointProjection = PointProjection;
declare const RAPIER_PointProjection: typeof PointProjection;
type RAPIER_Polyline = Polyline;
declare const RAPIER_Polyline: typeof Polyline;
type RAPIER_PrismaticImpulseJoint = PrismaticImpulseJoint;
declare const RAPIER_PrismaticImpulseJoint: typeof PrismaticImpulseJoint;
type RAPIER_PrismaticMultibodyJoint = PrismaticMultibodyJoint;
declare const RAPIER_PrismaticMultibodyJoint: typeof PrismaticMultibodyJoint;
type RAPIER_Quaternion = Quaternion;
declare const RAPIER_Quaternion: typeof Quaternion;
type RAPIER_QueryFilterFlags = QueryFilterFlags;
declare const RAPIER_QueryFilterFlags: typeof QueryFilterFlags;
type RAPIER_Ray = Ray;
declare const RAPIER_Ray: typeof Ray;
type RAPIER_RayColliderHit = RayColliderHit;
declare const RAPIER_RayColliderHit: typeof RayColliderHit;
type RAPIER_RayColliderIntersection = RayColliderIntersection;
declare const RAPIER_RayColliderIntersection: typeof RayColliderIntersection;
type RAPIER_RayIntersection = RayIntersection;
declare const RAPIER_RayIntersection: typeof RayIntersection;
type RAPIER_RevoluteImpulseJoint = RevoluteImpulseJoint;
declare const RAPIER_RevoluteImpulseJoint: typeof RevoluteImpulseJoint;
type RAPIER_RevoluteMultibodyJoint = RevoluteMultibodyJoint;
declare const RAPIER_RevoluteMultibodyJoint: typeof RevoluteMultibodyJoint;
type RAPIER_RigidBody = RigidBody;
declare const RAPIER_RigidBody: typeof RigidBody;
type RAPIER_RigidBodyDesc = RigidBodyDesc;
declare const RAPIER_RigidBodyDesc: typeof RigidBodyDesc;
type RAPIER_RigidBodyHandle = RigidBodyHandle;
type RAPIER_RigidBodySet = RigidBodySet;
declare const RAPIER_RigidBodySet: typeof RigidBodySet;
type RAPIER_RigidBodyType = RigidBodyType;
declare const RAPIER_RigidBodyType: typeof RigidBodyType;
type RAPIER_RopeImpulseJoint = RopeImpulseJoint;
declare const RAPIER_RopeImpulseJoint: typeof RopeImpulseJoint;
type RAPIER_Rotation = Rotation;
type RAPIER_RotationOps = RotationOps;
declare const RAPIER_RotationOps: typeof RotationOps;
type RAPIER_RoundCone = RoundCone;
declare const RAPIER_RoundCone: typeof RoundCone;
type RAPIER_RoundConvexPolyhedron = RoundConvexPolyhedron;
declare const RAPIER_RoundConvexPolyhedron: typeof RoundConvexPolyhedron;
type RAPIER_RoundCuboid = RoundCuboid;
declare const RAPIER_RoundCuboid: typeof RoundCuboid;
type RAPIER_RoundCylinder = RoundCylinder;
declare const RAPIER_RoundCylinder: typeof RoundCylinder;
type RAPIER_RoundTriangle = RoundTriangle;
declare const RAPIER_RoundTriangle: typeof RoundTriangle;
type RAPIER_SdpMatrix3 = SdpMatrix3;
declare const RAPIER_SdpMatrix3: typeof SdpMatrix3;
type RAPIER_SdpMatrix3Ops = SdpMatrix3Ops;
declare const RAPIER_SdpMatrix3Ops: typeof SdpMatrix3Ops;
type RAPIER_Segment = Segment;
declare const RAPIER_Segment: typeof Segment;
type RAPIER_SerializationPipeline = SerializationPipeline;
declare const RAPIER_SerializationPipeline: typeof SerializationPipeline;
type RAPIER_Shape = Shape;
declare const RAPIER_Shape: typeof Shape;
type RAPIER_ShapeCastHit = ShapeCastHit;
declare const RAPIER_ShapeCastHit: typeof ShapeCastHit;
type RAPIER_ShapeContact = ShapeContact;
declare const RAPIER_ShapeContact: typeof ShapeContact;
type RAPIER_ShapeType = ShapeType;
declare const RAPIER_ShapeType: typeof ShapeType;
type RAPIER_SharedColliderGeometry = SharedColliderGeometry;
type RAPIER_SolverFlags = SolverFlags;
declare const RAPIER_SolverFlags: typeof SolverFlags;
type RAPIER_SphericalImpulseJoint = SphericalImpulseJoint;
declare const RAPIER_SphericalImpulseJoint: typeof SphericalImpulseJoint;
type RAPIER_SphericalMultibodyJoint = SphericalMultibodyJoint;
declare const RAPIER_SphericalMultibodyJoint: typeof SphericalMultibodyJoint;
type RAPIER_SpringImpulseJoint = SpringImpulseJoint;
declare const RAPIER_SpringImpulseJoint: typeof SpringImpulseJoint;
type RAPIER_TempContactForceEvent = TempContactForceEvent;
declare const RAPIER_TempContactForceEvent: typeof TempContactForceEvent;
type RAPIER_TempContactManifold = TempContactManifold;
declare const RAPIER_TempContactManifold: typeof TempContactManifold;
type RAPIER_TriMesh = TriMesh;
declare const RAPIER_TriMesh: typeof TriMesh;
type RAPIER_TriMeshFlags = TriMeshFlags;
declare const RAPIER_TriMeshFlags: typeof TriMeshFlags;
type RAPIER_Triangle = Triangle;
declare const RAPIER_Triangle: typeof Triangle;
type RAPIER_UnitImpulseJoint = UnitImpulseJoint;
declare const RAPIER_UnitImpulseJoint: typeof UnitImpulseJoint;
type RAPIER_UnitMultibodyJoint = UnitMultibodyJoint;
declare const RAPIER_UnitMultibodyJoint: typeof UnitMultibodyJoint;
type RAPIER_VHACDParameters = VHACDParameters;
type RAPIER_Vector = Vector;
type RAPIER_Vector3 = Vector3;
declare const RAPIER_Vector3: typeof Vector3;
type RAPIER_VectorOps = VectorOps;
declare const RAPIER_VectorOps: typeof VectorOps;
type RAPIER_Voxels = Voxels;
declare const RAPIER_Voxels: typeof Voxels;
type RAPIER_World = World;
declare const RAPIER_World: typeof World;
declare const RAPIER_init: typeof init;
declare const RAPIER_reserveMemory: typeof reserveMemory;
declare const RAPIER_scratchBuffer: typeof scratchBuffer;
declare const RAPIER_version: typeof version;
declare namespace RAPIER {
  export { RAPIER_ActiveCollisionTypes as ActiveCollisionTypes, RAPIER_ActiveEvents as ActiveEvents, RAPIER_ActiveHooks as ActiveHooks, RAPIER_Ball as Ball, RAPIER_BroadPhase as BroadPhase, RAPIER_CCDSolver as CCDSolver, RAPIER_Capsule as Capsule, RAPIER_CharacterCollision as CharacterCollision, RAPIER_CoefficientCombineRule as CoefficientCombineRule, RAPIER_Collider as Collider, RAPIER_ColliderDesc as ColliderDesc, RAPIER_ColliderSet as ColliderSet, RAPIER_ColliderShapeCastHit as ColliderShapeCastHit, RAPIER_Compound as Compound, RAPIER_Cone as Cone, RAPIER_ConvexPolyhedron as ConvexPolyhedron, RAPIER_Cuboid as Cuboid, RAPIER_Cylinder as Cylinder, RAPIER_DebugRenderBuffers as DebugRenderBuffers, RAPIER_DebugRenderPipeline as DebugRenderPipeline, RAPIER_DynamicRayCastVehicleController as DynamicRayCastVehicleController, RAPIER_EventQueue as EventQueue, RAPIER_FeatureType as FeatureType, RAPIER_FixedImpulseJoint as FixedImpulseJoint, RAPIER_FixedMultibodyJoint as FixedMultibodyJoint, RAPIER_GenericImpulseJoint as GenericImpulseJoint, RAPIER_HalfSpace as HalfSpace, RAPIER_HeightFieldFlags as HeightFieldFlags, RAPIER_Heightfield as Heightfield, RAPIER_ImpulseJoint as ImpulseJoint, RAPIER_ImpulseJointSet as ImpulseJointSet, RAPIER_IntegrationParameters as IntegrationParameters, RAPIER_IslandManager as IslandManager, RAPIER_JointAxesMask as JointAxesMask, RAPIER_JointAxis as JointAxis, RAPIER_JointData as JointData, RAPIER_JointType as JointType, RAPIER_KinematicCharacterController as KinematicCharacterController, RAPIER_MassPropsMode as MassPropsMode, RAPIER_MotorModel as MotorModel, RAPIER_MultibodyJoint as MultibodyJoint, RAPIER_MultibodyJointSet as MultibodyJointSet, RAPIER_NarrowPhase as NarrowPhase, RAPIER_PhysicsPipeline as PhysicsPipeline, RAPIER_PidAxesMask as PidAxesMask, RAPIER_PidController as PidController, RAPIER_PointColliderProjection as PointColliderProjection, RAPIER_PointProjection as PointProjection, RAPIER_Polyline as Polyline, RAPIER_PrismaticImpulseJoint as PrismaticImpulseJoint, RAPIER_PrismaticMultibodyJoint as PrismaticMultibodyJoint, RAPIER_Quaternion as Quaternion, RAPIER_QueryFilterFlags as QueryFilterFlags, RAPIER_Ray as Ray, RAPIER_RayColliderHit as RayColliderHit, RAPIER_RayColliderIntersection as RayColliderIntersection, RAPIER_RayIntersection as RayIntersection, RAPIER_RevoluteImpulseJoint as RevoluteImpulseJoint, RAPIER_RevoluteMultibodyJoint as RevoluteMultibodyJoint, RAPIER_RigidBody as RigidBody, RAPIER_RigidBodyDesc as RigidBodyDesc, RAPIER_RigidBodySet as RigidBodySet, RAPIER_RigidBodyType as RigidBodyType, RAPIER_RopeImpulseJoint as RopeImpulseJoint, RAPIER_RotationOps as RotationOps, RAPIER_RoundCone as RoundCone, RAPIER_RoundConvexPolyhedron as RoundConvexPolyhedron, RAPIER_RoundCuboid as RoundCuboid, RAPIER_RoundCylinder as RoundCylinder, RAPIER_RoundTriangle as RoundTriangle, RAPIER_SdpMatrix3 as SdpMatrix3, RAPIER_SdpMatrix3Ops as SdpMatrix3Ops, RAPIER_Segment as Segment, RAPIER_SerializationPipeline as SerializationPipeline, RAPIER_Shape as Shape, RAPIER_ShapeCastHit as ShapeCastHit, RAPIER_ShapeContact as ShapeContact, RAPIER_ShapeType as ShapeType, RAPIER_SolverFlags as SolverFlags, RAPIER_SphericalImpulseJoint as SphericalImpulseJoint, RAPIER_SphericalMultibodyJoint as SphericalMultibodyJoint, RAPIER_SpringImpulseJoint as SpringImpulseJoint, RAPIER_TempContactForceEvent as TempContactForceEvent, RAPIER_TempContactManifold as TempContactManifold, RAPIER_TriMesh as TriMesh, RAPIER_TriMeshFlags as TriMeshFlags, RAPIER_Triangle as Triangle, RAPIER_UnitImpulseJoint as UnitImpulseJoint, RAPIER_UnitMultibodyJoint as UnitMultibodyJoint, RAPIER_Vector3 as Vector3, RAPIER_VectorOps as VectorOps, RAPIER_Voxels as Voxels, RAPIER_World as World, RAPIER_init as init, RAPIER_reserveMemory as reserveMemory, RAPIER_scratchBuffer as scratchBuffer, RAPIER_version as version };
  export type { RAPIER_ColliderHandle as ColliderHandle, RAPIER_ImpulseJointHandle as ImpulseJointHandle, RAPIER_InteractionGroups as InteractionGroups, RAPIER_MultibodyJointHandle as MultibodyJointHandle, RAPIER_PhysicsHooks as PhysicsHooks, RAPIER_RigidBodyHandle as RigidBodyHandle, RAPIER_Rotation as Rotation, RAPIER_SharedColliderGeometry as SharedColliderGeometry, RAPIER_VHACDParameters as VHACDParameters, RAPIER_Vector as Vector };
}

export { ActiveCollisionTypes, ActiveEvents, ActiveHooks, Ball, BroadPhase, CCDSolver, Capsule, CharacterCollision, CoefficientCombineRule, Collider, ColliderDesc, ColliderSet, ColliderShapeCastHit, Compound, Cone, ConvexPolyhedron, Cuboid, Cylinder, DebugRenderBuffers, DebugRenderPipeline, DynamicRayCastVehicleController, EventQueue, FeatureType, FixedImpulseJoint, FixedMultibodyJoint, GenericImpulseJoint, HalfSpace, HeightFieldFlags, Heightfield, ImpulseJoint, ImpulseJointSet, IntegrationParameters, IslandManager, JointAxesMask, JointAxis, JointData, JointType, KinematicCharacterController, MassPropsMode, MotorModel, MultibodyJoint, MultibodyJointSet, NarrowPhase, PhysicsPipeline, PidAxesMask, PidController, PointColliderProjection, PointProjection, Polyline, PrismaticImpulseJoint, PrismaticMultibodyJoint, Quaternion, QueryFilterFlags, Ray, RayColliderHit, RayColliderIntersection, RayIntersection, RevoluteImpulseJoint, RevoluteMultibodyJoint, RigidBody, RigidBodyDesc, RigidBodySet, RigidBodyType, RopeImpulseJoint, RotationOps, RoundCone, RoundConvexPolyhedron, RoundCuboid, RoundCylinder, RoundTriangle, SdpMatrix3, SdpMatrix3Ops, Segment, SerializationPipeline, Shape, ShapeCastHit, ShapeContact, ShapeType, SolverFlags, SphericalImpulseJoint, SphericalMultibodyJoint, SpringImpulseJoint, TempContactForceEvent, TempContactManifold, TriMesh, TriMeshFlags, Triangle, UnitImpulseJoint, UnitMultibodyJoint, Vector3, VectorOps, Voxels, World, RAPIER as default, init, reserveMemory, scratchBuffer, version };
export type { ColliderHandle, ImpulseJointHandle, InteractionGroups, MultibodyJointHandle, PhysicsHooks, RigidBodyHandle, Rotation, SharedColliderGeometry, VHACDParameters, Vector };
