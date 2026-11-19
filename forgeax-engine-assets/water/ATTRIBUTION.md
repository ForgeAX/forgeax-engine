# Water authored image sources

These eight files retain the exact bytes previously tracked at
`packages/content/assets/water` in Engine commit
`6c83ab355b316572315f6c6b0c5e6238a28d6e97`. They were moved into the existing
binary asset repository on November 14, 2026, to satisfy Engine's source asset
policy. No image was regenerated, renamed or recompressed.

`provenance.json` retains the original upstream identity, source paths, byte hashes,
volume atlas conversion and known source settings. `LICENSE.water.txt` retains
the original copyright and license record. Independent redistribution permission
remains unverified; this migration establishes no new permission.

Engine Content owns the unchanged Meta, GUID and Pack sources. Its
`scripts/prepare-water-content.mjs` verifies every declared SHA256 before copying
the pinned images back beside those sources. SDK source snapshots retain their
explicitly declared, sealed Content resource closure.
