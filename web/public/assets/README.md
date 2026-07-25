# Assets

Permissive licences only, per PLAN.md. Record provenance here as assets are added.

| File | Source | Licence | Measured metadata |
|---|---|---|---|
| `sheen-chair.glb` | [Khronos glTF-Sample-Assets — SheenChair](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SheenChair) © 2020 Wayfair, LLC (Eric Chadwick) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | extent 0.83 × 0.69 × 0.57 m, floor anchor, front `+Z` |

The model origin sits ~8 mm off the geometric centre in depth, so wall-seated
placement leaves a corresponding gap. Real catalog ingest has to normalise origins;
that is M2 work, not a spike concern.

## Models (curated catalog)

Furniture is **curated, not fetched from a live warehouse** (PLAN.md §5). Masters
are dropped into `web/assets-src/` (committed — they're the irreplaceable inputs),
described in `scripts/tags.json`, and normalised into `models/` (gitignored, like
textures). The committed index is `catalog.json`: the metadata the constraint solver
reads (real-world dims, anchor, front vector, clearance, licence, provenance).

Pipeline (`web/scripts/`), file-based and source-agnostic:

1. Drop a `.glb` master in `assets-src/` and add an entry to `tags.json` — the manual step: provenance (source/licence/attribution) plus geometry tags (real-world size + which axis, front yaw, anchor). **Sanity-check the *derived* dims, not just the one you type** (keying the round table on height first back-computed a 2.1 m diameter; re-keying on diameter fixed it).
2. `npm run ingest:build` — normalise each master (orient front→+Z, scale to real size *or* keep native scale if `sizeMeters` omitted, recenter origin to base-centre, meshopt-compress) and write `catalog.json`.

`npm run ingest:selftest` validates the normaliser on `sheen-chair.glb`.

For OBJ sources (e.g. the Kenney kit), `npm run ingest:kenney` extracts the kit zip
from `assets-src/_kenney/` (gitignored), keyword-matches a set, converts OBJ→GLB
([obj2gltf](https://github.com/CesiumGS/obj2gltf), Apache-2.0), and merges tag entries
— then `ingest:build` finishes. Same drop-in flow ingests supplied assets (e.g.
ArchSense exports). `catalog.json` is the index at this scale; a real DB is deferred
until the catalog outgrows a file (hundreds of assets, uploads, or search).

Seed set — CC0 low-poly furniture (all [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),
no attribution required; `source_url` in `catalog.json` records origin) from
[Quaternius](https://quaternius.com) / CreativeTrio, the [Khronos SheenChair](https://github.com/KhronosGroup/glTF-Sample-Assets)
(© Wayfair), and the [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit).
Placeholder content until the curated catalog lands.

| id | Source | Category | Norm. dims (W×H×D m) |
|---|---|---|---|
| `couch-medium` | Quaternius | seating | 1.96 × 0.80 × 0.92 |
| `armchair` | Khronos/Wayfair | seating | 0.83 × 0.69 × 0.57 |
| `kenney-chair` | Kenney | seating | 0.40 × 0.90 × 0.40 |
| `table-round-large` | CreativeTrio | table | 1.20 × 0.43 × 1.20 |
| `nightstand` | Quaternius | storage | 0.55 × 0.55 × 0.55 |
| `cabinet` | CreativeTrio | storage | 0.91 × 0.90 × 0.55 |
| `kenney-bookcase` | Kenney | storage | 0.85 × 1.80 × 0.53 |
| `kenney-bed` | Kenney | bed | 1.70 × 0.67 × 2.00 |
| `floor-lamp` | Quaternius | lighting | 0.26 × 1.50 × 0.28 |
| `kenney-rug` | Kenney | decor | 1.60 × 0.01 × 0.94 |
| `kenney-plant` | Kenney | decor | 0.16 × 0.50 × 0.19 |

Two tagging gotchas this set surfaced: **key on the defining dimension** — the round
table and the bed both back-computed absurd footprints when keyed on height (2.1 m
table, 2.5 × 3 m bed); re-keying on diameter / length fixed them. And `front` is
recorded as `+Z` for every asset but **not verified** — a thumbnail from an unknown
camera angle can't confirm model-local front; that needs a 3D preview at tag time.

> History: an earlier prototype pulled assets via the Poly Pizza API. That path is
> retired (it required reverse-engineering the API and a headless browser to clear a
> Cloudflare challenge on the GLB CDN). Sourcing is now curated files.

## Textures

Not committed — fetched on demand into `textures/` by `scripts/fetch-textures.sh`
(run `npm run textures`) and gitignored, per PLAN.md's guidance on binaries. All are
CC0 1K PBR sets (color + normal + roughness) from [ambientCG](https://ambientcg.com),
which releases everything under [CC0 1.0](https://docs.ambientcg.com/books/general/page/licensing).

| Local name | ambientCG asset | Used for |
|---|---|---|
| `wood-light` | WoodFloor051 | floor — light wood |
| `wood-dark` | WoodFloor043 | floor — dark wood |
| `tile` | Tiles141 | floor — stone tile |
| `concrete` | Concrete034 | floor — polished concrete |
| `drywall` | PaintedPlaster017 | walls (fixed matte drywall) |
