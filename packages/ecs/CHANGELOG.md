# @forgeax/engine-ecs changelog

All notable package changes are recorded here. The package follows semantic versioning.

## Unreleased

### Changed

- Query construction is now `world.query(descriptor)`. A Query is an iterable of transient
  `QueryRow` facades and owns an independent change-observation cursor.
- Query descriptors separate data access (`read`, `write`, and `optional`) from presence and
  observation filters (`with`, `without`, `changed`, and `added`).
- Systems and system parameters receive persistent Query tuples. Query results are no longer
  pre-collected before a system runs.
- Dense, table-only queries expose zero-copy TypedArray ranges through `query.spans()`.
  Unsupported descriptors return the structured `query-span-unavailable` error.
- `query.combinations(k)` derives unordered combinations from the same matching and observation
  pipeline.
- Archetype identity and physical storage are separate owners. Archetypes contain the complete
  logical component set and map their rows into shared SoA Tables.
- Component and resource change evidence is mutation-owned. Added and changed epochs travel with
  their storage rows through grow, migration, and swap-pop.

### Added

- `defineComponent(..., { storage: 'sparse' })` declares a zero-field sparse tag. Archetypes that
  differ only by sparse tags share one Table, so flipping the tag does not migrate table data.
- `world.inspect()` reports logical Archetypes and physical Tables separately.
- Query creation and iteration expose structured descriptor, span-capability, re-entry, and
  structural-invalidation errors.

### Removed

- The bundle-first query surface, including `queryRun`, `queryRunContiguous`, `createQueryState`,
  `QueryState`, `ColumnBundle`, and `NestedColumnBundle`.
- Direct Archetype column ownership and the World-level component change maps.

### Migration

```ts
const moving = world.query({ read: [Velocity], write: [Position] }).unwrap();
for (const row of moving) {
  row.mut(Position).x += row.get(Velocity).x;
}
```

Use `with` and `without` for zero-field tags. Use `row.entity` for identity. Choose
`query.spans()` only when the descriptor is dense and table-only; do not implement a copied-row
fallback for span rejection.
