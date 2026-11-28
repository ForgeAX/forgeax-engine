//! Deterministic, seamlessly tileable procedural surface generators into `ImageBuffer<f32>`.

use super::buffer::ImageBuffer;
use crate::error::KernelError;

#[inline]
fn hash2(x: i32, y: i32, seed: u32) -> u32 {
    let mut h = (x as u32)
        .wrapping_mul(374_761_393)
        .wrapping_add((y as u32).wrapping_mul(668_265_263))
        .wrapping_add(seed.wrapping_mul(1_442_695_041));
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^ (h >> 16)
}

#[inline]
fn hash_f32(x: i32, y: i32, seed: u32) -> f32 {
    (hash2(x, y, seed) & 0x00ff_ffff) as f32 / 16_777_216.0
}

#[inline]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn periodic_grad_noise(u: f32, v: f32, period_x: i32, period_y: i32, seed: u32) -> f32 {
    let x = u * (period_x as f32);
    let y = v * (period_y as f32);
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let fx = x - (x0 as f32);
    let fy = y - (y0 as f32);
    let ux = fade(fx);
    let uy = fade(fy);

    let grad = |gx: i32, gy: i32, dx: f32, dy: f32| -> f32 {
        let wx = gx.rem_euclid(period_x);
        let wy = gy.rem_euclid(period_y);
        let angle = hash_f32(wx, wy, seed) * std::f32::consts::TAU;
        angle.cos() * dx + angle.sin() * dy
    };

    let n00 = grad(x0, y0, fx, fy);
    let n10 = grad(x0 + 1, y0, fx - 1.0, fy);
    let n01 = grad(x0, y0 + 1, fx, fy - 1.0);
    let n11 = grad(x0 + 1, y0 + 1, fx - 1.0, fy - 1.0);
    let nx0 = lerp(n00, n10, ux);
    let nx1 = lerp(n01, n11, ux);
    lerp(nx0, nx1, uy)
}

/// Seamlessly tileable multi-octave gradient fBm in `[0, 1]`.
pub fn gen_perlin_fbm(
    width: u32,
    height: u32,
    scale_x: u32,
    scale_y: u32,
    octaves: u32,
    persistence: f32,
    seed: u32,
) -> Result<ImageBuffer, KernelError> {
    let mut buf = ImageBuffer::new(width, height, 1, 0.0)?;
    let sx = scale_x.max(1) as i32;
    let sy = scale_y.max(1) as i32;
    let octs = octaves.clamp(1, 10);
    let pers = persistence.clamp(0.1, 0.95);
    let inv_w = 1.0 / (width as f32);
    let inv_h = 1.0 / (height as f32);

    for y in 0..height {
        let v = (y as f32 + 0.5) * inv_h;
        for x in 0..width {
            let u = (x as f32 + 0.5) * inv_w;
            let mut sum = 0.0f32;
            let mut amp = 1.0f32;
            let mut norm = 0.0f32;
            let mut px = sx;
            let mut py = sy;
            for o in 0..octs {
                sum += periodic_grad_noise(u, v, px, py, seed.wrapping_add(o * 1013)) * amp;
                norm += amp;
                amp *= pers;
                px = px.saturating_mul(2);
                py = py.saturating_mul(2);
            }
            buf.data[(y * width + x) as usize] = ((sum / norm) * 0.7 + 0.5).clamp(0.0, 1.0);
        }
    }
    Ok(buf)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum WorleyMode {
    F1 = 0,
    EdgeF2MinusF1 = 1,
    CellId = 2,
}

impl WorleyMode {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::F1),
            1 => Some(Self::EdgeF2MinusF1),
            2 => Some(Self::CellId),
            _ => None,
        }
    }
}

/// Seamlessly tileable Worley / Voronoi cellular noise (`F1`, `F2 - F1` edges, or flat `CellId`).
pub fn gen_worley(
    width: u32,
    height: u32,
    cells_x: u32,
    cells_y: u32,
    jitter: f32,
    mode: WorleyMode,
    seed: u32,
) -> Result<ImageBuffer, KernelError> {
    let mut buf = ImageBuffer::new(width, height, 1, 0.0)?;
    let cx = cells_x.max(1) as i32;
    let cy = cells_y.max(1) as i32;
    let jit = jitter.clamp(0.0, 1.0);
    let inv_w = 1.0 / (width as f32);
    let inv_h = 1.0 / (height as f32);

    for y in 0..height {
        let py = (y as f32 + 0.5) * inv_h * (cy as f32);
        let iy = py.floor() as i32;
        for x in 0..width {
            let px = (x as f32 + 0.5) * inv_w * (cx as f32);
            let ix = px.floor() as i32;
            let mut d1 = f32::INFINITY;
            let mut d2 = f32::INFINITY;
            let mut best_id = 0.0f32;
            for oy in -1..=1 {
                for ox in -1..=1 {
                    let gx = ix + ox;
                    let gy = iy + oy;
                    let wx = gx.rem_euclid(cx);
                    let wy = gy.rem_euclid(cy);
                    let fx = (gx as f32) + 0.5 + (hash_f32(wx, wy, seed) - 0.5) * jit;
                    let fy = (gy as f32) + 0.5 + (hash_f32(wx, wy, seed ^ 0x9e37_79b9) - 0.5) * jit;
                    let dx = fx - px;
                    let dy = fy - py;
                    let dist = (dx * dx + dy * dy).sqrt();
                    if dist < d1 {
                        d2 = d1;
                        d1 = dist;
                        best_id = hash_f32(wx, wy, seed ^ 0x517c_c1b7);
                    } else if dist < d2 {
                        d2 = dist;
                    }
                }
            }
            let val = match mode {
                WorleyMode::F1 => d1.clamp(0.0, 1.0),
                WorleyMode::EdgeF2MinusF1 => (d2 - d1).clamp(0.0, 1.0),
                WorleyMode::CellId => best_id,
            };
            buf.data[(y * width + x) as usize] = val;
        }
    }
    Ok(buf)
}

/// Seamlessly tileable staggered brick/tile height field in `[0, 1]` with mortar bevel and per-brick jitter.
pub fn gen_brick(
    width: u32,
    height: u32,
    cols: u32,
    rows: u32,
    mortar: f32,
    bevel: f32,
    stagger: f32,
    seed: u32,
) -> Result<ImageBuffer, KernelError> {
    let mut buf = ImageBuffer::new(width, height, 1, 0.0)?;
    let c = cols.max(1) as f32;
    let r = rows.max(1) as f32;
    let m = mortar.clamp(0.0, 0.45);
    let bev = bevel.clamp(1e-4, 0.45);
    let inv_w = 1.0 / (width as f32);
    let inv_h = 1.0 / (height as f32);

    for y in 0..height {
        let v = (y as f32 + 0.5) * inv_h * r;
        let row = v.floor() as i32;
        let fv = v - (row as f32);
        let offset = if row.rem_euclid(2) != 0 { stagger } else { 0.0 };
        for x in 0..width {
            let u = (x as f32 + 0.5) * inv_w * c + offset;
            let col = u.floor() as i32;
            let fu = u - (col as f32);
            let du = fu.min(1.0 - fu);
            let dv = fv.min(1.0 - fv);
            let edge_dist = du.min(dv);
            let h = if edge_dist <= m {
                0.0
            } else {
                let t = ((edge_dist - m) / bev).clamp(0.0, 1.0);
                let smooth = t * t * (3.0 - 2.0 * t);
                let vary = 0.85
                    + 0.15
                        * hash_f32(
                            col.rem_euclid(cols.max(1) as i32),
                            row.rem_euclid(rows.max(1) as i32),
                            seed,
                        );
                smooth * vary
            };
            buf.data[(y * width + x) as usize] = h;
        }
    }
    Ok(buf)
}

/// Anisotropic brushed metal / streak pattern in `[0, 1]`.
pub fn gen_brushed(
    width: u32,
    height: u32,
    scale_u: u32,
    scale_v: u32,
    seed: u32,
) -> Result<ImageBuffer, KernelError> {
    gen_perlin_fbm(width, height, scale_u.max(1), scale_v.max(1), 4, 0.55, seed)
}

/// Procedural wood grain (warped rings + fine fibers) in `[0, 1]`.
pub fn gen_wood(
    width: u32,
    height: u32,
    rings: f32,
    warp: f32,
    seed: u32,
) -> Result<ImageBuffer, KernelError> {
    let mut buf = ImageBuffer::new(width, height, 1, 0.0)?;
    let fbm = gen_perlin_fbm(width, height, 4, 16, 4, 0.5, seed)?;
    let ring_freq = rings.max(1.0);
    let inv_w = 1.0 / (width as f32);

    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            let u = (x as f32 + 0.5) * inv_w;
            let n = fbm.data[i] - 0.5;
            let phase = (u * ring_freq + n * warp) * std::f32::consts::TAU;
            let grain = 0.5 + 0.5 * phase.sin();
            buf.data[i] = (grain * 0.75 + fbm.data[i] * 0.25).clamp(0.0, 1.0);
        }
    }
    Ok(buf)
}
