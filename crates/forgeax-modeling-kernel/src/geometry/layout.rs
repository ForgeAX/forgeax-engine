//! Canonical vertex attribute definitions and generic layout specs.

use crate::error::{KernelError, KernelErrorCode};

/// Canonical 15-key vertex attribute vocabulary matching GPU shader locations 0..14.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum AttributeKind {
    Position = 0,
    Normal = 1,
    Uv = 2,
    Tangent = 3,
    SkinIndex = 4,
    SkinWeight = 5,
    Uv1 = 6,
    Uv2 = 7,
    Uv3 = 8,
    Uv4 = 9,
    Uv5 = 10,
    Uv6 = 11,
    Uv7 = 12,
    Color = 13,
    TangentFrame = 14,
}

impl AttributeKind {
    pub const ALL: [AttributeKind; 15] = [
        AttributeKind::Position,
        AttributeKind::Normal,
        AttributeKind::Uv,
        AttributeKind::Tangent,
        AttributeKind::SkinIndex,
        AttributeKind::SkinWeight,
        AttributeKind::Uv1,
        AttributeKind::Uv2,
        AttributeKind::Uv3,
        AttributeKind::Uv4,
        AttributeKind::Uv5,
        AttributeKind::Uv6,
        AttributeKind::Uv7,
        AttributeKind::Color,
        AttributeKind::TangentFrame,
    ];

    pub fn from_u8(v: u8) -> Option<Self> {
        Self::ALL.get(v as usize).copied()
    }

    pub fn bit(self) -> u32 {
        1u32 << (self as u8)
    }

    pub fn default_format(self) -> AttributeFormat {
        match self {
            AttributeKind::Position | AttributeKind::Normal => AttributeFormat::Float32x3,
            AttributeKind::Uv
            | AttributeKind::Uv1
            | AttributeKind::Uv2
            | AttributeKind::Uv3
            | AttributeKind::Uv4
            | AttributeKind::Uv5
            | AttributeKind::Uv6
            | AttributeKind::Uv7 => AttributeFormat::Float32x2,
            AttributeKind::Tangent | AttributeKind::SkinWeight | AttributeKind::Color => {
                AttributeFormat::Float32x4
            }
            AttributeKind::SkinIndex => AttributeFormat::Uint16x4,
            AttributeKind::TangentFrame => AttributeFormat::Uint32,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            AttributeKind::Position => "position",
            AttributeKind::Normal => "normal",
            AttributeKind::Uv => "uv",
            AttributeKind::Tangent => "tangent",
            AttributeKind::SkinIndex => "skinIndex",
            AttributeKind::SkinWeight => "skinWeight",
            AttributeKind::Uv1 => "uv1",
            AttributeKind::Uv2 => "uv2",
            AttributeKind::Uv3 => "uv3",
            AttributeKind::Uv4 => "uv4",
            AttributeKind::Uv5 => "uv5",
            AttributeKind::Uv6 => "uv6",
            AttributeKind::Uv7 => "uv7",
            AttributeKind::Color => "color",
            AttributeKind::TangentFrame => "tangentFrame",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum AttributeFormat {
    Float32x2 = 0,
    Float32x3 = 1,
    Float32x4 = 2,
    Uint16x4 = 3,
    Unorm8x4 = 4,
    Unorm16x4 = 5,
    Uint32 = 6,
}

impl AttributeFormat {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Float32x2),
            1 => Some(Self::Float32x3),
            2 => Some(Self::Float32x4),
            3 => Some(Self::Uint16x4),
            4 => Some(Self::Unorm8x4),
            5 => Some(Self::Unorm16x4),
            6 => Some(Self::Uint32),
            _ => None,
        }
    }

    pub fn byte_len(self) -> usize {
        match self {
            Self::Unorm8x4 | Self::Uint32 => 4,
            Self::Float32x2 | Self::Uint16x4 | Self::Unorm16x4 => 8,
            Self::Float32x3 => 12,
            Self::Float32x4 => 16,
        }
    }

    pub fn component_count(self) -> usize {
        match self {
            Self::Uint32 => 1,
            Self::Float32x2 => 2,
            Self::Float32x3 => 3,
            Self::Float32x4 | Self::Uint16x4 | Self::Unorm8x4 | Self::Unorm16x4 => 4,
        }
    }

    pub fn element_byte_len(self) -> usize {
        match self {
            Self::Unorm8x4 => 1,
            Self::Uint16x4 | Self::Unorm16x4 => 2,
            Self::Float32x2 | Self::Float32x3 | Self::Float32x4 | Self::Uint32 => 4,
        }
    }

    pub fn is_float(self) -> bool {
        matches!(self, Self::Float32x2 | Self::Float32x3 | Self::Float32x4)
    }

    pub fn valid_for(self, kind: AttributeKind) -> bool {
        match kind {
            AttributeKind::SkinWeight => {
                matches!(self, Self::Float32x4 | Self::Unorm8x4 | Self::Unorm16x4)
            }
            _ => self == kind.default_format(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayoutEntry {
    pub kind: AttributeKind,
    pub format: AttributeFormat,
    pub shader_location: u8,
    pub offset: usize,
    pub byte_len: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VertexLayoutSpec {
    pub entries: Vec<LayoutEntry>,
    pub array_stride: usize,
    pub mask: u32,
}

impl VertexLayoutSpec {
    /// Build a layout spec from an ordered list of `(AttributeKind, AttributeFormat)` entries.
    /// When `canonical_order` is true, entries are sorted by canonical shader location (0..14).
    pub fn from_entries(
        raw: &[(AttributeKind, AttributeFormat)],
        canonical_order: bool,
    ) -> Result<Self, KernelError> {
        if raw.is_empty() {
            return Err(KernelError::new(
                KernelErrorCode::InvalidValue,
                "attributes",
                "at least one vertex attribute is required",
            ));
        }
        let mut items: Vec<(AttributeKind, AttributeFormat)> = raw.to_vec();
        if canonical_order {
            items.sort_by_key(|(k, _)| *k as u8);
        }
        let mut mask = 0u32;
        let mut offset = 0usize;
        let mut entries = Vec::with_capacity(items.len());
        for (kind, format) in items {
            if !format.valid_for(kind) {
                return Err(KernelError::invalid_value(
                    kind.name(),
                    "attribute storage format does not match attribute kind",
                ));
            }
            let bit = kind.bit();
            if (mask & bit) != 0 {
                return Err(KernelError::invalid_value(
                    kind.name(),
                    "duplicate vertex attribute kind",
                ));
            }
            mask |= bit;
            let byte_len = format.byte_len();
            entries.push(LayoutEntry {
                kind,
                format,
                shader_location: kind as u8,
                offset,
                byte_len,
            });
            offset += byte_len;
        }
        Ok(Self {
            entries,
            array_stride: offset,
            mask,
        })
    }

    pub fn find(&self, kind: AttributeKind) -> Option<&LayoutEntry> {
        self.entries.iter().find(|e| e.kind == kind)
    }
}
