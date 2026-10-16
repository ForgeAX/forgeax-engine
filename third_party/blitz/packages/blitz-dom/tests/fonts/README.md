# Deterministic headless test font

`dejavu-sans-ascii.ttf` contains U+0020 through U+007E from DejaVu Sans 2.37.
The adjacent [LICENSE](LICENSE) retains the DejaVu and Bitstream notices.
The subset is for layout, editing and pixel regressions without system-font access;
it does not establish non-ASCII coverage.

Reproduce with fonttools 4.60.1 and the distribution's unmodified DejaVuSans.ttf:

```sh
python -m fontTools.subset /path/to/DejaVuSans.ttf \
  --output-file=dejavu-sans-ascii.ttf --unicodes=U+0020-007E
```
