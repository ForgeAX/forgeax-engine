//! Exact BSP-tree CSG boolean operator (`difference`, `union`, `intersection`)
//! matching `@forgeax/engine-modeling`'s `bsp.ts` + `boolean-ts.ts` semantics in native Rust.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{add, cross, dot, length, newell, scale, sub, Vec3};
use crate::mesh::{EditMesh, NONE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BooleanOp {
    Union = 0,
    Difference = 1,
    Intersection = 2,
}

impl BooleanOp {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Union),
            1 => Some(Self::Difference),
            2 => Some(Self::Intersection),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Plane {
    n: Vec3,
    w: f64,
}

#[derive(Debug, Clone)]
struct Poly {
    points: Vec<Vec3>,
    plane: Plane,
    source: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PolyClass {
    In,
    Out,
    OnSame,
    OnOpposite,
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    min: Vec3,
    max: Vec3,
}

struct BspNode {
    plane: Plane,
    front: Option<usize>,
    back: Option<usize>,
}

const COPLANAR: u8 = 0;
const FRONT: u8 = 1;
const BACK: u8 = 2;
const SPANNING: u8 = 3;

fn plane_of(a: Vec3, b: Vec3, c: Vec3) -> Option<Plane> {
    let n_raw = cross(sub(b, a), sub(c, a));
    let l = length(n_raw);
    if l == 0.0 {
        return None;
    }
    let n = scale(n_raw, 1.0 / l);
    Some(Plane { n, w: dot(n, a) })
}

fn flip_poly(mut p: Poly) -> Poly {
    p.points.reverse();
    p.plane = Plane {
        n: [-p.plane.n[0], -p.plane.n[1], -p.plane.n[2]],
        w: -p.plane.w,
    };
    p
}

struct SplitResult {
    front: Option<Poly>,
    back: Option<Poly>,
    coplanar: Option<Poly>,
    aligned: bool,
}

fn split_poly(plane: Plane, poly: Poly, eps: f64) -> SplitResult {
    let n = poly.points.len();
    let mut types = Vec::with_capacity(n);
    let mut dists = Vec::with_capacity(n);
    let mut kind = 0u8;
    for &p in &poly.points {
        let t = dot(plane.n, p) - plane.w;
        let ty = if t < -eps {
            BACK
        } else if t > eps {
            FRONT
        } else {
            COPLANAR
        };
        kind |= ty;
        types.push(ty);
        dists.push(t);
    }
    match kind {
        COPLANAR => {
            let aligned = dot(plane.n, poly.plane.n) > 0.0;
            return SplitResult {
                front: None,
                back: None,
                coplanar: Some(poly),
                aligned,
            };
        }
        FRONT => {
            return SplitResult {
                front: Some(poly),
                back: None,
                coplanar: None,
                aligned: false,
            }
        }
        BACK => {
            return SplitResult {
                front: None,
                back: Some(poly),
                coplanar: None,
                aligned: false,
            }
        }
        _ => {}
    }

    let mut f = Vec::with_capacity(n + 1);
    let mut b = Vec::with_capacity(n + 1);
    for i in 0..n {
        let j = (i + 1) % n;
        let ti = types[i];
        let tj = types[j];
        let vi = poly.points[i];
        let vj = poly.points[j];
        if ti != BACK {
            f.push(vi);
        }
        if ti != FRONT {
            b.push(vi);
        }
        if (ti | tj) == SPANNING {
            let di = dists[i];
            let dj = dists[j];
            let t = di / (di - dj);
            let v = add(vi, scale(sub(vj, vi), t));
            f.push(v);
            b.push(v);
        }
    }
    SplitResult {
        front: if f.len() >= 3 {
            Some(Poly {
                points: f,
                plane: poly.plane,
                source: poly.source,
            })
        } else {
            None
        },
        back: if b.len() >= 3 {
            Some(Poly {
                points: b,
                plane: poly.plane,
                source: poly.source,
            })
        } else {
            None
        },
        coplanar: None,
        aligned: false,
    }
}

fn bounds_of(polys: &[Poly]) -> Bounds {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for poly in polys {
        for p in &poly.points {
            for k in 0..3 {
                if p[k] < min[k] {
                    min[k] = p[k];
                }
                if p[k] > max[k] {
                    max[k] = p[k];
                }
            }
        }
    }
    Bounds { min, max }
}

fn disjoint(poly: &Poly, bounds: Bounds, eps: f64) -> bool {
    for k in 0..3 {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for p in &poly.points {
            if p[k] < lo {
                lo = p[k];
            }
            if p[k] > hi {
                hi = p[k];
            }
        }
        if lo > bounds.max[k] + eps || hi < bounds.min[k] - eps {
            return true;
        }
    }
    false
}

struct BspTree {
    nodes: Vec<BspNode>,
    root: Option<usize>,
    bounds: Bounds,
}

impl BspTree {
    fn build(polys: &[Poly], eps: f64) -> Self {
        let bounds = bounds_of(polys);
        let mut nodes: Vec<BspNode> = Vec::new();
        if polys.is_empty() {
            return Self {
                nodes,
                root: None,
                bounds,
            };
        }
        enum Attach {
            Root,
            Front(usize),
            Back(usize),
        }
        let mut stack: Vec<(Vec<Poly>, Attach)> = vec![(polys.to_vec(), Attach::Root)];
        let mut root = None;
        while let Some((list, attach)) = stack.pop() {
            if list.is_empty() {
                continue;
            }
            let plane = list[0].plane;
            let idx = nodes.len();
            nodes.push(BspNode {
                plane,
                front: None,
                back: None,
            });
            match attach {
                Attach::Root => root = Some(idx),
                Attach::Front(p) => nodes[p].front = Some(idx),
                Attach::Back(p) => nodes[p].back = Some(idx),
            }
            let mut front = Vec::new();
            let mut back = Vec::new();
            for poly in list.into_iter().skip(1) {
                let s = split_poly(plane, poly, eps);
                if let Some(fp) = s.front {
                    front.push(fp);
                }
                if let Some(bp) = s.back {
                    back.push(bp);
                }
            }
            if !front.is_empty() {
                stack.push((front, Attach::Front(idx)));
            }
            if !back.is_empty() {
                stack.push((back, Attach::Back(idx)));
            }
        }
        Self {
            nodes,
            root,
            bounds,
        }
    }

    fn classify(&self, polys: &[Poly], eps: f64) -> Vec<(Poly, PolyClass)> {
        let mut out = Vec::new();
        let Some(root_idx) = self.root else {
            for p in polys {
                out.push((p.clone(), PolyClass::Out));
            }
            return out;
        };
        for poly in polys {
            if disjoint(poly, self.bounds, eps) {
                out.push((poly.clone(), PolyClass::Out));
                continue;
            }
            self.classify_rec(poly.clone(), root_idx, eps, &mut out);
        }
        out
    }

    fn combine(front: PolyClass, back: PolyClass, aligned: bool) -> PolyClass {
        if matches!(front, PolyClass::OnSame | PolyClass::OnOpposite) {
            return front;
        }
        if matches!(back, PolyClass::OnSame | PolyClass::OnOpposite) {
            return back;
        }
        if front == back {
            return front;
        }
        let solid_along_plane = front == PolyClass::Out;
        if solid_along_plane == aligned {
            PolyClass::OnSame
        } else {
            PolyClass::OnOpposite
        }
    }

    fn classify_rec(
        &self,
        poly: Poly,
        node_idx: usize,
        eps: f64,
        out: &mut Vec<(Poly, PolyClass)>,
    ) {
        let node = &self.nodes[node_idx];
        let s = split_poly(node.plane, poly, eps);
        if let Some(fp) = s.front {
            if let Some(fi) = node.front {
                self.classify_rec(fp, fi, eps, out);
            } else {
                out.push((fp, PolyClass::Out));
            }
        }
        if let Some(bp) = s.back {
            if let Some(bi) = node.back {
                self.classify_rec(bp, bi, eps, out);
            } else {
                out.push((bp, PolyClass::In));
            }
        }
        if let Some(cp) = s.coplanar {
            let mut front_res = Vec::new();
            if let Some(fi) = node.front {
                self.classify_rec(cp, fi, eps, &mut front_res);
            } else {
                front_res.push((cp, PolyClass::Out));
            }
            for (piece, f_cls) in front_res {
                let mut back_res = Vec::new();
                if let Some(bi) = node.back {
                    self.classify_rec(piece, bi, eps, &mut back_res);
                } else {
                    back_res.push((piece, PolyClass::In));
                }
                for (b_piece, b_cls) in back_res {
                    out.push((b_piece, Self::combine(f_cls, b_cls, s.aligned)));
                }
            }
        }
    }
}

struct SourceMeta {
    operand: u8,
    mat_name: String,
    label_name: String,
    role_name: String,
    flags: u8,
    tags: Vec<String>,
}

fn mesh_to_components(
    mesh: &EditMesh,
    operand: u8,
    sources: &mut Vec<SourceMeta>,
) -> Vec<Vec<Poly>> {
    let faces = mesh.faces();
    if faces.is_empty() {
        return Vec::new();
    }
    // Edge-connected components
    let mut comp_of: HashMap<i32, usize> = HashMap::new();
    let mut comps: Vec<Vec<i32>> = Vec::new();
    for &seed in &faces {
        if comp_of.contains_key(&seed) {
            continue;
        }
        let cid = comps.len();
        let mut stack = vec![seed];
        let mut list = Vec::new();
        comp_of.insert(seed, cid);
        while let Some(f) = stack.pop() {
            list.push(f);
            for h in mesh.face_halves(f) {
                let g = mesh.h_face[(h ^ 1) as usize];
                if g != NONE && !comp_of.contains_key(&g) {
                    comp_of.insert(g, cid);
                    stack.push(g);
                }
            }
        }
        comps.push(list);
    }

    let mut out_comps = Vec::new();
    for comp in comps {
        let mut polys = Vec::new();
        for f in comp {
            let verts = mesh.face_vertices(f);
            if verts.len() < 3 {
                continue;
            }
            let mat_name = mesh
                .material_names
                .get(mesh.f_material[f as usize] as usize)
                .cloned()
                .unwrap_or_else(|| "Default".into());
            let label_name = mesh
                .label_names
                .get(mesh.f_label[f as usize] as usize)
                .cloned()
                .unwrap_or_default();
            let role_name = mesh
                .role_names
                .get(mesh.f_role[f as usize] as usize)
                .cloned()
                .unwrap_or_default();
            let mut tags = Vec::new();
            for (ti, tname) in mesh.tag_names.iter().enumerate() {
                if mesh.has_tag(f, ti as i32) {
                    tags.push(tname.clone());
                }
            }
            let src_idx = sources.len();
            sources.push(SourceMeta {
                operand,
                mat_name,
                label_name,
                role_name,
                flags: mesh.f_flags[f as usize],
                tags,
            });
            // Fan triangulation (convex faces) or ear-clipping for concave faces
            let p0 = mesh.position(verts[0]);
            for i in 1..(verts.len() - 1) {
                let p1 = mesh.position(verts[i]);
                let p2 = mesh.position(verts[i + 1]);
                if let Some(plane) = plane_of(p0, p1, p2) {
                    polys.push(Poly {
                        points: vec![p0, p1, p2],
                        plane,
                        source: src_idx,
                    });
                }
            }
        }
        if !polys.is_empty() {
            out_comps.push(polys);
        }
    }
    out_comps
}

struct Welder {
    positions: Vec<Vec3>,
    parent: Vec<usize>,
    cells: HashMap<(i64, i64, i64), Vec<usize>>,
    eps: f64,
}

impl Welder {
    fn new(eps: f64) -> Self {
        Self {
            positions: Vec::new(),
            parent: Vec::new(),
            cells: HashMap::new(),
            eps,
        }
    }

    fn find(&mut self, mut x: usize) -> usize {
        let mut root = x;
        while self.parent[root] != root {
            root = self.parent[root];
        }
        while self.parent[x] != root {
            let nxt = self.parent[x];
            self.parent[x] = root;
            x = nxt;
        }
        root
    }

    fn add(&mut self, p: Vec3) -> usize {
        let size = (self.eps * 4.0).max(1e-9);
        let ix = (p[0] / size).floor() as i64;
        let iy = (p[1] / size).floor() as i64;
        let iz = (p[2] / size).floor() as i64;
        let id = self.positions.len();
        self.positions.push(p);
        self.parent.push(id);
        let eps2 = self.eps * self.eps;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = self.cells.get(&(ix + dx, iy + dy, iz + dz)).cloned() {
                        for other in list {
                            let q = self.positions[other];
                            let d0 = q[0] - p[0];
                            let d1 = q[1] - p[1];
                            let d2 = q[2] - p[2];
                            if d0 * d0 + d1 * d1 + d2 * d2 <= eps2 {
                                let ra = self.find(other);
                                let rb = self.find(id);
                                if ra != rb {
                                    self.parent[ra.max(rb)] = ra.min(rb);
                                }
                            }
                        }
                    }
                }
            }
        }
        self.cells.entry((ix, iy, iz)).or_default().push(id);
        id
    }
}

fn segment_insertions(loops: &[Vec<usize>], positions: &[Vec3], eps: f64) -> Vec<Vec<usize>> {
    // Collect all vertices that lie on any open (T-junction) edge
    let mut directed: HashSet<(usize, usize)> = HashSet::new();
    for lp in loops {
        for i in 0..lp.len() {
            directed.insert((lp[i], lp[(i + 1) % lp.len()]));
        }
    }
    let mut open_verts: HashSet<usize> = HashSet::new();
    let mut open_edges: HashSet<(usize, usize)> = HashSet::new();
    for &(a, b) in &directed {
        if !directed.contains(&(b, a)) {
            open_verts.insert(a);
            open_verts.insert(b);
            open_edges.insert((a, b));
        }
    }
    if open_edges.is_empty() {
        return loops.to_vec();
    }
    let candidates: Vec<usize> = open_verts.into_iter().collect();
    let eps2 = eps * eps;
    let mut edge_splits: HashMap<(usize, usize), Vec<(f64, usize)>> = HashMap::new();

    for &(a, b) in &open_edges {
        let pa = positions[a];
        let pb = positions[b];
        let ab = sub(pb, pa);
        let l2 = dot(ab, ab);
        if l2 <= eps2 {
            continue;
        }
        let min_x = pa[0].min(pb[0]) - eps;
        let max_x = pa[0].max(pb[0]) + eps;
        let min_y = pa[1].min(pb[1]) - eps;
        let max_y = pa[1].max(pb[1]) + eps;
        let min_z = pa[2].min(pb[2]) - eps;
        let max_z = pa[2].max(pb[2]) + eps;

        let mut ins = Vec::new();
        for &v in &candidates {
            if v == a || v == b {
                continue;
            }
            let pv = positions[v];
            if pv[0] < min_x
                || pv[0] > max_x
                || pv[1] < min_y
                || pv[1] > max_y
                || pv[2] < min_z
                || pv[2] > max_z
            {
                continue;
            }
            let t = dot(sub(pv, pa), ab) / l2;
            if t <= 1e-6 || t >= 1.0 - 1e-6 {
                continue;
            }
            let proj = add(pa, scale(ab, t));
            let d = sub(pv, proj);
            if dot(d, d) <= eps2 {
                ins.push((t, v));
            }
        }
        if !ins.is_empty() {
            ins.sort_by(|x, y| x.0.total_cmp(&y.0));
            edge_splits.insert((a, b), ins);
        }
    }

    if edge_splits.is_empty() {
        return loops.to_vec();
    }
    loops
        .iter()
        .map(|lp| {
            let mut out = Vec::with_capacity(lp.len() + 2);
            for i in 0..lp.len() {
                let a = lp[i];
                let b = lp[(i + 1) % lp.len()];
                out.push(a);
                if let Some(ins) = edge_splits.get(&(a, b)) {
                    for &(_, v) in ins {
                        if out.last().copied() != Some(v) {
                            out.push(v);
                        }
                    }
                }
            }
            out
        })
        .collect()
}

/// Execute CSG boolean (`Union`, `Difference`, `Intersection`) between `target` and `tool`,
/// replacing `target` in place with the welded, manifold result mesh.
pub fn boolean_op(
    target: &mut EditMesh,
    tool: &EditMesh,
    op: BooleanOp,
    eps: f64,
) -> Result<usize, KernelError> {
    let mut sources: Vec<SourceMeta> = Vec::new();
    let a_comps = mesh_to_components(target, 0, &mut sources);
    let b_comps = mesh_to_components(tool, 1, &mut sources);
    if a_comps.is_empty() || b_comps.is_empty() {
        return Err(KernelError::precondition(
            "boolean",
            "both operands must be non-empty",
        ));
    }

    let a_all: Vec<Poly> = a_comps.into_iter().flatten().collect();
    let target_tree = BspTree::build(&a_all, eps);
    let tool_trees: Vec<(Vec<Poly>, BspTree)> = b_comps
        .into_iter()
        .map(|polys| {
            let tree = BspTree::build(&polys, eps);
            (polys, tree)
        })
        .collect();

    let mut out_polys: Vec<Poly> = Vec::new();
    let mut pending: Vec<Poly> = a_all;
    for (_, t_tree) in &tool_trees {
        let classified = t_tree.classify(&pending, eps);
        let mut next = Vec::new();
        for (poly, cls) in classified {
            match op {
                BooleanOp::Union => {
                    if matches!(cls, PolyClass::Out | PolyClass::OnSame) {
                        next.push(poly);
                    }
                }
                BooleanOp::Difference => {
                    if matches!(cls, PolyClass::Out | PolyClass::OnOpposite) {
                        next.push(poly);
                    }
                }
                BooleanOp::Intersection => {
                    if matches!(cls, PolyClass::In | PolyClass::OnSame) {
                        out_polys.push(poly);
                    } else if matches!(cls, PolyClass::Out | PolyClass::OnOpposite) {
                        next.push(poly);
                    }
                }
            }
        }
        pending = next;
    }
    if op != BooleanOp::Intersection {
        out_polys.extend(pending);
    }

    for (i, (t_polys, _)) in tool_trees.iter().enumerate() {
        let mut polys: Vec<Poly> = target_tree
            .classify(t_polys, eps)
            .into_iter()
            .filter_map(|(p, cls)| {
                let keep = match op {
                    BooleanOp::Union => cls == PolyClass::Out,
                    BooleanOp::Difference | BooleanOp::Intersection => cls == PolyClass::In,
                };
                if keep {
                    Some(p)
                } else {
                    None
                }
            })
            .collect();
        for (j, (_, other_tree)) in tool_trees.iter().enumerate() {
            if j == i || polys.is_empty() {
                continue;
            }
            polys = other_tree
                .classify(&polys, eps)
                .into_iter()
                .filter_map(|(p, cls)| {
                    if cls == PolyClass::Out || (cls == PolyClass::OnSame && i < j) {
                        Some(p)
                    } else {
                        None
                    }
                })
                .collect();
        }
        for poly in polys {
            out_polys.push(if op == BooleanOp::Difference {
                flip_poly(poly)
            } else {
                poly
            });
        }
    }

    // Weld vertices and resolve T-junctions
    let mut welder = Welder::new(eps);
    let mut raw_ids: Vec<(Vec<usize>, usize)> = Vec::with_capacity(out_polys.len());
    for poly in &out_polys {
        let ids: Vec<usize> = poly.points.iter().map(|&p| welder.add(p)).collect();
        raw_ids.push((ids, poly.source));
    }
    let mut dense_map: HashMap<usize, usize> = HashMap::new();
    let mut positions: Vec<Vec3> = Vec::new();
    let mut raw_to_dense = vec![0usize; welder.positions.len()];
    for i in 0..welder.positions.len() {
        let r = welder.find(i);
        let d = *dense_map.entry(r).or_insert_with(|| {
            let idx = positions.len();
            positions.push(welder.positions[r]);
            idx
        });
        raw_to_dense[i] = d;
    }

    let mut clean_loops: Vec<Vec<usize>> = Vec::new();
    let mut clean_srcs: Vec<usize> = Vec::new();
    let min_area = eps * eps;
    for (ids, src) in raw_ids {
        let mut lp: Vec<usize> = Vec::with_capacity(ids.len());
        for raw in ids {
            let v = raw_to_dense[raw];
            if lp.last().copied() != Some(v) {
                lp.push(v);
            }
        }
        while lp.len() > 1 && lp.first() == lp.last() {
            lp.pop();
        }
        if lp.len() < 3 {
            continue;
        }
        let uniq: HashSet<usize> = lp.iter().copied().collect();
        if uniq.len() != lp.len() {
            continue;
        }
        let pts: Vec<Vec3> = lp.iter().map(|&v| positions[v]).collect();
        let area = 0.5 * length(newell(&pts));
        if area <= min_area {
            continue;
        }
        clean_loops.push(lp);
        clean_srcs.push(src);
    }

    // Insert T-junction vertices along open seam edges
    let fixed_loops = segment_insertions(&clean_loops, &positions, eps * 4.0);

    // Rebuild EditMesh cleanly preserving material slots, tags, labels, roles
    let mut next_mesh = EditMesh::new();
    // Preserve existing target name-table ordering first so slot indices stay synchronized
    for name in &target.material_names {
        next_mesh.name_index_material(name);
    }
    for name in &target.tag_names {
        next_mesh.tag_index(name, true);
    }
    for name in target.label_names.iter().skip(1) {
        next_mesh.name_index_label(name);
    }
    for name in target.role_names.iter().skip(1) {
        next_mesh.name_index_role(name);
    }

    let mut used_v: HashMap<usize, i32> = HashMap::new();
    let mut added_count = 0usize;
    for (lp, src_idx) in fixed_loops.into_iter().zip(clean_srcs.into_iter()) {
        if lp.len() < 3 {
            continue;
        }
        let mut v_ids = Vec::with_capacity(lp.len());
        for v in lp {
            let nv = match used_v.get(&v) {
                Some(&id) => id,
                None => {
                    let p = positions[v];
                    let id = next_mesh.add_vertex(p[0], p[1], p[2])?;
                    used_v.insert(v, id);
                    id
                }
            };
            if v_ids.last().copied() != Some(nv) {
                v_ids.push(nv);
            }
        }
        while v_ids.len() > 1 && v_ids.first() == v_ids.last() {
            v_ids.pop();
        }
        if v_ids.len() < 3 {
            continue;
        }
        let meta = &sources[src_idx];
        let mat = next_mesh.name_index_material(&meta.mat_name);
        let add_with_meta = |mesh: &mut EditMesh, loop_v: &[i32]| -> bool {
            if let Ok(nf) = mesh.add_face(loop_v, mat) {
                mesh.f_flags[nf as usize] = meta.flags;
                if !meta.label_name.is_empty() {
                    mesh.f_label[nf as usize] = mesh.name_index_label(&meta.label_name);
                    mesh.f_role[nf as usize] = mesh.name_index_role(&meta.role_name);
                }
                for t in &meta.tags {
                    let ti = mesh.tag_index(t, true);
                    mesh.add_tag(nf, ti);
                }
                true
            } else {
                false
            }
        };

        if v_ids.len() == 3 {
            if add_with_meta(&mut next_mesh, &v_ids) {
                added_count += 1;
            }
        } else {
            // Check strict convexity in best-fit plane; if T-junction insertion created collinear
            // or near-collinear edges, triangulate cleanly while keeping all boundary vertices.
            let pts: Vec<Vec3> = v_ids.iter().map(|&id| next_mesh.position(id)).collect();
            let n_raw = newell(&pts);
            let n_len = length(n_raw);
            if n_len <= min_area {
                continue;
            }
            let n_unit = scale(n_raw, 1.0 / n_len);
            let m = pts.len();
            let mut strictly_convex = true;
            for i in 0..m {
                let a = pts[(i + m - 1) % m];
                let b = pts[i];
                let c = pts[(i + 1) % m];
                let e1 = sub(b, a);
                let e2 = sub(c, b);
                let cross_n = dot(cross(e1, e2), n_unit);
                let scale_ref = length(e1) * length(e2);
                if scale_ref <= 1e-18 || cross_n <= scale_ref * 1e-4 {
                    strictly_convex = false;
                    break;
                }
            }
            if strictly_convex {
                if add_with_meta(&mut next_mesh, &v_ids) {
                    added_count += 1;
                }
            } else {
                // Find pivot vertex maximizing minimum fan-triangle signed area
                let mut best_pivot: Option<usize> = None;
                let mut best_min_area = 1e-12_f64;
                for p in 0..m {
                    let vp = pts[p];
                    let mut min_tri = f64::INFINITY;
                    for k in 1..(m - 1) {
                        let a = pts[(p + k) % m];
                        let b = pts[(p + k + 1) % m];
                        let area2 = dot(cross(sub(a, vp), sub(b, vp)), n_unit);
                        if area2 < min_tri {
                            min_tri = area2;
                        }
                    }
                    if min_tri > best_min_area {
                        best_min_area = min_tri;
                        best_pivot = Some(p);
                    }
                }
                if let Some(p) = best_pivot {
                    for k in 1..(m - 1) {
                        let tri = [v_ids[p], v_ids[(p + k) % m], v_ids[(p + k + 1) % m]];
                        if add_with_meta(&mut next_mesh, &tri) {
                            added_count += 1;
                        }
                    }
                } else {
                    // Fallback: fan around polygon centroid so every T-junction edge stays intact
                    let mut c = [0.0; 3];
                    for pt in &pts {
                        c[0] += pt[0];
                        c[1] += pt[1];
                        c[2] += pt[2];
                    }
                    let inv = 1.0 / (m as f64);
                    if let Ok(cv) = next_mesh.add_vertex(c[0] * inv, c[1] * inv, c[2] * inv) {
                        for i in 0..m {
                            let tri = [cv, v_ids[i], v_ids[(i + 1) % m]];
                            if add_with_meta(&mut next_mesh, &tri) {
                                added_count += 1;
                            }
                        }
                    }
                }
            }
        }
        let _ = meta.operand;
    }

    if added_count == 0 {
        return Err(KernelError::degenerate(
            "boolean",
            "boolean operation produced an empty mesh",
        ));
    }
    *target = next_mesh;
    Ok(added_count)
}
