// Tag-time 3D preview — dev-only tool behind `web/tag.html`.
//
// The tagging step in scripts/tags.json was blind: `front` got written "+Z" on faith
// (a thumbnail from an unknown camera angle can't confirm model-local front), and the
// derived W×D×H weren't visible until after a build (keying a piece on the wrong axis
// silently back-computed a 2.1 m round table). This tool closes both gaps against the
// real geometry: it applies the EXACT normalize.mjs transform (orient → scale →
// recenter) live, so what you see is what `ingest:build` will emit — then writes the
// confirmed entry straight back to tags.json.
//
// It re-derives the transform rather than importing normalize.mjs because that module
// runs in Node against gltf-transform docs; here we do the same three steps on a
// three.js object and read the AABB back. Keep the two in lockstep.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

type Axis = "x" | "y" | "z";

type Entry = {
  id: string;
  file: string;
  fetch?: { source: string; slug?: string; res?: string }; // re-fetchable source; no committed master
  title?: string;
  source?: string | null;
  source_url?: string | null;
  license?: string | null;
  attribution?: string | null;
  sizeMeters?: number; // omitted → keep native scale
  sizeAxis?: Axis;
  yawDeg?: number;
  anchor?: "floor" | "wall";
  category?: string;
  style?: string | null; // "photoreal" | "lowpoly"
  tags?: string[];
  verified?: boolean; // a human confirmed front/dims here
  clearance_m?: { front: number; sides: number; back: number } | null;
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const M_TO_IN = 39.3701;

// ---- scene -------------------------------------------------------------------
const canvas = $("view") as HTMLCanvasElement;
const stage = canvas.parentElement as HTMLElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
pmrem.dispose();

const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(2, 3, 2.5);
scene.add(key);
scene.add(new THREE.AmbientLight(0xffffff, 0.15));

// 1 m grid: "does it fit?" is answerable by eye against the squares.
const grid = new THREE.GridHelper(8, 8, 0x3a3d44, 0x24272d);
scene.add(grid);

// Front reference: the catalog convention is front → +Z. The operator rotates the
// model until its real front (a sofa's seat, a cabinet's doors) points down this arrow.
const front = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.01, 0), 1.4, 0x5b9dff, 0.28, 0.16);
scene.add(front);
scene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0.01, 0), 0.6, 0xd06666, 0.16, 0.1)); // +X, red

function label(text: string, color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.font = "bold 34px ui-monospace, monospace";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(0.9, 0.225, 1);
  return sprite;
}
const frontLabel = label("FRONT +Z", "#8fbaff");
frontLabel.position.set(0, 0.28, 1.5);
scene.add(frontLabel);

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
camera.position.set(1.8, 1.6, 3.2);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0.5, 0);

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
let model: THREE.Object3D | null = null;

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h || 1;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---- the normalize.mjs transform, live ---------------------------------------
const box = new THREE.Box3();
const AXIS: Record<Axis, "x" | "y" | "z"> = { x: "x", y: "y", z: "z" };

// Mirrors normalize.mjs step-for-step: orient (yaw about +Y) → scale (uniform, to the
// tagged real dimension, or skipped for native-scale sources) → recenter (base centre:
// X/Z centred, min-Y on the floor). Returns the measured extent the catalog records.
function applyTransform(obj: THREE.Object3D, opts: { yawDeg: number; sizeMeters?: number; sizeAxis: Axis }): THREE.Vector3 {
  obj.position.set(0, 0, 0);
  obj.rotation.set(0, 0, 0);
  obj.scale.setScalar(1);
  obj.rotation.y = (opts.yawDeg * Math.PI) / 180;
  obj.updateMatrixWorld(true);

  if (opts.sizeMeters != null && opts.sizeMeters > 0) {
    box.setFromObject(obj);
    const ext = box.getSize(new THREE.Vector3());
    const along = ext[AXIS[opts.sizeAxis]];
    if (along > 0) {
      obj.scale.setScalar(opts.sizeMeters / along);
      obj.updateMatrixWorld(true);
    }
  }

  box.setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.x -= c.x;
  obj.position.z -= c.z;
  obj.position.y -= box.min.y;
  obj.updateMatrixWorld(true);

  box.setFromObject(obj);
  return box.getSize(new THREE.Vector3());
}

function frameCamera(size: THREE.Vector3) {
  const radius = Math.max(0.3, size.length() / 2);
  const center = new THREE.Vector3(0, size.y / 2, 0);
  const dir = new THREE.Vector3(0.45, 0.5, 1).normalize(); // from the +Z (front) side, slightly above
  const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.35;
  camera.position.copy(center).add(dir.multiplyScalar(dist));
  controls.target.copy(center);
  controls.update();
}

// ---- readout -----------------------------------------------------------------
const readout = $("readout");
function updateReadout(size: THREE.Vector3, native: boolean) {
  const m = (n: number) => n.toFixed(3);
  const inch = (n: number) => (n * M_TO_IN).toFixed(1);
  const odd = (n: number) => n < 0.02 || n > 4; // flags a mis-keyed size axis
  const flag = odd(size.x) || odd(size.y) || odd(size.z);
  readout.innerHTML =
    `<div class="big">${m(size.x)} × ${m(size.y)} × ${m(size.z)} m</div>` +
    `<div class="muted">W × H × D · ${inch(size.x)} × ${inch(size.y)} × ${inch(size.z)} in</div>` +
    `<div class="muted">${native ? "native scale (source is real-world)" : "scaled to tagged size"}</div>` +
    (flag ? `<div style="color:#ffb454">⚠ a dimension looks off — check the size axis</div>` : "");
}

// ---- field <-> entry ---------------------------------------------------------
function readFields(): Entry {
  const native = ($("f-native") as HTMLInputElement).checked;
  const tags = ($("f-tags") as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean);
  const num = (id: string) => {
    const v = ($(id) as HTMLInputElement).value.trim();
    return v === "" ? null : Number(v);
  };
  const clOn = ($("f-clearance-on") as HTMLInputElement).checked;
  const attribution = ($("f-attribution") as HTMLInputElement).value.trim();
  const e: Entry = {
    id: ($("f-id") as HTMLInputElement).value.trim(),
    file: current!.file,
    title: ($("f-title") as HTMLInputElement).value.trim() || undefined,
    source: ($("f-source") as HTMLInputElement).value.trim() || null,
    source_url: ($("f-source-url") as HTMLInputElement).value.trim() || null,
    license: ($("f-license") as HTMLInputElement).value.trim() || null,
    attribution: attribution || null,
    sizeAxis: ($("f-axis") as HTMLSelectElement).value as Axis,
    yawDeg: Number(($("f-yaw") as HTMLInputElement).value) || 0,
    anchor: ($("f-anchor") as HTMLSelectElement).value as "floor" | "wall",
    category: ($("f-category") as HTMLInputElement).value.trim() || undefined,
    tags,
    clearance_m: clOn
      ? { front: num("f-cl-front") ?? 0, sides: num("f-cl-sides") ?? 0, back: num("f-cl-back") ?? 0 }
      : null,
  };
  if (!native) {
    const s = num("f-size");
    if (s != null && s > 0) e.sizeMeters = s;
  }
  // Carry fields the form doesn't edit, and mark verified — reaching Save means a human
  // just checked front + dims against the geometry.
  if (current!.fetch) e.fetch = current!.fetch;
  if (current!.style != null) e.style = current!.style;
  e.verified = true;
  return e;
}

function writeFields(e: Entry) {
  ($("f-id") as HTMLInputElement).value = e.id;
  ($("f-title") as HTMLInputElement).value = e.title ?? "";
  ($("f-yaw") as HTMLInputElement).value = String(e.yawDeg ?? 0);
  const native = e.sizeMeters == null;
  ($("f-native") as HTMLInputElement).checked = native;
  ($("f-axis") as HTMLSelectElement).value = e.sizeAxis ?? "y";
  ($("f-size") as HTMLInputElement).value = e.sizeMeters != null ? String(e.sizeMeters) : "";
  ($("f-anchor") as HTMLSelectElement).value = e.anchor ?? "floor";
  ($("f-category") as HTMLInputElement).value = e.category ?? "";
  ($("f-tags") as HTMLInputElement).value = (e.tags ?? []).join(", ");
  const clOn = e.clearance_m != null;
  ($("f-clearance-on") as HTMLInputElement).checked = clOn;
  ($("f-cl-front") as HTMLInputElement).value = clOn ? String(e.clearance_m!.front) : "";
  ($("f-cl-sides") as HTMLInputElement).value = clOn ? String(e.clearance_m!.sides) : "";
  ($("f-cl-back") as HTMLInputElement).value = clOn ? String(e.clearance_m!.back) : "";
  ($("f-source") as HTMLInputElement).value = e.source ?? "";
  ($("f-source-url") as HTMLInputElement).value = e.source_url ?? "";
  ($("f-license") as HTMLInputElement).value = e.license ?? "";
  ($("f-attribution") as HTMLInputElement).value = e.attribution ?? "";
  syncDisabled();
}

function syncDisabled() {
  const native = ($("f-native") as HTMLInputElement).checked;
  ($("f-axis") as HTMLSelectElement).disabled = native;
  ($("f-size") as HTMLInputElement).disabled = native;
  const clOn = ($("f-clearance-on") as HTMLInputElement).checked;
  for (const id of ["f-cl-front", "f-cl-sides", "f-cl-back"]) ($(id) as HTMLInputElement).disabled = !clOn;
}

// Re-apply the transform from the current field values (no reload of geometry).
function reapply(refame = false) {
  if (!model || !current) return;
  const e = readFields();
  const size = applyTransform(model, { yawDeg: e.yawDeg ?? 0, sizeMeters: e.sizeMeters, sizeAxis: e.sizeAxis ?? "y" });
  updateReadout(size, e.sizeMeters == null);
  if (refame) frameCamera(size);
}

// ---- load a master -----------------------------------------------------------
let current: Entry | null = null;

async function load(e: Entry) {
  current = e;
  $("fields").hidden = false;
  writeFields(e);
  setStatus("");
  if (model) {
    scene.remove(model);
    model = null;
  }
  const gltf = await loader.loadAsync(`/assets-src/${e.file}`);
  model = gltf.scene;
  scene.add(model);
  reapply(true);
}

// ---- manifest + list ---------------------------------------------------------
function defaultEntry(file: string): Entry {
  const id = file.replace(/\.glb$/i, "");
  return { id, file, title: id, yawDeg: 0, anchor: "floor", sizeAxis: "y", tags: [], license: "CC0-1.0", attribution: null };
}

async function loadManifest() {
  const res = await fetch("/tag-api/manifest");
  const { assets, untagged } = (await res.json()) as { assets: Entry[]; untagged: string[] };
  const list = $("list");
  list.innerHTML = "";
  const add = (e: Entry, tagged: boolean) => {
    const b = document.createElement("button");
    // Directional pieces scaffold verified:false — surface them as the work queue.
    const cls = !tagged ? "untagged" : e.verified === false ? "untagged" : "tagged";
    const txt = !tagged ? "new" : e.verified === false ? "verify" : "tagged";
    b.innerHTML = `<span>${e.title ?? e.id}</span><span class="badge ${cls}">${txt}</span>`;
    b.onclick = () => {
      for (const el of list.querySelectorAll("button")) el.classList.remove("active");
      b.classList.add("active");
      load(tagged ? e : defaultEntry(e.file));
    };
    list.appendChild(b);
  };
  for (const e of assets) add(e, true);
  for (const f of untagged) add(defaultEntry(f), false);
  if (!assets.length && !untagged.length) list.innerHTML = `<p class="note" style="padding:8px 14px">No masters in assets-src/.</p>`;
}

// ---- save --------------------------------------------------------------------
function setStatus(msg: string, kind: "ok" | "err" | "" = "") {
  const s = $("status");
  s.textContent = msg;
  s.className = `status ${kind}`;
}

async function save() {
  if (!current) return;
  const e = readFields();
  if (!e.id) return setStatus("id is required", "err");
  ($("save") as HTMLButtonElement).disabled = true;
  try {
    const res = await fetch("/tag-api/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e) });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setStatus(`saved → tags.json · run npm run ingest:build`, "ok");
    await loadManifest();
  } catch (err) {
    setStatus(`save failed: ${(err as Error).message}`, "err");
  } finally {
    ($("save") as HTMLButtonElement).disabled = false;
  }
}

// ---- wiring ------------------------------------------------------------------
for (const id of ["f-yaw", "f-size", "f-axis", "f-native", "f-clearance-on", "f-cl-front", "f-cl-sides", "f-cl-back"]) {
  const el = $(id);
  el.addEventListener("input", () => {
    syncDisabled();
    reapply();
  });
  el.addEventListener("change", () => {
    syncDisabled();
    reapply();
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>(".yaw-row button")) {
  btn.onclick = () => {
    const f = $("f-yaw") as HTMLInputElement;
    let v = (Number(f.value) || 0) + Number(btn.dataset.yaw);
    v = ((v % 360) + 360) % 360; // keep in [0,360)
    f.value = String(v);
    reapply();
  };
}
$("reset-view").onclick = () => reapply(true);
$("save").onclick = save;

loadManifest().catch((e) => setStatus(`manifest failed: ${e.message}`, "err"));
