//! ForgeaX engine-agnostic modeling kernel.
//!
//! Organized as one cohesive Rust crate with internal modules (`geometry`, and upcoming
//! `mesh`, `selector`, `ops`, `bake`, `surface`) sharing a single linear memory domain.

pub mod arena;
pub mod error;

#[cfg(feature = "geometry")]
pub mod geometry;

#[cfg(feature = "modeling")]
pub mod mesh;

#[cfg(feature = "modeling")]
pub mod selector;

#[cfg(feature = "modeling")]
pub mod ops;

#[cfg(feature = "modeling")]
pub mod uv;

#[cfg(feature = "modeling")]
pub mod solve;

#[cfg(feature = "modeling")]
pub mod skin;

#[cfg(feature = "modeling")]
pub mod query;

#[cfg(feature = "surface")]
pub mod surface;

#[cfg(feature = "bake")]
pub mod bake;

#[cfg(test)]
mod tests {
    use crate::geometry::*;

    #[test]
    fn builder_completes_quad_surface_stream_in_both_separate_and_interleaved_modes() {
        let mut b = MeshBuilderState::new(
            &[
                (AttributeKind::Position, AttributeFormat::Float32x3),
                (AttributeKind::Uv, AttributeFormat::Float32x2),
            ],
            1,
            4,
            6,
        )
        .unwrap();
        let base = b.allocate_vertices(4).unwrap();
        assert_eq!(base, 0);
        let pos_vals: [f32; 12] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        let uv_vals: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0];
        for (i, v) in pos_vals.iter().enumerate() {
            b.channels[0].bytes[i * 4..(i + 1) * 4].copy_from_slice(&v.to_le_bytes());
        }
        for (i, v) in uv_vals.iter().enumerate() {
            b.channels[1].bytes[i * 4..(i + 1) * 4].copy_from_slice(&v.to_le_bytes());
        }
        let ioff = b.allocate_indices(6).unwrap();
        assert_eq!(ioff, 0);
        b.indices.copy_from_slice(&[0, 1, 2, 0, 2, 3]);

        // Interleaved mode (ForgeaX zero-copy)
        let interleaved = b.build(OutputMode::Interleaved).unwrap();
        assert_eq!(interleaved.layout.array_stride, 48);
        assert_eq!(interleaved.interleaved.len(), 4 * 48);
        assert!(interleaved.channels.is_empty());
        assert_eq!(interleaved.aabb, [0.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
        assert!(matches!(interleaved.indices, IndexOutput::U16(ref v) if v == &[0, 1, 2, 0, 2, 3]));

        // Separate mode (Three.js BufferGeometry zero-copy)
        let separate = b.build(OutputMode::Separate).unwrap();
        assert!(separate.interleaved.is_empty());
        assert_eq!(separate.channels.len(), 4);
        assert_eq!(separate.channels[0].kind, AttributeKind::Position);
        assert_eq!(separate.channels[1].kind, AttributeKind::Normal);
        assert_eq!(separate.channels[2].kind, AttributeKind::Uv);
        assert_eq!(separate.channels[3].kind, AttributeKind::Tangent);
    }

    #[test]
    fn tangent_frame32_round_trips_orthonormal_basis() {
        let word = encode_tangent_frame32(0.0, 0.0, 1.0, 1.0, 0.0, 0.0, -1.0).unwrap();
        let decoded = decode_tangent_frame32(word);
        assert!((decoded[2] - 1.0).abs() < 1e-3);
        assert!((decoded[3] - 1.0).abs() < 2e-2);
        assert_eq!(decoded[6], -1.0);
    }

    #[test]
    fn edit_mesh_box_extrude_inset_subdivide_and_fxsl_vm() {
        use crate::mesh::geom::{is_closed, volume_about};
        use crate::mesh::EditMesh;
        use crate::ops::primitives::{append_box, tag_faces, Attribution};
        use crate::ops::region::{extrude, inset, RegionMode};
        use crate::ops::subdivide::{subdivide, SubdivisionBoundary, SubdivisionScheme};
        use crate::selector::{eval_node, resolve_fxsl, SelectorNode, FXSL_MAGIC, FXSL_VERSION};

        let mut m = EditMesh::new();
        let faces = append_box(
            &mut m,
            [2.0, 2.0, 2.0],
            [1, 1, 1],
            [0.0, 0.0, 0.0],
            Attribution::default(),
        )
        .unwrap();
        assert_eq!(faces.len(), 6);
        assert_eq!(m.vertex_count(), 8);
        assert!(is_closed(&m));
        assert!((volume_about(&m, [0.0, 0.0, 0.0]) - 8.0).abs() < 1e-9);

        // Select +Y face via FXSL v1 binary wire format: magic + ver + nonEmpty(0) + OP.facing(6) + axis(+y=2) + deg(15.0)
        let mut fxsl = Vec::new();
        fxsl.extend_from_slice(&FXSL_MAGIC.to_le_bytes());
        fxsl.push(FXSL_VERSION);
        fxsl.push(0); // nonEmpty
        fxsl.push(6); // facing
        fxsl.push(2); // +y
        fxsl.extend_from_slice(&15.0f64.to_le_bytes());
        let top = resolve_fxsl(&m, &fxsl).unwrap();
        assert_eq!(top.len(), 1);

        // Tag, inset, and extrude top face
        tag_faces(&mut m, &top, "roof").unwrap();
        let tagged = eval_node(&m, &SelectorNode::Tag("roof".into())).unwrap();
        assert_eq!(tagged, top);

        let cap_label = m.name_index_label("cap");
        let (inner, rim) = inset(&mut m, &top, 0.25, RegionMode::Merged, cap_label).unwrap();
        assert_eq!((inner, rim), (1, 4));
        assert_eq!(m.face_count(), 10);
        assert!(is_closed(&m));

        let top2 = resolve_fxsl(&m, &fxsl).unwrap();
        let inner_face = eval_node(
            &m,
            &SelectorNode::CreatedBy {
                label: "cap".into(),
                role: Some("inner".into()),
            },
        )
        .unwrap();
        assert_eq!(top2.len(), 5);
        assert_eq!(inner_face.len(), 1);

        let (moved, walls) = extrude(&mut m, &inner_face, 1.0, RegionMode::Merged, 0).unwrap();
        assert_eq!((moved, walls), (1, 4));
        assert_eq!(m.face_count(), 14);
        assert!(is_closed(&m));
        // Volume increased by (2 - 0.5)^2 * 1.0 = 2.25 => 10.25
        assert!((volume_about(&m, [0.0, 0.0, 0.0]) - 10.25).abs() < 1e-9);

        // Catmull-Clark subdivide 2 levels directly in Rust memory (no FXEM)
        let all_faces = m.faces();
        let out_faces = subdivide(
            &mut m,
            &all_faces,
            2,
            SubdivisionScheme::CatmullClark,
            SubdivisionBoundary::EdgeAndCorner,
            f64::INFINITY,
            100_000,
        )
        .unwrap();
        assert_eq!(out_faces, 14 * 4 * 4);
        assert!(is_closed(&m));

        // Zero-FXEM direct build into RenderMesh
        let built = m.build_render_mesh(OutputMode::Interleaved).unwrap();
        assert_eq!(built.vertex_count, (out_faces * 4) as u32);
        assert!(!built.interleaved.is_empty());
    }

    #[test]
    fn phase3_bvh_thin_offset_mirror_weld_and_uv_lscm_pack() {
        use crate::mesh::geom::{is_closed, volume_about};
        use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SEAM};
        use crate::ops::primitives::{append_box, mark_edge_flags, Attribution};
        use crate::ops::region::RegionMode;
        use crate::ops::wave2::{delete_faces, flip_faces, mirror, offset, weld};
        use crate::selector::{eval_node, SelectorNode};
        use crate::uv::{pack_uv_skyline, project_uv, unwrap_uv_lscm, ProjectionMode, SeamSource};

        // 1. BVH thickness & SelectorNode::Thin on a thin slab (2 x 0.2 x 2)
        let mut slab = EditMesh::new();
        append_box(
            &mut slab,
            [2.0, 0.2, 2.0],
            [1, 1, 1],
            [0.0, 0.0, 0.0],
            Attribution::default(),
        )
        .unwrap();
        let thin_faces = eval_node(&slab, &SelectorNode::Thin { max_width: 0.5 }).unwrap();
        assert_eq!(thin_faces.len(), 2); // top & bottom faces are 0.2m apart

        // 2. Offset + Mirror
        let mut half = EditMesh::new();
        append_box(
            &mut half,
            [1.0, 2.0, 2.0],
            [1, 1, 1],
            [0.5, 0.0, 0.0],
            Attribution::default(),
        )
        .unwrap();
        let inner_face = eval_node(
            &half,
            &SelectorNode::Facing {
                axis: 1,
                degrees: 15.0,
            },
        )
        .unwrap(); // -X face on plane x=0
        delete_faces(&mut half, &inner_face).unwrap();
        let mirrored_count = mirror(&mut half, 0, 1e-5).unwrap();
        assert_eq!(mirrored_count, 5);
        assert!(is_closed(&half));
        assert!((volume_about(&half, [0.0, 0.0, 0.0]) - 8.0).abs() < 1e-9);

        let top = eval_node(
            &half,
            &SelectorNode::Facing {
                axis: 2,
                degrees: 15.0,
            },
        )
        .unwrap();
        let (o_top, o_side) = offset(&mut half, &top, 0.5, RegionMode::Merged, 0).unwrap();
        assert_eq!(o_top, 2);
        assert!(o_side >= 4);
        assert!(is_closed(&half));
        assert!((volume_about(&half, [0.0, 0.0, 0.0]) - 10.0).abs() < 1e-9);

        // 3. Flip + Weld
        let mut box_weld = EditMesh::new();
        append_box(
            &mut box_weld,
            [1.0, 1.0, 1.0],
            [1, 1, 1],
            [0.0, 0.0, 0.0],
            Attribution::default(),
        )
        .unwrap();
        let all_f = box_weld.faces();
        flip_faces(&mut box_weld, &all_f).unwrap();
        assert!((volume_about(&box_weld, [0.0, 0.0, 0.0]) + 1.0).abs() < 1e-9);
        let all_f2 = box_weld.faces();
        flip_faces(&mut box_weld, &all_f2).unwrap();
        // Add duplicate nearby vertex and verify weld merges it
        box_weld.add_vertex(0.5001, 0.5, 0.5).unwrap();
        let (merged, collapsed) = weld(&mut box_weld, 0.001).unwrap();
        assert_eq!((merged, collapsed), (1, 0));

        // 4. UV Project (box) + LSCM Unwrap (sharp/seam) + Skyline Pack
        let mut uv_box = EditMesh::new();
        append_box(
            &mut uv_box,
            [2.0, 1.0, 1.0],
            [2, 1, 1],
            [0.0, 0.0, 0.0],
            Attribution::default(),
        )
        .unwrap();
        let f_all = uv_box.faces();
        project_uv(
            &mut uv_box,
            &f_all,
            ProjectionMode::Box,
            1,
            1.0,
            CornerChannelKind::Uv0,
        )
        .unwrap();
        for &f in &f_all {
            for h in uv_box.face_halves(f) {
                assert!(uv_box.corner(CornerChannelKind::Uv0, h).is_some());
            }
        }
        // Mark all sharp dihedral edges (> 60 deg) as seams and run LSCM + Skyline Pack
        let seam_edges = eval_node(
            &uv_box,
            &SelectorNode::Dihedral {
                greater: true,
                degrees: 60.0,
            },
        )
        .unwrap();
        mark_edge_flags(&mut uv_box, &seam_edges, EDGE_SEAM, true);
        let islands = unwrap_uv_lscm(
            &mut uv_box,
            &f_all,
            SeamSource::Marked,
            CornerChannelKind::Uv0,
        )
        .unwrap();
        assert_eq!(islands, 6);
        let packed = pack_uv_skyline(
            &mut uv_box,
            &f_all,
            1024,
            8.0,
            true,
            true,
            CornerChannelKind::Uv0,
        )
        .unwrap();
        assert_eq!(packed, 6);
        // Every packed UV must lie strictly inside [0, 1]^2
        for &f in &f_all {
            for h in uv_box.face_halves(f) {
                let uv = uv_box.corner(CornerChannelKind::Uv0, h).unwrap();
                assert!(uv[0] >= 0.0 && uv[0] <= 1.0, "u out of bounds: {}", uv[0]);
                assert!(uv[1] >= 0.0 && uv[1] <= 1.0, "v out of bounds: {}", uv[1]);
            }
        }
    }

    #[test]
    fn phase4_surface_generators_mesh_bake_and_standard_pbr_export() {
        use crate::bake::cage::{build_base_averaged_normals, BakeDirection};
        use crate::bake::correspond::{
            bake_correspond, BakeCorrespondInput, BakeGroupConfig, DetailMeshData,
        };
        use crate::bake::eval::{evaluate_bake_maps, BakeEvalOptions, BakeMapKind, BakeSlotSpec};
        use crate::mesh::geom::face_normal;
        use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SEAM};
        use crate::ops::primitives::{
            append_box, mark_edge_flags, set_material_faces, Attribution,
        };
        use crate::ops::region::{extrude, inset, RegionMode};
        use crate::selector::{eval_node, SelectorNode};
        use crate::surface::buffer::ImageBuffer;
        use crate::surface::{
            gen_brushed, gen_perlin_fbm, gen_worley, levels, PbrSurfaceStack, WorleyMode,
        };
        use crate::uv::{pack_uv_skyline, unwrap_uv_lscm, SeamSource};

        // 1. Build a stepped pedestal (has both convex edges AND concave cavity around extruded pillar)
        let mut m = EditMesh::new();
        append_box(
            &mut m,
            [2.0, 0.5, 2.0],
            [1, 1, 1],
            [0.0, 0.25, 0.0],
            Attribution::default(),
        )
        .unwrap();
        let top = eval_node(
            &m,
            &SelectorNode::Facing {
                axis: 2,
                degrees: 15.0,
            },
        )
        .unwrap();
        let cap_label = m.name_index_label("cap");
        inset(&mut m, &top, 0.4, RegionMode::Merged, cap_label).unwrap();
        let inner = eval_node(
            &m,
            &SelectorNode::CreatedBy {
                label: "cap".into(),
                role: Some("inner".into()),
            },
        )
        .unwrap();
        extrude(&mut m, &inner, 1.0, RegionMode::Merged, cap_label).unwrap();

        // Assign material slot "brass" to the extruded top cap
        let pillar_top = eval_node(
            &m,
            &SelectorNode::Facing {
                axis: 2,
                degrees: 15.0,
            },
        )
        .unwrap();
        set_material_faces(&mut m, &pillar_top, "brass").unwrap();
        let brass_slot = m.name_index_material("brass");

        // Unwrap + pack UVs cleanly
        let seams = eval_node(
            &m,
            &SelectorNode::Dihedral {
                greater: true,
                degrees: 45.0,
            },
        )
        .unwrap();
        mark_edge_flags(&mut m, &seams, EDGE_SEAM, true);
        let all_f = m.faces();
        unwrap_uv_lscm(&mut m, &all_f, SeamSource::Marked, CornerChannelKind::Uv0).unwrap();
        pack_uv_skyline(&mut m, &all_f, 64, 2.0, true, true, CornerChannelKind::Uv0).unwrap();

        // 2. Bake via the canonical correspond + evaluate_bake_maps pipeline
        let uv_ch = m.channels[CornerChannelKind::Uv0 as usize]
            .as_ref()
            .unwrap();
        let mut pos = Vec::new();
        let mut nrm = Vec::new();
        let mut tan = Vec::new();
        let mut uv = Vec::new();
        let mut idx = Vec::new();
        let mut tri_group = Vec::new();
        let mut tri_slot = Vec::new();
        let mut tri_face = Vec::new();
        for f in m.faces() {
            let halves = m.face_halves(f);
            if halves.len() < 3 {
                continue;
            }
            let fn_v = face_normal(&m, f);
            let mat = m.f_material[f as usize];
            let p0 = m.position(m.h_vert[halves[0] as usize]);
            let uv0 = [
                uv_ch.values[halves[0] as usize * 2],
                uv_ch.values[halves[0] as usize * 2 + 1],
            ];
            for i in 1..(halves.len() - 1) {
                let h1 = halves[i];
                let h2 = halves[i + 1];
                let p1 = m.position(m.h_vert[h1 as usize]);
                let p2 = m.position(m.h_vert[h2 as usize]);
                let uv1 = [
                    uv_ch.values[h1 as usize * 2],
                    uv_ch.values[h1 as usize * 2 + 1],
                ];
                let uv2 = [
                    uv_ch.values[h2 as usize * 2],
                    uv_ch.values[h2 as usize * 2 + 1],
                ];
                let base_v = (pos.len() / 3) as u32;
                pos.extend_from_slice(&p0);
                pos.extend_from_slice(&p1);
                pos.extend_from_slice(&p2);
                for _ in 0..3 {
                    nrm.extend_from_slice(&fn_v);
                    tan.extend_from_slice(&[1.0, 0.0, 0.0, 1.0]);
                }
                uv.extend_from_slice(&uv0);
                uv.extend_from_slice(&uv1);
                uv.extend_from_slice(&uv2);
                idx.extend_from_slice(&[base_v, base_v + 1, base_v + 2]);
                tri_group.push(0);
                tri_slot.push(if mat == brass_slot { 1 } else { 0 });
                tri_face.push(f);
            }
        }
        let tri_count = tri_group.len();
        let detail_cn = build_base_averaged_normals(&pos, &idx, &tri_group);
        let corr = bake_correspond(BakeCorrespondInput {
            width: 64,
            height: 64,
            samples_per_axis: 1,
            base_positions: pos.clone(),
            base_normals: nrm.clone(),
            base_tangents: tan,
            base_uvs: uv,
            base_indices: idx.clone(),
            base_tri_face: tri_face,
            base_tri_group: tri_group.clone(),
            base_tri_island: vec![0; tri_count],
            base_tri_tagged: vec![0; tri_count],
            detail: DetailMeshData {
                positions: pos,
                corner_normals: detail_cn,
                face_normals: vec![],
                indices: idx,
                tri_group,
                tri_slot,
                floater: vec![0; tri_count],
                vert_curvature: vec![],
                corner_colors: vec![],
                has_corner_colors: false,
            },
            groups: vec![BakeGroupConfig {
                offset: 0.02,
                max_ray: 0.05,
                diagonal: 3.0,
                direction: BakeDirection::Face,
                clip_check: false,
            }],
        })
        .unwrap();
        assert!(corr.counters.covered_texels > 1000);

        let eval = evaluate_bake_maps(
            &corr,
            &BakeEvalOptions {
                maps: vec![
                    BakeMapKind::Ao,
                    BakeMapKind::Curvature,
                    BakeMapKind::Normal,
                    BakeMapKind::BaseColor,
                ],
                slots: vec![
                    BakeSlotSpec {
                        base_color: [0.0, 0.0, 0.0, 1.0],
                        ..Default::default()
                    },
                    BakeSlotSpec {
                        base_color: [1.0, 0.0, 0.0, 1.0],
                        ..Default::default()
                    },
                ],
                gutter: 4,
                ao_samples: 16,
                ao_distance: Some(2.0),
                ao_bias: 1e-4,
                ..Default::default()
            },
        )
        .unwrap();
        let ao_map = &eval.buffers[0].1;
        let curv_map = &eval.buffers[1].1;
        let encoded_norm = &eval.buffers[2].1;
        let mat_mask = &eval.buffers[3].1;
        let mut norm_map = ImageBuffer::new(64, 64, 3, 0.0).unwrap();
        for i in 0..norm_map.pixel_count() {
            norm_map.data[i * 3] = encoded_norm.data[i * 4] * 2.0 - 1.0;
            norm_map.data[i * 3 + 1] = encoded_norm.data[i * 4 + 1] * 2.0 - 1.0;
            norm_map.data[i * 3 + 2] = encoded_norm.data[i * 4 + 2] * 2.0 - 1.0;
        }

        // AO must have both occluded (< 0.9) crease pixels and exposed (~1.0) pixels
        let ao_min = ao_map
            .data
            .chunks_exact(4)
            .map(|px| px[0])
            .fold(f32::INFINITY, f32::min);
        let ao_max = ao_map
            .data
            .chunks_exact(4)
            .map(|px| px[0])
            .fold(f32::NEG_INFINITY, f32::max);
        assert!(
            ao_min < 0.9,
            "expected concave crease occlusion, got min AO {ao_min}"
        );
        assert!(
            ao_max > 0.95,
            "expected exposed faces near 1.0 AO, got max AO {ao_max}"
        );

        // Curvature must span both concave (<0.5) and convex (>0.5) values
        let c_min = curv_map
            .data
            .chunks_exact(4)
            .map(|px| px[0])
            .fold(f32::INFINITY, f32::min);
        let c_max = curv_map
            .data
            .chunks_exact(4)
            .map(|px| px[0])
            .fold(f32::NEG_INFINITY, f32::max);
        assert!(
            c_min < 0.5 && c_max > 0.55,
            "curvature range [{c_min}, {c_max}]"
        );

        // 3. Procedural generators + multi-layer PBR composition
        let noise = gen_perlin_fbm(64, 64, 4, 4, 4, 0.5, 42).unwrap();
        let _worley = gen_worley(64, 64, 4, 4, 1.0, WorleyMode::EdgeF2MinusF1, 7).unwrap();
        let brushed = gen_brushed(64, 64, 32, 4, 99).unwrap();
        let edge_mask = levels(curv_map, 0.55, 0.85, 1.0, 0.0, 1.0);

        let mut surface = PbrSurfaceStack::new(64, 64).unwrap();
        // Base painted metal
        surface
            .add_layer(
                [0.12, 0.16, 0.22],
                0.55,
                0.2,
                0.5,
                [0.0; 3],
                None,
                Some(&noise),
                None,
                1.0,
            )
            .unwrap();
        // Brass material-slot layer
        surface
            .add_layer(
                [0.82, 0.64, 0.28],
                0.30,
                0.95,
                0.6,
                [0.0; 3],
                Some(mat_mask),
                Some(&brushed),
                None,
                1.0,
            )
            .unwrap();
        // Exposed edge wear driven by baked curvature
        surface
            .add_layer(
                [0.75, 0.77, 0.80],
                0.25,
                0.95,
                0.7,
                [0.0; 3],
                Some(&edge_mask),
                None,
                None,
                0.8,
            )
            .unwrap();
        surface.apply_ao(ao_map, 0.85).unwrap();
        surface.apply_base_normal(&norm_map).unwrap();

        let pbr = surface.export_standard_pbr(2.0).unwrap();
        assert_eq!(pbr.base_color_rgba8.len(), 64 * 64 * 4);
        assert_eq!(pbr.normal_rgba8.len(), 64 * 64 * 4);
        assert_eq!(pbr.orm_rgba8.len(), 64 * 64 * 4);
        assert!(pbr.emissive_rgba8.is_empty());

        // Check normal map alpha is 255 and Z channel points predominantly forward (> 127)
        let avg_nz: f64 = pbr
            .normal_rgba8
            .chunks_exact(4)
            .map(|px| {
                assert_eq!(px[3], 255);
                px[2] as f64
            })
            .sum::<f64>()
            / (64.0 * 64.0);
        assert!(
            avg_nz > 180.0,
            "expected tangent-space normals pointing +Z, avg nz={avg_nz}"
        );

        // Check ORM R channel carries baked AO variation (< 240 in creases)
        let min_ao_u8 = pbr.orm_rgba8.chunks_exact(4).map(|px| px[0]).min().unwrap();
        assert!(
            min_ao_u8 < 240,
            "expected baked AO in ORM.R, got min {min_ao_u8}"
        );
    }

    #[test]
    fn convoy_full_rust_operator_suite() {
        use crate::mesh::geom::{is_closed, volume_about};
        use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SHARP};
        use crate::ops::assembly::{append_mesh, array_faces, fill_holes, taper_faces, ArrayMode};
        use crate::ops::bevel::bevel_edges;
        use crate::ops::boolean::{boolean_op, BooleanOp};
        use crate::ops::primitives::{
            append_box, append_cylinder, append_revolve, append_sphere, append_torus,
            mark_edge_flags, Attribution,
        };
        use crate::ops::sweep::{panel_line_plane, sweep_polyline};
        use crate::selector::{eval_node, SelectorNode};
        use crate::uv::auto_uv;

        // 1. Cylinder, Sphere, Torus, Revolve (closed + positive volume)
        let mut cyl = EditMesh::new();
        append_cylinder(
            &mut cyl,
            0.5,
            0.5,
            2.0,
            16,
            1,
            false,
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        assert!(is_closed(&cyl));
        assert!(volume_about(&cyl, [0.0; 3]) > 1.4);

        let mut sph = EditMesh::new();
        append_sphere(&mut sph, 1.0, 16, 12, [0.0; 3], Attribution::default()).unwrap();
        assert!(is_closed(&sph));
        assert!(volume_about(&sph, [0.0; 3]) > 3.8);

        let mut tor = EditMesh::new();
        append_torus(
            &mut tor,
            1.0,
            0.2,
            8,
            24,
            360.0,
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        assert!(is_closed(&tor));
        assert!(volume_about(&tor, [0.0; 3]) > 0.5);

        // Partial revolve + fill_holes
        let mut arc = EditMesh::new();
        append_revolve(
            &mut arc,
            &[
                [0.5, -0.1],
                [0.6, -0.1],
                [0.6, 0.1],
                [0.5, 0.1],
                [0.5, -0.1],
            ],
            12,
            270.0,
            Attribution::default(),
        )
        .unwrap();
        assert!(!is_closed(&arc));
        let bnd = eval_node(&arc, &SelectorNode::MeshBoundary).unwrap();
        let caps = fill_holes(&mut arc, &bnd, None, Attribution::default()).unwrap();
        assert_eq!(caps, 2);
        assert!(is_closed(&arc));

        // 2. Box + Bevel (segs=3) + Boolean Difference with Cylinder bore
        let mut plate = EditMesh::new();
        append_box(
            &mut plate,
            [1.0, 1.0, 0.4],
            [1, 1, 1],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let all_e = plate.edges();
        let (bev_f, cor_f) =
            bevel_edges(&mut plate, &all_e, 0.06, 3, None, Attribution::default()).unwrap();
        assert!(bev_f > 0 && cor_f > 0);
        assert!(is_closed(&plate));

        let mut bore = EditMesh::new();
        append_cylinder(
            &mut bore,
            0.15,
            0.15,
            1.0,
            16,
            1,
            false,
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        // Rotate bore along Z
        let bf = bore.faces();
        crate::ops::primitives::rotate_faces(&mut bore, &bf, 0, 90.0, None).unwrap();
        let before_vol = volume_about(&plate, [0.0; 3]);
        boolean_op(&mut plate, &bore, BooleanOp::Difference, 1e-5).unwrap();
        let after_vol = volume_about(&plate, [0.0; 3]);
        assert!(
            after_vol < before_vol - 0.02,
            "expected bore to remove volume: {before_vol} -> {after_vol}"
        );

        // 3. PanelLine + Sweep + Taper + Array + Append + AutoUV
        let mut panel_box = EditMesh::new();
        append_box(
            &mut panel_box,
            [1.0, 1.0, 0.2],
            [1, 1, 1],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let front = eval_node(
            &panel_box,
            &SelectorNode::Facing {
                axis: 5,
                degrees: 15.0,
            },
        )
        .unwrap();
        let groove = panel_line_plane(
            &mut panel_box,
            &front,
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            0.05,
            0.02,
            None,
            Attribution::default(),
            1e-5,
        )
        .unwrap();
        assert!(groove >= 3);
        assert!(is_closed(&panel_box));

        let mut rod = EditMesh::new();
        sweep_polyline(
            &mut rod,
            &[[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02]],
            &[[0.0, 0.0, 0.0], [0.0, 0.5, 0.0]],
            true,
            40.0,
            [0.0, 1.0, 0.0],
            Attribution::default(),
        )
        .unwrap();
        assert!(is_closed(&rod));
        let rf = rod.faces();
        taper_faces(
            &mut rod,
            &rf,
            1,
            1.2,
            0b001,
            Some([0.0, 0.5]),
            Some([0.0, 0.0, 0.0]),
        )
        .unwrap();
        array_faces(
            &mut rod,
            &rf,
            ArrayMode::Linear {
                count: 3,
                offset: [0.1, 0.0, 0.0],
            },
            "arr",
            Attribution::default(),
        )
        .unwrap();
        append_mesh(
            &mut panel_box,
            &rod,
            [0.0, 0.0, 0.3],
            Attribution::default(),
        )
        .unwrap();

        let sharp = eval_node(
            &panel_box,
            &SelectorNode::Dihedral {
                greater: true,
                degrees: 45.0,
            },
        )
        .unwrap();
        mark_edge_flags(&mut panel_box, &sharp, EDGE_SHARP, true);
        let all_f = panel_box.faces();
        let charts = auto_uv(
            &mut panel_box,
            &all_f,
            45.0,
            true,
            512,
            4.0,
            true,
            CornerChannelKind::Uv0,
        )
        .unwrap();
        assert!(charts >= 6);
        for &f in &all_f {
            for h in panel_box.face_halves(f) {
                let uv = panel_box.corner(CornerChannelKind::Uv0, h).unwrap();
                assert!(uv[0] >= 0.0 && uv[0] <= 1.0 && uv[1] >= 0.0 && uv[1] <= 1.0);
            }
        }
    }

    #[test]
    fn phase5_cleanup_remesh_voxel_lowpoly_cut_deform_uv_skin_query() {
        use crate::mesh::geom::is_closed;
        use crate::mesh::{CornerChannelKind, EditMesh};
        use crate::ops::cleanup::{
            cleanup_planar, cleanup_quads, orient_faces, resolve_t_junctions, split_edges,
            triangulate_faces,
        };
        use crate::ops::cut::{
            duplicate_faces, hole_cut, loop_cut, shell_faces, slice_or_plane_cut,
        };
        use crate::ops::deform::{
            apply_draft, arap_deform, bend_vertices, implicit_smooth, lattice_deform,
            shrinkwrap_vertices, spherize_vertices, taubin_smooth, twist_vertices,
        };
        use crate::ops::lowpoly::{lowpoly_faces, LowpolyOptions};
        use crate::ops::primitives::{append_box, append_sphere, Attribution};
        use crate::ops::remesh::{isotropic_remesh, qem_simplify, RemeshOptions, SimplifyOptions};
        use crate::ops::shapes::{
            append_cone, append_extrude_polygon, append_loft, append_pipe_network, append_polygon,
            lift_triangle_soup,
        };
        use crate::ops::voxel::{build_sdf_from_mesh, surface_nets_to_mesh, SdfGrid};
        use crate::query::{hausdorff_distance, mesh_quality_metrics};
        use crate::skin::{bind_skin_geodesic, SkinBone};
        use crate::uv::ops::{lightmap_uv, plan_seams, straighten_uv, uv_overlap_pairs};
        use std::collections::{HashMap, HashSet};

        // 1. Triangulate + cleanup_quads + cleanup_planar
        let mut m = EditMesh::new();
        append_box(
            &mut m,
            [2.0, 2.0, 2.0],
            [2, 2, 2],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let fs = m.faces();
        let tris = triangulate_faces(&mut m, &fs).unwrap();
        assert_eq!(tris, 48);
        let qf = m.faces();
        let q_cnt = cleanup_quads(&mut m, &qf, 15.0, 0.02).unwrap();
        assert_eq!(q_cnt, 24);
        let pf = m.faces();
        let (merged, _) = cleanup_planar(&mut m, &pf, 1e-5).unwrap();
        assert_eq!(merged, 6);
        let of = m.faces();
        assert!(orient_faces(&mut m, &of).is_ok());
        assert!(resolve_t_junctions(&mut m, 1e-4).is_ok());

        // 2. Simplify & isotropic remesh & lowpoly
        let mut sp = EditMesh::new();
        append_sphere(&mut sp, 1.0, 16, 8, [0.0; 3], Attribution::default()).unwrap();
        let spf = sp.faces();
        let (simp_tris, _) = qem_simplify(
            &mut sp,
            &spf,
            &SimplifyOptions {
                target_faces: Some(64),
                ..Default::default()
            },
            &[],
        )
        .unwrap();
        assert!(simp_tris <= 64);

        let mut rm = EditMesh::new();
        append_box(
            &mut rm,
            [1.0, 1.0, 1.0],
            [1, 1, 1],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let rmf = rm.faces();
        let rem_tris = isotropic_remesh(
            &mut rm,
            &rmf,
            &RemeshOptions {
                target_edge_length: 0.4,
                iterations: 2,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(rem_tris > 12);

        let mut lp_m = EditMesh::new();
        append_box(
            &mut lp_m,
            [1.0, 1.0, 1.0],
            [2, 2, 2],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let lpf = lp_m.faces();
        let lp_rep = lowpoly_faces(
            &mut lp_m,
            &lpf,
            &LowpolyOptions {
                target_faces: 12,
                auto_uv: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(lp_rep.triangles <= 12 && lp_rep.charts >= 1);

        // 3. Voxel SDF encode/decode + Surface Nets
        let mut vx_m = EditMesh::new();
        append_box(
            &mut vx_m,
            [1.0, 1.0, 1.0],
            [1, 1, 1],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let vxf = vx_m.faces();
        let sdf = build_sdf_from_mesh(&vx_m, &vxf, 0.25, 2, 0.0).unwrap();
        let bytes = sdf.encode();
        let decoded = SdfGrid::decode(&bytes).unwrap();
        let vmesh = surface_nets_to_mesh(&decoded, 0.0, Attribution::default()).unwrap();
        assert!(vmesh.face_count() >= 12);

        // 4. Cut, shell, hole, loop_cut, bisect, split, duplicate
        let mut sh_m = EditMesh::new();
        append_polygon(
            &mut sh_m,
            &[[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]],
            false,
            Attribution::default(),
        )
        .unwrap();
        let shf = sh_m.faces();
        let added = shell_faces(&mut sh_m, &shf, 0.2, -1, Attribution::default()).unwrap();
        assert!(added >= 5 && is_closed(&sh_m));

        let mut hl_m = EditMesh::new();
        append_box(
            &mut hl_m,
            [2.0, 2.0, 0.4],
            [1, 1, 1],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let top_f = *hl_m
            .faces()
            .iter()
            .find(|&&f| crate::mesh::geom::face_normal(&hl_m, f)[2] > 0.9)
            .unwrap();
        hole_cut(
            &mut hl_m,
            top_f,
            &[[0.0, 0.0]],
            0.4,
            0.5,
            12,
            Attribution::default(),
            1e-5,
        )
        .unwrap();
        assert!(is_closed(&hl_m));

        let mut lc_m = EditMesh::new();
        append_box(
            &mut lc_m,
            [2.0, 1.0, 1.0],
            [1, 1, 1],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let x_edge = lc_m
            .edges()
            .into_iter()
            .find(|&e| {
                let [a, b] = lc_m.edge_vertices(e);
                (lc_m.position(a)[0] - lc_m.position(b)[0]).abs() > 1.5
            })
            .unwrap();
        let lc_f = loop_cut(&mut lc_m, &[x_edge], 2).unwrap();
        assert!(lc_f >= 8 && is_closed(&lc_m));
        assert!(slice_or_plane_cut(
            &mut lc_m,
            [0.0; 3],
            [1.0, 0.0, 0.0],
            true,
            true,
            1e-5,
            Attribution::default()
        )
        .is_ok());

        let mut dup_m = EditMesh::new();
        append_box(
            &mut dup_m,
            [1.0, 1.0, 1.0],
            [1, 1, 1],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let dup_seed = dup_m.faces()[0];
        let dc = duplicate_faces(&mut dup_m, &[dup_seed], Attribution::default()).unwrap();
        assert_eq!(dc.len(), 1);
        let int_e: Vec<i32> = lc_m.edges().into_iter().take(1).collect();
        let _ = split_edges(&mut lc_m, &int_e);

        // 5. Shapes: cone, extrude_polygon, loft, pipe_network, lift
        let mut shp = EditMesh::new();
        append_cone(
            &mut shp,
            0.5,
            1.0,
            12,
            false,
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        append_extrude_polygon(
            &mut shp,
            &[[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
            0.5,
            Attribution::default(),
        )
        .unwrap();
        append_loft(
            &mut shp,
            &[
                vec![
                    [-0.2, 0.0, -0.2],
                    [0.2, 0.0, -0.2],
                    [0.2, 0.0, 0.2],
                    [-0.2, 0.0, 0.2],
                ],
                vec![
                    [-0.4, 1.0, -0.4],
                    [0.4, 1.0, -0.4],
                    [0.4, 1.0, 0.4],
                    [-0.4, 1.0, 0.4],
                ],
            ],
            true,
            Attribution::default(),
        )
        .unwrap();
        append_pipe_network(
            &mut shp,
            &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
            &[(0, 1)],
            0.05,
            8,
            Attribution::default(),
        )
        .unwrap();
        let mut lifted = EditMesh::new();
        lift_triangle_soup(
            &mut lifted,
            &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            &[0, 1, 2],
            None,
            40.0,
            Attribution::default(),
        )
        .unwrap();
        assert_eq!(lifted.face_count(), 1);

        // 6. Deformers: bend, twist, lattice, draft, spherize, taubin, implicit, arap, shrinkwrap
        let mut df = EditMesh::new();
        append_box(
            &mut df,
            [1.0, 2.0, 1.0],
            [2, 4, 2],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let all_v = df.vertices();
        bend_vertices(&mut df, &all_v, 1, 0, 30.0, None, None).unwrap();
        twist_vertices(&mut df, &all_v, 1, 45.0, None, None).unwrap();
        lattice_deform(
            &mut df,
            &all_v,
            [2, 2, 2],
            None,
            &[([1, 1, 1], [0.1, 0.0, 0.0])],
        )
        .unwrap();
        spherize_vertices(&mut df, &all_v, 0.25, Some(1.0), None).unwrap();
        let dff = df.faces();
        apply_draft(&mut df, &dff, [0.0, 1.0, 0.0], [0.0; 3], 5.0).unwrap();
        taubin_smooth(&mut df, &all_v, 0.5, -0.53, 2, false, false).unwrap();
        implicit_smooth(
            &mut df,
            &all_v,
            0.05,
            1,
            &HashSet::new(),
            false,
            false,
            true,
        )
        .unwrap();
        let mut arap_c = HashMap::new();
        arap_c.insert(all_v[0], df.position(all_v[0]));
        arap_c.insert(
            *all_v.last().unwrap(),
            [
                df.position(*all_v.last().unwrap())[0] + 0.1,
                df.position(*all_v.last().unwrap())[1],
                df.position(*all_v.last().unwrap())[2],
            ],
        );
        arap_deform(&mut df, &all_v, &arap_c, 2).unwrap();

        let mut sp2 = EditMesh::new();
        append_sphere(&mut sp2, 0.8, 8, 6, [0.0; 3], Attribution::default()).unwrap();
        let s_pos: Vec<f64> = sp2
            .vertices()
            .iter()
            .flat_map(|&v| sp2.position(v))
            .collect();
        let v_to_i: HashMap<i32, u32> = sp2
            .vertices()
            .iter()
            .enumerate()
            .map(|(i, &v)| (v, i as u32))
            .collect();
        let mut s_idx = Vec::new();
        for f in sp2.faces() {
            let fv = sp2.face_vertices(f);
            for i in 1..(fv.len() - 1) {
                s_idx.extend_from_slice(&[v_to_i[&fv[0]], v_to_i[&fv[i]], v_to_i[&fv[i + 1]]]);
            }
        }
        shrinkwrap_vertices(&mut df, &[all_v[1]], &s_pos, &s_idx, None, 0.0, None).unwrap();

        // 7. UV ops + Skin + Query
        let mut uv_m = EditMesh::new();
        append_box(
            &mut uv_m,
            [1.0, 1.0, 1.0],
            [2, 2, 2],
            [0.0; 3],
            Attribution::default(),
        )
        .unwrap();
        let uvf1 = uv_m.faces();
        plan_seams(&mut uv_m, &uvf1, 45.0, true).unwrap();
        lightmap_uv(&mut uv_m, 256, 2.0, CornerChannelKind::Uv1).unwrap();
        let uvf2 = uv_m.faces();
        straighten_uv(&mut uv_m, &uvf2, CornerChannelKind::Uv1, 45.0).unwrap();
        let overlaps = uv_overlap_pairs(&uv_m, &uvf2, CornerChannelKind::Uv1);
        assert!(
            overlaps.is_empty(),
            "auto-lightmap should have zero UV overlaps, got {}",
            overlaps.len()
        );

        let skin = bind_skin_geodesic(
            &uv_m,
            &[
                SkinBone {
                    root: [0.0, -0.5, 0.0],
                    tips: vec![[0.0, 0.0, 0.0]],
                },
                SkinBone {
                    root: [0.0, 0.0, 0.0],
                    tips: vec![[0.0, 0.5, 0.0]],
                },
            ],
            4.0,
            16,
        )
        .unwrap();
        assert_eq!(skin.weights.len(), (uv_m.vertex_high_water as usize) * 4);
        let h_rep = hausdorff_distance(&uv_m, &uv_m.faces(), &uv_m, &uv_m.faces());
        assert!(h_rep.max < 1e-12);
        let q_rep = mesh_quality_metrics(&uv_m, &uv_m.faces());
        assert_eq!(q_rep.degenerate_faces, 0);
    }
}
