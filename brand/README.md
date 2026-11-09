# CatSim logo

**Idea:** a cat made of code: an outlined `<` with an ear and an eye, then a `/` that turns into a solid half-head.
Its whiskers are circuit traces ending in solder pads, and its eye is a via, so the cat lives on a circuit board.

## Files

| File | Use |
|---|---|
| `catsim-symbol.svg` | The mark, full colour, light backgrounds. 48 px and up. |
| `catsim-symbol-on-dark.svg` | The mark on dark backgrounds (light bracket). |
| `catsim-symbol-small.svg` / `-small-on-dark.svg` | Small-size cut for 16 to 47 px: solid head, eye knocked out, no traces. |
| `catsim-horizontal.svg` / `-on-dark.svg` | Mark and wordmark side by side: README headers, social cards, slides. |
| `catsim-horizontal-black.svg` / `-white.svg` / `-mono-ff9f5f.svg` | One-colour versions for print, stamps and embroidery (PNGs at 1200 px next to them). |
| `catsim-wordmark.svg` | Name only, for where the mark already appears nearby. |
| `web/` | Favicon (ICO, SVG, PNG 16/32/48), apple-touch icon, 192/512 and maskable icons, web manifest, `<head>` snippet. These are copied into `public/`. |

## Colours

| | HEX | RGB | Use |
|---|---|---|---|
| Ember orange | `#FF9F5F` | 255 159 95 | Ear, eye, solid half, "Sim" in the wordmark |
| Ink | `#2B2B2B` | 43 43 43 | Bracket, "Cat" in the wordmark |
| Paper | `#F4EFE9` | 244 239 233 | Bracket and "Cat" on dark backgrounds |
| Icon tile | `#FFF4EC` | 255 244 236 | App-icon background |

For orange **text** in the UI, use `#F08A3E`, a shade deeper. `#FF9F5F` on white is fine for the mark but too light for body text.

## Rules

- **Clear space:** keep at least the height of the left ear (28 units on the 256 grid) empty around the mark.
- **Minimum size:** the full mark at 48 px wide. Below that, use the small cut. The wordmark should be at least 16 px tall.
- **Backgrounds:** use the light versions on white or light greys, and the `-on-dark` versions on dark greys and black. On photos or busy backgrounds, use one-colour white or black.
- **Don't:** recolour the parts (the bracket stays ink or paper, the cat stays orange); rotate or skew it; add shadows, outlines or gradients; redraw the traces; set the name in another font next to the mark.

## Construction

Everything sits on a 256 grid. The brackets are 45°. The slash runs at 2:1, the slope of a typed `/`, and its tip forms the right ear. Strokes are 12 units (the bracket) and 14 units (the wordmark). Both ears are 28 units tall. The wordmark is drawn by hand as paths, with 45° chamfers like the mark, so it needs no font licence.

`generate.py` regenerates the master SVGs (`python3 brand/generate.py`). Edit the geometry there, not in the SVGs. The variants in `web/` and the one-colour files were exported from the masters with the logo-design skill's `export_variants.py`. If you change the mark, re-export them and copy the web icons into `public/`. The header in `index.html` inlines `catsim-symbol.svg`, so update that too.

No trademark search has been done. Run one before registering the mark.
