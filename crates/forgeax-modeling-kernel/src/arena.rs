//! Generational arena for safe retained kernel handles across FFI boundaries.

/// Opaque 64-bit generational handle: low 32 bits = slot index, high 32 bits = generation (>= 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Handle(pub u64);

impl Handle {
    pub const INVALID: Handle = Handle(0);

    #[inline]
    pub fn new(index: u32, generation: u32) -> Self {
        Handle(((generation as u64) << 32) | (index as u64))
    }

    #[inline]
    pub fn index(self) -> usize {
        (self.0 & 0xffff_ffff) as usize
    }

    #[inline]
    pub fn generation(self) -> u32 {
        (self.0 >> 32) as u32
    }

    #[inline]
    pub fn is_valid(self) -> bool {
        self.generation() != 0
    }
}

struct Slot<T> {
    generation: u32,
    value: Option<T>,
}

/// Slot-reusing generational arena. Freed slots increment generation so stale handles fail cleanly.
pub struct Arena<T> {
    slots: Vec<Slot<T>>,
    free: Vec<u32>,
    live: usize,
}

impl<T> Default for Arena<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Arena<T> {
    pub fn new() -> Self {
        Self {
            slots: Vec::new(),
            free: Vec::new(),
            live: 0,
        }
    }

    pub fn insert(&mut self, value: T) -> Handle {
        self.live += 1;
        if let Some(index) = self.free.pop() {
            let slot = &mut self.slots[index as usize];
            slot.value = Some(value);
            return Handle::new(index, slot.generation);
        }
        let index = self.slots.len() as u32;
        self.slots.push(Slot {
            generation: 1,
            value: Some(value),
        });
        Handle::new(index, 1)
    }

    pub fn get(&self, handle: Handle) -> Option<&T> {
        if !handle.is_valid() {
            return None;
        }
        let slot = self.slots.get(handle.index())?;
        if slot.generation != handle.generation() {
            return None;
        }
        slot.value.as_ref()
    }

    pub fn get_mut(&mut self, handle: Handle) -> Option<&mut T> {
        if !handle.is_valid() {
            return None;
        }
        let slot = self.slots.get_mut(handle.index())?;
        if slot.generation != handle.generation() {
            return None;
        }
        slot.value.as_mut()
    }

    pub fn remove(&mut self, handle: Handle) -> Option<T> {
        if !handle.is_valid() {
            return None;
        }
        let index = handle.index();
        let slot = self.slots.get_mut(index)?;
        if slot.generation != handle.generation() {
            return None;
        }
        let removed = slot.value.take()?;
        slot.generation = slot.generation.wrapping_add(1).max(1);
        self.free.push(index as u32);
        self.live -= 1;
        Some(removed)
    }

    pub fn live_count(&self) -> usize {
        self.live
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_rejects_stale_handles_after_removal_and_reuse() {
        let mut arena = Arena::new();
        let h1 = arena.insert(10u32);
        assert_eq!(arena.live_count(), 1);
        assert_eq!(arena.get(h1), Some(&10));
        assert_eq!(arena.remove(h1), Some(10));
        assert_eq!(arena.live_count(), 0);
        assert_eq!(arena.get(h1), None);

        let h2 = arena.insert(20u32);
        assert_eq!(h2.index(), h1.index());
        assert_ne!(h2.generation(), h1.generation());
        assert_eq!(arena.get(h1), None);
        assert_eq!(arena.get(h2), Some(&20));
    }
}
