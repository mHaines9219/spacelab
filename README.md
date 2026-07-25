# Spacelab

A 3D interior design tool for people who don't model in 3D. Lay out a living room, bedroom, or office without learning Blender.

Name is a placeholder.

## Status

**M1 — Floorplan & shell, in progress.** You start by creating a floor plan — a
rectangle or square by dimension, or drawn freehand top-down with typed feet-and-inches
segments — and it extrudes into a textured room you can resize and furnish. See
[PLAN.md](PLAN.md) for the architecture, the reasoning behind it, and the milestone
breakdown.

The M0 spike's throwaway `Spike` binding has been retired into the real `Document`
binding: mutations flow through Rust commands, and any wall edit re-emits geometry that
the web layer re-uploads. You can add and delete individual walls by clicking them in
3D, drop **parametric doors and windows that snap onto walls** (they cut the wall and
ride along it), and **Cmd/Ctrl+Z undoes any action**. Still open in M1: mitred
junctions, and room detection from the wall graph (multi-room / branching layouts).

### M0 gate results

Measured in Chrome 150 at 1280×800, DPR 2, on an Apple M3 Max (integrated GPU).

| Gate | Budget | Measured |
|---|---|---|
| `cargo test` wall geometry | passes | 12 tests, green |
| Dev server + production build load | both | both |
| Two walls render | yes | yes, from Rust-emitted buffers |
| Chair snaps to floor and wall | yes | floor anchor + both walls, yaw follows the wall |
| Frame rate | ≥ 60 fps | 120 fps, vsync-locked; 0.2–0.3 ms CPU per frame |
| WASM bundle | ≤ 250 KB gzipped | 46 KB raw, **21 KB gzipped** |
| Rust↔JS per-drag cost | documented | **0.3–0.5 µs** per call, batch-timed over 2000 calls |

The boundary is ~0.005% of a 120 Hz frame, so the "too chatty" risk does not bite at this
traffic shape: coarse typed arrays for mesh upload, one small array per pointer move. Two
caveats worth keeping honest — a single call is below `performance.now()` resolution, so
the figure only means anything measured in a batch; and an Intel iGPU will not hold 120 fps
the way an M3 Max does, though the CPU-side cost leaves room to spare.

Deliberately still absent: undo, mitred wall junctions, openings, and any non-prismatic
geometry. All of it is M1+.

## Layout

```
crates/core-scene/      parametric document — walls, openings, furnishings, command layer
crates/core-geometry/   extrusion, triangulation, snapping, clearance
crates/wasm-bindings/   wasm-bindgen boundary to the web app
web/                    Vite + React + TypeScript + three.js
ios/                    capture companion (RoomPlan / AR corner-tap) — M4
```

## Two rules that shape everything

1. **No document or geometry logic in JavaScript.** Rust owns the scene and emits buffers; the web layer draws them. The renderer is replaceable, the core is not.
2. **Every capture path emits the same parametric wall/opening schema** — RoomPlan scan, AR corner-tap, and manual floorplan trace alike.

## Spin up the app

**Prerequisites** — `wasm-pack` and the `wasm32-unknown-unknown` target (plus Node and a
Rust toolchain):

```sh
rustup target add wasm32-unknown-unknown
brew install wasm-pack
```

**First run, from a fresh clone:**

```sh
cargo test                    # 1. geometry + scene, no browser needed

cd web
npm install                   # 2. web deps (audit warnings here are expected — don't `audit fix --force`)
npm run ingest:build          # 3. build the furniture GLBs from the masters in assets-src/
npm run textures              # 4. fetch the CC0 floor/wall textures
npm run dev                   # 5. rebuild WASM + start Vite at http://localhost:5173
```

Steps 3 and 4 are the two that regenerate gitignored content — **skip either and the app
loads, but empty**: no furniture (step 3) or untextured surfaces (step 4). Run them once
after cloning; on later runs `npm run dev` alone is enough.

**What each step regenerates (none of it is committed):**

- `npm run ingest:build` — normalises the masters in `web/assets-src/` into
  `web/public/assets/models/*.glb` (the furniture the catalog places). `catalog.json`, the
  committed metadata index, points at these; without them the catalog is empty.
- `npm run textures` — fetches the CC0 floor/wall PBR sets from ambientCG into
  `web/public/assets/textures/` (~9 MB).
- `npm run dev` / `npm run build` rebuild the WASM first (`npm run wasm` does it alone);
  output lands in `web/src/wasm/`.
