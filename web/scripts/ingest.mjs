// Catalog ingest — file-based, source-agnostic.
//
// Drop a curated master into `web/assets-src/` (GLB, or a glTF folder), describe it
// in tags.json, then `npm run ingest:build`. Each master is normalised (orient
// front→+Z, optional scale to real size, recenter origin to base-centre, meshopt-
// compress) into public/assets/models/ and indexed in catalog.json.
//
// This is the sourcing model from PLAN.md §5: curated assets we own, not a live
// warehouse. It's the same drop-in flow for CC0 downloads and for supplied assets
// (e.g. ArchSense exports) — provenance is recorded per asset in tags.json.
//
// catalog.json IS the metadata index at this scale (tens of assets, committed to
// git). A real DB only earns its keep with hundreds of assets, uploads, or
// server-side search.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { normalizeGlb } from "./normalize.mjs";
import { ensureMaster } from "./fetch-master.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(HERE, "../public/assets/models"); // normalised output (gitignored)
const TAGS = resolve(HERE, "tags.json");
const CATALOG = resolve(HERE, "../public/assets/catalog.json");

async function build() {
  if (!existsSync(TAGS)) throw new Error(`no tags.json at ${TAGS}`);
  const assets = JSON.parse(readFileSync(TAGS, "utf8")).assets ?? [];
  if (!assets.length) throw new Error("tags.json has no assets");
  mkdirSync(MODELS_DIR, { recursive: true });

  const catalog = [];
  const failed = [];
  const round = (n) => Math.round(n * 1000) / 1000;
  for (const a of assets) {
    if (!a.id || !a.file) { console.warn(`  ! skipping entry missing id/file: ${JSON.stringify(a)}`); continue; }
    console.log(`• ${a.title ?? a.id}${a.fetch ? "  (fetched)" : ""}`);
    try {
      // Committed masters resolve locally; re-fetchable sources (a `fetch` descriptor)
      // download into the gitignored cache here, so the catalog isn't bounded by git.
      const src = await ensureMaster(a);
      const out = resolve(MODELS_DIR, `${a.id}.glb`);
      const r = await normalizeGlb({
        inputPath: src, outputPath: out,
        sizeAxis: a.sizeAxis ?? "y", sizeMeters: a.sizeMeters, yawDeg: a.yawDeg ?? 0,
      });
      catalog.push({
        asset_id: a.id,
        title: a.title ?? a.id,
        source: a.source ?? null,           // e.g. "Quaternius (CC0)"
        source_url: a.source_url ?? null,
        license: a.license ?? null,
        attribution: a.attribution ?? null, // null when licence needs none (CC0)
        category: a.category ?? null,
        style: a.style ?? null,             // "photoreal" | "lowpoly" — lets search pick a coherent look
        tags: a.tags ?? [],
        dims_m: { w: round(r.measured.x), h: round(r.measured.y), d: round(r.measured.z) },
        anchor: a.anchor ?? "floor",
        front: "+Z",
        // Whether a human has confirmed front/dims in `npm run tag`. Directional pieces
        // (seating/bed/storage) scaffold as false; symmetric ones auto-verify.
        verified: a.verified ?? false,
        clearance_m: a.clearance_m ?? null,
        blob: `models/${a.id}.glb`,
      });
      const scaled = a.sizeMeters != null ? ` scaled→${a.sizeAxis ?? "y"}=${a.sizeMeters}m` : " native scale";
      console.log(`  ✓ ${round(r.measured.x)}×${round(r.measured.y)}×${round(r.measured.z)} m${scaled}` +
        `, ${(r.bytesIn / 1024).toFixed(0)}→${(r.bytesOut / 1024).toFixed(0)} KB${r.compressed ? " (meshopt)" : ""}`);
    } catch (e) {
      // One bad asset (a dropped download, a corrupt master) must not sink a 500-asset
      // build. Skip it, keep its prior catalog output if any, and report at the end.
      failed.push({ id: a.id, error: e.message });
      console.warn(`  ✗ skipped: ${e.message}`);
    }
  }
  writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`\n${catalog.length} assets -> ${CATALOG}`);
  if (failed.length) {
    console.warn(`\n${failed.length} skipped (re-run to retry — cached masters won't re-download):`);
    for (const f of failed) console.warn(`  ✗ ${f.id}: ${f.error}`);
  }
}

try {
  await build();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
