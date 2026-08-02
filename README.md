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
ride along it), **set a furnishing aside into a bullpen** and re-import it later with its
size and rotation intact, and **Cmd/Ctrl+Z undoes any action**. Wall corners are **mitred**,
so they close instead of overlapping, and the walls are read as a graph to find **which
areas they actually enclose** — multi-room and branching layouts included. Still open in M1:
resizing a room rebuilds it from scratch, which wipes any wall you added by hand.

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

## AI style search (optional)

The furniture panel has a **"design with AI"** box: describe a look ("a cozy 70s bedroom")
and it proposes a coherent furniture set plus floor/wall/light finishes, which you review
and apply. It works with **no setup** — a built-in offline resolver matches your prompt
against the catalog — and gets better with an LLM.

To route it through a model, add a gitignored `web/.env.local`:

```sh
VITE_OPENROUTER_API_KEY=sk-or-...            # https://openrouter.ai/keys
VITE_OPENROUTER_MODEL=openai/gpt-4o-mini     # optional; any OpenRouter model slug
```

Restart `npm run dev` after adding it. Without the key the app uses the local resolver;
with it, the model answers and **falls back to the local resolver on any error**, so the
feature never hard-fails. The proposal card shows which one answered.

> **Note:** `VITE_*` vars are inlined into the browser bundle at build time, so the key is
> visible to anyone who loads a built site. That is fine for local single-user use; a shared
> deployment should move the OpenRouter call behind a proxy (it is one `fetch` in
> `web/src/llmResolver.ts`).

## Accounts & cloud portfolio (optional)

The app has a landing page (`/`) with **Google sign-in**, a **dashboard** (`/dashboard`)
holding your portfolio of saved rooms in folders plus your settings, and the 3D editor at
`/editor`. This is **additive**: the editor works with no account — localStorage is still
the working store — and saving to the cloud is a manual *"save to portfolio"*. With no
Supabase configured, the sign-in button is disabled and the editor is unaffected.

Backing store is [Supabase](https://supabase.com) (Auth + Postgres with row-level
security). A saved room's `document` is the same opaque `save_json()` envelope stored as
`jsonb` — never parsed server-side, so Rust stays the single source of truth.

### 1. Point the app at a Supabase project

Add these to the gitignored `web/.env.local` (the anon/publishable key is safe to ship —
RLS is what protects data):

```sh
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...     # Project Settings → API → publishable/anon key
```

The schema (`profiles`, `folders`, `projects` + RLS + a profile-on-signup trigger) lives in
the project's Supabase migrations. On a fresh project, apply the same DDL (see the
`accounts_and_portfolio` migration).

### 2. Turn on Google sign-in (a one-time manual step)

Sign-in code is wired, but the Google provider must be configured in two consoles — this
cannot be scripted from the app:

1. **Google Cloud Console** → *APIs & Services → Credentials* → create an **OAuth 2.0 Client
   ID** (type: Web application). Add Supabase's callback as an *Authorized redirect URI*:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`. Copy the **Client ID** and
   **Client secret**.
2. **Supabase dashboard** → *Authentication → Providers → Google* → enable it and paste the
   Client ID + secret. Then under *Authentication → URL Configuration* set the **Site URL**
   (e.g. `http://localhost:5173`) and add your dev/prod URLs to **Redirect URLs** (the app
   returns users to `/dashboard` after sign-in).

Restart `npm run dev` after editing `.env.local`. Until step 2 is done, the button appears
but no real sign-in can complete.
