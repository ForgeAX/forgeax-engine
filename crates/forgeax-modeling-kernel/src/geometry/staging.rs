//! Zero-copy staging MeshBuilder, validation, surface completion, and separate/interleaved pack.

use crate::error::KernelError;
use crate::geometry::layout::{AttributeFormat, AttributeKind, VertexLayoutSpec};
use crate::geometry::normals_tangent::{compute_tangent_vec4, frame_normals, normal_plane_tangent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PrimitiveTopology {
    PointList = 0,
    LineList = 1,
    LineStrip = 2,
    TriangleList = 3,
    TriangleStrip = 4,
}

impl PrimitiveTopology {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::PointList),
            1 => Some(Self::LineList),
            2 => Some(Self::LineStrip),
            3 => Some(Self::TriangleList),
            4 => Some(Self::TriangleStrip),
            _ => None,
        }
    }

    pub fn is_strip(self) -> bool {
        matches!(self, Self::LineStrip | Self::TriangleStrip)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OutputMode {
    /// Separate contiguous channel buffers (zero-copy for Three.js BufferGeometry).
    Separate = 0,
    /// Interleaved packed byte stream (zero-copy for ForgeaX MeshAsset interleaved storage).
    Interleaved = 1,
    /// Interleaved packed stream plus retained separate channel copies (authoring compatibility).
    InterleavedWithChannels = 2,
}

impl OutputMode {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Separate),
            1 => Some(Self::Interleaved),
            2 => Some(Self::InterleavedWithChannels),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubmeshInput {
    pub index_offset: Option<u32>,
    pub index_count: Option<u32>,
    pub vertex_count: Option<u32>,
    pub topology: PrimitiveTopology,
    pub material_slot: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubmeshOutput {
    pub index_offset: u32,
    pub index_count: u32,
    pub vertex_count: u32,
    pub topology: PrimitiveTopology,
    pub material_slot: u32,
}

pub struct ChannelBuffer {
    pub kind: AttributeKind,
    pub format: AttributeFormat,
    /// Raw little-endian bytes, length = vertex_count * format.byte_len().
    pub bytes: Vec<u8>,
}

pub enum IndexOutput {
    None,
    U16(Vec<u16>),
    U32(Vec<u32>),
}

pub struct BuiltMesh {
    pub vertex_count: u32,
    pub layout: VertexLayoutSpec,
    pub interleaved: Vec<u8>,
    pub channels: Vec<ChannelBuffer>,
    pub indices: IndexOutput,
    pub submeshes: Vec<SubmeshOutput>,
    pub aabb: [f32; 6],
}

/// Retained MeshBuilder with zero-copy mapped staging channels in linear memory.
pub struct MeshBuilderState {
    pub material_slot_count: u32,
    pub vertex_count: u32,
    pub channels: Vec<ChannelBuffer>,
    pub indices: Vec<u32>,
    pub submeshes: Vec<SubmeshInput>,
    pub last_built: Option<BuiltMesh>,
}

impl MeshBuilderState {
    pub fn new(
        declared: &[(AttributeKind, AttributeFormat)],
        material_slot_count: u32,
        vertex_capacity: u32,
        index_capacity: u32,
    ) -> Result<Self, KernelError> {
        if material_slot_count == 0 {
            return Err(KernelError::invalid_value(
                "materialSlots",
                "at least one material slot is required",
            ));
        }
        let spec = VertexLayoutSpec::from_entries(declared, true)?;
        if spec.find(AttributeKind::Position).is_none() {
            return Err(KernelError::invalid_value(
                "attributes.position",
                "position is required",
            ));
        }
        let channels = spec
            .entries
            .into_iter()
            .map(|e| ChannelBuffer {
                kind: e.kind,
                format: e.format,
                bytes: Vec::with_capacity((vertex_capacity as usize) * e.byte_len),
            })
            .collect();
        Ok(Self {
            material_slot_count,
            vertex_count: 0,
            channels,
            indices: Vec::with_capacity(index_capacity as usize),
            submeshes: Vec::new(),
            last_built: None,
        })
    }

    /// Reserve `count` contiguous vertices in every staging channel and return the base vertex index.
    /// Callers can obtain raw pointers to `[base_vertex .. base_vertex + count]` for zero-copy writes.
    pub fn allocate_vertices(&mut self, count: u32) -> Result<u32, KernelError> {
        if count == 0 {
            return Err(KernelError::invalid_value(
                "attributes.position",
                "vertex allocation count must be non-zero",
            ));
        }
        let base = self.vertex_count;
        let next = base
            .checked_add(count)
            .ok_or_else(|| KernelError::invalid_value("attributes", "vertex count overflow"))?;
        for ch in &mut self.channels {
            let new_len = (next as usize)
                .checked_mul(ch.format.byte_len())
                .ok_or_else(|| KernelError::invalid_value("attributes", "byte length overflow"))?;
            ch.bytes.resize(new_len, 0);
        }
        self.vertex_count = next;
        Ok(base)
    }

    /// Reserve `count` contiguous u32 indices and return the starting index offset.
    pub fn allocate_indices(&mut self, count: u32) -> Result<u32, KernelError> {
        let offset = self.indices.len() as u32;
        let next = self
            .indices
            .len()
            .checked_add(count as usize)
            .ok_or_else(|| KernelError::invalid_value("indices", "index count overflow"))?;
        self.indices.resize(next, 0);
        Ok(offset)
    }

    /// Rebase the most recently written section's local indices `[offset .. offset + count]`
    /// against `local_vertex_count` and add `base_vertex` in-place.
    pub fn rebase_section_indices(
        &mut self,
        index_offset: u32,
        index_count: u32,
        base_vertex: u32,
        local_vertex_count: u32,
        section_idx: u32,
    ) -> Result<(), KernelError> {
        let start = index_offset as usize;
        let end = start + (index_count as usize);
        if end > self.indices.len() {
            return Err(KernelError::invalid_value(
                "indices",
                "section index range exceeds allocated indices",
            ));
        }
        for i in 0..(index_count as usize) {
            let local = self.indices[start + i];
            if local >= local_vertex_count {
                return Err(KernelError::invalid_value(
                    format!("sections[{section_idx}].indices[{i}]"),
                    format!("must reference one of this section's {local_vertex_count} vertices"),
                ));
            }
            self.indices[start + i] = local + base_vertex;
        }
        Ok(())
    }

    pub fn add_submesh(&mut self, submesh: SubmeshInput) {
        self.submeshes.push(submesh);
    }

    pub fn build(&mut self, mode: OutputMode) -> Result<&BuiltMesh, KernelError> {
        let built = build_from_channels(
            self.vertex_count,
            &self.channels,
            &self.indices,
            &self.submeshes,
            self.material_slot_count,
            mode,
        )?;
        self.last_built = Some(built);
        Ok(self.last_built.as_ref().unwrap())
    }
}

fn bytes_as_f32(bytes: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    out
}

fn f32_as_bytes(floats: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(floats.len() * 4);
    for &f in floats {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

fn validate_channels(
    vertex_count: u32,
    channels: &[ChannelBuffer],
) -> Result<Vec<f32>, KernelError> {
    if vertex_count == 0 {
        return Err(KernelError::invalid_value(
            "attributes",
            "at least one vertex is required",
        ));
    }
    let mut positions: Option<Vec<f32>> = None;
    for ch in channels {
        let expected_bytes = (vertex_count as usize) * ch.format.byte_len();
        if ch.bytes.len() != expected_bytes {
            return Err(KernelError::invalid_value(
                ch.kind.name(),
                format!("byte length must be {expected_bytes}"),
            ));
        }
        if ch.format.is_float() {
            let floats = bytes_as_f32(&ch.bytes);
            for (idx, &v) in floats.iter().enumerate() {
                if !v.is_finite() {
                    return Err(KernelError::invalid_value(
                        ch.kind.name(),
                        format!("{}[{idx}] must be finite", ch.kind.name()),
                    ));
                }
            }
            if ch.kind == AttributeKind::Position {
                positions = Some(floats);
            }
        }
    }
    positions
        .ok_or_else(|| KernelError::invalid_value("attributes.position", "position is required"))
}

fn resolve_submeshes(
    requested: &[SubmeshInput],
    vertex_count: u32,
    index_count: u32,
    material_slot_count: u32,
) -> Result<Vec<SubmeshOutput>, KernelError> {
    if requested.is_empty() {
        return Ok(vec![SubmeshOutput {
            index_offset: 0,
            index_count,
            vertex_count,
            topology: PrimitiveTopology::TriangleList,
            material_slot: 0,
        }]);
    }
    let mut out = Vec::with_capacity(requested.len());
    for (idx, req) in requested.iter().enumerate() {
        let index_offset = req.index_offset.unwrap_or(0);
        let sub_index_count = req.index_count.unwrap_or(index_count);
        let sub_vertex_count = req.vertex_count.unwrap_or(vertex_count);
        let material_slot = req.material_slot.unwrap_or(idx as u32);
        if sub_vertex_count > vertex_count || material_slot >= material_slot_count {
            return Err(KernelError::invalid_value(
                format!("submeshes[{idx}]"),
                "range and material slot are invalid",
            ));
        }
        if index_count == 0 && (index_offset != 0 || sub_index_count != 0) {
            return Err(KernelError::invalid_value(
                format!("submeshes[{idx}]"),
                "non-indexed meshes use indexOffset=0 and indexCount=0",
            ));
        }
        if index_count > 0
            && (index_offset as u64) + (sub_index_count as u64) > (index_count as u64)
        {
            return Err(KernelError::invalid_value(
                format!("submeshes[{idx}]"),
                "index range exceeds the accumulated index buffer",
            ));
        }
        if index_count == 0 && req.topology.is_strip() {
            return Err(KernelError::invalid_value(
                format!("submeshes[{idx}].topology"),
                "strip topology requires an index buffer",
            ));
        }
        out.push(SubmeshOutput {
            index_offset,
            index_count: sub_index_count,
            vertex_count: sub_vertex_count,
            topology: req.topology,
            material_slot,
        });
    }
    Ok(out)
}

fn surface_triangles(
    submeshes: &[SubmeshOutput],
    indices: &[u32],
    vertex_count: u32,
) -> Option<Vec<u32>> {
    if submeshes.len() == 1
        && !indices.is_empty()
        && submeshes[0].topology == PrimitiveTopology::TriangleList
        && submeshes[0].index_offset == 0
        && submeshes[0].index_count as usize == indices.len()
        && indices.len() % 3 == 0
    {
        return Some(indices.to_vec());
    }
    let mut corners = Vec::new();
    let corner_of = |pos: usize| -> u32 {
        if indices.is_empty() {
            pos as u32
        } else {
            indices[pos]
        }
    };
    for sub in submeshes {
        let first = if indices.is_empty() {
            0
        } else {
            sub.index_offset as usize
        };
        let count = if indices.is_empty() {
            sub.vertex_count as usize
        } else {
            sub.index_count as usize
        };
        match sub.topology {
            PrimitiveTopology::TriangleList => {
                let mut k = 0;
                while k + 2 < count {
                    corners.push(corner_of(first + k));
                    corners.push(corner_of(first + k + 1));
                    corners.push(corner_of(first + k + 2));
                    k += 3;
                }
            }
            PrimitiveTopology::TriangleStrip => {
                let mut start = 0usize;
                let mut k = 0usize;
                while k + 2 < count {
                    let a = corner_of(first + k);
                    let b = corner_of(first + k + 1);
                    let c = corner_of(first + k + 2);
                    if a >= vertex_count || b >= vertex_count || c >= vertex_count {
                        start = k + 1;
                        k += 1;
                        continue;
                    }
                    if a == b || b == c || a == c {
                        k += 1;
                        continue;
                    }
                    if (k - start) % 2 == 0 {
                        corners.extend_from_slice(&[a, b, c]);
                    } else {
                        corners.extend_from_slice(&[b, a, c]);
                    }
                    k += 1;
                }
            }
            _ => {}
        }
    }
    if corners.is_empty() {
        None
    } else {
        Some(corners)
    }
}

fn compute_aabb(positions: &[f32]) -> [f32; 6] {
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut min_z = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    let mut max_z = f32::NEG_INFINITY;
    for chunk in positions.chunks_exact(3) {
        let (x, y, z) = (chunk[0], chunk[1], chunk[2]);
        if x < min_x {
            min_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if z < min_z {
            min_z = z;
        }
        if x > max_x {
            max_x = x;
        }
        if y > max_y {
            max_y = y;
        }
        if z > max_z {
            max_z = z;
        }
    }
    [min_x, min_y, min_z, max_x, max_y, max_z]
}

pub fn build_from_channels(
    vertex_count: u32,
    input_channels: &[ChannelBuffer],
    indices: &[u32],
    requested_submeshes: &[SubmeshInput],
    material_slot_count: u32,
    mode: OutputMode,
) -> Result<BuiltMesh, KernelError> {
    let positions = validate_channels(vertex_count, input_channels)?;

    let mut max_index = 0u32;
    for (idx_pos, &val) in indices.iter().enumerate() {
        if val >= vertex_count {
            return Err(KernelError::invalid_value(
                "indices",
                format!("indices[{idx_pos}] must be less than vertexCount ({vertex_count})"),
            ));
        }
        if val > max_index {
            max_index = val;
        }
    }

    let submeshes = resolve_submeshes(
        requested_submeshes,
        vertex_count,
        indices.len() as u32,
        material_slot_count,
    )?;

    // Collect owned channels (completing stock surface stream for triangle meshes).
    let mut completed: Vec<ChannelBuffer> = input_channels
        .iter()
        .map(|c| ChannelBuffer {
            kind: c.kind,
            format: c.format,
            bytes: c.bytes.clone(),
        })
        .collect();

    let has_tangent_frame = completed
        .iter()
        .any(|c| c.kind == AttributeKind::TangentFrame);
    let has_normal = completed.iter().any(|c| c.kind == AttributeKind::Normal);
    let has_uv = completed.iter().any(|c| c.kind == AttributeKind::Uv);
    let has_tangent = completed.iter().any(|c| c.kind == AttributeKind::Tangent);

    if !has_tangent_frame && !(has_normal && has_uv && has_tangent) {
        if let Some(tris) = surface_triangles(&submeshes, indices, vertex_count) {
            let authored_normal = completed
                .iter()
                .find(|c| c.kind == AttributeKind::Normal)
                .map(|c| bytes_as_f32(&c.bytes));
            let unit_normals = frame_normals(authored_normal.as_deref(), &positions, &tris);
            if !has_normal {
                completed.push(ChannelBuffer {
                    kind: AttributeKind::Normal,
                    format: AttributeFormat::Float32x3,
                    bytes: f32_as_bytes(&unit_normals),
                });
            }
            let uv_floats =
                if let Some(existing_uv) = completed.iter().find(|c| c.kind == AttributeKind::Uv) {
                    bytes_as_f32(&existing_uv.bytes)
                } else {
                    let zeros = vec![0.0f32; (vertex_count as usize) * 2];
                    completed.push(ChannelBuffer {
                        kind: AttributeKind::Uv,
                        format: AttributeFormat::Float32x2,
                        bytes: vec![0u8; (vertex_count as usize) * 8],
                    });
                    zeros
                };
            if !has_tangent {
                let tangents = match compute_tangent_vec4(
                    &positions,
                    &unit_normals,
                    &uv_floats,
                    Some(&tris),
                ) {
                    Ok(t) => t,
                    Err(_) => {
                        let mut fallback = vec![0.0f32; (vertex_count as usize) * 4];
                        for v in 0..(vertex_count as usize) {
                            let n = v * 3;
                            let t = normal_plane_tangent(
                                unit_normals[n],
                                unit_normals[n + 1],
                                unit_normals[n + 2],
                            )
                            .unwrap_or([1.0, 0.0, 0.0]);
                            fallback[v * 4] = t[0];
                            fallback[v * 4 + 1] = t[1];
                            fallback[v * 4 + 2] = t[2];
                            fallback[v * 4 + 3] = 1.0;
                        }
                        fallback
                    }
                };
                completed.push(ChannelBuffer {
                    kind: AttributeKind::Tangent,
                    format: AttributeFormat::Float32x4,
                    bytes: f32_as_bytes(&tangents),
                });
            }
        }
    }

    // Sort channels into canonical shader location order (0..14).
    completed.sort_by_key(|c| c.kind as u8);
    let raw_spec: Vec<(AttributeKind, AttributeFormat)> =
        completed.iter().map(|c| (c.kind, c.format)).collect();
    let layout = VertexLayoutSpec::from_entries(&raw_spec, true)?;

    let interleaved = match mode {
        OutputMode::Separate => Vec::new(),
        OutputMode::Interleaved | OutputMode::InterleavedWithChannels => {
            let stride = layout.array_stride;
            let vcount = vertex_count as usize;
            let mut packed = vec![0u8; vcount * stride];
            for (ch, entry) in completed.iter().zip(layout.entries.iter()) {
                let blen = entry.byte_len;
                let off = entry.offset;
                for v in 0..vcount {
                    let dst = v * stride + off;
                    let src = v * blen;
                    packed[dst..dst + blen].copy_from_slice(&ch.bytes[src..src + blen]);
                }
            }
            packed
        }
    };

    let retained_channels = match mode {
        OutputMode::Interleaved => Vec::new(),
        OutputMode::Separate | OutputMode::InterleavedWithChannels => completed,
    };

    let index_output = if indices.is_empty() {
        IndexOutput::None
    } else if max_index <= 0xffff {
        IndexOutput::U16(indices.iter().map(|&x| x as u16).collect())
    } else {
        IndexOutput::U32(indices.to_vec())
    };

    let aabb = compute_aabb(&positions);

    Ok(BuiltMesh {
        vertex_count,
        layout,
        interleaved,
        channels: retained_channels,
        indices: index_output,
        submeshes,
        aabb,
    })
}
