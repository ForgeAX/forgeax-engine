# Font fixtures

## NotoSansSC-Bold-subset.ttf

A static TrueType subset used by `font-outline.unit.test.ts`.

| Item | Value |
| --- | --- |
| Source | Noto Sans SC variable font, `NotoSansSC.ttf`, version 2.004-H2 (hotconv 1.0.118, makeotfexe 2.5.65603) |
| Instance | `wght=700` (Bold), pinned with `fontTools.varLib.instancer` |
| Subset text | `0-9`, `A-Z`, and the CJK characters 山 河 工 造 模 型 中 国 锻 铁 匠 印 章 板 牌 城 门 |
| Glyphs | 54 (cmap keys: 53 plus notdef) |
| Units per em | 1000 |
| Outlines | Simple glyphs only (no composites), quadratic TrueType |
| Tables | Layout features (GSUB, GPOS, GDEF), DSIG and FFTM dropped; hinting removed; no fvar or gvar |
| Size | 8668 bytes, sha256 `8f8756cf0946b4167d5893d2a7f84b7e52ca497811fe68f33dec7d6f669aaebf` |

### Name table and OS/2 changes

The instance keeps the upstream copyright (name ID 0) and the Reserved Font Name
statement, as required by the licence. Family and full names are changed to
`Noto Sans SC Bold Subset` (IDs 1 and 4), the subfamily to `Regular` (ID 2), the
unique identifier and PostScript name to `NotoSansSC-Bold-Subset` (IDs 3 and 6),
and `usWeightClass` is 700.

### Licence

The font is licensed under the SIL Open Font License 1.1. The full licence text is
in `NotoSansSC-OFL.txt`. Redistribution of this subset must keep that file and the
copyright line in name ID 0.

## NotoSansSC-OFL.txt

Verbatim SIL Open Font License 1.1 from the Noto Sans SC distribution.

## font-reference.json

Reference data produced by `generate-font-reference.py` from the subset file. It
holds fontTools facts (advance, bounds, signed area, contour count, hole count,
vertical metrics) for `0 8 A 山 门` and an 80 by 80 nonzero-winding raster over
x in [0, 1] and y in [-0.2, 1.0], rows listed from top to bottom.

The raster uses the TrueType nonzero winding rule. Noto's `A` has a crossbar contour
that overlaps the legs and has the same orientation as the outer loop, so an even-odd
fill would punch a counter that the font does not contain.

## Reproduction

```sh
# from a directory with fontTools and numpy visible to python3 -I
python3 -I src/__tests__/fixtures/generate-font-reference.py \
  src/__tests__/fixtures/NotoSansSC-Bold-subset.ttf \
  src/__tests__/fixtures/font-reference.json
```

The subset was produced from the Noto Sans SC variable font with the two scripts below.
They are working scripts outside the repository and are recorded here for review:

```sh
python3 -I make.py   # instancer wght=700, then subset to the text above
python3 -I rename.py # name IDs 1/2/3/4/6 and usWeightClass
```

where `make.py` calls `instancer.instantiateVariableFont(font, {'wght': 700})`
and `subset.Subsetter` with `layout_features = []`, `hinting = False`, and the
dropped tables listed above.
