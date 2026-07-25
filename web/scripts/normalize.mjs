// Normalize a raw GLB into a catalog-ready asset.
//
// A warehouse model arrives at arbitrary scale, arbitrary origin, facing an
// arbitrary direction. The constraint solver in core-scene needs the opposite:
// real-world metres, origin at the base centre (floor anchor), front along +Z.
// This is the "mirror-and-normalise" step from PLAN.md §5 — the reason we ingest
// rather than hotlink. The manual judgement (how tall is it really? which way is
// front?) comes in as a tag spec; everything here is deterministic.
//
// CLI:  node normalize.mjs <in.glb> <out.glb> --size-axis y --size 0.85 --yaw 90 [--no-compress]
// Test: node normalize.mjs --self-test         (runs on public/assets/sheen-chair.glb, no API key)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, prune, weld, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- column-major 4x4 helpers (glTF node matrices are column-major) ------------
const mul = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
};
const translation = (x, y, z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
const scaling = (s) => [s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1];
const rotationY = (rad) => {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1];
};

// Pre-multiply a world-space transform onto every root node of the default scene.
// Root nodes have no parent, so local == world and this is exact.
const applyWorld = (roots, m) =>
  roots.forEach((n) => n.setMatrix(mul(m, n.getMatrix())));

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

const AXIS = { x: 0, y: 1, z: 2 };

/**
 * @param {object} o
 * @param {string} o.inputPath
 * @param {string} o.outputPath
 * @param {"x"|"y"|"z"} o.sizeAxis   which real-world dimension `sizeMeters` refers to
 * @param {number} [o.sizeMeters]    target real-world length along sizeAxis. OMIT for
 *                                   sources already modelled to real-world scale
 *                                   (Poly Haven, most architectural assets) — the
 *                                   native size is kept and only recenter/orient run.
 * @param {number} [o.yawDeg=0]      rotation about +Y to make the model's front face +Z
 * @param {boolean} [o.compress=true]
 * @returns measured result (post-normalise, pre-compression — equals visual dims)
 */
export async function normalizeGlb({ inputPath, outputPath, sizeAxis = "y", sizeMeters, yawDeg = 0, compress = true }) {
  const bytesIn = readFileSync(inputPath).length;
  const doc = await io.read(inputPath);
  await doc.transform(dedup(), prune(), weld());

  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const roots = scene.listChildren();

  // 1. orient: rotate so front -> +Z
  if (yawDeg) applyWorld(roots, rotationY((yawDeg * Math.PI) / 180));

  // 2. scale: match the tagged real-world dimension (uniform — real objects keep
  //    proportions). Skipped when sizeMeters is omitted: the source is already
  //    real-world-scaled and we preserve its native size.
  if (sizeMeters != null) {
    const b1 = getBounds(scene);
    const ext1 = [b1.max[0] - b1.min[0], b1.max[1] - b1.min[1], b1.max[2] - b1.min[2]];
    const ai = AXIS[sizeAxis];
    if (!(ext1[ai] > 0)) throw new Error(`degenerate bounds on axis ${sizeAxis}: ${ext1[ai]}`);
    applyWorld(roots, scaling(sizeMeters / ext1[ai]));
  }

  // 3. recenter: origin at base centre — X/Z centred, min Y on the floor plane
  const b2 = getBounds(scene);
  applyWorld(roots, translation(
    -(b2.min[0] + b2.max[0]) / 2,
    -b2.min[1],
    -(b2.min[2] + b2.max[2]) / 2,
  ));

  // measure the normalised result (this is what the catalog records)
  const b3 = getBounds(scene);
  const measured = { x: b3.max[0] - b3.min[0], y: b3.max[1] - b3.min[1], z: b3.max[2] - b3.min[2] };
  const centerXZ = [(b3.min[0] + b3.max[0]) / 2, (b3.min[2] + b3.max[2]) / 2];
  const minY = b3.min[1];

  let compressed = false;
  if (compress) {
    try {
      await MeshoptEncoder.ready;
      await doc.transform(reorder({ encoder: MeshoptEncoder, target: "size" }), quantize());
      doc.createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
      compressed = true;
    } catch (e) {
      console.warn(`  ! meshopt compression skipped: ${e.message}`);
    }
  }

  await io.write(outputPath, doc);
  const bytesOut = readFileSync(outputPath).length;
  return { measured, centerXZ, minY, bytesIn, bytesOut, compressed };
}

// --- CLI ----------------------------------------------------------------------
function parseArgs(argv) {
  const [inputPath, outputPath] = argv.filter((a) => !a.startsWith("--"));
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : def;
  };
  return {
    inputPath,
    outputPath,
    sizeAxis: flag("size-axis", "y"),
    sizeMeters: Number(flag("size", "1")),
    yawDeg: Number(flag("yaw", "0")),
    compress: !argv.includes("--no-compress"),
  };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    const inputPath = resolve(HERE, "../public/assets/sheen-chair.glb");
    const outputPath = resolve(HERE, "../public/assets/models/_selftest-chair.glb");
    const target = 1.0; // scale the chair to exactly 1.0 m tall so the scale step is visibly exercised
    const r = await normalizeGlb({ inputPath, outputPath, sizeAxis: "y", sizeMeters: target, yawDeg: 0 });
    const round = (n) => Math.round(n * 1e4) / 1e4;
    console.log("self-test result:", {
      measured: { x: round(r.measured.x), y: round(r.measured.y), z: round(r.measured.z) },
      minY: round(r.minY), centerXZ: r.centerXZ.map(round),
      bytesIn: r.bytesIn, bytesOut: r.bytesOut, compressed: r.compressed,
    });
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const checks = [
      ["height == target (1.0m)", near(r.measured.y, target, 1e-3)],
      ["rests on floor (minY == 0)", near(r.minY, 0, 1e-3)],
      ["centred on X", near(r.centerXZ[0], 0, 1e-3)],
      ["centred on Z", near(r.centerXZ[1], 0, 1e-3)],
      ["compression applied", r.compressed === true],
      ["output smaller than input", r.bytesOut < r.bytesIn],
    ];
    let ok = true;
    for (const [name, pass] of checks) { console.log(`  ${pass ? "✓" : "✗"} ${name}`); ok &&= pass; }
    process.exit(ok ? 0 : 1);
  } else {
    const opts = parseArgs(argv);
    if (!opts.inputPath || !opts.outputPath) {
      console.error("usage: node normalize.mjs <in.glb> <out.glb> --size-axis y --size 0.85 --yaw 90 [--no-compress]");
      process.exit(2);
    }
    const r = await normalizeGlb(opts);
    console.log(JSON.stringify(r, null, 2));
  }
}
