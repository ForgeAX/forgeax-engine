//! FXSL v1 Binary Decoder and Direct VM over `mesh::EditMesh`.
//!
//! Matches `@forgeax/engine-modeling`'s `encodeSelectorAst()` / `evaluateSelectorAst()`
//! byte-for-byte with zero JS callback overhead.

use std::collections::{HashMap, HashSet};

use crate::error::KernelError;
use crate::mesh::geom::{
    cross, dot, face_area, face_centroid, face_normal, normalize, signed_axis_vector, sub,
    unsigned_axis_vector, Vec3,
};
use crate::mesh::{EditMesh, EDGE_SEAM, EDGE_SHARP, FACE_MIRRORED, NONE};

pub const FXSL_MAGIC: u32 = 0x4c53_5846; // "FXSL" little-endian
pub const FXSL_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    Face = 0,
    Edge = 1,
    Vert = 2,
}

impl Domain {
    fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Face),
            1 => Some(Self::Edge),
            2 => Some(Self::Vert),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitRule {
    All = 0,
    Centroid = 1,
    Any = 2,
}

impl HitRule {
    fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::All),
            1 => Some(Self::Centroid),
            2 => Some(Self::Any),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inclusion {
    Touching = 0,
    Contained = 1,
}

impl Inclusion {
    fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Touching),
            1 => Some(Self::Contained),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cardinality {
    NonEmpty,
    Exactly(u32),
    AtLeast(u32),
}

#[derive(Debug, Clone)]
pub enum SelectorNode {
    All(Domain),
    Tag(String),
    CreatedBy {
        label: String,
        role: Option<String>,
    },
    Material(String),
    Mirrored,
    Facing {
        axis: u8,
        degrees: f64,
    },
    Extreme {
        axis: u8,
    },
    InBox {
        min: Vec3,
        max: Vec3,
        by: HitRule,
    },
    Side {
        point: Vec3,
        normal: Vec3,
        by: HitRule,
    },
    Near {
        point: Vec3,
        count: u32,
    },
    Thin {
        max_width: f64,
    },
    Dihedral {
        greater: bool,
        degrees: f64,
    },
    MeshBoundary,
    Parallel {
        axis: u8,
        degrees: f64,
    },
    Perpendicular {
        axis: u8,
        degrees: f64,
    },
    Concave,
    Sharp,
    Seam,
    Not {
        domain: Domain,
        src: Box<SelectorNode>,
    },
    Largest(Box<SelectorNode>),
    Smallest(Box<SelectorNode>),
    Grow {
        steps: u32,
        src: Box<SelectorNode>,
    },
    Shrink {
        steps: u32,
        src: Box<SelectorNode>,
    },
    Connected {
        smooth: bool,
        src: Box<SelectorNode>,
    },
    ToEdges {
        include: Inclusion,
        src: Box<SelectorNode>,
    },
    Boundary(Box<SelectorNode>),
    ToVerts {
        include: Inclusion,
        src: Box<SelectorNode>,
    },
    ToFaces(Box<SelectorNode>),
    Loop(Box<SelectorNode>),
    Ring(Box<SelectorNode>),
    And {
        domain: Domain,
        a: Box<SelectorNode>,
        b: Box<SelectorNode>,
    },
    Or {
        domain: Domain,
        a: Box<SelectorNode>,
        b: Box<SelectorNode>,
    },
    Minus {
        domain: Domain,
        a: Box<SelectorNode>,
        b: Box<SelectorNode>,
    },
}

pub struct DecodedSelector {
    pub cardinality: Cardinality,
    pub root: SelectorNode,
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn u8(&mut self) -> Result<u8, KernelError> {
        if self.remaining() < 1 {
            return Err(KernelError::invalid_value("selector", "unexpected EOF"));
        }
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }

    fn u32(&mut self) -> Result<u32, KernelError> {
        if self.remaining() < 4 {
            return Err(KernelError::invalid_value(
                "selector",
                "unexpected EOF reading u32",
            ));
        }
        let v = u32::from_le_bytes([
            self.buf[self.pos],
            self.buf[self.pos + 1],
            self.buf[self.pos + 2],
            self.buf[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }

    fn f64(&mut self) -> Result<f64, KernelError> {
        if self.remaining() < 8 {
            return Err(KernelError::invalid_value(
                "selector",
                "unexpected EOF reading f64",
            ));
        }
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&self.buf[self.pos..self.pos + 8]);
        self.pos += 8;
        Ok(f64::from_le_bytes(bytes))
    }

    fn vec3(&mut self) -> Result<Vec3, KernelError> {
        Ok([self.f64()?, self.f64()?, self.f64()?])
    }

    fn string(&mut self) -> Result<String, KernelError> {
        let len = self.u32()? as usize;
        if self.remaining() < len {
            return Err(KernelError::invalid_value(
                "selector",
                "string exceeds buffer",
            ));
        }
        let s = std::str::from_utf8(&self.buf[self.pos..self.pos + len])
            .map_err(|_| KernelError::invalid_value("selector", "invalid UTF-8 in selector"))?;
        self.pos += len;
        Ok(s.to_string())
    }
}

fn read_node(r: &mut Reader<'_>) -> Result<SelectorNode, KernelError> {
    let op = r.u8()?;
    match op {
        1 => {
            let d = Domain::from_u8(r.u8()?)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid domain"))?;
            Ok(SelectorNode::All(d))
        }
        2 => Ok(SelectorNode::Tag(r.string()?)),
        3 => {
            let label = r.string()?;
            let has_role = r.u8()?;
            let role = match has_role {
                0 => None,
                1 => Some(r.string()?),
                _ => {
                    return Err(KernelError::invalid_value(
                        "selector",
                        "invalid createdBy role flag",
                    ))
                }
            };
            Ok(SelectorNode::CreatedBy { label, role })
        }
        4 => Ok(SelectorNode::Material(r.string()?)),
        5 => Ok(SelectorNode::Mirrored),
        6 => Ok(SelectorNode::Facing {
            axis: r.u8()?,
            degrees: r.f64()?,
        }),
        7 => Ok(SelectorNode::Extreme { axis: r.u8()? }),
        8 => {
            let min = r.vec3()?;
            let max = r.vec3()?;
            let by = HitRule::from_u8(r.u8()?)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid hit rule"))?;
            Ok(SelectorNode::InBox { min, max, by })
        }
        9 => {
            let point = r.vec3()?;
            let normal = r.vec3()?;
            let by = HitRule::from_u8(r.u8()?)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid hit rule"))?;
            Ok(SelectorNode::Side { point, normal, by })
        }
        10 => Ok(SelectorNode::Near {
            point: r.vec3()?,
            count: r.u32()?,
        }),
        11 => Ok(SelectorNode::Thin {
            max_width: r.f64()?,
        }),
        12 => {
            let c = r.u8()?;
            if c > 1 {
                return Err(KernelError::invalid_value(
                    "selector",
                    "invalid dihedral compare",
                ));
            }
            Ok(SelectorNode::Dihedral {
                greater: c == 0,
                degrees: r.f64()?,
            })
        }
        13 => Ok(SelectorNode::MeshBoundary),
        14 => Ok(SelectorNode::Parallel {
            axis: r.u8()?,
            degrees: r.f64()?,
        }),
        15 => Ok(SelectorNode::Perpendicular {
            axis: r.u8()?,
            degrees: r.f64()?,
        }),
        16 => Ok(SelectorNode::Concave),
        17 => Ok(SelectorNode::Sharp),
        18 => Ok(SelectorNode::Seam),
        20 => {
            let domain = Domain::from_u8(r.u8()?)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid not domain"))?;
            Ok(SelectorNode::Not {
                domain,
                src: Box::new(read_node(r)?),
            })
        }
        21 => Ok(SelectorNode::Largest(Box::new(read_node(r)?))),
        22 => Ok(SelectorNode::Smallest(Box::new(read_node(r)?))),
        23 => Ok(SelectorNode::Grow {
            steps: r.u32()?,
            src: Box::new(read_node(r)?),
        }),
        24 => Ok(SelectorNode::Shrink {
            steps: r.u32()?,
            src: Box::new(read_node(r)?),
        }),
        25 => {
            let across = r.u8()?;
            if across > 1 {
                return Err(KernelError::invalid_value(
                    "selector",
                    "invalid connected mode",
                ));
            }
            Ok(SelectorNode::Connected {
                smooth: across == 1,
                src: Box::new(read_node(r)?),
            })
        }
        26 => {
            let include = Inclusion::from_u8(r.u8()?)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid inclusion"))?;
            Ok(SelectorNode::ToEdges {
                include,
                src: Box::new(read_node(r)?),
            })
        }
        27 => Ok(SelectorNode::Boundary(Box::new(read_node(r)?))),
        28 => {
            let include = Inclusion::from_u8(r.u8()?)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid inclusion"))?;
            Ok(SelectorNode::ToVerts {
                include,
                src: Box::new(read_node(r)?),
            })
        }
        29 => Ok(SelectorNode::ToFaces(Box::new(read_node(r)?))),
        30 => Ok(SelectorNode::Loop(Box::new(read_node(r)?))),
        31 => Ok(SelectorNode::Ring(Box::new(read_node(r)?))),
        40 | 41 | 42 => {
            let domain = Domain::from_u8(r.u8()?)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid set domain"))?;
            let a = Box::new(read_node(r)?);
            let b = Box::new(read_node(r)?);
            match op {
                40 => Ok(SelectorNode::And { domain, a, b }),
                41 => Ok(SelectorNode::Or { domain, a, b }),
                _ => Ok(SelectorNode::Minus { domain, a, b }),
            }
        }
        _ => Err(KernelError::invalid_value(
            "selector",
            format!("unknown FXSL opcode {op}"),
        )),
    }
}

pub fn decode_fxsl(bytes: &[u8]) -> Result<DecodedSelector, KernelError> {
    let mut r = Reader::new(bytes);
    let magic = r.u32()?;
    if magic != FXSL_MAGIC {
        return Err(KernelError::invalid_value("selector", "invalid FXSL magic"));
    }
    let version = r.u8()?;
    if version != FXSL_VERSION {
        return Err(KernelError::invalid_value(
            "selector",
            format!("unsupported FXSL version {version}"),
        ));
    }
    let c_kind = r.u8()?;
    let cardinality = match c_kind {
        0 => Cardinality::NonEmpty,
        1 => Cardinality::Exactly(r.u32()?),
        2 => Cardinality::AtLeast(r.u32()?),
        _ => {
            return Err(KernelError::invalid_value(
                "selector",
                "invalid cardinality kind",
            ))
        }
    };
    let root = read_node(&mut r)?;
    if r.remaining() != 0 {
        return Err(KernelError::invalid_value(
            "selector",
            "trailing FXSL bytes",
        ));
    }
    Ok(DecodedSelector { cardinality, root })
}

fn domain_ids(mesh: &EditMesh, domain: Domain) -> Vec<i32> {
    match domain {
        Domain::Face => mesh.faces(),
        Domain::Edge => mesh.edges(),
        Domain::Vert => mesh.vertices(),
    }
}

fn hit_face(mesh: &EditMesh, f: i32, by: HitRule, pred: impl Fn(Vec3) -> bool) -> bool {
    match by {
        HitRule::Centroid => pred(face_centroid(mesh, f)),
        HitRule::All => mesh
            .face_vertices(f)
            .into_iter()
            .all(|v| pred(mesh.position(v))),
        HitRule::Any => mesh
            .face_vertices(f)
            .into_iter()
            .any(|v| pred(mesh.position(v))),
    }
}

fn face_neighbors(mesh: &EditMesh, f: i32, smooth_only: bool) -> Vec<i32> {
    let mut out = Vec::new();
    for h in mesh.face_halves(f) {
        if smooth_only && (mesh.e_flags[(h >> 1) as usize] & EDGE_SHARP) != 0 {
            continue;
        }
        let g = mesh.h_face[(h ^ 1) as usize];
        if g != NONE {
            out.push(g);
        }
    }
    out
}

/// Walk quad-mesh edge ring starting at `start_edge`.
fn edge_ring(mesh: &EditMesh, start_edge: i32) -> Vec<i32> {
    let mut visited = HashSet::new();
    visited.insert(start_edge);
    let mut out = vec![start_edge];
    for start_half in [start_edge * 2, start_edge * 2 + 1] {
        let mut h = start_half;
        loop {
            let f = mesh.h_face[h as usize];
            if f == NONE || mesh.f_len[f as usize] != 4 {
                break;
            }
            let opp = mesh.h_next[mesh.h_next[h as usize] as usize];
            let next_e = opp >> 1;
            if !visited.insert(next_e) {
                break;
            }
            out.push(next_e);
            h = opp ^ 1;
        }
    }
    out.sort_unstable();
    out
}

/// Walk valence-4 edge loop starting at `start_edge`.
fn edge_loop(mesh: &EditMesh, start_edge: i32) -> Vec<i32> {
    // Build vertex -> incident edges map once for local walk.
    let mut incident: HashMap<i32, Vec<i32>> = HashMap::new();
    for e in mesh.edges() {
        let [a, b] = mesh.edge_vertices(e);
        incident.entry(a).or_default().push(e);
        incident.entry(b).or_default().push(e);
    }
    let mut visited = HashSet::new();
    visited.insert(start_edge);
    let mut out = vec![start_edge];
    for dir in 0..2 {
        let mut cur_e = start_edge;
        let mut cur_v = mesh.edge_vertices(start_edge)[dir];
        loop {
            let Some(edges) = incident.get(&cur_v) else {
                break;
            };
            if edges.len() != 4 {
                break;
            }
            // Find the edge at cur_v that shares no face with cur_e.
            let f0 = mesh.h_face[(cur_e * 2) as usize];
            let f1 = mesh.h_face[(cur_e * 2 + 1) as usize];
            let mut next_e = NONE;
            for &cand in edges {
                if cand == cur_e {
                    continue;
                }
                let cf0 = mesh.h_face[(cand * 2) as usize];
                let cf1 = mesh.h_face[(cand * 2 + 1) as usize];
                let shares = (f0 != NONE && (cf0 == f0 || cf1 == f0))
                    || (f1 != NONE && (cf0 == f1 || cf1 == f1));
                if !shares {
                    next_e = cand;
                    break;
                }
            }
            if next_e == NONE || !visited.insert(next_e) {
                break;
            }
            out.push(next_e);
            let [a, b] = mesh.edge_vertices(next_e);
            cur_v = if a == cur_v { b } else { a };
            cur_e = next_e;
        }
    }
    out.sort_unstable();
    out
}

pub fn eval_node(mesh: &EditMesh, node: &SelectorNode) -> Result<Vec<i32>, KernelError> {
    match node {
        SelectorNode::All(d) => Ok(domain_ids(mesh, *d)),
        SelectorNode::Tag(name) => {
            let t = mesh.find_tag_index(name);
            if t < 0 {
                return Ok(Vec::new());
            }
            let word = (t as usize) >> 5;
            let mask = 1u32 << ((t as usize) & 31);
            let mut out = Vec::new();
            for f in 0..mesh.face_high_water {
                if (mesh.f_tags[(f as usize) * mesh.tag_words + word] & mask) != 0
                    && mesh.is_face_alive(f)
                {
                    out.push(f);
                }
            }
            Ok(out)
        }
        SelectorNode::CreatedBy { label, role } => {
            let Some(l) = mesh.label_names.iter().position(|n| n == label) else {
                return Ok(Vec::new());
            };
            if l == 0 {
                return Ok(Vec::new());
            }
            let li = l as i32;
            match role {
                None => Ok(mesh
                    .faces()
                    .into_iter()
                    .filter(|&f| mesh.f_label[f as usize] == li)
                    .collect()),
                Some(r_name) => {
                    let Some(r) = mesh.role_names.iter().position(|n| n == r_name) else {
                        return Ok(Vec::new());
                    };
                    let ri = r as i32;
                    Ok(mesh
                        .faces()
                        .into_iter()
                        .filter(|&f| {
                            mesh.f_label[f as usize] == li && mesh.f_role[f as usize] == ri
                        })
                        .collect())
                }
            }
        }
        SelectorNode::Material(slot) => {
            let Some(m) = mesh.material_names.iter().position(|n| n == slot) else {
                return Ok(Vec::new());
            };
            let mi = m as i32;
            Ok(mesh
                .faces()
                .into_iter()
                .filter(|&f| mesh.f_material[f as usize] == mi)
                .collect())
        }
        SelectorNode::Mirrored => Ok(mesh
            .faces()
            .into_iter()
            .filter(|&f| (mesh.f_flags[f as usize] & FACE_MIRRORED) != 0)
            .collect()),
        SelectorNode::Facing { axis, degrees } => {
            let dir = signed_axis_vector(*axis)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid signed axis"))?;
            let limit = (degrees * std::f64::consts::PI / 180.0).cos();
            Ok(mesh
                .faces()
                .into_iter()
                .filter(|&f| dot(face_normal(mesh, f), dir) >= limit - 1e-12)
                .collect())
        }
        SelectorNode::Extreme { axis } => {
            let dir = signed_axis_vector(*axis)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid signed axis"))?;
            let faces = mesh.faces();
            if faces.is_empty() {
                return Ok(Vec::new());
            }
            let mut reach = Vec::with_capacity(faces.len());
            let mut max_v = f64::NEG_INFINITY;
            for &f in &faces {
                let r = dot(face_centroid(mesh, f), dir);
                if r > max_v {
                    max_v = r;
                }
                reach.push(r);
            }
            Ok(faces
                .into_iter()
                .zip(reach)
                .filter(|&(_, r)| r >= max_v - 1e-9)
                .map(|(f, _)| f)
                .collect())
        }
        SelectorNode::InBox { min, max, by } => Ok(mesh
            .faces()
            .into_iter()
            .filter(|&f| {
                hit_face(mesh, f, *by, |p| {
                    p[0] >= min[0]
                        && p[0] <= max[0]
                        && p[1] >= min[1]
                        && p[1] <= max[1]
                        && p[2] >= min[2]
                        && p[2] <= max[2]
                })
            })
            .collect()),
        SelectorNode::Side { point, normal, by } => Ok(mesh
            .faces()
            .into_iter()
            .filter(|&f| hit_face(mesh, f, *by, |p| dot(sub(p, *point), *normal) >= 0.0))
            .collect()),
        SelectorNode::Near { point, count } => {
            let mut scored: Vec<(f64, i32)> = mesh
                .faces()
                .into_iter()
                .map(|f| {
                    let c = face_centroid(mesh, f);
                    let dx = c[0] - point[0];
                    let dy = c[1] - point[1];
                    let dz = c[2] - point[2];
                    ((dx * dx + dy * dy + dz * dz).sqrt(), f)
                })
                .collect();
            scored.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            scored.truncate(*count as usize);
            let mut out: Vec<i32> = scored.into_iter().map(|(_, f)| f).collect();
            out.sort_unstable();
            Ok(out)
        }
        SelectorNode::Thin { max_width } => {
            let widths = crate::mesh::bvh::face_thickness(mesh, *max_width, 1e-12);
            Ok(mesh
                .faces()
                .into_iter()
                .filter(|f| widths.get(f).copied().unwrap_or(f64::INFINITY) < *max_width)
                .collect())
        }
        SelectorNode::Dihedral { greater, degrees } => {
            let limit = (degrees * std::f64::consts::PI / 180.0).cos();
            Ok(mesh
                .edges()
                .into_iter()
                .filter(|&e| {
                    let a = mesh.h_face[(e * 2) as usize];
                    let b = mesh.h_face[(e * 2 + 1) as usize];
                    if a == NONE || b == NONE {
                        return false;
                    }
                    let c = dot(face_normal(mesh, a), face_normal(mesh, b));
                    if *greater {
                        c < limit - 1e-12
                    } else {
                        c > limit + 1e-12
                    }
                })
                .collect())
        }
        SelectorNode::MeshBoundary => Ok(mesh
            .edges()
            .into_iter()
            .filter(|&e| mesh.is_boundary_edge(e))
            .collect()),
        SelectorNode::Parallel { axis, degrees } => {
            let dir = unsigned_axis_vector(*axis)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid axis"))?;
            let limit = (degrees * std::f64::consts::PI / 180.0).cos();
            Ok(mesh
                .edges()
                .into_iter()
                .filter(|&e| {
                    let [a, b] = mesh.edge_vertices(e);
                    let d = normalize(sub(mesh.position(b), mesh.position(a)));
                    dot(d, dir).abs() >= limit - 1e-12
                })
                .collect())
        }
        SelectorNode::Perpendicular { axis, degrees } => {
            let dir = unsigned_axis_vector(*axis)
                .ok_or_else(|| KernelError::invalid_value("selector", "invalid axis"))?;
            let limit = (degrees * std::f64::consts::PI / 180.0).sin();
            Ok(mesh
                .edges()
                .into_iter()
                .filter(|&e| {
                    let [a, b] = mesh.edge_vertices(e);
                    let d = normalize(sub(mesh.position(b), mesh.position(a)));
                    dot(d, dir).abs() <= limit + 1e-12
                })
                .collect())
        }
        SelectorNode::Concave => Ok(mesh
            .edges()
            .into_iter()
            .filter(|&e| {
                let a = mesh.h_face[(e * 2) as usize];
                let b = mesh.h_face[(e * 2 + 1) as usize];
                if a == NONE || b == NONE {
                    return false;
                }
                let p = mesh.position(mesh.h_vert[(e * 2 + 1) as usize]);
                let q = mesh.position(mesh.h_vert[(e * 2) as usize]);
                let inward = cross(face_normal(mesh, b), normalize(sub(q, p)));
                dot(face_normal(mesh, a), inward) > 1e-9
            })
            .collect()),
        SelectorNode::Sharp => Ok(mesh
            .edges()
            .into_iter()
            .filter(|&e| (mesh.e_flags[e as usize] & EDGE_SHARP) != 0)
            .collect()),
        SelectorNode::Seam => Ok(mesh
            .edges()
            .into_iter()
            .filter(|&e| (mesh.e_flags[e as usize] & EDGE_SEAM) != 0)
            .collect()),
        SelectorNode::Not { domain, src } => {
            let excluded: HashSet<i32> = eval_node(mesh, src)?.into_iter().collect();
            Ok(domain_ids(mesh, *domain)
                .into_iter()
                .filter(|id| !excluded.contains(id))
                .collect())
        }
        SelectorNode::Largest(src) | SelectorNode::Smallest(src) => {
            let largest = matches!(node, SelectorNode::Largest(_));
            let mut best = NONE;
            let mut best_area = if largest {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            };
            for f in eval_node(mesh, src)? {
                let area = face_area(mesh, f);
                if if largest {
                    area > best_area
                } else {
                    area < best_area
                } {
                    best = f;
                    best_area = area;
                }
            }
            Ok(if best == NONE { Vec::new() } else { vec![best] })
        }
        SelectorNode::Grow { steps, src } => {
            let mut set: HashSet<i32> = eval_node(mesh, src)?.into_iter().collect();
            for _ in 0..*steps {
                let snapshot: Vec<i32> = set.iter().copied().collect();
                for f in snapshot {
                    for g in face_neighbors(mesh, f, false) {
                        set.insert(g);
                    }
                }
            }
            let mut out: Vec<i32> = set.into_iter().collect();
            out.sort_unstable();
            Ok(out)
        }
        SelectorNode::Shrink { steps, src } => {
            let mut set: HashSet<i32> = eval_node(mesh, src)?.into_iter().collect();
            for _ in 0..*steps {
                let current = set;
                set = current
                    .iter()
                    .copied()
                    .filter(|&f| {
                        mesh.face_halves(f).into_iter().all(|h| {
                            let g = mesh.h_face[(h ^ 1) as usize];
                            g == NONE || current.contains(&g)
                        })
                    })
                    .collect();
            }
            let mut out: Vec<i32> = set.into_iter().collect();
            out.sort_unstable();
            Ok(out)
        }
        SelectorNode::Connected { smooth, src } => {
            let mut set: HashSet<i32> = eval_node(mesh, src)?.into_iter().collect();
            let mut stack: Vec<i32> = set.iter().copied().collect();
            while let Some(f) = stack.pop() {
                for g in face_neighbors(mesh, f, *smooth) {
                    if set.insert(g) {
                        stack.push(g);
                    }
                }
            }
            let mut out: Vec<i32> = set.into_iter().collect();
            out.sort_unstable();
            Ok(out)
        }
        SelectorNode::ToEdges { include, src } => {
            let faces: HashSet<i32> = eval_node(mesh, src)?.into_iter().collect();
            let mut out = HashSet::new();
            for &f in &faces {
                for h in mesh.face_halves(f) {
                    let other = mesh.h_face[(h ^ 1) as usize];
                    if *include == Inclusion::Touching || other == NONE || faces.contains(&other) {
                        out.insert(h >> 1);
                    }
                }
            }
            let mut sorted: Vec<i32> = out.into_iter().collect();
            sorted.sort_unstable();
            Ok(sorted)
        }
        SelectorNode::Boundary(src) => {
            let faces: HashSet<i32> = eval_node(mesh, src)?.into_iter().collect();
            let mut out = Vec::new();
            for e in mesh.edges() {
                let a = faces.contains(&mesh.h_face[(e * 2) as usize]);
                let b = faces.contains(&mesh.h_face[(e * 2 + 1) as usize]);
                if a != b {
                    out.push(e);
                }
            }
            Ok(out)
        }
        SelectorNode::ToVerts { include, src } => {
            let faces: HashSet<i32> = eval_node(mesh, src)?.into_iter().collect();
            let mut out = HashSet::new();
            for &f in &faces {
                for v in mesh.face_vertices(f) {
                    out.insert(v);
                }
            }
            if *include == Inclusion::Contained {
                for f in mesh.faces() {
                    if faces.contains(&f) {
                        continue;
                    }
                    for v in mesh.face_vertices(f) {
                        out.remove(&v);
                    }
                }
            }
            let mut sorted: Vec<i32> = out.into_iter().collect();
            sorted.sort_unstable();
            Ok(sorted)
        }
        SelectorNode::ToFaces(src) => {
            let mut out = HashSet::new();
            for e in eval_node(mesh, src)? {
                for h in [e * 2, e * 2 + 1] {
                    let f = mesh.h_face[h as usize];
                    if f != NONE {
                        out.insert(f);
                    }
                }
            }
            let mut sorted: Vec<i32> = out.into_iter().collect();
            sorted.sort_unstable();
            Ok(sorted)
        }
        SelectorNode::Loop(src) => {
            let mut out = HashSet::new();
            for e in eval_node(mesh, src)? {
                for x in edge_loop(mesh, e) {
                    out.insert(x);
                }
            }
            let mut sorted: Vec<i32> = out.into_iter().collect();
            sorted.sort_unstable();
            Ok(sorted)
        }
        SelectorNode::Ring(src) => {
            let mut out = HashSet::new();
            for e in eval_node(mesh, src)? {
                for x in edge_ring(mesh, e) {
                    out.insert(x);
                }
            }
            let mut sorted: Vec<i32> = out.into_iter().collect();
            sorted.sort_unstable();
            Ok(sorted)
        }
        SelectorNode::And { a, b, .. } => {
            let b_set: HashSet<i32> = eval_node(mesh, b)?.into_iter().collect();
            Ok(eval_node(mesh, a)?
                .into_iter()
                .filter(|id| b_set.contains(id))
                .collect())
        }
        SelectorNode::Or { a, b, .. } => {
            let mut combined = eval_node(mesh, a)?;
            combined.extend(eval_node(mesh, b)?);
            combined.sort_unstable();
            combined.dedup();
            Ok(combined)
        }
        SelectorNode::Minus { a, b, .. } => {
            let b_set: HashSet<i32> = eval_node(mesh, b)?.into_iter().collect();
            Ok(eval_node(mesh, a)?
                .into_iter()
                .filter(|id| !b_set.contains(id))
                .collect())
        }
    }
}

/// Decode FXSL v1 bytes, evaluate on `mesh`, and check the encoded cardinality contract.
pub fn resolve_fxsl(mesh: &EditMesh, bytes: &[u8]) -> Result<Vec<i32>, KernelError> {
    let decoded = decode_fxsl(bytes)?;
    let ids = eval_node(mesh, &decoded.root)?;
    match decoded.cardinality {
        Cardinality::NonEmpty => {
            if ids.is_empty() {
                return Err(KernelError::selection_empty(
                    "selector",
                    "selector matched 0 elements",
                ));
            }
        }
        Cardinality::Exactly(n) => {
            if ids.len() != n as usize {
                return Err(KernelError::selection_count(
                    "selector",
                    format!("expected exactly {n} elements, matched {}", ids.len()),
                ));
            }
        }
        Cardinality::AtLeast(n) => {
            if ids.len() < n as usize {
                return Err(KernelError::selection_count(
                    "selector",
                    format!("expected at least {n} elements, matched {}", ids.len()),
                ));
            }
        }
    }
    Ok(ids)
}
