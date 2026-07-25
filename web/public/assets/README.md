# Assets

Permissive licences only, per PLAN.md. Record provenance here as assets are added.

| File | Source | Licence | Measured metadata |
|---|---|---|---|
| `sheen-chair.glb` | [Khronos glTF-Sample-Assets — SheenChair](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SheenChair) © 2020 Wayfair, LLC (Eric Chadwick) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | extent 0.83 × 0.69 × 0.57 m, floor anchor, front `+Z` |

The model origin sits ~8 mm off the geometric centre in depth, so wall-seated
placement leaves a corresponding gap. Real catalog ingest has to normalise origins;
that is M2 work, not a spike concern.

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
