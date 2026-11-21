# repath brand

The identity of repath: the mark, the name, the colours, and the rules for using them.

Open `index.html` for the guidelines.

| Folder | What |
| --- | --- |
| `logo/` | Mark and name on one line: colour for dark grounds, `-day` for light ones, `-ink`, `-paper`, `-current` |
| `mark/` | The r alone, in the same five colourings |
| `icon/` | The r on its tile: dark, light, and the small cut for 32 px and under |
| `wordmark/` | The name alone |
| `favicon/` | `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` |
| `social/` | `og.png` (1200 x 630) and `avatar-512.png` |
| `tools/` | The scripts that build every file from the one drawing |

## In short

- The mark is a lowercase r whose arm is a step response: it rises, overshoots, rings and settles.
- Two colours: Signal blue `#4ea8ff` and Settled green `#7fe3a0` on dark grounds, `#1f7fe0` and `#17a35a` on light ones.
- The name is always `repath`, lowercase. Geist, weight 600, tracking -0.035 em.
- At 32 px and under, use the small cut (`icon/repath-icon-small.svg`, `favicon/favicon.svg`).

## Rebuild

Both scripts take what they need from the app in `web/`, so install its dependencies first:

```sh
(cd web && npm ci)
cd brand
python -I tools/build.py   # the vector files
node tools/make.cjs        # the PNG and ICO files, and index.html
```

`build.py` needs `fonttools`, `uharfbuzz` and `brotli`, and reads Geist from
`web/node_modules/@fontsource-variable/geist`, the same font the app self-hosts. `make.cjs` drives a
headless Chromium through the `playwright` package in `web/node_modules`; if Playwright has no browser
yet, `npx playwright install chromium` in `web/` fetches one.

The files the app serves are copies: after a rebuild, copy `favicon/favicon.svg` over
`web/src/lib/assets/favicon.svg`, and the PNG and ICO files and `social/og.png` into `web/static/`.
