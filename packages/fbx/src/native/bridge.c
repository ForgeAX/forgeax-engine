/*
 * bridge.c — ufbx → JSON POD bridge for WebAssembly.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) forgeax engine contributors.
 *
 * Emits the engine FBX POD JSON schema consumed by the parse-*.ts /
 * to-asset-pack.ts bridge layer (single ufbx WASM parser, no native addon).
 *
 * Compiled with Emscripten: emcc -O3 ufbx.c bridge.c -o fbx-wasm.mjs
 *
 * Exported functions (called from JS):
 *   parseFbxWasm(ptr, size)  — parse FBX bytes, store result JSON internally
 *   getResultPtr()           — pointer to result JSON string
 *   getResultLen()           — byte length of result JSON string
 *   freeResult()             — free the result buffer
 */

#include "ufbx.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

/* ── Dynamic string buffer ─────────────────────────────────────────── */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} Buf;

static void buf_init(Buf *b) {
    b->cap = 4096;
    b->data = (char *)malloc(b->cap);
    b->len = 0;
    b->data[0] = '\0';
}

static void buf_ensure(Buf *b, size_t extra) {
    while (b->len + extra + 1 > b->cap) {
        b->cap *= 2;
        b->data = (char *)realloc(b->data, b->cap);
    }
}

static void buf_str(Buf *b, const char *s) {
    size_t n = strlen(s);
    buf_ensure(b, n);
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

static void buf_char(Buf *b, char c) {
    buf_ensure(b, 1);
    b->data[b->len++] = c;
    b->data[b->len] = '\0';
}

static void buf_double(Buf *b, double v) {
    if (!isfinite(v)) v = 0.0;
    char tmp[64];
    snprintf(tmp, sizeof(tmp), "%.17g", v);
    buf_str(b, tmp);
}

static void buf_int(Buf *b, int v) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%d", v);
    buf_str(b, tmp);
}

static void buf_size(Buf *b, size_t v) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%zu", v);
    buf_str(b, tmp);
}

static void buf_quoted(Buf *b, const char *s) {
    buf_char(b, '"');
    for (const char *p = s; *p; p++) {
        if (*p == '"') buf_str(b, "\\\"");
        else if (*p == '\\') buf_str(b, "\\\\");
        else if (*p == '\n') buf_str(b, "\\n");
        else if (*p == '\r') buf_str(b, "\\r");
        else if (*p == '\t') buf_str(b, "\\t");
        else buf_char(b, *p);
    }
    buf_char(b, '"');
}

/* ── Mesh writing ──────────────────────────────────────────────────── */

static void write_mesh(Buf *b, ufbx_mesh *mesh, int source_index) {
    buf_char(b, '{');

    /* name */
    buf_str(b, "\"name\":");
    const char *name = mesh->element.name.data;
    if (!name || name[0] == '\0') {
        ufbx_node *node = mesh->instances.count > 0 ? mesh->instances.data[0] : NULL;
        name = node ? node->name.data : "";
    }
    buf_quoted(b, name ? name : "");
    buf_char(b, ',');

    /* Triangulate and collect vertex data */
    size_t max_tris = 0;
    for (size_t fi = 0; fi < mesh->num_faces; fi++) {
        ufbx_face face = mesh->faces.data[fi];
        if (face.num_indices >= 3) max_tris += face.num_indices - 2;
    }

    size_t num_tri_indices = max_tris * 3;
    uint32_t *tri_indices = (uint32_t *)calloc(num_tri_indices, sizeof(uint32_t));

    float *positions = (float *)calloc(mesh->num_indices * 3, sizeof(float));
    float *normals = (float *)calloc(mesh->num_indices * 3, sizeof(float));

    for (size_t i = 0; i < mesh->num_indices; i++) {
        uint32_t vi = mesh->vertex_position.indices.data[i];
        ufbx_vec3 p = mesh->vertex_position.values.data[vi];
        positions[i * 3 + 0] = (float)p.x;
        positions[i * 3 + 1] = (float)p.y;
        positions[i * 3 + 2] = (float)p.z;

        if (mesh->vertex_normal.exists) {
            uint32_t ni = mesh->vertex_normal.indices.data[i];
            ufbx_vec3 n = mesh->vertex_normal.values.data[ni];
            normals[i * 3 + 0] = (float)n.x;
            normals[i * 3 + 1] = (float)n.y;
            normals[i * 3 + 2] = (float)n.z;
        }
    }

    /* Re-triangulate all faces into tri_indices */
    size_t max_face_tris = mesh->max_face_triangles;
    size_t temp_size = max_face_tris * 3;
    if (temp_size < 64) temp_size = 64;
    uint32_t *temp = (uint32_t *)malloc(temp_size * sizeof(uint32_t));
    size_t tri_idx = 0;
    for (size_t fi = 0; fi < mesh->num_faces; fi++) {
        ufbx_face face = mesh->faces.data[fi];
        size_t nt = ufbx_triangulate_face(temp, temp_size, mesh, face);
        for (size_t ti = 0; ti < nt * 3 && tri_idx < num_tri_indices; ti++) {
            tri_indices[tri_idx++] = temp[ti];
        }
    }
    free(temp);
    num_tri_indices = tri_idx;

    /* vertices (positions as flat array) */
    buf_str(b, "\"vertices\":[");
    for (size_t i = 0; i < mesh->num_indices * 3; i++) {
        if (i > 0) buf_char(b, ',');
        buf_double(b, positions[i]);
    }
    buf_str(b, "],");

    /* indices (triangulated) */
    buf_str(b, "\"indices\":[");
    for (size_t i = 0; i < num_tri_indices; i++) {
        if (i > 0) buf_char(b, ',');
        buf_int(b, (int)tri_indices[i]);
    }
    buf_str(b, "],");

    /* attributes */
    buf_str(b, "\"attributes\":{");

    if (mesh->vertex_normal.exists) {
        buf_str(b, "\"NORMAL\":[");
        for (size_t i = 0; i < mesh->num_indices * 3; i++) {
            if (i > 0) buf_char(b, ',');
            buf_double(b, normals[i]);
        }
        buf_char(b, ']');
    }

    /* UV layers */
    for (size_t layer = 0; layer < mesh->uv_sets.count; layer++) {
        ufbx_uv_set *uv_set = &mesh->uv_sets.data[layer];
        if (mesh->vertex_normal.exists || layer > 0) buf_char(b, ',');

        char key[32];
        snprintf(key, sizeof(key), "TEXCOORD_%zu", layer);
        buf_char(b, '"'); buf_str(b, key); buf_str(b, "\":[");
        for (size_t i = 0; i < mesh->num_indices; i++) {
            uint32_t ui = uv_set->vertex_uv.indices.data[i];
            ufbx_vec2 uv = uv_set->vertex_uv.values.data[ui];
            if (i > 0) buf_char(b, ',');
            buf_double(b, uv.x); buf_char(b, ','); buf_double(b, uv.y);
        }
        buf_char(b, ']');
    }

    buf_str(b, "}");

    /* BlendShape channels are the FBX producer's morph source of truth.
     * Keep one dense target per ordinary channel; parse-mesh applies the
     * shared target/attribute budgets and rejects in-between keyframes. */
    size_t morph_count = 0;
    for (size_t di = 0; di < mesh->blend_deformers.count; di++) {
        ufbx_blend_deformer *blend = mesh->blend_deformers.data[di];
        morph_count += blend->channels.count;
    }
    if (morph_count > 0) {
        buf_str(b, ",\"morphTargets\":[");
        size_t target_index = 0;
        for (size_t di = 0; di < mesh->blend_deformers.count; di++) {
            ufbx_blend_deformer *blend = mesh->blend_deformers.data[di];
            for (size_t ci = 0; ci < blend->channels.count; ci++) {
                ufbx_blend_channel *channel = blend->channels.data[ci];
                if (target_index++ > 0) buf_char(b, ',');
                ufbx_blend_shape *shape = channel->target_shape;
                if (shape == NULL && channel->keyframes.count == 1) {
                    shape = channel->keyframes.data[0].shape;
                }
                buf_char(b, '{');
                buf_str(b, "\"position\":[");
                for (size_t vi = 0; vi < mesh->num_indices; vi++) {
                    if (vi > 0) buf_char(b, ',');
                    uint32_t cp = mesh->vertex_position.indices.data[vi];
                    ufbx_vec3 value = shape ? ufbx_get_blend_shape_vertex_offset(shape, cp) : (ufbx_vec3){0,0,0};
                    buf_double(b, value.x); buf_char(b, ',');
                    buf_double(b, value.y); buf_char(b, ',');
                    buf_double(b, value.z);
                }
                buf_char(b, ']');
                if (shape != NULL && shape->normal_offsets.count > 0) {
                    buf_str(b, ",\"normal\":[");
                    for (size_t vi = 0; vi < mesh->num_indices; vi++) {
                        if (vi > 0) buf_char(b, ',');
                        uint32_t cp = mesh->vertex_position.indices.data[vi];
                        uint32_t oi = ufbx_get_blend_shape_offset_index(shape, cp);
                        ufbx_vec3 value = (ufbx_vec3){0,0,0};
                        if (oi != UFBX_NO_INDEX && oi < shape->normal_offsets.count) {
                            value = shape->normal_offsets.data[oi];
                        }
                        buf_double(b, value.x); buf_char(b, ',');
                        buf_double(b, value.y); buf_char(b, ',');
                        buf_double(b, value.z);
                    }
                    buf_char(b, ']');
                }
                buf_char(b, '}');
            }
        }
        buf_str(b, "],\"morphWeights\":[");
        target_index = 0;
        for (size_t di = 0; di < mesh->blend_deformers.count; di++) {
            ufbx_blend_deformer *blend = mesh->blend_deformers.data[di];
            for (size_t ci = 0; ci < blend->channels.count; ci++) {
                if (target_index++ > 0) buf_char(b, ',');
                buf_double(b, blend->channels.data[ci]->weight);
            }
        }
        buf_char(b, ']');
    }

    buf_char(b, ',');

    /* polygonCount, sourceIndex, materialIndex */
    buf_str(b, "\"polygonCount\":"); buf_size(b, mesh->num_faces); buf_char(b, ',');
    buf_str(b, "\"sourceIndex\":"); buf_int(b, source_index); buf_char(b, ',');
    buf_str(b, "\"materialIndex\":");
    if (mesh->materials.count > 0) buf_int(b, 0);
    else buf_int(b, -1);

    buf_char(b, '}');

    free(positions);
    free(normals);
    free(tri_indices);
}

/* ── System-node filter ────────────────────────────────────────────── */

/* FBX files carry built-in system objects the Autodesk SDK never surfaces in
 * the node tree: the seven "Producer <view>" viewport cameras and the
 * "Camera Switcher". ufbx exposes them as ordinary nodes, so we filter them by
 * name to match the SDK ScenePod/animation baseline (M0 probe: 93 -> 85 nodes).
 * Authored cameras/lights/bones/empties are kept. */
static int is_system_node(const ufbx_node *node) {
    const char *name = node->name.data;
    if (!name) return 0;
    if (strncmp(name, "Producer ", 9) == 0) return 1;
    if (strcmp(name, "Camera Switcher") == 0) return 1;
    return 0;
}

/* True for nodes that must not appear in the emitted ScenePod / animation. */
static int skip_node(const ufbx_node *node) {
    return node->is_root || is_system_node(node);
}

/* ── Scene nodes writing ───────────────────────────────────────────── */

/* Emit ScenePod nodes in DFS pre-order from the root's children, matching the
 * SDK binding's WalkNode traversal so entity indices + children[] references
 * line up field-for-field. `order` maps each emitted node -> its flat index;
 * two passes (assign indices, then emit) keep children[] forward-referenceable.
 *
 * A DFS that descends into skipped (system) nodes' subtrees would still hide
 * the system node itself but keep its descendants; the SDK's system cameras are
 * childless leaves, so simply skipping them is equivalent. */

static void dfs_assign(ufbx_node *node, ufbx_node **order, int *count) {
    if (!skip_node(node)) order[(*count)++] = node;
    for (size_t i = 0; i < node->children.count; i++) {
        dfs_assign(node->children.data[i], order, count);
    }
}

static int index_of(ufbx_node **order, int count, const ufbx_node *node) {
    for (int i = 0; i < count; i++) {
        if (order[i] == node) return i;
    }
    return -1;
}

static void write_nodes(Buf *b, ufbx_scene *scene) {
    buf_str(b, "\"nodes\":[");

    /* Build the DFS pre-order emit list (root's subtrees, root excluded). */
    ufbx_node **order = (ufbx_node **)malloc(scene->nodes.count * sizeof(ufbx_node *));
    int count = 0;
    ufbx_node *root = scene->root_node;
    if (root) {
        for (size_t i = 0; i < root->children.count; i++) {
            dfs_assign(root->children.data[i], order, &count);
        }
    }

    for (int n = 0; n < count; n++) {
        ufbx_node *node = order[n];
        if (n > 0) buf_char(b, ',');

        buf_char(b, '{');

        /* name */
        buf_str(b, "\"name\":");
        buf_quoted(b, node->name.data ? node->name.data : "");
        buf_char(b, ',');

        /* transform (local) */
        ufbx_transform xform = node->local_transform;
        buf_str(b, "\"transform\":{");
        buf_str(b, "\"translation\":[");
        buf_double(b, xform.translation.x); buf_char(b, ',');
        buf_double(b, xform.translation.y); buf_char(b, ',');
        buf_double(b, xform.translation.z);
        buf_str(b, "],\"rotation\":[");
        buf_double(b, xform.rotation.x); buf_char(b, ',');
        buf_double(b, xform.rotation.y); buf_char(b, ',');
        buf_double(b, xform.rotation.z); buf_char(b, ',');
        buf_double(b, xform.rotation.w);
        buf_str(b, "],\"scale\":[");
        buf_double(b, xform.scale.x); buf_char(b, ',');
        buf_double(b, xform.scale.y); buf_char(b, ',');
        buf_double(b, xform.scale.z);
        buf_str(b, "]},");

        /* meshIndex */
        buf_str(b, "\"meshIndex\":");
        if (node->mesh) {
            int idx = -1;
            for (size_t mi = 0; mi < scene->meshes.count; mi++) {
                if (scene->meshes.data[mi] == node->mesh) { idx = (int)mi; break; }
            }
            buf_int(b, idx);
        } else {
            buf_int(b, -1);
        }
        buf_char(b, ',');

        /* children (indices into the emitted DFS list) */
        buf_str(b, "\"children\":[");
        int first_child = 1;
        for (size_t ci = 0; ci < node->children.count; ci++) {
            ufbx_node *child = node->children.data[ci];
            if (skip_node(child)) continue;
            if (!first_child) buf_char(b, ',');
            first_child = 0;
            buf_int(b, index_of(order, count, child));
        }
        buf_char(b, ']');

        buf_char(b, '}');
    }
    buf_char(b, ']');
    free(order);
}

/* LODGroup is a NodeAttribute attached to a parent node.  ufbx exposes the
 * attribute's instances and keeps each instance's child order as the source
 * file order, so export one engine group per instance rather than flattening
 * multiple FBX instances into one ambiguous list. */
static void write_lod_groups(Buf *b, ufbx_scene *scene) {
    if (scene->lod_groups.count == 0) return;

    buf_str(b, ",\"lodGroups\":[");
    int first_group = 1;
    for (size_t gi = 0; gi < scene->lod_groups.count; gi++) {
        ufbx_lod_group *lod = scene->lod_groups.data[gi];
        for (size_t ii = 0; ii < lod->instances.count; ii++) {
            ufbx_node *parent = lod->instances.data[ii];
            if (!parent) continue;
            if (!first_group) buf_char(b, ',');
            first_group = 0;
            buf_str(b, "{\"children\":[");
            for (size_t ci = 0; ci < parent->children.count; ci++) {
                if (ci > 0) buf_char(b, ',');
                ufbx_node *child = parent->children.data[ci];
                int mesh_index = -1;
                if (child && child->mesh) {
                    for (size_t mi = 0; mi < scene->meshes.count; mi++) {
                        if (scene->meshes.data[mi] == child->mesh) {
                            mesh_index = (int)mi;
                            break;
                        }
                    }
                }
                buf_str(b, "{\"meshIndex\":");
                buf_int(b, mesh_index);
                if (ci < lod->lod_levels.count) {
                    const ufbx_lod_level *level = &lod->lod_levels.data[ci];
                    buf_str(b, ",\"distance\":");
                    buf_double(b, level->distance);
                    buf_str(b, ",\"display\":");
                    switch (level->display) {
                    case UFBX_LOD_DISPLAY_SHOW: buf_quoted(b, "show"); break;
                    case UFBX_LOD_DISPLAY_HIDE: buf_quoted(b, "hide"); break;
                    default: buf_quoted(b, "use-lod"); break;
                    }
                }
                buf_char(b, '}');
            }
            buf_str(b, "],\"threshold\":");
            if (lod->lod_levels.count > 1) {
                buf_double(b, lod->lod_levels.data[1].distance);
            } else {
                buf_double(b, 0.0);
            }
            buf_str(b, ",\"mode\":");
            buf_quoted(b, lod->relative_distances ? "percentage" : "distance");
            buf_str(b, ",\"relative\":");
            buf_str(b, lod->relative_distances ? "true" : "false");
            buf_str(b, ",\"displayMode\":\"eLODGroup\"}");
        }
    }
    buf_char(b, ']');
}

/* ── Materials writing ─────────────────────────────────────────────── */

static void write_materials(Buf *b, ufbx_scene *scene) {
    if (scene->materials.count == 0) return;

    buf_str(b, ",\"materials\":[");
    for (size_t i = 0; i < scene->materials.count; i++) {
        ufbx_material *mat = scene->materials.data[i];
        if (i > 0) buf_char(b, ',');
        buf_char(b, '{');

        buf_str(b, "\"name\":");
        buf_quoted(b, mat->name.data ? mat->name.data : "");
        buf_char(b, ',');

        /* Material kind detection (KB §1.7 / appendix B-1, PBR-first).
         *
         * shader_type alone under-classifies: a material whose shader_type is
         * UFBX_SHADER_UNKNOWN (e.g. legacy 3ds Max "Standard") still fills
         * material->fbx.* / material->pbr.* with valid values, so keying only
         * on the shader_type whitelist wrongly drops it to "fallback" grey.
         *
         * Classification (matches the SDK binding's StingrayPBS > Phong >
         * Lambert > fallback priority):
         *   - explicit PBR shader graphs (Stingray/glTF/3ds-Max-PBR/OSL/Arnold/
         *     OpenPBR) or a material with the PBR feature enabled -> stingray-pbs
         *     (read pbr.* maps)
         *   - otherwise a material that has specular (Phong lighting) -> phong
         *     (read fbx.* maps: diffuse + specular_exponent + specular_color)
         *   - otherwise a material with diffuse -> lambert (read fbx.diffuse)
         *   - otherwise -> fallback */
        int is_pbr_shader =
            mat->shader_type == UFBX_SHADER_SHADERFX_GRAPH ||
            mat->shader_type == UFBX_SHADER_GLTF_MATERIAL ||
            mat->shader_type == UFBX_SHADER_3DS_MAX_PBR_METAL_ROUGH ||
            mat->shader_type == UFBX_SHADER_3DS_MAX_PBR_SPEC_GLOSS ||
            mat->shader_type == UFBX_SHADER_3DS_MAX_PHYSICAL_MATERIAL ||
            mat->shader_type == UFBX_SHADER_OSL_STANDARD_SURFACE ||
            mat->shader_type == UFBX_SHADER_ARNOLD_STANDARD_SURFACE ||
            mat->shader_type == UFBX_SHADER_OPENPBR_MATERIAL;

        int is_phong =
            mat->shader_type == UFBX_SHADER_FBX_PHONG ||
            mat->shader_type == UFBX_SHADER_BLENDER_PHONG ||
            mat->features.specular.enabled;

        int has_diffuse =
            mat->features.diffuse.enabled || mat->fbx.diffuse_color.has_value;

        if (is_pbr_shader || mat->features.pbr.enabled) {

            ufbx_material_map bc = mat->pbr.base_color;
            buf_str(b, "\"kind\":\"stingray-pbs\",");
            buf_str(b, "\"stingrayProps\":{");
            buf_str(b, "\"baseColor\":[");
            buf_double(b, bc.value_vec4.x); buf_char(b, ',');
            buf_double(b, bc.value_vec4.y); buf_char(b, ',');
            buf_double(b, bc.value_vec4.z);
            buf_str(b, "],");
            buf_str(b, "\"metallic\":");
            buf_double(b, mat->pbr.metalness.value_real);
            buf_str(b, ",\"roughness\":");
            buf_double(b, mat->pbr.roughness.value_real);
            buf_char(b, '}');

        } else if (is_phong) {
            buf_str(b, "\"kind\":\"phong\",");
            buf_str(b, "\"diffuse\":[");
            buf_double(b, mat->fbx.diffuse_color.value_vec3.x); buf_char(b, ',');
            buf_double(b, mat->fbx.diffuse_color.value_vec3.y); buf_char(b, ',');
            buf_double(b, mat->fbx.diffuse_color.value_vec3.z);
            buf_str(b, "],");
            buf_str(b, "\"shininess\":");
            buf_double(b, mat->fbx.specular_exponent.value_real);
            buf_str(b, ",\"specular\":[");
            buf_double(b, mat->fbx.specular_color.value_vec3.x); buf_char(b, ',');
            buf_double(b, mat->fbx.specular_color.value_vec3.y); buf_char(b, ',');
            buf_double(b, mat->fbx.specular_color.value_vec3.z);
            buf_char(b, ']');

        } else if (has_diffuse || mat->shader_type == UFBX_SHADER_FBX_LAMBERT) {
            buf_str(b, "\"kind\":\"lambert\",");
            buf_str(b, "\"diffuse\":[");
            buf_double(b, mat->fbx.diffuse_color.value_vec3.x); buf_char(b, ',');
            buf_double(b, mat->fbx.diffuse_color.value_vec3.y); buf_char(b, ',');
            buf_double(b, mat->fbx.diffuse_color.value_vec3.z);
            buf_char(b, ']');
        } else {
            buf_str(b, "\"kind\":\"fallback\"");
        }

        buf_str(b, ",\"sourceIndex\":");
        buf_size(b, i);

        buf_char(b, '}');
    }
    buf_char(b, ']');
}

/* ── Skeleton writing ──────────────────────────────────────────────── */

static void write_skeleton(Buf *b, ufbx_scene *scene) {
    /* Find the first skin deformer with clusters */
    ufbx_skin_deformer *skin = NULL;
    for (size_t i = 0; i < scene->skin_deformers.count; i++) {
        if (scene->skin_deformers.data[i]->clusters.count > 0) {
            skin = scene->skin_deformers.data[i];
            break;
        }
    }
    if (!skin) return;

    size_t cluster_count = skin->clusters.count;

    buf_str(b, ",\"skeletons\":[{");
    buf_str(b, "\"jointCount\":"); buf_size(b, cluster_count); buf_char(b, ',');

    /* Inverse bind matrices: for each cluster, compute IBM */
    buf_str(b, "\"inverseBindMatrices\":[");
    for (size_t c = 0; c < cluster_count; c++) {
        ufbx_skin_cluster *cluster = skin->clusters.data[c];
        ufbx_matrix ibm = cluster->geometry_to_bone;

        if (c > 0) buf_char(b, ',');
        /* 4x4 column-major (matching glTF convention) */
        buf_double(b, ibm.m00); buf_char(b, ',');
        buf_double(b, ibm.m10); buf_char(b, ',');
        buf_double(b, ibm.m20); buf_char(b, ',');
        buf_double(b, 0.0);     buf_char(b, ',');
        buf_double(b, ibm.m01); buf_char(b, ',');
        buf_double(b, ibm.m11); buf_char(b, ',');
        buf_double(b, ibm.m21); buf_char(b, ',');
        buf_double(b, 0.0);     buf_char(b, ',');
        buf_double(b, ibm.m02); buf_char(b, ',');
        buf_double(b, ibm.m12); buf_char(b, ',');
        buf_double(b, ibm.m22); buf_char(b, ',');
        buf_double(b, 0.0);     buf_char(b, ',');
        buf_double(b, ibm.m03); buf_char(b, ',');
        buf_double(b, ibm.m13); buf_char(b, ',');
        buf_double(b, ibm.m23); buf_char(b, ',');
        buf_double(b, 1.0);
    }
    buf_str(b, "],");

    /* Joint paths (bone names) */
    buf_str(b, "\"jointPaths\":[");
    for (size_t c = 0; c < cluster_count; c++) {
        ufbx_skin_cluster *cluster = skin->clusters.data[c];
        if (c > 0) buf_char(b, ',');
        const char *name = cluster->bone_node ?
            cluster->bone_node->name.data : "";
        buf_quoted(b, name ? name : "");
    }
    buf_str(b, "]");

    buf_str(b, "}]");
}

/* ── Skin writing ──────────────────────────────────────────────────── */

/* Emit one influence object (top-4 joints by weight, normalized) for skin
 * control point `cp` (an index into skin->vertices). An out-of-range cp emits a
 * zeroed influence so a corner referencing a control point the deformer never
 * weighted still produces a well-formed entry. */
static void write_skin_influence(Buf *b, const ufbx_skin_deformer *skin, size_t cp) {
    buf_str(b, "{\"jointIndices\":[");

    /* Collect all weights for this control point */
    typedef struct { int joint; double weight; } wp;
    wp pairs[64];
    int pair_count = 0;

    if (cp < skin->vertices.count) {
        ufbx_skin_vertex sv = skin->vertices.data[cp];
        for (size_t wi = 0; wi < sv.num_weights && wi < 64; wi++) {
            ufbx_skin_weight w = skin->weights.data[sv.weight_begin + wi];
            if (pair_count < 64) {
                pairs[pair_count].joint = (int)w.cluster_index;
                pairs[pair_count].weight = w.weight;
                pair_count++;
            }
        }
    }

    /* Sort by weight descending (simple bubble for <=64 elements) */
    for (int a = 0; a < pair_count - 1; a++) {
        for (int bb = a + 1; bb < pair_count; bb++) {
            if (pairs[bb].weight > pairs[a].weight) {
                wp tmp = pairs[a]; pairs[a] = pairs[bb]; pairs[bb] = tmp;
            }
        }
    }

    /* Take top 4, normalize */
    int top = pair_count < 4 ? pair_count : 4;
    double sum = 0;
    for (int k = 0; k < top; k++) sum += pairs[k].weight;

    for (int k = 0; k < 4; k++) {
        if (k > 0) buf_char(b, ',');
        buf_int(b, k < top ? pairs[k].joint : 0);
    }
    buf_str(b, "],\"jointWeights\":[");
    for (int k = 0; k < 4; k++) {
        if (k > 0) buf_char(b, ',');
        buf_double(b, (k < top && sum > 0) ? pairs[k].weight / sum : 0.0);
    }
    buf_str(b, "]}");
}

static void write_skin(Buf *b, ufbx_scene *scene) {
    ufbx_skin_deformer *skin = NULL;
    ufbx_mesh *skinned_mesh = NULL;

    for (size_t i = 0; i < scene->skin_deformers.count; i++) {
        ufbx_skin_deformer *sd = scene->skin_deformers.data[i];
        if (sd->clusters.count == 0) continue;
        skin = sd;
        /* Find the mesh this deformer is attached to */
        for (size_t mi = 0; mi < scene->meshes.count; mi++) {
            ufbx_mesh *m = scene->meshes.data[mi];
            for (size_t di = 0; di < m->skin_deformers.count; di++) {
                if (m->skin_deformers.data[di] == sd) { skinned_mesh = m; break; }
            }
            if (skinned_mesh) break;
        }
        break;
    }
    if (!skin || !skinned_mesh) return;

    /* write_mesh de-indexes geometry to one vertex per polygon corner (positions
     * sized mesh->num_indices), while ufbx stores skin influences per control
     * point (skin->vertices, indexed by control-point index). Emit influences in
     * the same corner order the mesh uses: for each corner, look up its control
     * point via vertex_position.indices and expand that control point's weights.
     * This keeps influences.length == the emitted mesh vertex count, which
     * to-asset-pack.ts requires (influences.length === vc) to write the skinned
     * 18-float vertex layout. A control-point-length array (1605) against a
     * corner-length mesh (9618 for humanoid) makes that check fail, silently
     * drops skinIndex/skinWeight, and the render-system then fail-fasts with
     * material-skin-attr-missing. Mirrors the per-vertex contract glTF skins
     * already satisfy. */
    size_t corner_count = skinned_mesh->num_indices;
    size_t cluster_count = skin->clusters.count;

    buf_str(b, ",\"skins\":[{");
    buf_str(b, "\"meshSourceIndex\":0,");

    /* Joint paths */
    buf_str(b, "\"jointPaths\":[");
    for (size_t c = 0; c < cluster_count; c++) {
        if (c > 0) buf_char(b, ',');
        const char *name = skin->clusters.data[c]->bone_node ?
            skin->clusters.data[c]->bone_node->name.data : "";
        buf_quoted(b, name ? name : "");
    }
    buf_str(b, "],");

    buf_str(b, "\"vertexCount\":"); buf_size(b, corner_count); buf_char(b, ',');

    /* Per-corner influences (top 4, normalized), expanded from control points. */
    buf_str(b, "\"influences\":[");
    for (size_t corner = 0; corner < corner_count; corner++) {
        if (corner > 0) buf_char(b, ',');
        uint32_t cp = skinned_mesh->vertex_position.indices.data[corner];
        write_skin_influence(b, skin, cp);
    }
    buf_char(b, ']');

    buf_str(b, "}]");
}

/* ── Node path helper ──────────────────────────────────────────────── */

static void build_node_path(char *out, size_t out_size, ufbx_node *node) {
    /* Build "Root/Parent/Child" from bottom up, then reverse segments. */
    const char *segments[128];
    int depth = 0;
    ufbx_node *cur = node;
    while (cur && !cur->is_root && depth < 128) {
        segments[depth++] = cur->name.data ? cur->name.data : "";
        cur = cur->parent;
    }
    size_t pos = 0;
    for (int i = depth - 1; i >= 0; i--) {
        if (i < depth - 1 && pos < out_size - 1) out[pos++] = '/';
        const char *s = segments[i];
        while (*s && pos < out_size - 1) out[pos++] = *s++;
    }
    out[pos] = '\0';
}

/* ── Animation writing ─────────────────────────────────────────────── */

static int source_property_has_keys(const ufbx_anim_stack *stack, const ufbx_node *node, const char *property) {
    for (size_t i=0;i<stack->layers.count;i++) {
        ufbx_anim_prop *prop=ufbx_find_anim_prop(stack->layers.data[i],&node->element,property);
        if (prop && prop->anim_value) for (int c=0;c<3;c++) if (prop->anim_value->curves[c] && prop->anim_value->curves[c]->keyframes.count) return 1;
    }
    return 0;
}
typedef struct { double time; double values[4]; } AnimationKey;
typedef struct { AnimationKey *data; size_t count, capacity; } AnimationKeys;
/* Retained keys are ordinary Float32 runtime lerp/slerp samples. Error refinement
 * evaluates the original composed source, never the already baked interpolant. */
static AnimationKey animation_key(ufbx_anim *anim, ufbx_node *node, int property, double time, double origin) {
    /* Translation includes pivot/rotation/scale dependencies. Rotation and scale
     * can use ufbx's narrower evaluation without dropping their dependencies. */
    uint32_t flags = property == 0 ? 0 : UFBX_TRANSFORM_FLAG_EXPLICIT_INCLUDES |
        (property == 1 ? UFBX_TRANSFORM_FLAG_INCLUDE_ROTATION : UFBX_TRANSFORM_FLAG_INCLUDE_SCALE);
    ufbx_transform t = ufbx_evaluate_transform_flags(anim, node, origin + time, flags);
    AnimationKey key = {0}; key.time = time;
    if (property == 1) { key.values[0]=t.rotation.x; key.values[1]=t.rotation.y; key.values[2]=t.rotation.z; key.values[3]=t.rotation.w; }
    else { ufbx_vec3 v = property == 0 ? t.translation : t.scale; key.values[0]=v.x; key.values[1]=v.y; key.values[2]=v.z; }
    return key;
}
/* Nine significant decimal digits round-trip the runtime's Float32 values.
 * Keep source evaluation in double precision; narrow only at POD publication. */
static int buf_animation_value(Buf *b, double value) {
    if (!isfinite((float)value)) return 0;
    char text[32];
    snprintf(text, sizeof(text), "%.9g", (double)(float)value);
    buf_str(b, text);
    return 1;
}
static int append_animation_key(AnimationKeys *keys, AnimationKey key, size_t *total) {
    if (++(*total) > 2000000) return 0;
    if (keys->count == keys->capacity) {
        size_t capacity = keys->capacity ? keys->capacity*2 : 256;
        AnimationKey *data = realloc(keys->data, capacity*sizeof(AnimationKey));
        if (!data) return 0; keys->data=data; keys->capacity=capacity;
    }
    keys->data[keys->count++]=key; return 1;
}
static int refine_animation_segment(AnimationKeys *keys, size_t *total, ufbx_anim *anim, ufbx_node *node, int property, AnimationKey a, AnimationKey b, double origin, int depth, const AnimationKey *midpoint) {
    AnimationKey references[3];
    int split = 0;
    for (int i=1; i<=3; i++) {
        double alpha=i*0.25;
        AnimationKey reference = i == 2 && midpoint ? *midpoint :
            animation_key(anim,node,property,a.time+(b.time-a.time)*alpha,origin);
        references[i-1] = reference;
        if (property == 1) {
            ufbx_quat qa={a.values[0],a.values[1],a.values[2],a.values[3]}, qb={b.values[0],b.values[1],b.values[2],b.values[3]};
            ufbx_quat q=ufbx_quat_slerp(qa,qb,alpha);
            double dot=fabs(q.x*reference.values[0]+q.y*reference.values[1]+q.z*reference.values[2]+q.w*reference.values[3]);
            if (dot < cos(0.01*3.141592653589793/360.0)) split=1;
        } else {
            double error=0; for (int c=0;c<3;c++) { double delta=a.values[c]+(b.values[c]-a.values[c])*alpha-reference.values[c]; error+=delta*delta; }
            double epsilon=property == 0 ? 2e-4 : 1e-5;
            if (error > epsilon*epsilon) split=1;
        }
    }
    /* Mixed source steps have a bounded <=10us transition in the LINEAR POD.
     * Refining below Float32 time precision cannot improve runtime evidence. */
    if (!split || b.time-a.time <= fmax(1e-5,4.76837158203125e-7*fmax(fabs(a.time),fabs(b.time)))) return append_animation_key(keys,b,total);
    if (depth >= 14) return 0;
    /* Parent quarter points are the child midpoints. Keep their source values
     * instead of evaluating the same times again at each recursion level. */
    AnimationKey mid = references[1];
    return refine_animation_segment(keys,total,anim,node,property,a,mid,origin,depth+1,&references[0]) && refine_animation_segment(keys,total,anim,node,property,mid,b,origin,depth+1,&references[2]);
}

/* ufbx provides source knots, composed layers and bounded non-linear seed samples.
 * Retain those knots and adapt to measured source error; runtime stays format-free. */
static int write_animation(Buf *b, ufbx_scene *scene) {
    if (scene->anim_stacks.count == 0) return 1;
    buf_str(b, ",\"clips\":[");
    int first_clip = 1;
    size_t total_keys = 0;
    for (size_t si = 0; si < scene->anim_stacks.count; si++) {
        ufbx_anim_stack *stack = scene->anim_stacks.data[si];
        if (stack->time_end <= stack->time_begin || stack->layers.count == 0) continue;
        ufbx_bake_opts opts = { 0 };
        opts.trim_start_time = true;
        opts.resample_rate = 60.0;
        opts.minimum_sample_rate = 1e30;
        opts.max_keyframe_segments = 4096;
        opts.key_reduction_enabled = true;
        opts.key_reduction_rotation = true;
        opts.key_reduction_threshold = 1e-6;
        opts.step_handling = UFBX_BAKE_STEP_HANDLING_CUSTOM_DURATION;
        opts.step_custom_duration = 1e-5;
        opts.step_custom_epsilon = 1e-6;
        opts.temp_allocator.memory_limit = 256 * 1024 * 1024;
        opts.result_allocator.memory_limit = 256 * 1024 * 1024;
        ufbx_error error;
        ufbx_baked_anim *bake = ufbx_bake_anim(scene, stack->anim, &opts, &error);
        if (!bake) return 0;
        if (bake->nodes.count == 0) { ufbx_free_baked_anim(bake); continue; }
        if (!first_clip) buf_char(b, ',');
        first_clip = 0;
        buf_str(b, "{\"name\":"); buf_quoted(b, stack->name.data ? stack->name.data : "");
        buf_str(b, ",\"duration\":"); buf_double(b, bake->playback_duration);
        buf_str(b, ",\"channels\":[");
        int first_channel = 1;
        for (size_t ni = 0; ni < bake->nodes.count; ni++) {
            const ufbx_baked_node *bn = &bake->nodes.data[ni];
            ufbx_node *node = scene->nodes.data[bn->typed_id];
            if (skip_node(node)) continue;
            char path[1024]; build_node_path(path, sizeof(path), node);
            for (int property = 0; property < 3; property++) {
                const ufbx_baked_vec3_list vecs = property == 0 ? bn->translation_keys : bn->scale_keys;
                const ufbx_baked_quat_list rots = bn->rotation_keys;
                size_t count = property == 1 ? rots.count : vecs.count;
                if (count == 0) continue;
                int authored=source_property_has_keys(stack,node,property==0?UFBX_Lcl_Translation:property==1?UFBX_Lcl_Rotation:UFBX_Lcl_Scaling);
                if (!authored && property == 1 && bn->constant_rotation) {
                    ufbx_quat a = rots.data[0].value, v = node->local_transform.rotation;
                    if (fabs(fabs(a.x*v.x+a.y*v.y+a.z*v.z+a.w*v.w)-1.0) < 1e-10) continue;
                } else if (!authored && ((property == 0 && bn->constant_translation) || (property == 2 && bn->constant_scale))) {
                    ufbx_vec3 a = vecs.data[0].value, v = property == 0 ? node->local_transform.translation : node->local_transform.scale;
                    if (fabs(a.x-v.x) < 1e-10 && fabs(a.y-v.y) < 1e-10 && fabs(a.z-v.z) < 1e-10) continue;
                }
                AnimationKeys keys = {0};
                AnimationKey previous = {0};
                for (size_t k=0;k<count;k++) {
                    double time = property == 1 ? rots.data[k].time : vecs.data[k].time;
                    AnimationKey key=animation_key(stack->anim,node,property,time,stack->time_begin);
                    int ok = k == 0 ? append_animation_key(&keys,key,&total_keys) : refine_animation_segment(&keys,&total_keys,stack->anim,node,property,previous,key,stack->time_begin,0,NULL);
                    if (!ok) { free(keys.data); ufbx_free_baked_anim(bake); return 0; }
                    previous=key;
                }
                if (!first_channel) buf_char(b, ','); first_channel = 0;
                buf_str(b, "{\"targetNode\":"); buf_quoted(b, path);
                buf_str(b, ",\"property\":"); buf_quoted(b, property == 0 ? "translation" : property == 1 ? "rotation" : "scale");
                buf_str(b, ",\"keyTimes\":[");
                for (size_t k = 0; k < keys.count; k++) { if (k) buf_char(b, ','); buf_double(b,keys.data[k].time); }
                buf_str(b, "],\"keyValues\":[");
                for (size_t k = 0; k < keys.count; k++) {
                    for (int c=0;c<(property==1?4:3);c++) { if (k||c) buf_char(b,','); if (!buf_animation_value(b,keys.data[k].values[c])) { free(keys.data); ufbx_free_baked_anim(bake); return 0; } }
                }
                free(keys.data);
                buf_str(b,"]}");
            }
        }
        buf_str(b,"]}"); ufbx_free_baked_anim(bake);
    }
    buf_char(b,']'); return 1;
}

static char *g_result = NULL;
static size_t g_result_len = 0;

__attribute__((used))
void parseFbxWasm(const void *data, size_t size) {
    /* Free previous result */
    if (g_result) { free(g_result); g_result = NULL; g_result_len = 0; }

    /* Load FBX from memory via ufbx */
    ufbx_load_opts opts = { 0 };
    opts.target_axes = ufbx_axes_right_handed_y_up;
    opts.target_unit_meters = 1.0;
    opts.space_conversion = UFBX_SPACE_CONVERSION_TRANSFORM_ROOT;

    ufbx_error error;
    ufbx_scene *scene = ufbx_load_memory(data, size, &opts, &error);

    if (!scene) {
        /* Return error JSON */
        Buf b; buf_init(&b);
        buf_str(&b, "{\"error\":{\"code\":\"fbx-parse-failed\",\"message\":");
        buf_quoted(&b, error.description.data ? error.description.data : "unknown error");
        buf_str(&b, "}}");
        g_result = b.data;
        g_result_len = b.len;
        return;
    }

    Buf b;
    buf_init(&b);
    buf_char(&b, '{');

    /* Meshes */
    buf_str(&b, "\"meshes\":[");
    for (size_t i = 0; i < scene->meshes.count; i++) {
        if (i > 0) buf_char(&b, ',');
        write_mesh(&b, scene->meshes.data[i], (int)i);
    }
    buf_str(&b, "],");

    /* Nodes */
    write_nodes(&b, scene);

    /* Native FbxLODGroup attributes and their ordered node children. */
    write_lod_groups(&b, scene);

    /* Materials */
    write_materials(&b, scene);

    /* Skeleton */
    write_skeleton(&b, scene);

    /* Skin */
    write_skin(&b, scene);

    /* Animation */
    if (!write_animation(&b, scene)) {
        free(b.data); b = (Buf){ 0 };
        buf_str(&b, "{\"error\":{\"code\":\"fbx-parse-failed\",\"message\":\"bounded ufbx animation bake failed\"}}");
        g_result = b.data; g_result_len = b.len; ufbx_free_scene(scene); return;
    }

    buf_char(&b, '}');

    g_result = b.data;
    g_result_len = b.len;

    ufbx_free_scene(scene);
}

__attribute__((used))
const char *getResultPtr(void) { return g_result; }

__attribute__((used))
size_t getResultLen(void) { return g_result_len; }

__attribute__((used))
void freeResult(void) {
    if (g_result) { free(g_result); g_result = NULL; g_result_len = 0; }
}
