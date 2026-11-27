import { FrameSet, popcount } from './frame-set';
import { nodes } from './frame-tree';
import type { SceneSlotFrame } from './scene-slots';

// Four words per 32 input ranks. Prefix counts address the selected draw
// sequence. Display rejection is separate: an offscreen caster can still draw.
const STRIDE = 4;
const ADMITTED = 0;
const SHADOW_ONLY = 1;
const FIRST_RANK = 2;
const CAMERA_HIDDEN = 3;

export class CullProjection {
  private readonly words: Uint32Array;
  constructor(readonly capacity: number) {
    this.words = new Uint32Array(Math.ceil(capacity / 32) * STRIDE);
  }

  reset(rows: number): void {
    this.words.fill(0, 0, Math.ceil(rows / 32) * STRIDE);
  }

  admit(index: number, shadowOnly: boolean): void {
    const base = (index >>> 5) * STRIDE;
    const bit = 1 << (index & 31);
    this.words[base + ADMITTED] = (this.words[base + ADMITTED] as number) | bit;
    if (shadowOnly)
      this.words[base + SHADOW_ONLY] = (this.words[base + SHADOW_ONLY] as number) | bit;
  }

  hide(index: number): void {
    const at = (index >>> 5) * STRIDE + CAMERA_HIDDEN;
    this.words[at] = (this.words[at] as number) | (1 << (index & 31));
  }

  /** Prefixes are complete before any dispatch reads them. Only the two draw
   * masks affect address equality; camera membership is published independently. */
  finish(rows: number, previous: CullProjection | undefined): boolean {
    let count = 0;
    let same = previous !== undefined;
    const end = Math.ceil(rows / 32) * STRIDE;
    for (let base = 0; base < end; base += STRIDE) {
      const selected = this.words[base + ADMITTED] as number;
      this.words[base + FIRST_RANK] = count;
      count += popcount(selected);
      if (
        same &&
        previous &&
        (selected !== previous.words[base + ADMITTED] ||
          this.words[base + SHADOW_ONLY] !== previous.words[base + SHADOW_ONLY])
      )
        same = false;
    }
    return same;
  }

  address(index: number, shadow: boolean): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.capacity) return -1;
    const base = (index >>> 5) * STRIDE;
    const bit = 1 << (index & 31);
    const selected = this.words[base + ADMITTED] as number;
    if (!(selected & bit) || (!shadow && (this.words[base + SHADOW_ONLY] as number) & bit))
      return -1;
    return (this.words[base + FIRST_RANK] as number) + popcount(selected & (bit - 1));
  }

  /** Expand masks over occupied lanes only. Published sets own their physical
   * words; the view may immediately reuse the rank storage for a later frame. */
  slots(source: SceneSlotFrame, hidden: boolean): FrameSet {
    const channel = hidden ? CAMERA_HIDDEN : ADMITTED;
    return FrameSet.fromOrderedWords((write) => {
      // In a fully occupied domain a rank word is already a physical slot word.
      if (source.capacity === source.length) {
        const end = Math.ceil(source.length / 32);
        for (let word = 0; word < end; word++) {
          const value = this.words[word * STRIDE + channel] as number;
          if (value !== 0) write(word, value);
        }
        return;
      }
      let rank = 0;
      for (const page of nodes(source.root)) {
        for (let half = 0; half < 2; half++) {
          const occupied = (half === 0 ? page.value.lowMask : page.value.highMask) >>> 0;
          if (!occupied) continue;
          const base = (rank >>> 5) * STRIDE + channel;
          const shift = rank & 31;
          const count = popcount(occupied);
          let selected = (this.words[base] as number) >>> shift;
          if (shift + count > 32) selected |= (this.words[base + STRIDE] as number) << (32 - shift);
          rank += count;
          const mask = 0xffffffff >>> (32 - count);
          selected = (selected & mask) >>> 0;
          if (!selected) continue;
          let physical = selected;
          if (selected === mask) physical = occupied;
          else if (count !== 32) {
            physical = 0;
            let remaining = occupied;
            while (selected) {
              if (selected & 1) physical |= remaining & -remaining;
              remaining &= remaining - 1;
              selected >>>= 1;
            }
          }
          write(page.key * 2 + half, physical >>> 0);
        }
      }
    });
  }
}
