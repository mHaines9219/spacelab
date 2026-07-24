# Spacelab

A 3D interior design tool for people who don't model in 3D. Lay out a living room, bedroom, or office without learning Blender.

Name is a placeholder.

## Status

Scaffold only. No implementation yet. See [PLAN.md](PLAN.md) for the architecture, the reasoning behind it, and the milestone breakdown.

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

```sh
cargo test              # geometry + scene, no browser needed
cd web && npm install && npm run dev
```
