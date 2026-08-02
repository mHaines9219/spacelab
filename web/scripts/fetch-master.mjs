// Resolve a tags.json entry to a local master .glb — fetching re-fetchable sources.
//
// The catalog scales past what git can hold if every master is committed (500 pieces ≈
// half a gig). So re-downloadable sources aren't committed: a `fetch` descriptor on the
// tags entry says how to regenerate the master, and it lands in the gitignored cache
// (`assets-src/_cache/`) on demand — the same "regenerate, don't commit" model
// `fetch-textures.sh` already uses for textures. Truly irreplaceable masters (a supplied
// ArchSense export) still commit as a plain `file` with no `fetch`.
//
// Shared by `ingest:build` (needs the master to normalise) and the tag preview server
// (needs it to render), so a fetch happens at most once and both reuse the cache.

import { mkdirSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, "../assets-src");
const CACHE = resolve(SRC_DIR, "_cache"); // gitignored, re-fetchable masters
const API = "https://api.polyhaven.com";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// Network flakiness is a given at hundreds of fetches, so retry transient failures
// (dropped connection, 5xx) with backoff before giving up. A 4xx isn't retried.
async function fetchRetry(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      last = new Error(`GET ${url} → ${r.status}`);
      if (r.status < 500) throw last; // client error — retrying won't help
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  throw last;
}
async function getJson(url) {
  return (await fetchRetry(url)).json();
}
async function download(url, dest) {
  const r = await fetchRetry(url);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

// Poly Haven ships glTF + .bin + textures (not single-file GLB), so download the bundle
// preserving the relative paths the .gltf references, then repack to one .glb at `out`.
async function fetchPolyhaven(spec, out) {
  const res = spec.res ?? "1k";
  const files = await getJson(`${API}/files/${spec.slug}`);
  const gltf = files?.gltf?.[res]?.gltf;
  if (!gltf?.url) throw new Error(`no ${res} glTF for ${spec.slug}`);
  const tmp = join(CACHE, "_tmp", spec.slug);
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  const gltfPath = join(tmp, `${spec.slug}.gltf`);
  await download(gltf.url, gltfPath);
  for (const [rel, meta] of Object.entries(gltf.include ?? {})) {
    await download(meta.url, join(tmp, rel));
  }
  const doc = await io.read(gltfPath);
  mkdirSync(dirname(out), { recursive: true });
  await io.write(out, doc);
  rmSync(tmp, { recursive: true, force: true });
}

const FETCHERS = { polyhaven: fetchPolyhaven };

/**
 * Return an absolute path to the entry's master .glb, producing it if it's a
 * re-fetchable source not yet cached. Never commits anything — cached masters live
 * under the gitignored `assets-src/_cache/`.
 * @param {{id:string,file:string,fetch?:{source:string}}} entry
 */
export async function ensureMaster(entry) {
  if (entry.fetch) {
    const cached = resolve(CACHE, entry.file);
    if (!existsSync(cached)) {
      const fetcher = FETCHERS[entry.fetch.source];
      if (!fetcher) throw new Error(`unknown fetch source '${entry.fetch.source}' for ${entry.id}`);
      await fetcher(entry.fetch, cached);
    }
    return cached;
  }
  // Committed master: a plain file in assets-src/ (irreplaceable input, no `fetch`).
  const committed = resolve(SRC_DIR, entry.file);
  if (!existsSync(committed)) throw new Error(`master not found: assets-src/${entry.file} (and no fetch descriptor)`);
  if (statSync(committed).isDirectory()) throw new Error(`glTF-folder ingest not wired yet for ${entry.file} — supply a .glb`);
  if (extname(committed).toLowerCase() !== ".glb") throw new Error(`unsupported master type: ${entry.file} (expected .glb)`);
  return committed;
}

export { CACHE, SRC_DIR };
