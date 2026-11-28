//! O(1)-reset frame bump arena and typed scratch pools for zero per-frame heap churn.

#[derive(Default)]
pub struct FrameBumpArena {
    pub u32_words: Vec<u32>,
    pub u64_words: Vec<u64>,
    pub f32_words: Vec<f32>,
    pub bytes: Vec<u8>,
}

impl FrameBumpArena {
    pub fn with_capacity(u32_cap: usize, u64_cap: usize, f32_cap: usize, byte_cap: usize) -> Self {
        Self {
            u32_words: Vec::with_capacity(u32_cap),
            u64_words: Vec::with_capacity(u64_cap),
            f32_words: Vec::with_capacity(f32_cap),
            bytes: Vec::with_capacity(byte_cap),
        }
    }

    /// Resets all cursors to zero while keeping backing capacity resident.
    #[inline]
    pub fn reset(&mut self) {
        self.u32_words.clear();
        self.u64_words.clear();
        self.f32_words.clear();
        self.bytes.clear();
    }

    #[inline]
    pub fn alloc_u32_range(&mut self, len: usize) -> std::ops::Range<usize> {
        let start = self.u32_words.len();
        self.u32_words.resize(start + len, 0);
        start..start + len
    }

    #[inline]
    pub fn push_u32_slice(&mut self, slice: &[u32]) -> std::ops::Range<usize> {
        let start = self.u32_words.len();
        self.u32_words.extend_from_slice(slice);
        start..self.u32_words.len()
    }

    #[inline]
    pub fn push_bytes_aligned(&mut self, data: &[u8], align: usize) -> usize {
        let mask = align.saturating_sub(1);
        let aligned = (self.bytes.len() + mask) & !mask;
        if aligned > self.bytes.len() {
            self.bytes.resize(aligned, 0);
        }
        let offset = self.bytes.len();
        self.bytes.extend_from_slice(data);
        offset
    }
}
