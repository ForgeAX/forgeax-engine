//! Atomic/composite `lowpoly` pipeline in pure Rust:
//! part union (exact BSP with voxel fallback) -> hard-angle sharp detection ->
//! silhouette-weighted QEM simplify -> quad pairing -> optional auto UV -> component tagging.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{dot, face_normal, Vec3};
use crate::mesh::{CornerChannelKind, EditMesh, EDGE_SHARP, FACE_ROLE_MASK, FACE_ROLE_SHIFT, NONE};
use crate::ops::boolean::{boolean_op, BooleanOp};
use crate::ops::cleanup::cleanup_quads;
use crate::ops::primitives::Attribution;
use crate::ops::remesh::{qem_simplify, PreserveConstraints, SimplifyOptions};
use crate::ops::voxel::{build_sdf_from_mesh, surface_nets_to_mesh};
use crate::uv::auto_uv;

#[derive(Debug, Clone)]
pub struct LowpolyOptions {
    pub target_faces: usize,
    pub hard_angle_deg: f64,
    pub max_error: Option<f64>,
    pub roles_form_only: bool,
    pub quad_max_angle_deg: f64,
    pub quad_max_planarity: f64,
    pub auto_uv: bool,
    pub uv_resolution: u32,
    pub uv_padding_texels: f64,
    pub group_prefix: String,
    pub preserve_groups: bool,
    pub voxel_size: Option<f64>,
    pub silhouette_weight: f64,
    pub silhouette_eyes: Vec<Vec3>,
    pub tolerance: f64,
}

impl Default for LowpolyOptions {
    fn default() -> Self {
        Self {
            target_faces: 500,
            hard_angle_deg: 40.0,
            max_error: None,
            roles_form_only: false,
            quad_max_angle_deg: 15.0,
            quad_max_planarity: 0.02,
            auto_uv: true,
            uv_resolution: 512,
            uv_padding_texels: 4.0,
            group_prefix: "part_".to_string(),
            preserve_groups: true,
            voxel_size: None,
            silhouette_weight: 2.0,
            silhouette_eyes: Vec::new(),
            tolerance: 1e-5,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LowpolyReport {
    pub triangles: usize,
    pub quads: usize,
    pub components: usize,
    pub used_voxel_fallback: bool,
    pub charts: usize,
}

fn connected_face_components_by_vertex(mesh: &EditMesh, faces: &[i32]) -> Vec<Vec<i32>> {
    let allowed: HashSet<i32> = faces.iter().copied().collect();
    let mut v_faces: HashMap<i32, Vec<i32>> = HashMap::new();
    for &f in faces {
        if !mesh.is_face_alive(f) {
            continue;
        }
        for v in mesh.face_vertices(f) {
            v_faces.entry(v).or_default().push(f);
        }
    }
    let mut seen = HashSet::new();
    let mut comps = Vec::new();
    for &seed in faces {
        if !mesh.is_face_alive(seed) || !seen.insert(seed) {
            continue;
        }
        let mut stack = vec![seed];
        let mut comp = Vec::new();
        while let Some(f) = stack.pop() {
            comp.push(f);
            for v in mesh.face_vertices(f) {
                if let Some(list) = v_faces.get(&v) {
                    for &nf in list {
                        if allowed.contains(&nf) && seen.insert(nf) {
                            stack.push(nf);
                        }
                    }
                }
            }
        }
        comps.push(comp);
    }
    comps
}

fn extract_submesh(src: &EditMesh, faces: &[i32]) -> Result<EditMesh, KernelError> {
    let mut dst = EditMesh::new();
    let mut vmap = HashMap::new();
    for &f in faces {
        if !src.is_face_alive(f) {
            continue;
        }
        let fv = src.face_vertices(f);
        let mut mapped = Vec::with_capacity(fv.len());
        for v in fv {
            let nv = match vmap.get(&v) {
                Some(&id) => id,
                None => {
                    let p = src.position(v);
                    let id = dst.add_vertex(p[0], p[1], p[2])?;
                    vmap.insert(v, id);
                    id
                }
            };
            mapped.push(nv);
        }
        let mat_name = src
            .material_names
            .get(src.f_material[f as usize].max(0) as usize)
            .cloned()
            .unwrap_or_default();
        let mat_id = dst.name_index_material(&mat_name);
        let nf = dst.add_face(&mapped, mat_id)?;
        let lbl_name = src
            .label_names
            .get(src.f_label[f as usize].max(0) as usize)
            .cloned()
            .unwrap_or_default();
        dst.f_label[nf as usize] = dst.name_index_label(&lbl_name);
        let role_name = src
            .role_names
            .get(src.f_role[f as usize].max(0) as usize)
            .cloned()
            .unwrap_or_default();
        dst.f_role[nf as usize] = dst.name_index_role(&role_name);
        dst.f_flags[nf as usize] = src.f_flags[f as usize];
        for (ti, tname) in src.tag_names.iter().enumerate() {
            if src.has_tag(f, ti as i32) {
                let nti = dst.tag_index(tname, true);
                dst.add_tag(nf, nti);
            }
        }
    }
    Ok(dst)
}

pub fn lowpoly_faces(
    mesh: &mut EditMesh,
    faces: &[i32],
    opts: &LowpolyOptions,
) -> Result<LowpolyReport, KernelError> {
    let input_faces: Vec<i32> = faces
        .iter()
        .copied()
        .filter(|&f| {
            mesh.is_face_alive(f)
                && (!opts.roles_form_only
                    || ((mesh.f_flags[f as usize] & FACE_ROLE_MASK) >> FACE_ROLE_SHIFT) == 0)
        })
        .collect();
    if input_faces.is_empty() {
        return Err(KernelError::no_effect(
            "lowpoly",
            "no matching faces selected",
        ));
    }

    let comps = connected_face_components_by_vertex(mesh, &input_faces);
    let mut shell = extract_submesh(mesh, &comps[0])?;
    let mut used_voxel = false;

    if comps.len() > 1 {
        let mut boolean_ok = true;
        for comp in comps.iter().skip(1) {
            let other = extract_submesh(mesh, comp)?;
            if boolean_op(&mut shell, &other, BooleanOp::Union, opts.tolerance).is_err() {
                boolean_ok = false;
                break;
            }
        }
        if !boolean_ok {
            used_voxel = true;
            let full = extract_submesh(mesh, &input_faces)?;
            let vs = opts.voxel_size.unwrap_or(0.05);
            let full_faces = full.faces();
            let sdf = build_sdf_from_mesh(&full, &full_faces, vs, 3, 0.0)?;
            shell = surface_nets_to_mesh(&sdf, 0.0, Attribution::default())?;
        }
    }

    // Mark sharp edges by dihedral > hard_angle_deg
    let cos_thresh = opts.hard_angle_deg.to_radians().cos();
    for e in shell.edges() {
        if shell.is_boundary_edge(e) {
            continue;
        }
        let f1 = shell.h_face[(e * 2) as usize];
        let f2 = shell.h_face[(e * 2 + 1) as usize];
        if f1 != NONE && f2 != NONE {
            let n1 = face_normal(&shell, f1);
            let n2 = face_normal(&shell, f2);
            if dot(n1, n2) < cos_thresh {
                shell.e_flags[e as usize] |= EDGE_SHARP;
            }
        }
    }

    // Simplify shell to target_faces
    let shell_faces = shell.faces();
    let (tris_after, _) = qem_simplify(
        &mut shell,
        &shell_faces,
        &SimplifyOptions {
            target_faces: Some(opts.target_faces),
            max_error: opts.max_error,
            volume_preserving: true,
            max_aspect: None,
            max_valence: None,
            constraints: PreserveConstraints::default(),
            silhouette_weight: opts.silhouette_weight,
        },
        &opts.silhouette_eyes,
    )?;

    // Quad pair smooth triangles
    let simp_faces = shell.faces();
    let quads = cleanup_quads(
        &mut shell,
        &simp_faces,
        opts.quad_max_angle_deg,
        opts.quad_max_planarity,
    )
    .unwrap_or(0);

    // Optional Auto-UV respecting sharp seams
    let charts = if opts.auto_uv {
        let uv_faces = shell.faces();
        auto_uv(
            &mut shell,
            &uv_faces,
            opts.hard_angle_deg.max(45.0),
            true,
            opts.uv_resolution,
            opts.uv_padding_texels,
            true,
            CornerChannelKind::Uv0,
        )?
    } else {
        0
    };

    // Tag output connected components if preserve_groups disabled or add component prefix
    let final_faces = shell.faces();
    let out_comps = connected_face_components_by_vertex(&shell, &final_faces);
    for (ci, comp) in out_comps.iter().enumerate() {
        let already_grouped =
            opts.preserve_groups
                && comp.iter().any(|&f| {
                    shell.tag_names.iter().enumerate().any(|(ti, n)| {
                        n.starts_with(&opts.group_prefix) && shell.has_tag(f, ti as i32)
                    })
                });
        if !already_grouped && !opts.group_prefix.is_empty() {
            let ti = shell.tag_index(&format!("{}{}", opts.group_prefix, ci), true);
            for &f in comp {
                shell.add_tag(f, ti);
            }
        }
    }

    // Replace input faces in `mesh` with simplified `shell`
    let mut old_verts = HashSet::new();
    for &f in &input_faces {
        for v in mesh.face_vertices(f) {
            old_verts.insert(v);
        }
        mesh.remove_face(f);
    }
    crate::ops::assembly::append_mesh(mesh, &shell, [0.0, 0.0, 0.0], Attribution::default())?;

    let mut used = HashSet::new();
    for f in mesh.faces() {
        for v in mesh.face_vertices(f) {
            used.insert(v);
        }
    }
    for v in old_verts {
        if !used.contains(&v) {
            mesh.remove_vertex(v);
        }
    }

    Ok(LowpolyReport {
        triangles: tris_after,
        quads,
        components: out_comps.len(),
        used_voxel_fallback: used_voxel,
        charts,
    })
}
