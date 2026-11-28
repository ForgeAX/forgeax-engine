//! High-precision f32 image buffer for procedural texture synthesis and baking,
//! exporting strictly standard 8-bit game PBR textures (sRGB baseColor, linear normal,
//! linear packed ORM: R=AO, G=Roughness, B=Metallic).

use crate::error::KernelError;

/// Internal high-precision f32 image buffer (1, 3, or 4 channels).
#[derive(Debug, Clone)]
pub struct ImageBuffer {
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub data: Vec<f32>,
}

#[inline]
pub fn linear_to_srgb(v: f32) -> f32 {
    let x = v.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

#[inline]
pub fn quantize_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

impl ImageBuffer {
    pub fn new(width: u32, height: u32, channels: u8, fill: f32) -> Result<Self, KernelError> {
        if width == 0 || height == 0 || width > 8192 || height > 8192 {
            return Err(KernelError::invalid_value(
                "resolution",
                "texture width and height must be in [1, 8192]",
            ));
        }
        if channels != 1 && channels != 3 && channels != 4 {
            return Err(KernelError::invalid_value(
                "channels",
                "ImageBuffer supports 1, 3, or 4 channels",
            ));
        }
        let len = (width as usize) * (height as usize) * (channels as usize);
        Ok(Self {
            width,
            height,
            channels,
            data: vec![fill; len],
        })
    }

    #[inline]
    pub fn pixel_count(&self) -> usize {
        (self.width as usize) * (self.height as usize)
    }

    #[inline]
    pub fn idx(&self, x: u32, y: u32) -> usize {
        ((y as usize) * (self.width as usize) + (x as usize)) * (self.channels as usize)
    }

    #[inline]
    pub fn get_wrap(&self, x: i32, y: i32, c: usize) -> f32 {
        let w = self.width as i32;
        let h = self.height as i32;
        let wx = x.rem_euclid(w) as u32;
        let wy = y.rem_euclid(h) as u32;
        self.data[self.idx(wx, wy) + c]
    }

    /// Quantize linear RGB/RGBA/R buffer into standard 8-bit sRGB RGBA8.
    pub fn to_rgba8_srgb(&self) -> Vec<u8> {
        let n = self.pixel_count();
        let mut out = vec![255u8; n * 4];
        match self.channels {
            1 => {
                for i in 0..n {
                    let s = quantize_u8(linear_to_srgb(self.data[i]));
                    out[i * 4] = s;
                    out[i * 4 + 1] = s;
                    out[i * 4 + 2] = s;
                    out[i * 4 + 3] = 255;
                }
            }
            3 => {
                for i in 0..n {
                    out[i * 4] = quantize_u8(linear_to_srgb(self.data[i * 3]));
                    out[i * 4 + 1] = quantize_u8(linear_to_srgb(self.data[i * 3 + 1]));
                    out[i * 4 + 2] = quantize_u8(linear_to_srgb(self.data[i * 3 + 2]));
                    out[i * 4 + 3] = 255;
                }
            }
            _ => {
                for i in 0..n {
                    out[i * 4] = quantize_u8(linear_to_srgb(self.data[i * 4]));
                    out[i * 4 + 1] = quantize_u8(linear_to_srgb(self.data[i * 4 + 1]));
                    out[i * 4 + 2] = quantize_u8(linear_to_srgb(self.data[i * 4 + 2]));
                    out[i * 4 + 3] = quantize_u8(self.data[i * 4 + 3]);
                }
            }
        }
        out
    }

    /// Quantize linear buffer into standard 8-bit linear RGBA8.
    pub fn to_rgba8_linear(&self) -> Vec<u8> {
        let n = self.pixel_count();
        let mut out = vec![255u8; n * 4];
        match self.channels {
            1 => {
                for i in 0..n {
                    let v = quantize_u8(self.data[i]);
                    out[i * 4] = v;
                    out[i * 4 + 1] = v;
                    out[i * 4 + 2] = v;
                    out[i * 4 + 3] = 255;
                }
            }
            3 => {
                for i in 0..n {
                    out[i * 4] = quantize_u8(self.data[i * 3]);
                    out[i * 4 + 1] = quantize_u8(self.data[i * 3 + 1]);
                    out[i * 4 + 2] = quantize_u8(self.data[i * 3 + 2]);
                    out[i * 4 + 3] = 255;
                }
            }
            _ => {
                for i in 0..n {
                    out[i * 4] = quantize_u8(self.data[i * 4]);
                    out[i * 4 + 1] = quantize_u8(self.data[i * 4 + 1]);
                    out[i * 4 + 2] = quantize_u8(self.data[i * 4 + 2]);
                    out[i * 4 + 3] = quantize_u8(self.data[i * 4 + 3]);
                }
            }
        }
        out
    }
}

/// Pack tangent-space normal XYZ in `[-1, 1]` into standard linear RGBA8 (`R=nx, G=ny, B=nz, A=255`).
pub fn encode_normal_rgba8(normals: &ImageBuffer) -> Result<Vec<u8>, KernelError> {
    if normals.channels < 3 {
        return Err(KernelError::invalid_value(
            "normal",
            "normal buffer needs 3+ channels",
        ));
    }
    let n = normals.pixel_count();
    let ch = normals.channels as usize;
    let mut out = vec![255u8; n * 4];
    for i in 0..n {
        let mut nx = normals.data[i * ch];
        let mut ny = normals.data[i * ch + 1];
        let mut nz = normals.data[i * ch + 2];
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len > 1e-6 && len.is_finite() {
            nx /= len;
            ny /= len;
            nz /= len;
        } else {
            nx = 0.0;
            ny = 0.0;
            nz = 1.0;
        }
        out[i * 4] = quantize_u8(nx * 0.5 + 0.5);
        out[i * 4 + 1] = quantize_u8(ny * 0.5 + 0.5);
        out[i * 4 + 2] = quantize_u8(nz * 0.5 + 0.5);
        out[i * 4 + 3] = 255;
    }
    Ok(out)
}

/// Pack standard glTF 2.0 / Three.js / ForgeaX ORM texture (`R=AO, G=Roughness, B=Metallic, A=255`, linear).
pub fn pack_orm_rgba8(
    ao: &ImageBuffer,
    roughness: &ImageBuffer,
    metallic: &ImageBuffer,
) -> Result<Vec<u8>, KernelError> {
    if ao.width != roughness.width
        || ao.height != roughness.height
        || ao.width != metallic.width
        || ao.height != metallic.height
    {
        return Err(KernelError::invalid_value(
            "orm",
            "AO, roughness, and metallic dimensions must match",
        ));
    }
    let n = ao.pixel_count();
    let ca = ao.channels as usize;
    let cr = roughness.channels as usize;
    let cm = metallic.channels as usize;
    let mut out = vec![255u8; n * 4];
    for i in 0..n {
        out[i * 4] = quantize_u8(ao.data[i * ca]);
        out[i * 4 + 1] = quantize_u8(roughness.data[i * cr]);
        out[i * 4 + 2] = quantize_u8(metallic.data[i * cm]);
        out[i * 4 + 3] = 255;
    }
    Ok(out)
}
