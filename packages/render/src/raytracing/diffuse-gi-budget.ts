/** One field consumer's per-frame claim: the Renderer frame and its view focus. */
interface DiffuseGiClaim {
  frame: number;
  focus: readonly [number, number, number];
}

/**
 * Renderer-owned split of the per-frame diffuse GI budgets across the CameraViews
 * that run a field. Each field claims the Renderer frame with its view focus before
 * scheduling; the roster is every field that claimed this or the previous frame,
 * in first-claim order. A budget `B` splits equally: `floor(B / N)` each, the
 * remainder rotating by frame so no view always loses it, and never below one.
 * The split is deterministic and needs no GPU feedback.
 */
export class DiffuseGiBudget {
  readonly #claims = new Map<object, DiffuseGiClaim>();
  #frame = 0;

  /** Records `owner` as active in Renderer frame `frame` with view focus `focus`. */
  claim(owner: object, frame: number, focus: readonly [number, number, number]): void {
    this.#frame = Math.max(this.#frame, frame);
    const claim = this.#claims.get(owner);
    if (claim === undefined) this.#claims.set(owner, { frame, focus });
    else {
      claim.frame = frame;
      claim.focus = focus;
    }
  }

  release(owner: object): void {
    this.#claims.delete(owner);
  }

  #roster(): object[] {
    const out: object[] = [];
    for (const [owner, claim] of this.#claims) if (claim.frame >= this.#frame - 1) out.push(owner);
    return out;
  }

  /** `owner`'s share of `total`; an unclaimed owner gets the whole budget. */
  share(owner: object, total: number): number {
    const roster = this.#roster();
    const index = roster.indexOf(owner);
    const n = roster.length;
    if (index < 0 || n <= 1) return total;
    const base = Math.floor(total / n);
    const turn = (((index - this.#frame) % n) + n) % n;
    return Math.max(1, base + (turn < total % n ? 1 : 0));
  }

  /** Every active view focus, in roster order: residency ranks against all of them. */
  focuses(): readonly (readonly [number, number, number])[] {
    return this.#roster().flatMap((owner) => {
      const claim = this.#claims.get(owner);
      return claim === undefined ? [] : [claim.focus];
    });
  }

  /** Active field consumers this frame. */
  get views(): number {
    return this.#roster().length;
  }
}
