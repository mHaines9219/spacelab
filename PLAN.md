# Plan: Consumer 3D interior space design app — technology selection & foundation

## Context

**Problem.** Non-technical people who want to lay out a living room, bedroom, or office must choose between intimidating professional tools (Blender, SketchUp) and toys that can't produce a convincing result. The technical vocabulary — vertices, modifiers, extrusions, node graphs — is the barrier, not 3D itself.

**Goal of this plan.** Settle the technology question ("is forking Blender the right base?"), weigh options for phone-camera room capture, and lay a foundation a good UX can be built on. UX design is out of scope; this plan makes only the architectural commitments UX work depends on.

**Confirmed decisions (from clarifying questions):**

| Decision | Answer |
|---|---|
| Domain | **Interior spaces** — living rooms, bedrooms, offices. Not general-purpose 3D modeling. |
| Platform | **Web now, native later**, shared Rust core — *amended below*: a thin native iOS capture app moves earlier. |
| Licensing | Undecided → **permissive-only dependencies** so every business model stays open. |
| AI | **Assistive, not core.** Manual direct manipulation is the product. |
| Capture | **Tiered** — RoomPlan (LiDAR) → AR corner-tap (any ARKit iPhone) → manual trace (any browser). |
| Android | **Follows.** iOS capture first; Android users trace manually, which works everywhere. |
| Accuracy | **~5–10cm is acceptable** — this is for visualizing, not ordering. |

**How to read this plan.** Each area below states two things: the **Powerful** choice (what this should become if the product works) and the **MVP** choice (what to build now). They differ, and conflating them is the main way a project like this stalls. Where MVP diverges from Powerful, the plan notes whether the divergence is *cheap to reverse* or a *one-way door*.

---

## Where we are

Updated at the end of every PR — see [Keeping this section current](#keeping-this-section-current). Newest entry first.

**Now: M1 — Floorplan & shell.** MVP is M0–M4.

| Milestone | State |
|---|---|
| M0 — Vertical spike | ✅ [#1](https://github.com/mHaines9219/spacelab/pull/1) |
| M1 — Floorplan & shell | 🚧 [#2](https://github.com/mHaines9219/spacelab/pull/2) |
| M2 — Furnishing | 🚧 [#3](https://github.com/mHaines9219/spacelab/pull/3) |
| M3 — Look | ⬜ |
| M4 — Capture companion (iOS) | ⬜ |
| M5 — Persistence & sharing | ⬜ |
| M6+ — Expansion | ⬜ |

### Furnishing bullpen: set aside & re-import · 2026-07-25

**Accomplished**

- **A bullpen for parking furnishings out of the room while rearranging.** "Set aside" on the selection panel pulls the selected item out of the 3D scene into a bottom-centre tray of thumbnail cards; clicking a card **re-imports** it (re-enters at the staggered room centre, re-selected), and the ✕ **discards** it for good. The tray only appears when something is in it.
- **Membership is document state, per Rule #1.** `Furnishing` gained a `stashed: bool`; a stashed item stays owned by the `Scene` — keeping its scale, yaw, and identity — but is excluded from `furnishing_ids`/geometry so it stops rendering. The new `Command::SetStashed` flows through the same `apply` funnel, so **undo covers set-aside/re-import for free**, and because the furnishing is only *flagged* (never torn down and rebuilt) a **resized or rotated item comes back exactly as it left** — `unstash` re-seats at a fresh drop point but re-applies the saved yaw so re-seating doesn't reface it. New binding methods `stash_selected`/`unstash`/`stashed_ids`/`remove_furnishing`; JS keeps owning the id→catalog-entry map and draws the tray from `stashed_ids`. The catalog and bullpen now **share one offscreen thumbnail renderer** (lifted into `App`), so a re-import's card hits the cache the catalog already warmed — and that also retires the second WebGL context the catalog-only thumbnailer used to spin up.
- Verified: **45 Rust tests + clippy clean** (new `core-scene` test that stashing pulls an item from the placed set while keeping it owned; binding tests that a set-aside item leaves the room and returns at the same size, that stash is undoable and bullpen items are discardable, and that `unstash` rejects a non-stashed id). Playwright drove create-room → place → set aside (item leaves the room, a tray card appears) → re-import (back in the room) → undo (returns to the tray) → discard, **11/11 checks, no console errors**; screenshot reviewed (two-card tray, thumbnails rendered, clear of the catalog and floor picker). WASM ~35.5 KB gzipped (was ~34).

**Remains**

- **Re-import lands at the room centre, not where the item was.** Dropping the old position is intentional — that's the point of setting aside — but there's no "put it back where it came from" and no drag-from-tray-to-a-spot placement, so a re-imported item usually needs a manual drag next.
- The bullpen has **no ordering, grouping, naming, or bulk "bring all back" / "clear"** beyond stash order — fine for a handful, cramped for a whole room's worth (the strip scrolls horizontally but doesn't wrap).
- **Stashed items don't persist** — there's no serialization anywhere yet (M5), so a reload loses them along with the rest of the scene.
- Carried: clearance/collision (`parry3d`) is still the headline M2 gap — a re-imported item can land overlapping others; resize still rebuilds a rectangle as two walls, wiping hand-added walls; `front=+Z` unverified; thumbnails still render client-side (now one shared context) and aren't cached to disk; KTX2 unbuilt; no redo; rotate/scale undo per-keypress; RoomPlan USD round-trip; fps on one machine; dev-only probes (`__furnishingCount`, `__wallCount`, `__floorTris`, `__selectedYaw`, `__openingCount`, `__wallTris`, `__addOpeningOnWall`, `__deleteWallById`).

### Draw-mode alignment lock + Conductor run scripts · 2026-07-25

**Accomplished**

- **Draw mode now locks the cursor onto earlier corners so the loop closes square.** On top of the existing ortho-straighten (which only aligns to the *previous* corner), `worldAt` now pulls each axis onto the nearest earlier corner within `ALIGN_M` (~8"), checking the start corner first so it wins ties — so you line the last "downward" leg up with the origin and the room shuts cleanly. A dashed guide line renders through the aligned corner (green when it's the start, echoing the close affordance). All still JS-side draw-input massaging; the emitted polygon is unchanged, so **Rule #1 holds** — Rust owns the geometry.
- **Committed `.conductor/settings.toml`** so the Conductor setup/run scripts are versioned, not per-machine: setup regenerates the two gitignored artifacts (`ingest:build` furniture GLBs, `textures`) once per workspace; run is `npm run dev -- --port $CONDUCTOR_PORT` (rebuilds WASM every start, per-workspace port); `run_mode = "concurrent"` since nothing shared is contended.
- Verified: `tsc` clean on `DrawEditor.tsx` (pre-existing `viewport.ts` errors are only the un-built WASM module); `.conductor/settings.toml` parses; confirmed npm forwards `--port` past the compound `&&` to vite.

**Remains**

- **The alignment lock is unverified in the live app** — WASM wasn't rebuilt this session, so the draw flow and green guide line haven't been driven end-to-end. `ALIGN_M = 0.2` is a guess; may feel too grabby or too weak against the 6" grid until tuned by hand.
- Alignment inference targets *every* prior corner, not just the start; a genuinely-diagonal leg passing within ~8" of an unrelated corner's row/column will get pulled onto it. Acceptable/standard, but noted.
- The `.conductor/` config is a new committed file riding along with the feature; this workspace was created before it existed, so its setup may need a one-time manual re-run.

### Default room opens with two walls · 2026-07-25

**Accomplished**

- **A generated rectangle now spawns as an open corner, not a closed box.** `set_rectangle` raises only the two far walls (meeting at the origin corner); the near two — the ones the camera looks through — are omitted, so a fresh room reads as a dollhouse view you can see into rather than the inside of a sealed box. The **floor keeps its full rectangular footprint** regardless, since the document already stored the floor outline independently of the walls. The missing walls can be added back by hand from the 3D "add wall" flow.
- Refactored `build_room` to take an explicit list of wall segments + a floor outline (the two were already decoupled in the document). The **Draw** path is untouched — a traced polygon still raises every wall the user drew; the two-wall default is only for the generated rectangle/square.
- Verified: **26 Rust tests + clippy clean** (updated three undo tests off the old 4-wall assumption; added `a_rectangle_opens_with_two_walls_but_a_full_floor` and `a_traced_polygon_raises_every_wall`); drove the real app — created a 12×10 room, `__wallCount` reads 2, no console errors, screenshot shows the open back corner over a complete floor.

**Remains**

- **Resize rebuilds as two walls too** (RoomSizePanel re-calls `set_rectangle`), so resizing wipes any walls added back by hand — same rebuild-from-scratch behaviour the 4-wall version had, now more visible.
- Which two walls are kept is fixed to the origin corner and tuned to the default camera azimuth; if the camera orbits behind them the room reads as open from the back. No per-room control over which sides are open.
- Carried: clearance/collision (`parry3d`) still absent; `front` axis unverified; thumbnails uncached; KTX2 unbuilt; RoomPlan USD round-trip; fps on one machine; dev-only probes (`__wallCount`, `__furnishingCount`, `__selectedYaw`, `__floorTris`, `__deleteWallById`). Doors/windows (merged in the entry below) are unaffected — openings ride their wall, so the two omitted walls simply carry no openings by default.

### M1: parametric doors & windows that snap to walls · 2026-07-25

**Accomplished**

- **Openings are real document objects, owned by a wall.** New `Opening { wall, kind, along, width, height, sill }` + `OpeningKind::{Door, Window}` in `core-scene`, stored on the `Scene` in a flat list keyed by `wall` id — position is a distance *along the wall centreline*, never world coordinates, so the opening rides with its wall. New commands `AddOpening`/`RemoveOpening`/`MoveOpening`/`ResizeOpening` all flow through the same `Scene::apply` funnel, so **undo works for free** via the existing snapshot stack. Deleting a wall (or `ClearWalls`) cascades its openings away in the same retain. **Rule #1 held** — every bit of placement/geometry math is in Rust; JS sends intent and reads back coarse arrays.
- **The wall mesh is cut, not faked.** `wall_mesh` now takes the wall's openings and partitions each long face into solid strips (before / below / above / after each opening), leaving the hole, then lines it with sill/head/jamb **reveals** through the wall thickness so you see real depth looking through. A floor-standing door omits the sill strip and reveal; a window keeps them. `seat_opening` clamps the centre so the whole opening stays within the wall (wider-than-wall centres instead of inverting).
- **Snap-to-wall placement + direct manipulation.** "add door" / "add window" arm a placement mode; the next wall click drops the opening snapped to that point (the pointer handler raycasts the existing invisible wall-pick boxes, hands the world point to Rust, which projects + clamps). A placed opening is selectable (invisible per-opening pick box + blue selection outline, both positioned purely from a Rust transform, exactly like furnishings), **drag-slides along its wall**, edits width/height (+ sill for windows) by typed inches in a side panel, and deletes. Windows also get a translucent glass pane drawn by JS from the same Rust transform.
- Verified: **39 Rust tests + clippy clean** (new scene/geometry/binding tests: hole leaves no geometry in the doorway, door adds head+2 jambs but no sill, window adds the sill reveal, reveal normals face the void, seat clamping, wall-delete cascade, drag+undo). Playwright drove create-room → place door (wall cut confirmed by triangle-count change) → place window → add-mode banner + Esc → undo both → walls intact, **13/13 checks, no console errors**; screenshot reviewed (doorway to floor with visible reveals, windowed opening with sill + glass).

**Remains**

- **No clearance/collision checking** — an opening can overlap furniture, and two openings whose spans overlap *along one wall* produce undefined face geometry (the sweep assumes non-overlapping spans; nothing rejects it yet). Same `parry3d` gap flagged for M2 furniture.
- Openings only snap to a wall's **centreline projection**; there's no along-wall dimension readout, no grid/snap-to-centre, and no 2D-plan representation of them.
- Height/sill clamp to the wall height but there's **no per-opening validation UI** (e.g. a sill dragged near the ceiling just yields a sliver). Door leaf/swing, window frame mullions, and casing/trim are all unbuilt — a door is a framed *doorway*, a window is a *glass pane*, nothing opens.
- Dragging an opening **rebuilds the whole wall mesh per pointer move** (fine at this scale; a bigger model would want a targeted re-emit). New dev probes `__openingCount` / `__wallTris` / `__addOpeningOnWall`.
- WASM grew to **~34 KB gzipped** (was ~23) with the opening geometry + binding surface — still far under the 250 KB budget.
- Carried from M2 and earlier: clearance/collision (`parry3d`) still the headline M2 gap; `front`-vector unverified; thumbnails un-cached; KTX2/texture compression unbuilt; no redo; rotate/scale undo per-keypress; RoomPlan USD round-trip; fps on one machine only. **Still open within M1: mitred wall junctions and room detection from the wall graph** (doors/windows now off that list).

### Setup docs: document the ingest step · 2026-07-25

**Accomplished**

- Rewrote the README's **Develop** section into numbered **Spin up the app** steps. The fix that prompted it: a fresh clone was missing `npm run ingest:build`, so `catalog.json` populated the catalog UI but the normalised GLBs it points at (gitignored, regenerated from `assets-src/` masters) were never built — the catalog rendered empty. The step is now called out alongside `npm run textures` as one of the two that regenerate gitignored content, with the "skip either and the app loads, but empty" symptom named.

**Remains**

- Docs-only; no code or milestone-state change. All M1/M2 remains carried forward from the entry below — clearance/collision (`parry3d`) still the next real M2 step; unverified `front=+Z`; thumbnails uncached; RoomPlan USD round-trip.

### M2: furniture catalog — ingest, browse, place, manipulate · 2026-07-25

**Accomplished**

- **File-based asset pipeline.** Curated masters in `web/assets-src/` → `npm run ingest:build` normalises each (orient front→+Z, scale to real size *or* keep native, recenter origin to base-centre, meshopt-compress) → `catalog.json` (the committed metadata index) + `models/` (gitignored). Source-agnostic: the same drop-in flow will take supplied assets (ArchSense). An earlier Poly Pizza API prototype was retired — the API needed reverse-engineering and a headless browser to clear a Cloudflare challenge on its GLB CDN. **11 CC0 assets across 7 categories** — Quaternius/CreativeTrio, the Khronos SheenChair, and 5 from the Kenney Furniture Kit converted OBJ→GLB (`npm run ingest:kenney`, obj2gltf, Apache-2.0). The normaliser's recenter also **fixes the 8 mm chair-origin gap carried since PR #1**.
- **Rust: real multi-object scene.** `Document` went from one hardcoded `CHAIR` to `add_furnishing(extent)→id` / `remove_selected` / `select` / `deselect`, with drag/rotate/scale/dimension/reset all retargeted to the selected id; new `RemoveFurnishing` command. Selection is UI state kept *off* the undo snapshots, and every op guards against an undo removing the selected furnishing out from under it. **Rule #1 held** — placement stays in Rust; JS sends intent and reads back a coarse transform per id.
- **Viewport: multi-furnishing manager.** Loads normalised meshopt GLBs by catalog `blob` (MeshoptDecoder wired into GLTFLoader), one pickable group per id, per-object select/drag/rotate/scale, and an undo path that reconciles the mesh set (rebuilding from cached templates, so a restored furnishing reappears synchronously).
- **Catalog UI.** Right-side floating window: broad category filter (Seating/Table/Storage/Lighting) + free-text search + lazy client-side 3D thumbnails (one reused offscreen renderer). Click places into the room (staggered so items don't stack); the selection panel (moved left) shows the item's title, live W/D/H, reset, and remove. Placements auto-stagger.
- Verified: **24 Rust tests + clippy clean**; Playwright drove create-room → category filter → search → place several → rotate → undo with **no console errors**; screenshots reviewed (thumbnails, placement, selection highlight, panel layout).

**Remains**

- **Clearance / collision checking (`parry3d`) — the actual M2 value — is still absent.** Nothing checks "does it fit", walkway, or door-swing; items only *stagger* on placement and can freely overlap. This is the next real M2 step.
- `front` is recorded as `+Z` for every asset but **unverified** — a thumbnail from an unknown camera angle can't confirm model-local front; needs a 3D preview at tag time. Related tagging trap seen twice: keying a piece on the wrong axis back-computes an absurd footprint (2.1 m round table, 2.5×3 m bed) — key on the *defining* dimension and sanity-check the derived ones.
- Thumbnails render client-side each session (a second WebGL context), not cached to disk. Fine at this catalog size.
- No 2D-plan view of furniture, no multi-select, no duplicate; rotate/scale undo still per-keypress (carried).
- The sheen armchair master is the textured ~3.9 MB GLB (normalised to ~3.3 MB — meshopt compresses geometry, not its large textures); the low-poly pieces are 6–16 KB. KTX2/texture compression still unbuilt (carried).
- dev-only probes present, now `__selectedYaw` / `__furnishingCount` / `__wallCount` / `__floorTris` / `__deleteWallById` (evolved from `__chairYaw`).
- Carried: RoomPlan USD round-trip; fps measured on one machine only.

### Undo (Cmd/Ctrl+Z) · 2026-07-24

**Accomplished**

- **Undo across every action** — furniture rotate/scale/drag/dimension/reset, floor finish, wall add/delete, and room create/resize. The command funnel finally has a stack on top of it: the `Document` binding snapshots the scene before each action (`checkpoint`) and `undo` restores it. Cloning the whole scene is trivial at this size and far simpler than an inverse per command — the plan's "simple command-stack undo".
- **One gesture = one undo step.** Discrete actions checkpoint themselves; a drag checkpoints once (on the first pointer move, not per move), so undoing a drag returns to where it started in a single step. Undoing room creation returns to the start screen.
- The web sends only the Cmd/Ctrl+Z intent (ignored while a text field is focused, so native text-undo still works) and re-syncs the whole scene from the restored document.
- Verified: 3 new binding unit tests (undo reverts action-by-action; restores a deleted wall; coalesces a drag into one step) — **21 Rust tests**; Playwright drives Cmd+Z across rotate, resize, wall delete, wall add, floor finish, and creation-to-start-screen (14 checks). Clippy clean.

**Remains**

- **No redo yet.** History is one-directional; redo is a second stack away.
- Rotate/scale undo is per key-press, so holding an arrow makes many small steps.
- Snapshot-based (clones the scene per action) — right at this scale, but a large document would want the inverse-command model.
- Undo doesn't reach into the 2D draw editor's in-progress corners (those aren't document state until the room is created).
- (carried) RoomPlan USD round-trip; chair origin 8 mm; the 3.9 MB GLB; fps on one machine; dev-only probes (`__chairYaw`, `__wallCount`, `__floorTris`, `__deleteWallById`) present.

### M1: floorplan creation, polygon floor & the document binding · 2026-07-24

**Accomplished**

- **Floorplan creation flow** — a start screen with three routes: **Rectangle** and **Square** take feet + inches; **Draw** is a top-down SVG editor (click corners, direct-distance entry by typing feet + inches for the next segment, 6-inch grid + ortho snapping, snap-to-close to finish the loop).
- **Real polygon floor** — ear-clipping triangulation of the wall loop replaces the bounding-box floor, so concave (L-shaped) rooms fill correctly. Emits UVs and guaranteed-upward normals.
- **The geometry-rebuild seam** — any wall edit re-emits floor + wall buffers and the 3D view re-uploads them live; the camera reframes to the footprint. This is the real M1 binding, so the throwaway **`Spike` is retired into `Document`**. Room construction (rectangle, polygon) lives in Rust; JS only sends intent. New `core-scene` commands `DeleteWall`/`ClearWalls`; `set_rectangle`/`set_polygon`/`delete_wall`/`wall_segments`/`room_bounds` on the binding.
- **Resize the space** — rectangle/square rooms show editable Width × Depth (feet + inches) that regenerate the room live.
- **Add / delete walls in 3D** — click a wall to select it (translucent highlight), press Delete or the panel button to remove it; "add wall" mode drops a segment from two floor clicks. The **floor is a document-owned footprint** (`Scene::floor_outline`) set at room creation, *independent of the walls* — so deleting one, two, or all walls never reshapes it. (Earlier iterations derived the floor from the wall loop and collapsed it to a triangle once two adjacent walls were gone; regression-tested now for 0–4 deletions.)
- Furniture (select/rotate/scale/reset) and floor finishes verified still working end-to-end inside generated rooms.
- Verified: 17 Rust tests (new rectangular + concave-floor triangulation tests), clippy clean; Playwright drove all three creation modes, resize, a furniture regression, and wall select/delete/add (27 checks across three runs); screenshots reviewed.

**Remains**

- **Resize is rectangle-only.** A drawn room can't be resized by W × D without destroying its shape — it needs the 2D plan editor or a uniform scale.
- The floor footprint is only set at room creation/resize; there's no edit-the-floor-shape affordance, and added walls don't extend it. Proper wall-graph face detection / multi-room support is still an M1 item.
- Added walls default to the same thickness/height as generated ones; per-wall height/thickness editing isn't exposed.
- The draw tool doesn't reject self-intersecting polygons; ear-clipping degrades gracefully but the result is undefined for those.
- Still open within M1: **parametric doors/windows, mitred wall junctions, room detection from the wall graph.**
- Undo still absent across all these commands. (carried)
- dev-only `__chairYaw` probe still present. (carried)
- Carried from PR #1: RoomPlan USD round-trip; chair origin 8 mm; the 3.9 MB GLB committed directly; fps measured on one machine only.

### Floor finishes & drywall walls · 2026-07-24

**Accomplished**

- **Floor finishes** — four CC0 textured floors (light wood, dark wood, stone tile, polished concrete) chosen from a picker. The *choice* is document state: new `FloorMaterial` enum + `SetFloorMaterial` command in `core-scene`. **Rule #1 held** — Rust owns which finish is selected; JS maps the ordinal to the texture files. This is the first material work, so it foreshadows M3's document-level material swapping.
- **Walls** — fixed matte drywall (ambientCG `PaintedPlaster017`) with a light normal map, so they read as dry wall rather than flat paint. No wall options, by request.
- Geometry now emits **per-vertex UVs** (metric, projected per quad) on `MeshBuffers`; floor and walls are split into separate meshes so each carries its own material.
- Textures are CC0 1K PBR sets fetched from ambientCG by `scripts/fetch-textures.sh` (`npm run textures`), gitignored (~9 MB), provenance in the assets README — matches the plan's "fetch script, not committed binaries" guidance.
- Rotation direction flipped per feedback: `←` clockwise, `→` counter-clockwise. Added the missing `vite-env.d.ts`.
- Verified: 16 Rust tests green (new `FloorMaterial` test); a 13-check Playwright run drives the floor picker, selection, both rotation directions, scale, typed dimension, reset and deselect — all pass, no console errors; screenshots of all four finishes reviewed.

**Scope note.** Floor/wall texturing is early **M3 (Look)** landing during M1 — flagged, not absorbed, same as rotate/scale was early M2.

**Remains**

- Wall material is fixed — no per-wall/per-room choice and no paint-colour option (deliberately, per "don't overthink"). A real M3 look pass wants material swapping as document state, the way the floor now is.
- Floor UVs project in world metres at a fixed per-finish tile size; the tiling grid isn't aligned to any wall origin. Fine at this fidelity.
- Textures are 1K and load at runtime — all four floor sets eagerly, no KTX2/compression or lazy-loading. The plan's content pipeline (KTX2, meshopt) is still unbuilt. Fetch also depends on ambientCG being reachable; Poly Haven's CDN was down from here, so every set comes from one host.
- The dev-only `__chairYaw` probe (from PR #2) is still present. (carried)

### Select, rotate & scale a furnishing · 2026-07-24

**Accomplished**

- Direct manipulation of the chair: click to select (edge-box outline), click empty space or `Esc` to deselect.
- **Rotate** — `←`/`→` in 15° steps.
- **Scale** — `↑`/`↓` nudge ±5% uniformly; a selection panel shows **W/D/H in inches** and takes an exact value per axis by typing; `R` (or a button) resets to catalog proportions.
- Two new `core-scene` commands — `SetYaw` and `SetScale` — so every rotate/scale/reset flows through `Scene::apply`. **Rule #1 held**: JS only reads back a coarse `[x, up, z, yaw, sx, sy, sz, snapped]` transform and draws it; no document or geometry logic crossed the boundary. A resize re-seats the asset against its wall with the new footprint and preserves the user's yaw (scaling never re-orients).
- Verified: 3 new `core-scene` unit tests (15 Rust tests total, green); a 10-check Playwright run drives the real app end to end — select, rotate and reverse, ↑ enlarge, type an exact width, reset, deselect — all pass, no console errors. WASM 23 KB gzipped (was 21).

**Scope note.** Rotate/scale is **M2 (Furnishing)** work landing during M1 — surfaced here per scope discipline rather than absorbed quietly. It is a thin slice: one hard-coded chair, no catalog, no clearance checking.

**Remains**

- **Scale cuts against the real-dimension thesis.** Expressing size in inches keeps "does it fit?" answerable, but there is still no clearance / collision checking (`parry3d`) — that check is the actual M2 value and isn't here yet. Per-axis scale can also distort the GLB, which a real normalized catalog pipeline would disallow.
- Rotating a wall-anchored asset changes yaw only; it does not re-form the anchor, so a rotated chair floats off the wall until the next drag re-snaps it.
- Still a single hard-coded chair. No multi-object scene, no per-object identity beyond the `CHAIR` id; the selection UI, keyboard handling, and `Spike` bindings around the new commands are throwaway M0 glue.
- A dev-only `__chairYaw` probe (gated by `import.meta.env.DEV`, stripped from production) exists so the e2e test can read rotation.
- **Undo** still absent — `SetYaw`/`SetScale` go through the command funnel, but there is no stack on top of it. (carried)
- Carried from PR #1, still open: RoomPlan USD schema round-trip; CC0 chair origin 8 mm off-centre; the 3.9 MB GLB committed directly; fps measured on one machine only (no low-end/Windows/Linux/mobile); delete `Spike` when M1 lands a real document binding.

### PR #1 — M0 vertical spike · 2026-07-24

**Accomplished**

- The seam holds end to end: Rust owns the parametric document and emits geometry, JS only uploads and draws. No document or geometry logic crossed into TypeScript.
- `core-scene` — `Wall`, `Anchor`/`Placement`, `Asset` metadata (extent + front vector), and the `Command`/`apply` funnel. That funnel is the one-way door this plan flagged, and it is in place from the first real commit rather than retrofitted.
- `core-geometry` — prismatic wall extrusion, floor derived from wall bounds, and placement resolution that seats an asset against the nearest wall and yaws it to face into the room. 12 tests, no browser.
- `web` — three.js viewport with IBL, shadows, pointer drag, metrics HUD.
- Gate met: 120 fps vsync-locked on an M3 Max, 21 KB gzipped WASM, **0.3–0.5 µs** per Rust↔JS drag call. The chatty-boundary risk is retired at this traffic shape.
- Asset licensing hygiene started: CC0 chair with provenance and measured metadata recorded in `web/public/assets/README.md`.

**Remains**

- All of M1: 2D wall drawing with snapping, parametric doors and windows, mitred junctions, room detection from the wall graph.
- Undo. The command funnel exists; the stack on top of it does not.
- **Schema round-trip against a real RoomPlan USD export.** Still the highest-leverage unvalidated bet in this plan, and still cheapest to test during M1 on a borrowed LiDAR device — before any Swift is written.
- Asset origin normalisation. The CC0 chair's origin sits 8 mm off centre in depth, so wall-seated placement leaves a matching gap. Harmless at 5–10 cm tolerance; a real M2 ingest problem.
- The 3.9 MB GLB is committed directly. Swap for a fetch script before the catalog grows.
- The fps figure is one machine. No low-end integrated GPU, Windows, or Linux measurement yet, and no mobile browser at all.
- `Spike` in `crates/wasm-bindings` is throwaway. Delete it when M1 lands a real document binding.

### Keeping this section current

Every PR updates this section before it merges: flip the milestone table if a state changed, then add a dated entry saying what landed and what it leaves behind. Unresolved items carry forward into the next entry rather than being dropped — that carry-forward is the whole point, since it is how deferred work stays visible instead of resurfacing as a surprise. Enforced as a rule in [CLAUDE.md](CLAUDE.md).

---

## The Blender question: don't fork it

Your hunch is reasonable but wrong for this product. Four independent reasons, any one disqualifying:

1. **Wrong feature set.** Interior layout needs parametric walls and openings, a semantic furniture catalog, constraint-based placement ("against wall", "on floor"), 2D floorplan ↔ 3D sync, and clearance checking. Blender provides *none* of these. It provides mesh editing, sculpting, rigging, animation, simulation, compositing — the 95% you must hide. Maximum weight, minimum value.
2. **The complexity is architectural, not cosmetic.** [Bforartists](https://github.com/Bforartists/Bforartists) is the reference data point: a dedicated UI-focused Blender fork with **3000+ core interface changes**, whose maintainers report chronic difficulty staying in sync because [roughly half the changes can't be done as an addon or theme](https://www.bforartists.de/faq-2/). After all that, it's still recognizably Blender.
3. **No browser target.** Blender is a desktop C/C++ app with a bespoke UI toolkit. No WASM build exists. Zero-install is your single biggest lever with casual users, and a Blender base forecloses it.
4. **License.** Blender is [GPLv2-or-later](https://www.blender.org/about/license/). Any fork you distribute must publish all source under GPL. That's legally and commercially viable (E-Cycles charges money for a GPL fork), but it rules out closed-source and open-core — and you haven't decided. Permissive deps cost nothing now and keep every option open.

**One legitimate Blender use, later:** run **headless Blender + Cycles server-side** as the photoreal final-render backend. Running it on your own servers isn't distribution, so GPL obligations don't attach to your app. Cheapest route to the 4K render quality Coohom and Planner5D actually compete on. Rule: never bundle it into a downloadable client.

---

## Hard platform constraints (verified)

These are facts, not preferences, and they drive the capture design:

- **iOS Safari has no WebXR.** [caniuse shows ❌ for every Safari iOS version through 26.5](https://caniuse.com/webxr) (June 2026). No ARKit from the browser. Some blogs claim Safari 18 changed this; the support data says otherwise. **Camera capture on iPhone requires a native app.**
- **RoomPlan requires LiDAR** — iPhone 12 Pro and later Pro models, iPad Pro 2020+. [Apple ships no non-LiDAR fallback](https://developer.apple.com/forums/thread/776280).
- **Android has no RoomPlan equivalent.** ARCore exposes planes and an ML Depth API; structured room layout is [an open feature request](https://github.com/google-ar/arcore-android-sdk/issues/1772), not a product.
- **Polycam's Room Mode is itself built on ARKit RoomPlan.** "Like Polycam" ≈ RoomPlan + photogrammetry with good UX. No publicly documented embeddable capture SDK.
- **Photogrammetry fails exactly where interiors live.** COLMAP is unreliable in textureless indoor environments, and blank painted walls are the entire problem. Gaussian splatting depends on those same SfM poses and [optimizes visual coherence over geometric accuracy](https://arxiv.org/html/2507.06109v2) — a gorgeous backdrop, not editable walls.
- **Meta's SceneScript is CC BY-NC.** Non-commercial only; can't ship it. Still worth reading — its "layout as a parametric language" framing independently validates the scene schema below.

---

## Phone-camera capture: options weighed

| # | Option | Output | Reach | Cost / risk | Verdict |
|---|---|---|---|---|---|
| A | **Apple RoomPlan** in a native iOS app | Parametric walls, doors, windows, openings + *classified furniture boxes*; USD export | iPhone Pro 12+, iPad Pro | Free, Apple-maintained. Weeks of Swift. | **Ship in MVP** |
| B | **AR corner-tap** (ARKit; ARCore later) — user taps room corners, drags wall heights | Parametric walls at tap accuracy (~5–10cm) | Nearly every modern phone | You own the UX; no ML, no vendor | **Ship in MVP** — this is the reach path |
| C | **Manual floorplan trace** in the web app | Parametric, exact if the user measures | Universal, no app | Very low | **Ship in MVP** — it's also your correctness baseline |
| D | **Third-party SDK** (CubiCasa mobile SDK + Exporter API, MagicPlan) | 2D/3D floorplans | Cross-platform | [Contract-gated, opaque per-scan pricing](https://www.cubi.casa/developers/); vendor owns your differentiator; output may not map to your schema | Only if A+B underdeliver |
| E | **Video → photogrammetry / splat** (server-side COLMAP+OpenMVS, or gsplat) | Messy mesh or splat — **not editable** | Any phone | High GPU cost, minutes of latency, fails on blank walls | **Not for geometry.** Later, for visual backdrop only |
| F | **Custom ML layout-from-video** (RoomFormer-class) | Parametric | Any phone | Research project, months+; best open model is NC-licensed | No. Revisit in ~18 months |

**Recommended: A + B + C, tiered, behind one schema.**

```
LiDAR iPhone / iPad Pro  →  RoomPlan            (best quality, also detects existing furniture)
Any ARKit iPhone         →  AR corner-tap       (the reach path)
Any browser, no app      →  manual floorplan trace
                                  ↓
                    ONE parametric wall/opening schema
```

Since accuracy only needs to be ~5–10cm, **B is a first-class path, not a consolation prize** — and that's what makes this affordable. LiDAR becomes a quality bonus rather than a gate.

> **Cheap insurance, worth doing anyway:** always display room dimensions and make every one hand-editable. Even in "just visualizing" mode some users will reason about whether a sofa fits. This costs almost nothing if the schema is parametric from the start, and it's expensive to retrofit.

**Why A earns its keep beyond accuracy:** RoomPlan returns *classified bounding boxes for existing furniture*. Your "cleanse the room to a blank slate" feature becomes "delete the detected objects, keep the shell" — nearly free. On paths B and C there's nothing to delete because nothing was captured. That's the strongest argument for the LiDAR path.

**Companion app scope (MVP):** scan → review/correct → upload → "open on desktop." Nothing else. Pure Swift is likely simpler than React Native here since RoomPlan needs a native module regardless, and the app is genuinely small. Revisit if you later want to share TS logic.

---

## Architecture

### 1. Scene document (Rust) — the load-bearing decision

Not mesh soup. A semantic, parametric model of a space:

- **Walls** — centerline segments with thickness + height; junctions mitered from the wall graph; rooms derived as faces of the planar wall graph rather than authored by hand.
- **Openings** — doors/windows as parametric cuts *owned by* a wall (position along wall, sill height, dimensions). Move a wall, its openings follow.
- **Furnishings** — `{asset_id, anchor, transform, params}`. Placement is a **constraint against an anchor surface**, never a raw 4×4 matrix. This is what makes drag-and-drop feel intelligent instead of fiddly.

| | Choice |
|---|---|
| **Powerful** | Full parametric building model, CRDT-backed for real-time collaboration, complete undo/redo history, versioned document format. |
| **MVP** | Same schema, single-user, simple command-stack undo, versioned serialization from day one. |
| **Reversibility** | Single-user → collaborative is a real refactor but tractable *if* mutations already flow through a command layer. Build that layer now; it's cheap and it's the one-way door. |

**All three capture paths must emit this schema.** RoomPlan already produces almost exactly this shape — parametric walls, doors, windows, openings. Aligning now is nearly free; getting it wrong means a rewrite. This is the single highest-leverage decision in the plan.

### 2. Geometry (Rust)

- **Walls/floors/ceilings** — walls are prismatic, so 2D polygon offsetting + earcut triangulation + extrusion covers the common case.
- **Placement & collision** — `parry3d` (Apache-2.0) for oriented-box queries: snapping, "does it fit", door-swing and walkway clearance.
- **No B-rep kernel.** Skip OpenCascade, CadQuery, Zoo's API — they solve mechanical CAD (fillets, STEP, tolerances). You need none of it, and OpenCascade's WASM payload is large.

| | Choice |
|---|---|
| **Powerful** | Add [`manifold-3d`](https://github.com/elalish/manifold) (Apache-2.0, robust CSG, WASM-proven) for non-prismatic cases: sloped ceilings, dormers, curved walls, arbitrary wall booleans. |
| **MVP** | Prismatic extrusion only. Straight walls, rectangular openings, flat ceilings. |
| **Reversibility** | Easy — additive. Manifold drops in behind the same geometry interface later. |

Because geometry is pure Rust it's unit-testable without a browser: wall mitering, opening cuts, snap resolution all become `cargo test`.

### 3. Renderer

**Rule that must hold in every variant: no document or geometry logic in JavaScript.** Rust emits vertex buffers and instance transforms; JS uploads and draws them.

| | Choice |
|---|---|
| **Powerful** | `wgpu` renderer in Rust — one renderer for web (WebGPU) and native (Vulkan/Metal), shared shaders, full control over look. |
| **MVP** | **React + TypeScript + three.js.** Mature glTF loading, IBL, shadows, post-processing, transform gizmos, outline/selection — *today*. Automatic WebGL2 fallback where WebGPU coverage is thin. |
| **Reversibility** | You will write the renderer twice. **This is deliberate.** In Rust you'd rebuild all of the above, costing months before anything looks good — and looking good is the whole product. The renderer is the cheap half to replace; the expensive, correctness-critical half (scene model, constraints, geometry) is already Rust and ports unchanged. |

Keep the boundary coarse and typed — transferable `ArrayBuffer`s, never per-object JSON.

### 4. UI shell

React + TypeScript + Vite. A 2D floorplan editor (SVG or canvas2d) and a 3D viewport, both projections of the same Rust document, bidirectionally synced. The 2D↔3D pairing is consistently what casual users find most legible.

| | Choice |
|---|---|
| **Powerful** | Multiplayer cursors, comments, variant/version comparison, guided templates per room type. |
| **MVP** | Single-user 2D + 3D synced views, drag-to-place, transform gizmo, undo. |

### 5. Content pipeline

- **glTF 2.0 / GLB** as the asset format (meshopt/Draco geometry, KTX2 textures). USDZ export for iOS AR Quick Look.
- **Mandatory per-asset metadata:** category, real-world dimensions, anchor type (floor/wall/ceiling/surface), front vector, clearance volume. Without this the constraint system has nothing to work with.

| | Choice |
|---|---|
| **Powerful** | Thousands of real-brand models with buy links — this is Coohom's and HomeByMe's actual moat. Requires retailer partnerships plus an ingest/normalize/tag pipeline. |
| **MVP** | ~100–200 hand-curated CC0 assets covering common room archetypes: [Poly Haven](https://polyhaven.com/license) (models + HDRIs, CC0, commercial use, no attribution), ambientCG (materials), Quaternius/Kenney. Tag them by hand. |
| **Reversibility** | Easy *if* the metadata schema is right from asset #1. Retrofitting anchors and dimensions across thousands of models is miserable. |

> **Flag — the long pole is content, not code.** Planner5D ships ~8,000 items; Coohom's moat is its brand catalog. Sourcing, licensing, normalizing, and tagging thousands of models is a business and ops problem that will outlast the engineering. Budget it as a parallel workstream from M2, not a task.

**Sourcing decision — curated files, not a runtime warehouse and not a warehouse API.** A live in-app "3D warehouse" (Sketchfab, Trimble, Fab) is the wrong shape: warehouses ship *geometry*, but the constraint system needs the metadata above (anchor, real dims, front vector, clearance) that **none of them provide** — so a warehouse only accelerates *sourcing*, it never removes the normalize+tag workstream, which is the long pole. That insight survived a prototype: we built a full ingest against the Poly Pizza API and it worked, but the API needed reverse-engineering and its GLB CDN sits behind a Cloudflare browser challenge (a headless browser just to download). The catalog is small and curated ("not that many"), so the sourcing model is now **operator-supplied master files** — hand-picked CC0 assets now, and supplied assets (e.g. ArchSense exports) going forward. Same benefit as mirror-and-normalize, none of the warehouse coupling.

> **Pipeline (built):** file-based and source-agnostic (`web/scripts/`). Drop a master in `assets-src/` (committed — irreplaceable inputs), describe provenance + geometry tags in `tags.json`, run `npm run ingest:build` → normalise (orient front→+Z, scale to real dims *or* keep native scale, recenter origin to base-centre, meshopt-compress) → `catalog.json`. The normaliser's base-centre recenter also fixes the long-standing 8 mm chair-origin gap. Seeded with 5 CC0 low-poly furniture pieces (Quaternius/CreativeTrio).
>
> **Storage shape:** normalised GLBs live in `models/` (gitignored, regenerated from masters); `catalog.json` is the committed metadata index (`asset_id, source, license, attribution, category, dims_m, anchor, front, clearance_m, tags, blob`). **At this scale `catalog.json` IS the database** — a real DB (SQLite → Postgres) is deferred until the catalog outgrows a file: hundreds of assets, user uploads, or server-side search. Then the object-store + relational-index split applies. **Objaverse-XL** (10M+ open GLB) remains a later ML lever for auto-orient/auto-tag at scale — a research direction, not an MVP catalog.

### 6. Cloud

| | Choice |
|---|---|
| **Powerful** | Accounts, cloud documents, share links, GPU render workers (headless Cycles) for 4K stills and walkthrough video. |
| **MVP** | Local persistence + file export. One upload endpoint for phone scans. No accounts. |

---

## AI: assistive, per your decision

| | Choice |
|---|---|
| **Powerful** | Natural-language asset search over catalog embeddings; "auto-arrange this room" respecting circulation and sightlines; style transfer across a whole space; generated materials. |
| **MVP** | None, or at most text search over hand-written asset tags. Not on the critical path. |

**"Cleanse the room" — two genuinely different problems; don't conflate them:**
- **3D capture path (the real one).** RoomPlan gives classified furniture boxes; deleting them yields a true blank slate you can then design in. Comes almost free with capture option A.
- **2D defurnishing (the demo).** Segment + diffusion-inpaint a photo or panorama into an empty room. Mature — [Matterport published on exactly this](https://arxiv.org/abs/2405.03682) and commercial tools do it in seconds. Output is an *image*: useful as a reference backdrop, **not something you can design in.**

Build the 3D path. The 2D path is marketing.

---

## Milestones

**M0 — Vertical spike (1–2 weeks). Do this before anything else.**
Throwaway code proving the whole seam: Rust→WASM emits wall geometry for two hand-coded walls; three.js renders with IBL; drag one CC0 GLB chair with floor + wall snapping. Measure WASM bundle size, frame time, Rust↔JS round-trip cost. De-risks every bet above cheaply, and is cheap to abandon if the boundary is wrong.

**M1 — Floorplan & shell.** 2D wall drawing with snapping; parametric doors/windows; extrusion to 3D; room detection from the wall graph. *This is capture path C, and it's the schema that paths A and B must target.*

**M2 — Furnishing.** Catalog ingest + metadata schema; drag-to-place with anchor constraints; move/rotate/duplicate; clearance warnings. Content workstream starts here in parallel.

**M3 — Look.** PBR materials, material swapping, lighting presets, shadows, camera framing. **This milestone decides whether output is convincing enough that anyone shares it.** Do not skip or defer it — for this product, look *is* function.

**M4 — Capture companion (iOS).** Swift app: RoomPlan when LiDAR present, AR corner-tap when not, review/correct, upload. Both paths emit the M1 schema.

**M5 — Persistence & sharing.** Save/load, share links, image + glTF/USDZ export.

**M6+ — Expansion.** Android capture (ARCore + corner-tap), native desktop shell (`wgpu`), cloud final-render, AI assist, collaboration, brand catalog.

**MVP = M0–M4.** M5 is close behind and arguably part of it, since a design nobody can share is a design nobody talks about.

## Deliberately deferred

Named explicitly so they don't creep in: mesh editing of any kind, custom furniture modeling, curved and sloped architecture, multi-floor buildings, lighting simulation and daylighting analysis, cost estimation, Android capture, real-time collaboration, brand catalog, generative 3D. **The wedge is laying out one room. Reject general 3D modeling features by default.**

## Risks

| Risk | Mitigation |
|---|---|
| Rust↔JS boundary too chatty | Coarse typed-array interface; measure in M0 before committing |
| Renderer written twice | Accepted deliberately; the expensive half (Rust core) ports unchanged |
| Asset catalog volume & licensing | Parallel content workstream from M2; get metadata schema right at asset #1 |
| Capture reach narrower than hoped | AR corner-tap (B) is the reach path precisely because ~5–10cm suffices; manual trace (C) always works |
| WebGPU coverage | three.js WebGL2 fallback |
| App Store review / signing friction on the companion | Keep it tiny and single-purpose; start the account and provisioning setup during M3, not M4 |
| Scope creep toward general 3D modeling | See "Deliberately deferred". Default answer is no |

## Verification

- **M0 gate:** `cargo test` passes for wall geometry; dev server loads; two walls render; chair snaps to floor and wall; ≥60fps on integrated GPU; WASM bundle under a stated budget; per-frame boundary cost documented.
- **Geometry correctness:** pure Rust unit tests — wall junction mitering at varied angles, opening cuts near wall ends, snap resolution with competing anchors, degenerate wall graphs.
- **Schema round-trip:** import a real RoomPlan USD export into the M1 schema and re-render it. Do this during M1, using a scan from a borrowed LiDAR device — *before* building the companion app. It validates the highest-leverage decision at the lowest possible cost.
- **Per-milestone user check:** hand the build to someone who has never used Blender or SketchUp and ask them to lay out their own bedroom unassisted. Watch where they stall. This is the only test that measures the actual thesis.

## Step 0 — Repo scaffold (first action on approval)

Placeholder name **`spacelab`** — renameable later with `mv` plus a remote update.

Creates `/Users/mattseismic/code/spacelab/` as a **new git repo**. Note: `/Users/mattseismic/code` is deliberately *not* initialized — it holds ~15 unrelated projects (`brookwell`, `seismic`, `src20-factory`, …) and a repo at that level would sweep them all in.

```
spacelab/
  .git/
  .gitignore              # target/, node_modules/, dist/
  PLAN.md                 # this plan, committed as the project's north star
  Cargo.toml              # workspace manifest
  crates/
    core-scene/           # parametric document: walls, openings, furnishings, command layer
    core-geometry/        # prismatic extrusion, triangulation, snapping (parry3d)
    wasm-bindings/        # wasm-bindgen boundary — coarse typed-array interface only
  web/                    # Vite + React + TypeScript + three.js viewport
  ios/                    # placeholder, populated at M4
```

Crates are stubs with manifests and empty `lib.rs` — no premature implementation. One initial commit.

**Then publish to GitHub:**

```
gh repo create mHaines9219/spacelab --private --source=. --remote=origin --push
```

- **Private**, under the personal account **`mHaines9219`** — explicitly *not* the seismic-systems org.
- Verified: `gh` is authenticated as `mHaines9219` (sole account, `repo` scope), and global git identity is `mhaines / mhaines9219@gmail.com` — personal, not `mh@seismic.systems`. No repo-local identity override needed.

**Then:** re-run Ultraplan from inside `spacelab/`. The two earlier handoff attempts failed solely because cloud agents require a git repository; with a repo and remote in place the launch should succeed and produce the browser link.

> Chosen with the layout-before-refinement tradeoff understood: refinement may reorganize this. Cheap to change while the crates are empty — the commit exists mainly to give the cloud agent real structure to reason about.

---

## Sources

**Blender / licensing** — [Blender License](https://www.blender.org/about/license/) · [GPL legal limits with Blender](https://cgcookie.com/posts/the-gpl-and-the-legal-limits-of-blender) · [Bforartists](https://github.com/Bforartists/Bforartists) · [Bforartists FAQ](https://www.bforartists.de/faq-2/) · [Forking for a custom GUI, Blender Conference 2023](https://conference.blender.org/2023/presentations/1816/)

**Capture** — [caniuse: WebXR](https://caniuse.com/webxr) · [RoomPlan (WWDC22)](https://developer.apple.com/videos/play/wwdc2022/10127/) · [3D Parametric Room Representation with RoomPlan](https://machinelearning.apple.com/research/roomplan) · [RoomPlan LiDAR requirement](https://developer.apple.com/forums/thread/776280) · [ARCore room-scanning feature request](https://github.com/google-ar/arcore-android-sdk/issues/1772) · [CubiCasa developer APIs](https://www.cubi.casa/developers/) · [State of WebXR on iOS](https://launch.variant3d.com/blog/23-06-state-webxr-on-ios-beyond)

**Reconstruction research** — [SceneScript](https://github.com/facebookresearch/scenescript) (CC BY-NC) · [LighthouseGS: indoor 3DGS for panorama-style mobile captures](https://arxiv.org/html/2507.06109v2) · [2DGS-Room](https://arxiv.org/pdf/2412.03428) · [Automatic Defurnishing of Indoor Panoramas](https://arxiv.org/abs/2405.03682) · [Layout Aware Inpainting for Furniture Removal](https://arxiv.org/abs/2210.15796)

**Engine / geometry** — [Manifold](https://github.com/elalish/manifold) · [manifold-3d on npm](https://www.npmjs.com/package/manifold-3d) · [OpenCascade.js](https://ocjs.org/docs/about) · [Zoo Design API](https://zoo.dev/design-api) · [Bevy + WebGPU](https://bevy.org/news/bevy-webgpu/) · [Three.js vs Babylon.js](https://blog.logrocket.com/three-js-vs-babylon-js/)

**Assets** — [Poly Haven License](https://polyhaven.com/license) · [awesome-cc0](https://github.com/madjin/awesome-cc0)

**Comparables** — [Planner 5D](https://planner5d.com/) · [Coohom](https://www.e.coohom.com/) · [HomeByMe](https://home.by.me/en/) · [Womp](https://womp.com/) · [Spline](https://spline.design/)
