// Scaffold catalog entries from Poly Haven's open CC0 API — the bulk-source half of
// scaling toward hundreds of pieces.
//
// This writes *recipes*, not masters: each entry gets a `fetch` descriptor (source +
// slug + res) instead of a committed .glb, so `ingest:build` downloads and packs it on
// demand into the gitignored cache (see fetch-master.mjs). Metadata the constraint
// solver needs is derived from the API, not hand-typed:
//   - category   ← Poly Haven's category path        (seating/table/storage/bed/…)
//   - tags       ← Poly Haven's tags
//   - scale      ← native (Poly Haven models are real-world sized — no sizeMeters)
//   - anchor     ← floor, or wall for wall decoration
//   - clearance  ← a per-category default envelope
//   - style      ← "photoreal"
// Front can't be derived, so entries land at yaw 0. Directional pieces (seating, bed,
// storage) scaffold `verified:false` — they owe a pass through `npm run tag`; symmetric
// pieces (tables, lighting, decor) auto-verify since front is immaterial to placement.
//
//   node polyhaven.mjs --category furniture [--limit 40]   # whole category
//   node polyhaven.mjs Sofa_01 Ottoman_01 dining_table     # explicit slugs
//   npm run ingest:polyhaven -- --category furniture --limit 40
//
// A prior yaw or verified:true from a completed `npm run tag` pass is preserved across
// re-scaffolds — re-running never clobbers human verification.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAGS = resolve(HERE, "tags.json");
const API = "https://api.polyhaven.com";
const RES = "1k"; // texture resolution to fetch at build time

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

// Poly Haven's category path (e.g. "Furniture/Storage Furniture/Cabinets") → our schema.
function mapCategory(a) {
  const path = (a.category ?? "").toLowerCase();
  const cats = (a.categories ?? []).map((c) => c.toLowerCase());
  const has = (s) => path.includes(s) || cats.includes(s);
  if (has("bed")) return "bed";
  if (has("seating") || has("sofa") || has("chair") || has("stool") || has("ottoman") || has("bench")) return "seating";
  if (path.includes("storage") || has("shelv") || has("cabinet") || has("drawer") || has("sideboard") || has("bookcase")) return "storage";
  if (has("table") || has("desk")) return "table";
  if (has("lighting") || has("lamp")) return "lighting";
  return "decor";
}

// Per-category defaults: the walk/pull envelope the solver reads, and the anchor.
const DEFAULTS = {
  seating: { anchor: "floor", clearance_m: { front: 0.45, sides: 0, back: 0 } },
  table: { anchor: "floor", clearance_m: { front: 0.45, sides: 0.45, back: 0.45 } },
  storage: { anchor: "floor", clearance_m: { front: 0.6, sides: 0, back: 0 } },
  bed: { anchor: "floor", clearance_m: { front: 0, sides: 0.3, back: 0 } },
  lighting: { anchor: "floor", clearance_m: null },
  decor: { anchor: "floor", clearance_m: null },
};
// Directional pieces have a front that matters for placement → owe manual verification.
const DIRECTIONAL = new Set(["seating", "bed", "storage"]);

function slugToId(slug) {
  return "ph-" + slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// Build one tags entry from a Poly Haven /assets record, preserving a prior human pass.
function scaffold(slug, a, prior) {
  const category = mapCategory(a);
  const d = DEFAULTS[category];
  const author = Object.keys(a.authors ?? {})[0] ?? "Poly Haven";
  const tags = [...new Set([category, ...(a.tags ?? []).slice(0, 6)])];
  const verified = prior?.verified ?? !DIRECTIONAL.has(category); // symmetric → auto-verified
  return {
    id: slugToId(slug),
    file: `${slugToId(slug)}.glb`, // cache filename; not committed
    fetch: { source: "polyhaven", slug, res: RES },
    title: a.name ?? slug,
    source: `Poly Haven — ${author} (CC0)`,
    source_url: `https://polyhaven.com/a/${slug}`,
    license: "CC0-1.0",
    attribution: null,
    // native scale: Poly Haven is real-world sized, so no sizeMeters.
    sizeAxis: "y",
    yawDeg: prior?.yawDeg ?? 0, // front is verified in `npm run tag`, not here
    anchor: d.anchor,
    category,
    style: "photoreal",
    tags,
    verified,
    clearance_m: d.clearance_m,
  };
}

function parseArgs(argv) {
  const out = { slugs: [], category: null, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--category") out.category = argv[++i];
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]);
    else out.slugs.push(argv[i]);
  }
  return out;
}

async function main() {
  const { slugs, category, limit } = parseArgs(process.argv.slice(2));
  if (!slugs.length && !category) {
    console.error("usage: node polyhaven.mjs --category furniture [--limit N] | <slug...>");
    process.exit(2);
  }

  // One /assets call carries name, categories, tags, authors — everything we scaffold from.
  const list = await getJson(`${API}/assets?type=models${category ? `&categories=${category}` : ""}`);
  let picks = category ? Object.keys(list) : slugs;
  picks = picks.filter((s) => list[s]).slice(0, limit);
  if (!picks.length) throw new Error("no matching Poly Haven assets");

  const doc = existsSync(TAGS) ? JSON.parse(readFileSync(TAGS, "utf8")) : { assets: [] };
  doc.assets = doc.assets ?? [];
  const byId = new Map(doc.assets.map((a, i) => [a.id, i]));

  let added = 0, updated = 0, needVerify = 0;
  for (const slug of picks) {
    const id = slugToId(slug);
    const prior = byId.has(id) ? doc.assets[byId.get(id)] : null;
    const entry = scaffold(slug, list[slug], prior);
    if (byId.has(id)) { doc.assets[byId.get(id)] = entry; updated++; }
    else { doc.assets.push(entry); byId.set(id, doc.assets.length - 1); added++; }
    if (!entry.verified) needVerify++;
    console.log(`• ${entry.title}  [${entry.category}]  ${entry.verified ? "auto-verified" : "⚠ verify front"}`);
  }
  writeFileSync(TAGS, JSON.stringify(doc, null, 2) + "\n");
  console.log(`\n${added} added, ${updated} updated → tags.json` +
    `\n${needVerify} directional piece(s) owe a front check in npm run tag` +
    `\nThen: npm run ingest:build  (fetches masters into _cache/, normalises, indexes)`);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
