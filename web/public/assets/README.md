# Assets

Permissive licences only, per PLAN.md. Record provenance here as assets are added.

| File | Source | Licence | Measured metadata |
|---|---|---|---|
| `sheen-chair.glb` | [Khronos glTF-Sample-Assets — SheenChair](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SheenChair) © 2020 Wayfair, LLC (Eric Chadwick) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | extent 0.83 × 0.69 × 0.57 m, floor anchor, front `+Z` |

The model origin sits ~8 mm off the geometric centre in depth, so wall-seated
placement leaves a corresponding gap. Real catalog ingest has to normalise origins;
that is M2 work, not a spike concern.

## Models (curated catalog)

`scripts/tags.json` is the committed source-of-truth per asset; `catalog.json` is the
generated index the constraint solver reads (real-world dims, anchor, front vector,
clearance, licence, provenance, `style`, `verified`). Normalised GLBs live in `models/`
(gitignored). Built to scale to **500+ pieces** — see the two rules below.

**Masters: committed only when irreplaceable, re-fetched otherwise.** A tags entry
either names a committed `file` in `assets-src/` (a supplied ArchSense export — the
input we can't get back) *or* carries a `fetch` descriptor and is regenerated on demand
into the gitignored `assets-src/_cache/` ([`scripts/fetch-master.mjs`](../../scripts/fetch-master.mjs)).
Same "regenerate, don't commit" model textures use — **so catalog size isn't bounded by
git weight** (500 committed masters ≈ ½ GB in history, which is why we don't).

Pipeline (`web/scripts/`), source-agnostic:

1. Tag the asset — provenance plus geometry tags (real-world size + axis, front yaw, anchor). Do it in **`npm run tag`** (below), or scaffold in bulk from a source (below); don't hand-type `tags.json` at scale.
2. `npm run ingest:build` — resolve each master (committed, or **fetched into `_cache/`** if it carries a `fetch` descriptor), normalise (orient front→+Z, scale to real size *or* keep native if `sizeMeters` omitted, recenter to base-centre, meshopt-compress), write `catalog.json`.

`npm run ingest:selftest` validates the normaliser on `sheen-chair.glb`.

### `npm run tag` — verify a tag against the real geometry

Opens a dev-only 3D preview (`web/tag.html`, served only under `vite`) that removes the
two guesses hand-editing `tags.json` couldn't check:

- **`front` is now verified, not asserted.** The preview applies the *exact*
  `ingest:build` transform live (orient → scale → recenter — `src/tag/preview.ts` mirrors
  `normalize.mjs` step for step) and draws the model on a 1 m grid with a blue
  **FRONT +Z** arrow. Rotate (yaw buttons or the field) until the real front points down
  the arrow; the yaw you land on is what gets saved. A thumbnail from an unknown camera
  angle never could confirm this.
- **The *derived* dims are on screen before a build.** W×D×H (m and inches) update as you
  change the size axis / value, and a warning fires on an implausible dimension — the
  2.1 m round table and 2.5×3 m bed traps show up here instead of in a shipped catalog.
- **Save writes straight back to `tags.json`** in the shape `ingest:build` reads, so the
  loop is tag → save → `npm run ingest:build`, no hand-editing. Untagged `.glb` masters in
  `assets-src/` appear in the list marked *new* with sensible defaults to fill in.

### Bulk scaffolding — how the catalog scales without hand-typing

Tagging 500 assets one by one is the real bottleneck, so bulk sources **scaffold recipe
entries from source metadata** instead:

- **[Poly Haven](https://polyhaven.com/license) (CC0 warehouse).**
  `npm run ingest:polyhaven -- --category furniture [--limit N]` (or a slug list) reads
  Poly Haven's `/assets` metadata and writes one `tags.json` entry per asset with a
  `fetch` descriptor, deriving category, tags, native scale, per-category clearance/anchor,
  and `style:"photoreal"` ([`scripts/polyhaven.mjs`](../../scripts/polyhaven.mjs)). No
  Cloudflare challenge (the wall the retired Poly Pizza path hit); masters download at
  build time into `_cache/`. **Front can't be derived**, so entries land at yaw 0 —
  directional pieces (seating/bed/storage) scaffold `verified:false` as an explicit queue
  for `npm run tag`; symmetric pieces (tables/lighting/decor) auto-verify since front
  doesn't affect placement.
- **Kenney kit (OBJ).** `npm run ingest:kenney` extracts the kit zip from
  `assets-src/_kenney/` (gitignored), keyword-matches a set, converts OBJ→GLB
  ([obj2gltf](https://github.com/CesiumGS/obj2gltf), Apache-2.0), merges tag entries.

Then `npm run ingest:build`. The same flow ingests supplied assets (ArchSense) as
committed masters. `catalog.json` stays the index even at 500 (~200 KB, filtered
client-side); a real DB is deferred until uploads or server-side search, not asset count.

Catalog (all [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), no
attribution required; `source_url` in `catalog.json` records per-asset origin). At this
size the per-asset list *is* `catalog.json` — this README keeps only the summary so it
doesn't rot as the catalog grows toward 500.

**41 assets** — by category: seating 15, table 10, storage 10, decor 3, bed 2, lighting 1.
By style: photoreal 31, lowpoly 10.

| Source | Count | Style | Scale | Master |
|---|---|---|---|---|
| [Poly Haven](https://polyhaven.com) | 30 | photoreal | native (real-world) | fetched → `_cache/` |
| [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit) | 5 | lowpoly | keyed | committed (from kit zip) |
| [Quaternius](https://quaternius.com) / CreativeTrio | 5 | lowpoly | keyed | committed |
| [Khronos SheenChair](https://github.com/KhronosGroup/glTF-Sample-Assets) (© Wayfair) | 1 | photoreal | keyed | committed |

**31 of 41 carry `verified:false`** — the 20 directional Poly Haven pieces (seating/bed/
storage) awaiting a front check in `npm run tag`, plus the 11 seed assets whose `+Z` fronts
predate the tool. Symmetric Poly Haven pieces (tables/decor/lighting) auto-verified.

Two tagging gotchas this set surfaced — both now caught by `npm run tag` (above)
rather than by inspection: **key on the defining dimension** — the round table and the
bed both back-computed absurd footprints when keyed on height (2.1 m table, 2.5 × 3 m
bed); the preview's live derived-dims readout and out-of-range warning surface this
before a build. And `front`, recorded `+Z` for every asset, was previously **asserted,
not verified** — a thumbnail from an unknown camera angle can't confirm model-local
front; the preview's FRONT +Z arrow is the 3D check that can. (The seed set's `+Z`
values predate the tool and are still worth a pass through it.)

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
