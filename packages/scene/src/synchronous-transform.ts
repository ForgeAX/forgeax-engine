let publication = 0;

/** Validity of an immediately readable local/world transform pair.
 *
 * A write to a derived matrix never invalidates its local inputs. Callers own
 * their storage and supply the same composition kernel for both immediate and
 * scheduled consumers. An unobserved parent supplies no reuse evidence.
 */
export class SynchronousTransform {
  private localDirty = true;
  private worldDirty = true;
  private parent: SynchronousTransform | null | undefined;
  private parentVersion = 0;
  private published = 0;

  get revision(): number {
    return this.published;
  }

  constructor(
    private readonly composeLocal: () => void,
    private readonly composeWorld: () => void,
  ) {}

  invalidateLocal(): void {
    this.localDirty = true;
    this.worldDirty = true;
  }

  /** An external matrix write is immediately visible to a child that is
   * explicitly updated without refreshing its parents. */
  replaceWorld(): void {
    this.worldDirty = true;
    this.published = ++publication;
  }

  resolveLocal(): void {
    if (!this.localDirty) return;
    this.composeLocal();
    this.localDirty = false;
  }

  resolve(parent: SynchronousTransform | null | undefined): boolean {
    this.resolveLocal();
    if (
      parent !== undefined &&
      !this.worldDirty &&
      this.parent === parent &&
      this.parentVersion === (parent?.published ?? 0)
    )
      return false;
    this.composeWorld();
    this.worldDirty = false;
    this.parent = parent;
    this.parentVersion = parent?.published ?? 0;
    this.published = ++publication;
    return true;
  }
}
