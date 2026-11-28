//! Tileable f32 image filters: levels, invert, separable Gaussian blur, Scharr
//! height-to-normal, blend modes, color ramp, and UV seam dilation.

use super::buffer::ImageBuffer;
use crate::error::KernelError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BlendMode {
    Normal = 0,
    Multiply = 1,
    Screen = 2,
    Overlay = 3,
    Add = 4,
    Subtract = 5,
    Min = 6,
    Max = 7,
}

impl BlendMode {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Normal),
            1 => Some(Self::Multiply),
            2 => Some(Self::Screen),
            3 => Some(Self::Overlay),
            4 => Some(Self::Add),
            5 => Some(Self::Subtract),
            6 => Some(Self::Min),
            7 => Some(Self::Max),
            _ => None,
        }
    }
}

pub fn levels(
    src: &ImageBuffer,
    in_min: f32,
    in_max: f32,
    gamma: f32,
    out_min: f32,
    out_max: f32,
) -> ImageBuffer {
    let mut out = src.clone();
    let span = (in_max - in_min).max(1e-6);
    let inv_gamma = 1.0 / gamma.max(1e-4);
    for v in &mut out.data {
        let t = ((*v - in_min) / span).clamp(0.0, 1.0).powf(inv_gamma);
        *v = out_min + t * (out_max - out_min);
    }
    out
}

pub fn invert(src: &ImageBuffer) -> ImageBuffer {
    let mut out = src.clone();
    for v in &mut out.data {
        *v = (1.0 - *v).clamp(0.0, 1.0);
    }
    out
}

/// Tileable separable Gaussian blur with kernel radius in pixels.
pub fn blur_gaussian(src: &ImageBuffer, radius: u32) -> ImageBuffer {
    if radius == 0 {
        return src.clone();
    }
    let r = radius.min(32) as i32;
    let sigma = (r as f32) * 0.5;
    let mut weights = Vec::with_capacity((2 * r + 1) as usize);
    let mut w_sum = 0.0f32;
    for k in -r..=r {
        let w = (-(k * k) as f32 / (2.0 * sigma * sigma)).exp();
        weights.push(w);
        w_sum += w;
    }
    for w in &mut weights {
        *w /= w_sum;
    }

    let w = src.width;
    let h = src.height;
    let ch = src.channels as usize;
    let mut tmp = vec![0.0f32; src.data.len()];
    // Horizontal pass
    for y in 0..h {
        for x in 0..w {
            let base = ((y * w + x) as usize) * ch;
            for c in 0..ch {
                let mut acc = 0.0f32;
                for k in -r..=r {
                    acc += src.get_wrap(x as i32 + k, y as i32, c) * weights[(k + r) as usize];
                }
                tmp[base + c] = acc;
            }
        }
    }
    let tmp_buf = ImageBuffer {
        width: w,
        height: h,
        channels: src.channels,
        data: tmp,
    };
    let mut out = vec![0.0f32; src.data.len()];
    // Vertical pass
    for y in 0..h {
        for x in 0..w {
            let base = ((y * w + x) as usize) * ch;
            for c in 0..ch {
                let mut acc = 0.0f32;
                for k in -r..=r {
                    acc += tmp_buf.get_wrap(x as i32, y as i32 + k, c) * weights[(k + r) as usize];
                }
                out[base + c] = acc;
            }
        }
    }
    ImageBuffer {
        width: w,
        height: h,
        channels: src.channels,
        data: out,
    }
}

/// Convert scalar height map (`[0, 1]`) into unit tangent-space normals (`[-1, 1]` RGB)
/// via a tileable 3x3 Scharr operator.
pub fn height_to_normal(height: &ImageBuffer, strength: f32) -> Result<ImageBuffer, KernelError> {
    let mut out = ImageBuffer::new(height.width, height.height, 3, 0.0)?;
    let w = height.width as i32;
    let h = height.height as i32;
    let scale = strength / 32.0;

    for y in 0..h {
        for x in 0..w {
            let tl = height.get_wrap(x - 1, y - 1, 0);
            let t = height.get_wrap(x, y - 1, 0);
            let tr = height.get_wrap(x + 1, y - 1, 0);
            let l = height.get_wrap(x - 1, y, 0);
            let r = height.get_wrap(x + 1, y, 0);
            let bl = height.get_wrap(x - 1, y + 1, 0);
            let b = height.get_wrap(x, y + 1, 0);
            let br = height.get_wrap(x + 1, y + 1, 0);

            let dx = (3.0 * tr + 10.0 * r + 3.0 * br) - (3.0 * tl + 10.0 * l + 3.0 * bl);
            let dy = (3.0 * bl + 10.0 * b + 3.0 * br) - (3.0 * tl + 10.0 * t + 3.0 * tr);

            let nx = -dx * scale;
            let ny = dy * scale;
            let nz = 1.0f32;
            let inv = 1.0 / (nx * nx + ny * ny + nz * nz).sqrt();
            let base = ((y as u32 * height.width + x as u32) as usize) * 3;
            out.data[base] = nx * inv;
            out.data[base + 1] = ny * inv;
            out.data[base + 2] = nz * inv;
        }
    }
    Ok(out)
}

#[inline]
fn blend_scalar(a: f32, b: f32, mode: BlendMode) -> f32 {
    match mode {
        BlendMode::Normal => b,
        BlendMode::Multiply => a * b,
        BlendMode::Screen => 1.0 - (1.0 - a) * (1.0 - b),
        BlendMode::Overlay => {
            if a < 0.5 {
                2.0 * a * b
            } else {
                1.0 - 2.0 * (1.0 - a) * (1.0 - b)
            }
        }
        BlendMode::Add => (a + b).min(1.0),
        BlendMode::Subtract => (a - b).max(0.0),
        BlendMode::Min => a.min(b),
        BlendMode::Max => a.max(b),
    }
}

pub fn blend(
    base: &ImageBuffer,
    top: &ImageBuffer,
    mask: Option<&ImageBuffer>,
    mode: BlendMode,
    opacity: f32,
) -> Result<ImageBuffer, KernelError> {
    if base.width != top.width || base.height != top.height {
        return Err(KernelError::invalid_value(
            "blend",
            "buffer dimensions must match",
        ));
    }
    let mut out = base.clone();
    let n = base.pixel_count();
    let cb = base.channels as usize;
    let ct = top.channels as usize;
    let op = opacity.clamp(0.0, 1.0);

    for i in 0..n {
        let m = match mask {
            Some(mb) => mb.data[i * (mb.channels as usize)].clamp(0.0, 1.0) * op,
            None => op,
        };
        if m <= 0.0 {
            continue;
        }
        for c in 0..cb {
            let a = base.data[i * cb + c];
            let b = top.data[i * ct + c.min(ct - 1)];
            let blended = blend_scalar(a, b, mode);
            out.data[i * cb + c] = a + (blended - a) * m;
        }
    }
    Ok(out)
}

/// Reoriented Normal Mapping (RNM) detail blend of `detail` normal onto `base` normal (both in `[-1, 1]`).
#[inline]
pub fn blend_normals_rnm(base: [f32; 3], detail: [f32; 3]) -> [f32; 3] {
    let t = [base[0], base[1], base[2] + 1.0];
    let u = [-detail[0], -detail[1], detail[2]];
    let dot_tu = t[0] * u[0] + t[1] * u[1] + t[2] * u[2];
    let tz = t[2].max(1e-5);
    let r = [
        t[0] * (dot_tu / tz) - u[0],
        t[1] * (dot_tu / tz) - u[1],
        t[2] * (dot_tu / tz) - u[2],
    ];
    let len = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt().max(1e-6);
    [r[0] / len, r[1] / len, r[2] / len]
}

/// Iterative edge dilation into uncovered UV gutter texels (prevents dark mipmap seams).
pub fn dilate_uv_gutter(buf: &mut ImageBuffer, coverage: &[u8], radius_px: u32) {
    let w = buf.width as i32;
    let h = buf.height as i32;
    let ch = buf.channels as usize;
    let mut cov = coverage.to_vec();
    let mut next_cov = cov.clone();
    let mut next_data = buf.data.clone();

    for _ in 0..radius_px {
        let mut changed = false;
        for y in 0..h {
            for x in 0..w {
                let pi = (y * w + x) as usize;
                if cov[pi] != 0 {
                    continue;
                }
                let mut sum = [0.0f32; 4];
                let mut count = 0u32;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = x + dx;
                        let ny = y + dy;
                        if nx < 0 || nx >= w || ny < 0 || ny >= h {
                            continue;
                        }
                        let ni = (ny * w + nx) as usize;
                        if cov[ni] != 0 {
                            for c in 0..ch {
                                sum[c] += buf.data[ni * ch + c];
                            }
                            count += 1;
                        }
                    }
                }
                if count > 0 {
                    let inv = 1.0 / (count as f32);
                    for c in 0..ch {
                        next_data[pi * ch + c] = sum[c] * inv;
                    }
                    next_cov[pi] = 1;
                    changed = true;
                }
            }
        }
        buf.data.copy_from_slice(&next_data);
        cov.copy_from_slice(&next_cov);
        if !changed {
            break;
        }
    }
}
