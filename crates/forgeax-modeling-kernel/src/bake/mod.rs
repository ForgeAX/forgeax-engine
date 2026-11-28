//! High-to-low cage resolution (`cage`), correspondence raycasting (`correspond`),
//! and multi-map evaluation (`eval`) over `EditMesh` + `Bvh`.

pub mod cage;
pub mod correspond;
pub mod eval;

#[cfg(test)]
mod tests {
    use super::cage::{
        build_base_averaged_normals, resolve_cage_group, BakeDirection, BaseTriData, CageSpec,
    };
    use super::correspond::{
        bake_correspond, BakeCorrespondInput, BakeGroupConfig, DetailMeshData,
    };
    use super::eval::{evaluate_bake_maps, BakeEvalOptions, BakeMapKind, BakeSlotSpec};
    use crate::mesh::geom::{cross, normalize, sub};
    use crate::surface::atlas::{
        atlas_bleed_report, dilate_atlas, AtlasBufferMut, AtlasGrid, UNOWNED,
    };

    #[test]
    fn atlas_dilate_preserves_categorical_ids_and_reports_zero_protected_bleed() {
        let w = 256u32;
        let h = 256u32;
        let texels = (w * h) as usize;
        let mut color = vec![0.0f32; texels * 4];
        let mut mat_id = vec![0.0f32; texels * 4];
        let mut covered = vec![0u8; texels];
        let mut owner = vec![UNOWNED; texels];
        let mut frame = vec![UNOWNED; texels];

        // Chart 0 at [16..96, 16..96], Chart 1 at [144..224, 16..96] -> gap = 48 >= 16 px padding
        for y in 16..96 {
            for x in 16..96 {
                let idx = (y * w + x) as usize;
                covered[idx] = 1;
                owner[idx] = 0;
                frame[idx] = 0;
                color[idx * 4..idx * 4 + 4].copy_from_slice(&[0.9, 0.1, 0.1, 1.0]);
                mat_id[idx * 4..idx * 4 + 4].copy_from_slice(&[1.0, 0.0, 0.0, 1.0]);
            }
            for x in 144..224 {
                let idx = (y * w + x) as usize;
                covered[idx] = 1;
                owner[idx] = 1;
                frame[idx] = 1;
                color[idx * 4..idx * 4 + 4].copy_from_slice(&[0.1, 0.8, 0.2, 1.0]);
                mat_id[idx * 4..idx * 4 + 4].copy_from_slice(&[0.0, 1.0, 0.0, 1.0]);
            }
        }
        let chart_mask = covered.clone();
        let grid = AtlasGrid {
            width: w,
            height: h,
            wrap_u: false,
            wrap_v: false,
        };
        let mut bufs = [
            AtlasBufferMut {
                data: &mut color,
                categorical: false,
            },
            AtlasBufferMut {
                data: &mut mat_id,
                categorical: true,
            },
        ];
        dilate_atlas(&mut bufs, &mut covered, &mut owner, &frame, grid, 8);
        let report = atlas_bleed_report(&owner, &chart_mask, grid, Some(1));
        assert!(report.pass);
        // Categorical material_id in gutter right next to chart 0 keeps exact [1,0,0,1]
        let gx = (16 * w + 98) as usize;
        assert_eq!(covered[gx], 1);
        assert_eq!(mat_id[gx * 4], 1.0);
        assert_eq!(mat_id[gx * 4 + 1], 0.0);
    }

    #[test]
    fn high_to_low_cage_correspond_and_eval_round_trip() {
        // Low quad in XZ plane at y = 0, UV covering [0.1, 0.9]^2
        let base_pos = vec![
            -1.0, 0.0, -1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, 1.0,
        ];
        let base_nrm = [0.0, 1.0, 0.0].repeat(4);
        let base_tan = [1.0f32, 0.0, 0.0, 1.0].repeat(4);
        let base_uv = vec![0.1f32, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9];
        let base_idx = vec![0u32, 2, 1, 0, 3, 2];

        // High mesh = raised platform + beveled rim at y = 0.05..0.15
        let detail_pos = vec![
            -1.0, 0.05, -1.0, 1.0, 0.05, -1.0, 1.0, 0.05, 1.0, -1.0, 0.05, 1.0, -0.3, 0.15, -0.3,
            0.3, 0.15, -0.3, 0.3, 0.15, 0.3, -0.3, 0.15, 0.3,
        ];
        let detail_idx = vec![
            0, 2, 1, 0, 3, 2, // base deck
            4, 6, 5, 4, 7, 6, // raised boss
        ];
        let tri_count_b = 2usize;
        let base_tri_group = vec![0i32; tri_count_b];
        let averaged = build_base_averaged_normals(&base_pos, &base_idx, &base_tri_group);
        let mut shading = Vec::with_capacity(tri_count_b * 9);
        let mut face_n = Vec::with_capacity(tri_count_b * 3);
        for t in 0..tri_count_b {
            let p0 = [
                base_pos[base_idx[t * 3] as usize * 3],
                base_pos[base_idx[t * 3] as usize * 3 + 1],
                base_pos[base_idx[t * 3] as usize * 3 + 2],
            ];
            let p1 = [
                base_pos[base_idx[t * 3 + 1] as usize * 3],
                base_pos[base_idx[t * 3 + 1] as usize * 3 + 1],
                base_pos[base_idx[t * 3 + 1] as usize * 3 + 2],
            ];
            let p2 = [
                base_pos[base_idx[t * 3 + 2] as usize * 3],
                base_pos[base_idx[t * 3 + 2] as usize * 3 + 1],
                base_pos[base_idx[t * 3 + 2] as usize * 3 + 2],
            ];
            let fn_v = normalize(cross(sub(p1, p0), sub(p2, p0)));
            face_n.extend_from_slice(&fn_v);
            for _ in 0..3 {
                shading.extend_from_slice(&[0.0, 1.0, 0.0]);
            }
        }
        let base_data = BaseTriData {
            positions: base_pos.clone(),
            indices: base_idx.clone(),
            group: base_tri_group.clone(),
            averaged,
            shading,
            face: face_n,
            tagged: vec![0, 0],
        };
        let cage = resolve_cage_group(
            CageSpec {
                offset: None,
                max_ray: None,
            },
            "default",
            &base_data,
            &[0, 1],
            &detail_pos,
            &detail_idx,
            &[0, 1, 2, 3],
            BakeDirection::Averaged,
            None,
        )
        .unwrap();
        assert!(
            cage.offset >= 0.15,
            "cage offset should clear 0.15 boss height, got {}",
            cage.offset
        );

        let corr = bake_correspond(BakeCorrespondInput {
            width: 32,
            height: 32,
            samples_per_axis: 1,
            base_positions: base_pos,
            base_normals: base_nrm,
            base_tangents: base_tan,
            base_uvs: base_uv,
            base_indices: base_idx,
            base_tri_face: vec![0, 1],
            base_tri_group: vec![0, 0],
            base_tri_island: vec![0, 0],
            base_tri_tagged: vec![0, 0],
            detail: DetailMeshData {
                positions: detail_pos,
                corner_normals: vec![],
                face_normals: vec![],
                indices: detail_idx,
                tri_group: vec![0, 0, 0, 0],
                tri_slot: vec![0, 0, 1, 1],
                floater: vec![0, 0, 0, 0],
                vert_curvature: vec![],
                corner_colors: vec![],
                has_corner_colors: false,
            },
            groups: vec![BakeGroupConfig {
                offset: cage.offset,
                max_ray: cage.max_ray,
                diagonal: cage.diagonal,
                direction: BakeDirection::Averaged,
                clip_check: true,
            }],
        })
        .unwrap();
        assert!(corr.counters.covered_texels > 400);
        assert_eq!(corr.counters.primary, corr.count as u32);

        let eval = evaluate_bake_maps(
            &corr,
            &BakeEvalOptions {
                maps: vec![
                    BakeMapKind::Height,
                    BakeMapKind::Normal,
                    BakeMapKind::Ao,
                    BakeMapKind::MaterialId,
                ],
                slots: vec![
                    BakeSlotSpec::default(),
                    BakeSlotSpec {
                        base_color: [0.2, 0.6, 0.9, 1.0],
                        roughness: 0.3,
                        metallic: 0.8,
                        emissive: [0.0; 3],
                    },
                ],
                gutter: 4,
                ao_samples: 8,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(eval.buffers.len(), 4);
        let center_h = eval.buffers[0].1.data[(16 * 32 + 16) * 4];
        let outer_h = eval.buffers[0].1.data[(5 * 32 + 5) * 4];
        assert!(
            center_h > outer_h + 0.5,
            "center boss height ({center_h}) should exceed outer deck ({outer_h})"
        );
    }
}
