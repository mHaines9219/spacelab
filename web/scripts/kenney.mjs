// Convert selected pieces from the Kenney Furniture Kit (CC0) into catalog masters.
//
// Kenney ships OBJ + a shared texture atlas, not GLB, so this extracts the kit,
// keyword-matches a complementary furniture set, converts each OBJ→GLB (obj2gltf)
// into web/assets-src/, and merges tag entries into tags.json. Then run the normal
// `npm run ingest:build` to normalise + index them.
//
//   1. drop the kit zip at  web/assets-src/_kenney/furniture-kit.zip
//   2. npm run ingest:kenney      (this script)
//   3. npm run ingest:build
//
// Sizes below are best-guess real-world defaults keyed on height; after building,
// sanity-check the DERIVED width/depth in the build output and adjust tags.json (a
// round table keyed on height once back-computed a 2.1 m diameter — same trap).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename } from "node:path";
import obj2gltf from "obj2gltf";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, "../assets-src");
const KENNEY_DIR = resolve(SRC_DIR, "_kenney");
const ZIP = resolve(KENNEY_DIR, "furniture-kit.zip");
const EXTRACT = resolve(KENNEY_DIR, "extracted");
const TAGS = resolve(HERE, "tags.json");

// Complementary set (the catalog already has couch, tables, nightstand, lamp,
// cabinet, armchair). `match` are case-insensitive substrings tried against OBJ
// basenames; the first hit wins. sizeMeters is along sizeAxis (default y = height).
const PICKS = [
  // Beds are defined by length, not height — keying height blows up the footprint.
  { id: "kenney-bed", title: "Bed (Double)", match: ["beddouble", "bed"], category: "bed", sizeAxis: "z", sizeMeters: 2.0, tags: ["bed", "double", "bedroom"], clearance_m: { front: 0, sides: 0.3, back: 0 } },
  { id: "kenney-chair", title: "Chair", match: ["chairrounded", "chairdesk", "chair"], category: "seating", sizeAxis: "y", sizeMeters: 0.9, tags: ["chair", "dining", "desk"], clearance_m: { front: 0.4, sides: 0, back: 0 } },
  { id: "kenney-bookcase", title: "Bookcase", match: ["bookcaseclosed", "bookcaseopen", "bookcase"], category: "storage", sizeAxis: "y", sizeMeters: 1.8, tags: ["bookcase", "shelf", "storage"], clearance_m: { front: 0.4, sides: 0, back: 0 } },
  { id: "kenney-rug", title: "Rug", match: ["rugrounded", "rugsquare", "ruground", "rug"], category: "decor", sizeAxis: "x", sizeMeters: 1.6, tags: ["rug", "floor", "decor"], clearance_m: null },
  { id: "kenney-plant", title: "Potted Plant", match: ["pottedplant", "plantsmall", "plant"], category: "decor", sizeAxis: "y", sizeMeters: 0.5, tags: ["plant", "greenery", "decor"], clearance_m: null },
];

if (!existsSync(ZIP)) {
  console.error(`No kit zip at ${ZIP}\nDownload the CC0 Furniture Kit from https://kenney.nl/assets/furniture-kit and drop it there.`);
  process.exit(1);
}

// Fresh extract.
mkdirSync(EXTRACT, { recursive: true });
console.log("extracting kit…");
execFileSync("unzip", ["-oq", ZIP, "-d", EXTRACT]);

// Discover every .obj in the kit.
const objs = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.toLowerCase().endsWith(".obj")) objs.push(p);
  }
};
walk(EXTRACT);
console.log(`found ${objs.length} OBJ models in the kit`);

// Respect keyword priority: try the most specific term across all OBJs first, so
// "beddouble" wins over a bare "bed" that would otherwise grab bedBunk.
const findObj = (matches) => {
  for (const m of matches) {
    const hit = objs.find((o) => basename(o).toLowerCase().includes(m));
    if (hit) return hit;
  }
  return undefined;
};

const newEntries = [];
for (const pick of PICKS) {
  const obj = findObj(pick.match);
  if (!obj) {
    console.warn(`  ! no OBJ matched ${pick.id} (${pick.match.join(", ")}) — skipping`);
    continue;
  }
  const outFile = `${pick.id}.glb`;
  const glb = await obj2gltf(obj, { binary: true });
  writeFileSync(resolve(SRC_DIR, outFile), glb);
  console.log(`  ✓ ${basename(obj)} → assets-src/${outFile}`);
  newEntries.push({
    id: pick.id,
    file: outFile,
    title: pick.title,
    source: "Kenney Furniture Kit (CC0)",
    source_url: "https://kenney.nl/assets/furniture-kit",
    license: "CC0-1.0",
    attribution: null,
    sizeMeters: pick.sizeMeters,
    sizeAxis: pick.sizeAxis,
    yawDeg: 0,
    anchor: "floor",
    category: pick.category,
    tags: pick.tags,
    clearance_m: pick.clearance_m,
  });
}

// Merge into tags.json (skip ids already present, so re-runs are idempotent).
const doc = JSON.parse(readFileSync(TAGS, "utf8"));
const have = new Set((doc.assets ?? []).map((a) => a.id));
const added = newEntries.filter((e) => !have.has(e.id));
doc.assets = [...(doc.assets ?? []), ...added];
writeFileSync(TAGS, JSON.stringify(doc, null, 2) + "\n");

console.log(`\nmerged ${added.length} new entries into tags.json (${newEntries.length - added.length} already present).`);
console.log("Next: npm run ingest:build — then sanity-check the derived dims in the output.");
