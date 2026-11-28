//! Chart- and owner-aware 2D UV atlas dilation and mip-bleed diagnostics.

pub const UNOWNED: i32 = -1;
pub const MIXED: i32 = -2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AtlasGrid {
    pub width: u32,
    pub height: u32,
    pub wrap_u: bool,
    pub wrap_v: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AtlasBleedReport {
    pub levels: Vec<u32>,
    pub protect_mip: u32,
    pub protected_bleed: u32,
    pub pass: bool,
}

pub struct AtlasBufferMut<'a> {
    pub data: &'a mut [f32],
    pub categorical: bool,
}

#[inline]
pub fn atlas_neighbor(x: i32, y: i32, grid: AtlasGrid) -> i32 {
    let w = grid.width as i32;
    let h = grid.height as i32;
    if w <= 0 || h <= 0 {
        return -1;
    }
    let xi = if x < 0 || x >= w {
        if !grid.wrap_u {
            return -1;
        }
        x.rem_euclid(w)
    } else {
        x
    };
    let yi = if y < 0 || y >= h {
        if !grid.wrap_v {
            return -1;
        }
        y.rem_euclid(h)
    } else {
        y
    };
    yi * w + xi
}

/// Most common frame among covered 8-neighbors of `idx` (ties break by smallest neighbor order).
pub fn dominant_source(idx: usize, covered: &[u8], source: &[i32], grid: AtlasGrid) -> i32 {
    let w = grid.width as i32;
    let x = (idx as i32) % w;
    let y = (idx as i32 - x) / w;
    let mut best = -1i32;
    let mut best_count = 0u32;
    let mut seen: [(i32, u32); 9] = [(-1, 0); 9];
    let mut seen_len = 0usize;

    for dy in -1..=1 {
        for dx in -1..=1 {
            let j = atlas_neighbor(x + dx, y + dy, grid);
            if j < 0 || covered[j as usize] != 1 {
                continue;
            }
            let s = source[j as usize];
            if s < 0 {
                continue;
            }
            let mut found = None;
            for slot in &mut seen[..seen_len] {
                if slot.0 == s {
                    slot.1 += 1;
                    found = Some(slot.1);
                    break;
                }
            }
            let count = if let Some(c) = found {
                c
            } else {
                seen[seen_len] = (s, 1);
                seen_len += 1;
                1
            };
            if count > best_count {
                best = s;
                best_count = count;
            }
        }
    }
    best
}

/// Dilate RGBA f32 atlas channels into `gutter` rings of empty texels, preserving
/// chart boundaries (`owner`) and fine source frames (`frame`), without smoothing categorical buffers.
pub fn dilate_atlas(
    buffers: &mut [AtlasBufferMut<'_>],
    covered: &mut [u8],
    owner: &mut [i32],
    frame: &[i32],
    grid: AtlasGrid,
    gutter: u32,
) {
    let texels = (grid.width as usize) * (grid.height as usize);
    if texels == 0 || gutter == 0 {
        return;
    }
    let w = grid.width as i32;
    let mut seen = vec![-1i32; texels];
    let mut source = frame.to_vec();
    let mut frontier = Vec::with_capacity(texels / 4);
    for (i, &c) in covered.iter().enumerate().take(texels) {
        if c == 1 {
            frontier.push(i);
        }
    }

    for pass in 0..(gutter as i32) {
        if frontier.is_empty() {
            break;
        }
        let mut fresh = Vec::new();
        for &i in &frontier {
            let x = (i as i32) % w;
            let y = (i as i32 - x) / w;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let j = atlas_neighbor(x + dx, y + dy, grid);
                    if j < 0 {
                        continue;
                    }
                    let ju = j as usize;
                    if covered[ju] == 1 || seen[ju] == pass {
                        continue;
                    }
                    seen[ju] = pass;
                    fresh.push(ju);
                }
            }
        }
        fresh.sort_unstable();
        for &i in &fresh {
            let x = (i as i32) % w;
            let y = (i as i32 - x) / w;
            let mut chart = UNOWNED;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let j = atlas_neighbor(x + dx, y + dy, grid);
                    if j < 0 || covered[j as usize] != 1 {
                        continue;
                    }
                    let o = owner[j as usize];
                    chart = if chart == UNOWNED {
                        o
                    } else if chart == o {
                        chart
                    } else {
                        MIXED
                    };
                }
            }
            owner[i] = chart;
        }
        for &i in &fresh {
            source[i] = dominant_source(i, covered, &source, grid);
        }
        for buf in buffers.iter_mut() {
            let categorical = buf.categorical;
            for &i in &fresh {
                let x = (i as i32) % w;
                let y = (i as i32 - x) / w;
                let mut acc = [0.0f32; 4];
                let mut n = 0u32;
                let target_src = source[i];
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let j = atlas_neighbor(x + dx, y + dy, grid);
                        if j < 0 {
                            continue;
                        }
                        let ju = j as usize;
                        if covered[ju] != 1 || source[ju] != target_src || (categorical && n > 0) {
                            continue;
                        }
                        n += 1;
                        let base = ju * 4;
                        acc[0] += buf.data[base];
                        acc[1] += buf.data[base + 1];
                        acc[2] += buf.data[base + 2];
                        acc[3] += buf.data[base + 3];
                    }
                }
                if n > 0 {
                    let inv = 1.0 / (n as f32);
                    let dst = i * 4;
                    buf.data[dst] = acc[0] * inv;
                    buf.data[dst + 1] = acc[1] * inv;
                    buf.data[dst + 2] = acc[2] * inv;
                    buf.data[dst + 3] = acc[3] * inv;
                }
            }
        }
        for &i in &fresh {
            covered[i] = 1;
        }
        frontier = fresh;
    }
}

/// Mip bleed (V4): per mip level 1.., count blocks containing a chart texel together with
/// a different chart owner, a MIXED gutter texel, or background.
pub fn mip_bleed(owner: &[i32], chart: &[u8], grid: AtlasGrid) -> Vec<u32> {
    let mut out = Vec::new();
    let mut w = grid.width as usize;
    let mut h = grid.height as usize;
    let mut own = owner.to_vec();
    let mut has = chart.to_vec();

    while w > 1 || h > 1 {
        let lw = (w >> 1).max(1);
        let lh = (h >> 1).max(1);
        let mut next = vec![0i32; lw * lh];
        let mut next_has = vec![0u8; lw * lh];
        let mut bleeding = 0u32;
        for y in 0..lh {
            for x in 0..lw {
                let mut o: Option<i32> = None;
                let mut any = 0u8;
                for dy in 0..=1 {
                    for dx in 0..=1 {
                        let sx = (x * 2 + dx).min(w - 1);
                        let sy = (y * 2 + dy).min(h - 1);
                        let value = own[sy * w + sx];
                        o = match o {
                            None => Some(value),
                            Some(cur) if cur == value => Some(cur),
                            Some(_) => Some(MIXED),
                        };
                        any |= has[sy * w + sx];
                    }
                }
                let raw = o.unwrap_or(UNOWNED);
                let merged = if raw == UNOWNED && any == 1 {
                    MIXED
                } else {
                    raw
                };
                next[y * lw + x] = merged;
                next_has[y * lw + x] = any;
                if any == 1 && merged < 0 {
                    bleeding += 1;
                }
            }
        }
        out.push(bleeding);
        own = next;
        has = next_has;
        w = lw;
        h = lh;
    }
    out
}

pub fn atlas_bleed_report(
    owner: &[i32],
    chart: &[u8],
    grid: AtlasGrid,
    protect_mip: Option<u32>,
) -> AtlasBleedReport {
    let pm = protect_mip.unwrap_or_else(|| {
        let min_side = grid.width.min(grid.height);
        let mut k = 0u32;
        while (min_side as f64) / ((1u64 << (k + 1)) as f64) >= 128.0 {
            k += 1;
        }
        k
    });
    let levels = mip_bleed(owner, chart, grid);
    let protected_bleed: u32 = levels.iter().take(pm as usize).copied().sum();
    AtlasBleedReport {
        levels,
        protect_mip: pm,
        protected_bleed,
        pass: protected_bleed == 0,
    }
}
