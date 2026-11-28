/** Raw C-ABI exports of `modeling_kernel.wasm`. */
export interface ModelingKernelWasmExports {
  readonly memory: WebAssembly.Memory;
  mk_scratch_ensure(minLen: number): number;
  mk_last_error_code(): number;
  mk_last_error_field_ptr(): number;
  mk_last_error_field_len(): number;
  mk_last_error_reason_ptr(): number;
  mk_last_error_reason_len(): number;
  mk_live_builders(): number;
  mk_builder_create(
    layoutPtr: number,
    pairCount: number,
    materialSlotCount: number,
    vertexCapacity: number,
    indexCapacity: number,
  ): bigint;
  mk_builder_alloc_verts(handle: bigint, count: number, outPtrsPtr: number): number;
  mk_builder_alloc_indices(handle: bigint, count: number, outPtr: number): number;
  mk_builder_rebase_section(
    handle: bigint,
    indexOffset: number,
    indexCount: number,
    baseVertex: number,
    localVertexCount: number,
    sectionIdx: number,
  ): number;
  mk_builder_add_submesh(
    handle: bigint,
    flags: number,
    indexOffset: number,
    indexCount: number,
    vertexCount: number,
    topology: number,
    materialSlot: number,
  ): number;
  mk_builder_build(handle: bigint, outputMode: number): number;
  mk_builder_built_meta(handle: bigint, outMetaPtr: number): number;
  mk_builder_built_channel_meta(handle: bigint, index: number, outMetaPtr: number): number;
  mk_builder_built_submesh_meta(handle: bigint, index: number, outMetaPtr: number): number;
  mk_builder_built_layout_entry(handle: bigint, index: number, outMetaPtr: number): number;
  mk_builder_built_layout_len(handle: bigint): number;
  mk_builder_dispose(handle: bigint): number;
  mk_encode_tangent_frame32(
    nx: number,
    ny: number,
    nz: number,
    tx: number,
    ty: number,
    tz: number,
    handedness: number,
    outWordPtr: number,
  ): number;
  mk_decode_tangent_frame32(word: number, outF32Ptr: number): void;
  // Phase 2: EditMesh, FXSL v1 VM, and Modeling Ops C-ABI
  mk_live_meshes(): number;
  mk_mesh_create(): bigint;
  mk_mesh_dispose(handle: bigint): number;
  mk_mesh_clone(handle: bigint): bigint;
  mk_mesh_assign(dstHandle: bigint, srcHandle: bigint): number;
  mk_mesh_counts(handle: bigint, outU32Ptr: number): number;
  mk_mesh_soa_ptrs(handle: bigint, outU32Ptr: number): number;
  mk_mesh_add_vertex(handle: bigint, x: number, y: number, z: number): number;
  mk_mesh_remove_vertex(handle: bigint, v: number): number;
  mk_mesh_set_position(handle: bigint, v: number, x: number, y: number, z: number): number;
  mk_mesh_add_face(handle: bigint, vertsPtr: number, vertCount: number, material: number): number;
  mk_mesh_remove_face(handle: bigint, f: number): number;
  mk_mesh_find_half(handle: bigint, a: number, b: number): number;
  mk_mesh_intern_tag(handle: bigint, ptr: number, len: number, create: number): number;
  mk_mesh_intern_label(handle: bigint, ptr: number, len: number): number;
  mk_mesh_intern_role(handle: bigint, ptr: number, len: number): number;
  mk_mesh_intern_material(handle: bigint, ptr: number, len: number): number;
  mk_mesh_set_corner(
    handle: bigint,
    channelId: number,
    h: number,
    valsPtr: number,
    dim: number,
  ): number;
  mk_mesh_channel_ptrs(handle: bigint, channelId: number, outU32Ptr: number): number;
  mk_mesh_box(
    handle: bigint,
    sx: number,
    sy: number,
    sz: number,
    nx: number,
    ny: number,
    nz: number,
    cx: number,
    cy: number,
    cz: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_plane(
    handle: bigint,
    w: number,
    h: number,
    nx: number,
    ny: number,
    cx: number,
    cy: number,
    cz: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_eval_fxsl(
    handle: bigint,
    bytesPtr: number,
    byteLen: number,
    checkCardinality: number,
    outMetaPtr: number,
  ): number;
  mk_mesh_translate(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    dx: number,
    dy: number,
    dz: number,
  ): number;
  mk_mesh_scale(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    sx: number,
    sy: number,
    sz: number,
    hasPivot: number,
    px: number,
    py: number,
    pz: number,
  ): number;
  mk_mesh_rotate(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    axis: number,
    degrees: number,
    hasPivot: number,
    px: number,
    py: number,
    pz: number,
  ): number;
  mk_mesh_tag_faces(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    namePtr: number,
    nameLen: number,
  ): number;
  mk_mesh_set_material(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    slotPtr: number,
    slotLen: number,
  ): number;
  mk_mesh_mark_edges(
    handle: bigint,
    edgesPtr: number,
    edgeCount: number,
    flag: number,
    enable: number,
  ): number;
  mk_mesh_extrude(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    distance: number,
    regionMode: number,
    label: number,
    outCountsPtr: number,
  ): number;
  mk_mesh_inset(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    thickness: number,
    regionMode: number,
    label: number,
    outCountsPtr: number,
  ): number;
  mk_mesh_subdivide(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    levels: number,
    scheme: number,
    boundary: number,
    creaseSharpness: number,
    faceBudget: number,
  ): number;
  mk_mesh_build_render(handle: bigint, outputMode: number): number;
  mk_mesh_built_meta(handle: bigint, outMetaPtr: number): number;
  mk_mesh_built_channel_meta(handle: bigint, index: number, outMetaPtr: number): number;
  mk_mesh_built_submesh_meta(handle: bigint, index: number, outMetaPtr: number): number;
  mk_mesh_built_layout_len(handle: bigint): number;
  mk_mesh_built_layout_entry(handle: bigint, index: number, outMetaPtr: number): number;
  // Phase 3: Wave 2 Ops & UV Pipeline C-ABI
  mk_mesh_offset(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    distance: number,
    regionMode: number,
    label: number,
    outCountsPtr: number,
  ): number;
  mk_mesh_mirror(handle: bigint, axis: number, weldDistance: number): number;
  mk_mesh_weld(handle: bigint, distance: number, outCountsPtr: number): number;
  mk_mesh_flip(handle: bigint, facesPtr: number, faceCount: number): number;
  mk_mesh_delete(handle: bigint, facesPtr: number, faceCount: number): number;
  mk_mesh_uv_project(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    mode: number,
    axis: number,
    scale: number,
    channelId: number,
  ): number;
  mk_mesh_uv_unwrap(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    seamMode: number,
    channelId: number,
  ): number;
  mk_mesh_uv_pack(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    resolution: number,
    paddingTexels: number,
    normalizeDensity: number,
    allowRotate: number,
    channelId: number,
  ): number;
  // Phase 4: Surface ImageBuffer, Mesh-to-Texture Baking, and PBR Surface Stack C-ABI
  mk_live_images(): number;
  mk_live_surfaces(): number;
  mk_img_dispose(handle: bigint): number;
  mk_img_create(width: number, height: number, channels: number, fill: number): bigint;
  mk_img_meta(handle: bigint, outU32Ptr: number): number;
  mk_img_perlin_fbm(
    width: number,
    height: number,
    scaleX: number,
    scaleY: number,
    octaves: number,
    persistence: number,
    seed: number,
  ): bigint;
  mk_img_worley(
    width: number,
    height: number,
    cellsX: number,
    cellsY: number,
    jitter: number,
    mode: number,
    seed: number,
  ): bigint;
  mk_img_brick(
    width: number,
    height: number,
    cols: number,
    rows: number,
    mortar: number,
    bevel: number,
    stagger: number,
    seed: number,
  ): bigint;
  mk_img_brushed(
    width: number,
    height: number,
    scaleU: number,
    scaleV: number,
    seed: number,
  ): bigint;
  mk_img_wood(width: number, height: number, rings: number, warp: number, seed: number): bigint;
  mk_img_levels(
    srcHandle: bigint,
    inMin: number,
    inMax: number,
    gamma: number,
    outMin: number,
    outMax: number,
  ): bigint;
  mk_img_invert(srcHandle: bigint): bigint;
  mk_img_blur(srcHandle: bigint, radius: number): bigint;
  mk_img_height_to_normal(srcHandle: bigint, strength: number): bigint;
  mk_img_blend(
    baseHandle: bigint,
    topHandle: bigint,
    maskHandle: bigint,
    mode: number,
    opacity: number,
  ): bigint;
  mk_surface_create(width: number, height: number): bigint;
  mk_surface_dispose(handle: bigint): number;
  mk_surface_add_layer(
    surfaceHandle: bigint,
    r: number,
    g: number,
    b: number,
    roughness: number,
    metallic: number,
    heightVal: number,
    er: number,
    eg: number,
    eb: number,
    maskHandle: bigint,
    heightHandle: bigint,
    roughnessHandle: bigint,
    opacity: number,
  ): number;
  mk_surface_apply_ao(surfaceHandle: bigint, aoHandle: bigint, strength: number): number;
  mk_surface_apply_base_normal(surfaceHandle: bigint, normalHandle: bigint): number;
  mk_surface_export_pbr(surfaceHandle: bigint, heightNormalStrength: number): number;
  mk_surface_export_meta(surfaceHandle: bigint, outU32Ptr: number): number;
  // Phase 5 (Convoy 100% Rust): Primitives, Assembly, Sweep, PanelLine, Bevel, Boolean, AutoUV
  mk_mesh_cylinder(
    handle: bigint,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    radialSegments: number,
    heightSegments: number,
    openEnded: number,
    cx: number,
    cy: number,
    cz: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_sphere(
    handle: bigint,
    radius: number,
    widthSegments: number,
    heightSegments: number,
    cx: number,
    cy: number,
    cz: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_torus(
    handle: bigint,
    radius: number,
    tube: number,
    radialSegments: number,
    tubularSegments: number,
    angleDeg: number,
    cx: number,
    cy: number,
    cz: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_revolve(
    handle: bigint,
    ptsF64Ptr: number,
    ptCount: number,
    segments: number,
    angleDeg: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_append(
    dstHandle: bigint,
    srcHandle: bigint,
    tx: number,
    ty: number,
    tz: number,
    label: number,
    tag: number,
  ): number;
  mk_mesh_array(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    kind: number,
    count: number,
    vx: number,
    vy: number,
    vz: number,
    angleDeg: number,
    cx: number,
    cy: number,
    cz: number,
    prefixPtr: number,
    prefixLen: number,
    label: number,
    tag: number,
  ): number;
  mk_mesh_fill_holes(
    handle: bigint,
    edgesPtr: number,
    edgeCount: number,
    material: number,
    label: number,
    tag: number,
  ): number;
  mk_mesh_taper(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    axis: number,
    factor: number,
    axesMask: number,
    hasRange: number,
    r0: number,
    r1: number,
    hasOrigin: number,
    ox: number,
    oy: number,
    oz: number,
  ): number;
  mk_mesh_sweep_polyline(
    handle: bigint,
    profileF64Ptr: number,
    profileCount: number,
    pathF64Ptr: number,
    pathCount: number,
    caps: number,
    sharpAngleDeg: number,
    ux: number,
    uy: number,
    uz: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_panel_line_plane(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    width: number,
    depth: number,
    material: number,
    label: number,
    tag: number,
    tolerance: number,
  ): number;
  mk_mesh_bevel(
    handle: bigint,
    edgesPtr: number,
    edgeCount: number,
    width: number,
    segments: number,
    material: number,
    label: number,
    tag: number,
    outCountsPtr: number,
  ): number;
  mk_mesh_boolean(targetHandle: bigint, toolHandle: bigint, opId: number, eps: number): number;
  mk_mesh_uv_auto(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    maxNormalDevDeg: number,
    respectSharp: number,
    resolution: number,
    paddingTexels: number,
    allowRotate: number,
    channelId: number,
  ): number;
  mk_bake_build_bvh_groups(
    posPtr: number,
    posLen: number,
    normPtr: number,
    normLen: number,
    idxPtr: number,
    idxLen: number,
    slotsPtr: number,
    slotsLen: number,
    floaterPtr: number,
    floaterLen: number,
    strayPtr: number,
    strayLen: number,
    groupTrisPtr: number,
    groupTrisLen: number,
    groupRangesPtr: number,
    groupRangesLen: number,
  ): number;
  mk_bake_bvh_meta(outU32Ptr: number): number;
  mk_bake_bvh_clear(): void;
  // Extended modeling, atlas & high-to-low bake C-ABI
  mk_atlas_dilate(
    width: number,
    height: number,
    wrapU: number,
    wrapV: number,
    gutter: number,
    protectMip: number,
    bufCount: number,
    rgbaPtr: number,
    categoricalPtr: number,
    coveredPtr: number,
    ownerPtr: number,
    framePtr: number,
    outMetaPtr: number,
  ): number;
  mk_bake_resolve_cage(
    basePosPtr: number,
    baseVertCount: number,
    baseNrmPtr: number,
    baseIdxPtr: number,
    baseTriCount: number,
    detailPosPtr: number,
    detailVertCount: number,
    detailIdxPtr: number,
    detailTriCount: number,
    offsetIn: number,
    maxRayIn: number,
    dirMode: number,
    blendDist: number,
    outF64Ptr: number,
  ): number;
  mk_live_correspondences(): number;
  mk_bake_correspond_dispose(handle: bigint): number;
  mk_bake_correspond(
    width: number,
    height: number,
    samplesPerAxis: number,
    basePosPtr: number,
    baseVertCount: number,
    baseNrmPtr: number,
    baseTanPtr: number,
    baseUvPtr: number,
    baseIdxPtr: number,
    baseTriCount: number,
    baseTriGroupPtr: number,
    baseTriIslandPtr: number,
    detailPosPtr: number,
    detailVertCount: number,
    detailNrmPtr: number,
    detailIdxPtr: number,
    detailTriCount: number,
    detailTriGroupPtr: number,
    detailTriSlotPtr: number,
    detailFloaterPtr: number,
    groupCount: number,
    groupParamsF64Ptr: number,
    outCountersPtr: number,
  ): bigint;
  mk_bake_correspond_eval(
    corrHandle: bigint,
    mapsPtr: number,
    mapCount: number,
    slotsF32Ptr: number,
    slotCount: number,
    gutter: number,
    aoSamples: number,
    aoCone: number,
    aoDistance: number,
    aoBias: number,
    outImgHandlesPtr: number,
    outRangesF32Ptr: number,
  ): number;
  mk_mesh_mark_part_role(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    roleId: number,
  ): number;
  mk_mesh_mark_float(handle: bigint, facesPtr: number, faceCount: number, floating: number): number;
  mk_mesh_mark_crease(
    handle: bigint,
    edgesPtr: number,
    edgeCount: number,
    sharpness: number,
  ): number;
  mk_mesh_orient(handle: bigint, facesPtr: number, faceCount: number): number;
  mk_mesh_triangulate(handle: bigint, facesPtr: number, faceCount: number): number;
  mk_mesh_dissolve(
    handle: bigint,
    edgesPtr: number,
    edgeCount: number,
    outCountsPtr: number,
  ): number;
  mk_mesh_split_edges(handle: bigint, edgesPtr: number, edgeCount: number): number;
  mk_mesh_cleanup_planar(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    tolerance: number,
    outCountsPtr: number,
  ): number;
  mk_mesh_cleanup_quads(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    maxAngleDeg: number,
    maxPlanarity: number,
  ): number;
  mk_mesh_cleanup_slivers(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    width: number,
    tolerance: number,
    outCountsPtr: number,
  ): number;
  mk_mesh_resolve_t_junctions(handle: bigint, distance: number): number;
  mk_mesh_simplify(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    targetFaces: number,
    maxError: number,
    constraintBits: number,
    silhouetteEyesPtr: number,
    silhouetteEyeCount: number,
    silhouetteWeight: number,
    outErrPtr: number,
  ): number;
  mk_mesh_remesh(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    targetEdgeLength: number,
    iterations: number,
    smoothWeight: number,
    constraintBits: number,
  ): number;
  mk_mesh_cleanup_tiling(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    maxAspect: number,
    maxError: number,
    iterations: number,
  ): number;
  mk_mesh_lowpoly(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    targetFaces: number,
    hardAngleDeg: number,
    maxError: number,
    rolesFormOnly: number,
    autoUvFlag: number,
    uvResolution: number,
    uvPadding: number,
    preserveGroups: number,
    prefixPtr: number,
    prefixLen: number,
    tolerance: number,
    outCountsPtr: number,
  ): number;
  mk_mesh_voxel_remesh(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    mode: number,
    distance: number,
    voxelSize: number,
    band: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_duplicate(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    label: number,
    tag: number,
  ): number;
  mk_mesh_disconnect(handle: bigint, facesPtr: number, faceCount: number): number;
  mk_mesh_bridge(
    handle: bigint,
    edgesPtr: number,
    edgeCount: number,
    segments: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_loop_cut(handle: bigint, edgesPtr: number, edgeCount: number, cuts: number): number;
  mk_mesh_plane_cut(
    handle: bigint,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    positiveOnly: number,
    fillHolesCap: number,
    tolerance: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_shell(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    thickness: number,
    direction: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_hole(
    handle: bigint,
    face: number,
    centersPtr: number,
    centerCount: number,
    diameter: number,
    depth: number,
    segments: number,
    label: number,
    material: number,
    tag: number,
    tolerance: number,
  ): number;
  mk_mesh_polygon(
    handle: bigint,
    ptsPtr: number,
    ptCount: number,
    flip: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_cone(
    handle: bigint,
    radius: number,
    height: number,
    radialSegments: number,
    openEnded: number,
    cx: number,
    cy: number,
    cz: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_extrude_polygon(
    handle: bigint,
    ptsPtr: number,
    ptCount: number,
    depth: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_loft(
    handle: bigint,
    ptsPtr: number,
    ringLensPtr: number,
    ringCount: number,
    capped: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_pipe_network(
    handle: bigint,
    nodesPtr: number,
    nodeCount: number,
    edgesPtr: number,
    edgeCount: number,
    radius: number,
    segments: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_lift(
    handle: bigint,
    posPtr: number,
    vertCount: number,
    idxPtr: number,
    idxCount: number,
    uvPtr: number,
    creaseAngleDeg: number,
    label: number,
    material: number,
    tag: number,
  ): number;
  mk_mesh_bend(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    axis: number,
    toward: number,
    angleDeg: number,
    hasRange: number,
    r0: number,
    r1: number,
    hasOrig: number,
    ox: number,
    oy: number,
    oz: number,
  ): number;
  mk_mesh_twist(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    axis: number,
    angleDeg: number,
    hasRange: number,
    r0: number,
    r1: number,
    hasOrig: number,
    ox: number,
    oy: number,
    oz: number,
  ): number;
  mk_mesh_lattice(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    nx: number,
    ny: number,
    nz: number,
    offIdxPtr: number,
    offVecPtr: number,
    offCount: number,
  ): number;
  mk_mesh_apply_draft(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    angleDeg: number,
  ): number;
  mk_mesh_spherize(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    factor: number,
    radius: number,
    hasCenter: number,
    cx: number,
    cy: number,
    cz: number,
  ): number;
  mk_mesh_curve_deform(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    pathPtr: number,
    pathCount: number,
    axis: number,
    hasOrigin: number,
    ox: number,
    oy: number,
    oz: number,
  ): number;
  mk_mesh_smooth(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    lambda: number,
    mu: number,
    iterations: number,
    pinBoundary: number,
    pinSharp: number,
  ): number;
  mk_mesh_implicit_smooth(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    lambda: number,
    iterations: number,
    pinsPtr: number,
    pinCount: number,
    pinBoundary: number,
    pinSharp: number,
    preserveVolume: number,
  ): number;
  mk_mesh_arap(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    constraintIdsPtr: number,
    constraintPosPtr: number,
    constraintCount: number,
    iterations: number,
  ): number;
  mk_mesh_shrinkwrap(
    handle: bigint,
    vertsPtr: number,
    vertCount: number,
    targetPosPtr: number,
    targetVertCount: number,
    targetIdxPtr: number,
    targetTriCount: number,
    hasDir: number,
    dx: number,
    dy: number,
    dz: number,
    offset: number,
    maxDistance: number,
  ): number;
  mk_mesh_uv_plan_seams(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    maxAngleDeg: number,
    respectSharp: number,
  ): number;
  mk_mesh_uv_straighten(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    channelId: number,
    maxAngleDeg: number,
  ): number;
  mk_mesh_uv_lightmap(
    handle: bigint,
    resolution: number,
    paddingTexels: number,
    channelId: number,
  ): number;
  mk_mesh_uv_trim(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    tileU: number,
    channelId: number,
  ): number;
  mk_mesh_uv_swatch(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    channelId: number,
  ): number;
  mk_mesh_uv_overlaps(
    handle: bigint,
    facesPtr: number,
    faceCount: number,
    channelId: number,
  ): number;
  mk_mesh_skin_bind(
    handle: bigint,
    rootsPtr: number,
    tipsPtr: number,
    tipCountsPtr: number,
    boneCount: number,
    falloff: number,
    gridRes: number,
    outJointsPtr: number,
    outWeightsPtr: number,
  ): number;
  mk_mesh_hausdorff(
    handleA: bigint,
    facesAPtr: number,
    faceCountA: number,
    handleB: bigint,
    facesBPtr: number,
    faceCountB: number,
    outF64Ptr: number,
  ): number;
  mk_mesh_quality(handle: bigint, facesPtr: number, faceCount: number, outF64Ptr: number): number;
}

let cachedExports: ModelingKernelWasmExports | undefined;

/** Instantiate from caller-supplied WASM bytes (works in Browser, Worker, Node, and mini-games). */
export function initModelingKernelWasmSync(bytes: BufferSource): ModelingKernelWasmExports {
  const mod = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(mod, {});
  cachedExports = instance.exports as unknown as ModelingKernelWasmExports;
  return cachedExports;
}

/** Async instantiation from bytes or a `Response` (preferred in browsers for large modules). */
export async function initModelingKernelWasm(
  source: BufferSource | Response | PromiseLike<Response>,
): Promise<ModelingKernelWasmExports> {
  if (cachedExports !== undefined) return cachedExports;
  const resolved = await source;
  if (typeof Response !== 'undefined' && resolved instanceof Response) {
    const result = await WebAssembly.instantiateStreaming(resolved, {});
    cachedExports = result.instance.exports as unknown as ModelingKernelWasmExports;
    return cachedExports;
  }
  const result = await WebAssembly.instantiate(resolved as BufferSource, {});
  cachedExports = result.instance.exports as unknown as ModelingKernelWasmExports;
  return cachedExports;
}

/** Return the initialized singleton WASM exports, or undefined if not yet loaded. */
export function getModelingKernelWasm(): ModelingKernelWasmExports | undefined {
  return cachedExports;
}

/** Resolve the bundled `modeling_kernel.wasm` URL relative to this module. */
export function modelingKernelWasmUrl(): URL {
  const rel = import.meta.url.endsWith('/src/index.ts')
    ? '../dist/modeling_kernel.wasm'
    : './modeling_kernel.wasm';
  return new URL(rel, import.meta.url);
}
