//! Operatorized PBR material layer stack (`f32` internal precision) exporting
//! strictly standard 8-bit game PBR textures (`baseColor` sRGB, `normal` linear,
//! `orm` linear R=AO/G=Roughness/B=Metallic, optional `emissive` sRGB).

use super::buffer::{encode_normal_rgba8, pack_orm_rgba8, ImageBuffer};
use super::filters::{blend_normals_rnm, height_to_normal};
use crate::error::KernelError;

/// Final game-ready standard 8-bit PBR texture set (100% compatible with glTF 2.0,
/// Three.js `MeshStandardMaterial`, and ForgeaX `default_standard_surface.wgsl`).
#[derive(Debug, Clone)]
pub struct StandardPbrTextures {
    pub width: u32,
    pub height: u32,
    /// sRGB RGBA8 albedo.
    pub base_color_rgba8: Vec<u8>,
    /// Linear RGBA8 tangent-space normal (`(n * 0.5 + 0.5) * 255`).
    pub normal_rgba8: Vec<u8>,
    /// Linear RGBA8 packed ORM (`R=AO, G=Roughness, B=Metallic, A=255`).
    pub orm_rgba8: Vec<u8>,
    /// Optional sRGB RGBA8 emissive (empty when no layer writes emissive).
    pub emissive_rgba8: Vec<u8>,
}

/// Retained f32 PBR surface stack in WASM/Native linear memory.
pub struct PbrSurfaceStack {
    pub width: u32,
    pub height: u32,
    pub base_color: ImageBuffer,  // 3ch linear RGB
    pub height_map: ImageBuffer,  // 1ch height [0, 1]
    pub roughness: ImageBuffer,   // 1ch [0, 1]
    pub metallic: ImageBuffer,    // 1ch [0, 1]
    pub ao: ImageBuffer,          // 1ch [0, 1]
    pub base_normal: ImageBuffer, // 3ch tangent-space XYZ in [-1, 1]
    pub emissive: ImageBuffer,    // 3ch linear RGB
    pub has_emissive: bool,
    pub last_export: Option<StandardPbrTextures>,
}

impl PbrSurfaceStack {
    pub fn new(width: u32, height: u32) -> Result<Self, KernelError> {
        let mut base_normal = ImageBuffer::new(width, height, 3, 0.0)?;
        for i in 0..base_normal.pixel_count() {
            base_normal.data[i * 3 + 2] = 1.0;
        }
        Ok(Self {
            width,
            height,
            base_color: ImageBuffer::new(width, height, 3, 0.5)?,
            height_map: ImageBuffer::new(width, height, 1, 0.5)?,
            roughness: ImageBuffer::new(width, height, 1, 0.5)?,
            metallic: ImageBuffer::new(width, height, 1, 0.0)?,
            ao: ImageBuffer::new(width, height, 1, 1.0)?,
            base_normal,
            emissive: ImageBuffer::new(width, height, 3, 0.0)?,
            has_emissive: false,
            last_export: None,
        })
    }

    /// Composite a uniform PBR layer (optionally modulated by a scalar `mask` and/or `height_src`).
    #[allow(clippy::too_many_arguments)]
    pub fn add_layer(
        &mut self,
        color_rgb: [f32; 3],
        roughness: f32,
        metallic: f32,
        height_val: f32,
        emissive_rgb: [f32; 3],
        mask: Option<&ImageBuffer>,
        height_src: Option<&ImageBuffer>,
        roughness_src: Option<&ImageBuffer>,
        opacity: f32,
    ) -> Result<(), KernelError> {
        if let Some(m) = mask {
            if m.width != self.width || m.height != self.height {
                return Err(KernelError::invalid_value(
                    "mask",
                    "mask resolution mismatch",
                ));
            }
        }
        if let Some(h) = height_src {
            if h.width != self.width || h.height != self.height {
                return Err(KernelError::invalid_value(
                    "height",
                    "height resolution mismatch",
                ));
            }
        }
        if let Some(r) = roughness_src {
            if r.width != self.width || r.height != self.height {
                return Err(KernelError::invalid_value(
                    "roughness",
                    "roughness resolution mismatch",
                ));
            }
        }
        let op = opacity.clamp(0.0, 1.0);
        let emits = emissive_rgb[0] > 0.0 || emissive_rgb[1] > 0.0 || emissive_rgb[2] > 0.0;
        if emits {
            self.has_emissive = true;
        }
        let n = self.base_color.pixel_count();
        for i in 0..n {
            let w = match mask {
                Some(m) => m.data[i * (m.channels as usize)].clamp(0.0, 1.0) * op,
                None => op,
            };
            if w <= 0.0 {
                continue;
            }
            let inv = 1.0 - w;
            for c in 0..3 {
                self.base_color.data[i * 3 + c] =
                    self.base_color.data[i * 3 + c] * inv + color_rgb[c] * w;
                if emits {
                    self.emissive.data[i * 3 + c] =
                        self.emissive.data[i * 3 + c] * inv + emissive_rgb[c] * w;
                }
            }
            let r_val = match roughness_src {
                Some(rs) => (roughness * rs.data[i * (rs.channels as usize)]).clamp(0.0, 1.0),
                None => roughness.clamp(0.0, 1.0),
            };
            let h_val = match height_src {
                Some(hs) => (height_val * hs.data[i * (hs.channels as usize)]).clamp(0.0, 1.0),
                None => height_val.clamp(0.0, 1.0),
            };
            self.roughness.data[i] = self.roughness.data[i] * inv + r_val * w;
            self.metallic.data[i] = self.metallic.data[i] * inv + metallic.clamp(0.0, 1.0) * w;
            self.height_map.data[i] = self.height_map.data[i] * inv + h_val * w;
        }
        Ok(())
    }

    /// Multiply a baked ambient occlusion map into the stack's `ao` channel.
    pub fn apply_ao(&mut self, ao_map: &ImageBuffer, strength: f32) -> Result<(), KernelError> {
        if ao_map.width != self.width || ao_map.height != self.height {
            return Err(KernelError::invalid_value(
                "ao",
                "AO map resolution mismatch",
            ));
        }
        let s = strength.clamp(0.0, 1.0);
        let ch = ao_map.channels as usize;
        for i in 0..self.ao.pixel_count() {
            let baked = ao_map.data[i * ch].clamp(0.0, 1.0);
            let factor = 1.0 - s * (1.0 - baked);
            self.ao.data[i] = (self.ao.data[i] * factor).clamp(0.0, 1.0);
        }
        Ok(())
    }

    /// Blend a baked tangent-space normal map onto the base normal channel.
    pub fn apply_base_normal(&mut self, normal_map: &ImageBuffer) -> Result<(), KernelError> {
        if normal_map.width != self.width
            || normal_map.height != self.height
            || normal_map.channels < 3
        {
            return Err(KernelError::invalid_value(
                "normal",
                "normal map resolution/channel mismatch",
            ));
        }
        let ch = normal_map.channels as usize;
        for i in 0..self.base_normal.pixel_count() {
            let b = [
                self.base_normal.data[i * 3],
                self.base_normal.data[i * 3 + 1],
                self.base_normal.data[i * 3 + 2],
            ];
            let d = [
                normal_map.data[i * ch],
                normal_map.data[i * ch + 1],
                normal_map.data[i * ch + 2],
            ];
            let blended = blend_normals_rnm(b, d);
            self.base_normal.data[i * 3] = blended[0];
            self.base_normal.data[i * 3 + 1] = blended[1];
            self.base_normal.data[i * 3 + 2] = blended[2];
        }
        Ok(())
    }

    /// Finalize the f32 stack into standard 8-bit game PBR textures (sRGB baseColor,
    /// linear normal blended from height + baseNormal via RNM, linear ORM, optional emissive).
    pub fn export_standard_pbr(
        &mut self,
        height_normal_strength: f32,
    ) -> Result<&StandardPbrTextures, KernelError> {
        let micro_normal = if height_normal_strength.abs() > 1e-6 {
            Some(height_to_normal(&self.height_map, height_normal_strength)?)
        } else {
            None
        };

        let final_normal = match micro_normal {
            None => self.base_normal.clone(),
            Some(micro) => {
                let mut combined = ImageBuffer::new(self.width, self.height, 3, 0.0)?;
                for i in 0..combined.pixel_count() {
                    let b = [
                        self.base_normal.data[i * 3],
                        self.base_normal.data[i * 3 + 1],
                        self.base_normal.data[i * 3 + 2],
                    ];
                    let d = [
                        micro.data[i * 3],
                        micro.data[i * 3 + 1],
                        micro.data[i * 3 + 2],
                    ];
                    let r = blend_normals_rnm(b, d);
                    combined.data[i * 3] = r[0];
                    combined.data[i * 3 + 1] = r[1];
                    combined.data[i * 3 + 2] = r[2];
                }
                combined
            }
        };

        let base_color_rgba8 = self.base_color.to_rgba8_srgb();
        let normal_rgba8 = encode_normal_rgba8(&final_normal)?;
        let orm_rgba8 = pack_orm_rgba8(&self.ao, &self.roughness, &self.metallic)?;
        let emissive_rgba8 = if self.has_emissive {
            self.emissive.to_rgba8_srgb()
        } else {
            Vec::new()
        };

        self.last_export = Some(StandardPbrTextures {
            width: self.width,
            height: self.height,
            base_color_rgba8,
            normal_rgba8,
            orm_rgba8,
            emissive_rgba8,
        });
        Ok(self.last_export.as_ref().unwrap())
    }
}
