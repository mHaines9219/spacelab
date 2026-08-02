// Dev-only Vite middleware backing the tag-time preview (`web/tag.html`).
//
// The tag step edits `scripts/tags.json` by hand, blind: `front` is written `+Z`
// on faith and derived W×D×H aren't seen until after a build. This server lets the
// browser preview do that verification against the real geometry — so it exposes
// three things the preview needs and nothing else:
//
//   GET  /tag-api/manifest      → { assets: [tagged entries], untagged: [glb files] }
//   GET  /assets-src/<file>     → the raw master GLB (masters live outside publicDir)
//   POST /tag-api/tags          → upsert one entry back into scripts/tags.json
//
// It only mounts under `vite dev`; nothing here ships in a build. The write path
// keeps tags.json in the exact shape `npm run ingest:build` reads (2-space indent,
// trailing newline, entry order preserved), so save-from-preview → rebuild is a
// closed loop with no hand-editing in between.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { ensureMaster } from "./fetch-master.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, "../assets-src");
const TAGS = resolve(HERE, "tags.json");

const readTags = () => JSON.parse(readFileSync(TAGS, "utf8"));

// Every .glb sitting in assets-src/, ignoring the gitignored _kenney scratch dir.
function listMasters() {
  if (!existsSync(SRC_DIR)) return [];
  return readdirSync(SRC_DIR)
    .filter((f) => f.toLowerCase().endsWith(".glb"))
    .filter((f) => statSync(join(SRC_DIR, f)).isFile())
    .sort();
}

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(s);
}

function readBody(req) {
  return new Promise((ok, err) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => ok(raw));
    req.on("error", err);
  });
}

// Upsert one entry by id, preserving position for edits and appending new ones.
// Returns the entry as written so the client can confirm what landed on disk.
function saveEntry(entry) {
  if (!entry || typeof entry.id !== "string" || !entry.id) throw new Error("entry needs a string id");
  if (typeof entry.file !== "string" || !entry.file) throw new Error("entry needs a file");
  if (!existsSync(join(SRC_DIR, entry.file))) throw new Error(`no master assets-src/${entry.file}`);
  const doc = readTags();
  doc.assets = doc.assets ?? [];
  const i = doc.assets.findIndex((a) => a.id === entry.id);
  if (i >= 0) doc.assets[i] = entry;
  else doc.assets.push(entry);
  writeFileSync(TAGS, JSON.stringify(doc, null, 2) + "\n");
  return entry;
}

/** @returns {import('vite').Plugin} */
export function tagServer() {
  return {
    name: "spacelab-tag-server",
    apply: "serve", // dev only — never part of a build
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];

        if (url === "/tag-api/manifest" && req.method === "GET") {
          const doc = readTags();
          const assets = doc.assets ?? [];
          const tagged = new Set(assets.map((a) => a.file));
          const untagged = listMasters().filter((f) => !tagged.has(f));
          return sendJson(res, 200, { assets, untagged });
        }

        if (url === "/tag-api/tags" && req.method === "POST") {
          return readBody(req).then((raw) => {
            try {
              const saved = saveEntry(JSON.parse(raw));
              sendJson(res, 200, { ok: true, entry: saved });
            } catch (e) {
              sendJson(res, 400, { ok: false, error: e.message });
            }
          });
        }

        if (url.startsWith("/assets-src/") && req.method === "GET") {
          // Serve a single master. Reject path traversal — only bare filenames in SRC_DIR.
          const name = decodeURIComponent(url.slice("/assets-src/".length));
          if (name.includes("/") || name.includes("..") || !name.toLowerCase().endsWith(".glb")) {
            res.statusCode = 400;
            return res.end("bad master name");
          }
          // A tagged entry may be re-fetchable (no committed file) — ensureMaster fetches
          // it into the cache on first preview. An untagged committed .glb serves directly.
          const entry = (readTags().assets ?? []).find((a) => a.file === name);
          const serve = (p) => {
            res.setHeader("Content-Type", "model/gltf-binary");
            res.setHeader("Cache-Control", "no-store");
            res.end(readFileSync(p));
          };
          if (entry) {
            return ensureMaster(entry).then(
              (p) => serve(p),
              (e) => { res.statusCode = 502; res.end(`fetch failed: ${e.message}`); },
            );
          }
          const p = join(SRC_DIR, name);
          if (!existsSync(p)) {
            res.statusCode = 404;
            return res.end("no such master");
          }
          return serve(p);
        }

        next();
      });
    },
  };
}
