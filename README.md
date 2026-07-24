# Spacelab

A 3D interior design tool for people who don't model in 3D. Lay out a living room, bedroom, or office without learning Blender.

Name is a placeholder.

## Status

**M0 vertical spike complete.** Two Rust-defined walls extrude and render, a CC0 chair
drags across the floor, and placement snaps to the nearest wall with the asset yawed to
face into the room. See [PLAN.md](PLAN.md) for the architecture, the reasoning behind it,
and the milestone breakdown.

The spike is deliberately throwaway — it exists to measure the Rust/JS seam before M1
commits to it. `Spike` in `crates/wasm-bindings` is the only part meant to be deleted.

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

## Develop

Needs `wasm-pack` and the `wasm32-unknown-unknown` target:

```sh
rustup target add wasm32-unknown-unknown
brew install wasm-pack

cargo test              # geometry + scene, no browser needed
cd web && npm install && npm run dev
```

`npm run dev` and `npm run build` rebuild the WASM first; `npm run wasm` does it alone.
Generated output lands in `web/src/wasm/` and is not committed.
