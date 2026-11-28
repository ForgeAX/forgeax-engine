//! 32-bit generational handles (`generation:12 | slot:20`, `0` = invalid).

pub const INVALID_HANDLE: u32 = 0;
pub const SLOT_BITS: u32 = 20;
pub const SLOT_MASK: u32 = (1 << SLOT_BITS) - 1;
pub const GEN_MASK: u32 = 0x0FFF;

#[inline]
pub const fn pack_handle(slot: u32, generation: u32) -> u32 {
    ((generation & GEN_MASK) << SLOT_BITS) | (slot & SLOT_MASK)
}

#[inline]
pub const fn handle_slot(handle: u32) -> usize {
    (handle & SLOT_MASK) as usize
}

#[inline]
pub const fn handle_generation(handle: u32) -> u32 {
    (handle >> SLOT_BITS) & GEN_MASK
}

#[inline]
pub const fn next_generation(gen: u32) -> u32 {
    let n = (gen + 1) & GEN_MASK;
    if n == 0 { 1 } else { n }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandleError {
    Invalid,
    StaleGeneration,
    AlreadyDestroyed,
    CapacityExceeded,
}

struct SlotEntry<T> {
    generation: u32,
    value: Option<T>,
}

/// Contiguous generational slot table with O(1) lookup, insert, and remove.
pub struct SlotTable<T> {
    entries: Vec<SlotEntry<T>>,
    free_list: Vec<u32>,
    live_count: usize,
}

impl<T> Default for SlotTable<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> SlotTable<T> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            free_list: Vec::new(),
            live_count: 0,
        }
    }

    pub fn with_capacity(cap: usize) -> Self {
        Self {
            entries: Vec::with_capacity(cap),
            free_list: Vec::new(),
            live_count: 0,
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.live_count
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.live_count == 0
    }

    pub fn insert(&mut self, value: T) -> Result<u32, HandleError> {
        if let Some(slot) = self.free_list.pop() {
            let entry = &mut self.entries[slot as usize];
            entry.value = Some(value);
            self.live_count += 1;
            return Ok(pack_handle(slot, entry.generation));
        }
        if self.entries.len() > SLOT_MASK as usize {
            return Err(HandleError::CapacityExceeded);
        }
        let slot = self.entries.len() as u32;
        self.entries.push(SlotEntry {
            generation: 1,
            value: Some(value),
        });
        self.live_count += 1;
        Ok(pack_handle(slot, 1))
    }

    pub fn get(&self, handle: u32) -> Result<&T, HandleError> {
        if handle == INVALID_HANDLE {
            return Err(HandleError::Invalid);
        }
        let slot = handle_slot(handle);
        let gen = handle_generation(handle);
        let entry = self.entries.get(slot).ok_or(HandleError::Invalid)?;
        if entry.generation != gen {
            return Err(HandleError::StaleGeneration);
        }
        entry.value.as_ref().ok_or(HandleError::AlreadyDestroyed)
    }

    pub fn get_mut(&mut self, handle: u32) -> Result<&mut T, HandleError> {
        if handle == INVALID_HANDLE {
            return Err(HandleError::Invalid);
        }
        let slot = handle_slot(handle);
        let gen = handle_generation(handle);
        let entry = self.entries.get_mut(slot).ok_or(HandleError::Invalid)?;
        if entry.generation != gen {
            return Err(HandleError::StaleGeneration);
        }
        entry.value.as_mut().ok_or(HandleError::AlreadyDestroyed)
    }

    pub fn remove(&mut self, handle: u32) -> Result<T, HandleError> {
        if handle == INVALID_HANDLE {
            return Err(HandleError::Invalid);
        }
        let slot = handle_slot(handle);
        let gen = handle_generation(handle);
        let entry = self.entries.get_mut(slot).ok_or(HandleError::Invalid)?;
        if entry.generation != gen {
            return Err(HandleError::StaleGeneration);
        }
        let val = entry.value.take().ok_or(HandleError::AlreadyDestroyed)?;
        entry.generation = next_generation(entry.generation);
        self.free_list.push(slot as u32);
        self.live_count -= 1;
        Ok(val)
    }

    pub fn iter(&self) -> impl Iterator<Item = (u32, &T)> {
        self.entries.iter().enumerate().filter_map(|(i, e)| {
            e.value
                .as_ref()
                .map(|v| (pack_handle(i as u32, e.generation), v))
        })
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.free_list.clear();
        self.live_count = 0;
    }

    pub fn for_each_live_mut(&mut self, mut f: impl FnMut(u32, &mut T)) {
        for (slot, entry) in self.entries.iter_mut().enumerate() {
            if let Some(val) = entry.value.as_mut() {
                f(pack_handle(slot as u32, entry.generation), val);
            }
        }
    }
}
