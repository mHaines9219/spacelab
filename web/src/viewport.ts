import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import init, { Document } from "./wasm/wasm_bindings.js";
import { assertBindingIsCurrent } from "./binding-guard";

const TEX_ROOT = "/assets/textures";
// Directory per floor finish; index matches Rust's `FloorMaterial` ordinal.
const FLOOR_DIRS = ["wood-light", "wood-dark", "tile", "concrete"] as const;
// Metres of floor spanned by one texture repeat, tuned per finish so plank/tile
// scale reads as real. UVs arrive in metres, so repeat = 1 / tile-size.
const FLOOR_TILE_M = [1.0, 1.0, 1.2, 2.5];
const WALL_DIR = "drywall";
const WALL_TILE_M = 2.5;
/**
 * Paint tints for the wall finishes, indexed by Rust's `WallMaterial` ordinal. Unlike
 * the floor — where each finish is a different texture set — every wall finish shares
 * the one matte plaster set and differs only in colour, so this is a tint list rather
 * than a directory list, and the walls keep reading as drywall rather than flat paint.
 * Index 0 is the off-white the walls carried before finishes were selectable.
 */
const WALL_TINTS = [0xf4f1ea, 0xd9dce0, 0xd6cec2, 0xb9c3b2, 0xc7ab9a];

/**
 * What each `LightingPreset` ordinal means. The document owns the choice; these are the
 * renderer's interpretation of it. `env` fills the shadows (the IBL contribution), so
 * low-sun moods raise it to keep the room readable rather than half-black, and Overcast
 * carries almost all its light there. `sun` is metres in world space — height above the
 * floor sets how long the shadows run.
 *
 * Every preset keeps the key light **off the default camera's azimuth**. The camera sits
 * at +x/+z and the sun used to sit at +x/+z as well, within a few degrees of it, so every
 * shadow fell directly away from the viewer and hid behind the object that cast it. The
 * shadows were rendering correctly the whole time and simply could not be seen — flat,
 * on-camera-flash lighting. Swinging the key ~90° round the room is what makes the moods
 * legible.
 *
 * The room's two default walls sit on the -x and -z edges, so a *low* sun from that side
 * is blocked by them and floods the floor with wall shadow. The lateral offsets below
 * therefore go over the open +x / +z sides, and only the height varies the shadow length.
 */
const LIGHTING = [
  { color: 0xffffff, intensity: 3.4, sun: [5.0, 7.0, -1.5], env: 0.55, sky: 0x14161a },
  { color: 0xffd9a8, intensity: 2.9, sun: [-1.5, 4.0, 5.0], env: 0.7, sky: 0x1a1a1d },
  { color: 0xff9d5c, intensity: 2.4, sun: [6.0, 2.8, 1.0], env: 0.62, sky: 0x1d1518 },
  { color: 0xdfe6ef, intensity: 0.9, sun: [2.0, 8.0, 1.0], env: 1.35, sky: 0x1c1f23 },
] as const;

const textureLoader = new THREE.TextureLoader();

function loadTexture(url: string, srgb: boolean, repeat: number) {
  const texture = textureLoader.load(url);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A matte PBR material from a CC0 color/normal/roughness set under `TEX_ROOT/dir`. */
function pbrMaterial(
  dir: string,
  tileMetres: number,
  extra: THREE.MeshStandardMaterialParameters = {},
) {
  const repeat = 1 / tileMetres;
  return new THREE.MeshStandardMaterial({
    map: loadTexture(`${TEX_ROOT}/${dir}/color.jpg`, true, repeat),
    normalMap: loadTexture(`${TEX_ROOT}/${dir}/normal.jpg`, false, repeat),
    roughnessMap: loadTexture(`${TEX_ROOT}/${dir}/roughness.jpg`, false, repeat),
    metalness: 0,
    roughness: 1,
    ...extra,
  });
}

function meshGeometry(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array,
) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

export type Stats = {
  fps: number;
  frameMs: number;
  renderMs: number;
  dragUs: number;
  triangles: number;
  snapped: boolean;
  wasmBytes: number;
  /**
   * What the walls *enclose*, which is not the same as the floor — a room with a wall
   * removed still has its whole floor footprint but encloses nothing. `areasM2` is one
   * entry per detected room, largest first, so `[]` means "no enclosed room" rather
   * than "no room".
   *
   * Refreshed when the walls change, not per frame: detection is a graph walk, and
   * nothing about it can change between frames without a wall edit.
   */
  rooms: { areasM2: number[] };
};

/** One catalog asset, as read from `/assets/catalog.json`. */
export type CatalogEntry = {
  asset_id: string;
  title: string;
  category: string | null;
  tags: string[];
  dims_m: { w: number; h: number; d: number };
  blob: string; // e.g. "models/couch-medium.glb", served from /assets/
};

/**
 * The selected furnishing's title and real-world size in inches `[width, depth, height]`,
 * or null when nothing is selected.
 */
export type Selection = { title: string; dims: [number, number, number] } | null;

/** One furnishing set aside in the bullpen: its document id and its catalog entry. */
export type BullpenItem = { id: number; entry: CatalogEntry };

/**
 * The selected opening's kind and size in inches `[width, height, sill]`, or null when no
 * opening is selected. Doors ignore the sill field.
 */
export type OpeningSelection =
  | { kind: "door" | "window"; dims: [number, number, number] }
  | null;

export type ViewportHandle = {
  dispose: () => void;
  /** Place a catalog asset in the room and select it. */
  addFromCatalog: (entry: CatalogEntry) => Promise<void>;
  /** Remove the selected furnishing, if any. */
  removeSelected: () => void;
  /** Set the selected furnishing aside into the bullpen, if any. */
  stashSelected: () => void;
  /** Bring a bullpen item back into the room by id, re-selecting it. */
  unstash: (id: number) => Promise<void>;
  /** Discard a bullpen item for good by id. */
  discardStashed: (id: number) => void;
  /** Set one dimension in inches: axis 0 = width, 1 = depth, 2 = height. */
  setDimension: (axis: number, inches: number) => void;
  /** Restore the selected asset to its catalog proportions. */
  resetScale: () => void;
  /** Choose the floor finish by index (matches Rust's FloorMaterial ordinal). */
  setFloorMaterial: (index: number) => void;
  /** Choose the wall paint finish by index (matches Rust's WallMaterial ordinal). */
  setWallMaterial: (index: number) => void;
  /** Choose the lighting mood by index (matches Rust's LightingPreset ordinal). */
  setLighting: (index: number) => void;
  /** Replace the room with an axis-aligned rectangle (metres). */
  setRectangle: (widthM: number, depthM: number) => void;
  /** Replace the room with a closed polygon, `[x0, z0, x1, z1, …]` in metres. */
  setPolygon: (coordsM: number[]) => void;
  /** Delete a wall by id, then rebuild geometry. */
  deleteWall: (id: number) => void;
  /** Current wall centrelines as `[startX, startZ, endX, endZ, …]` in metres. */
  wallSegments: () => number[];
  /** Wall ids parallel to `wallSegments`. */
  wallIds: () => number[];
  /** Enter add-wall mode: the next two floor clicks define a new wall. */
  startAddWall: () => void;
  /** Delete the currently selected wall, if any. */
  deleteSelectedWall: () => void;
  /** Enter add-opening mode: the next wall click drops a snapped door or window. */
  startAddOpening: (kind: "door" | "window") => void;
  /** Remove the selected door/window, if any. */
  removeSelectedOpening: () => void;
  /** Set one opening dimension in inches: axis 0 = width, 1 = height, 2 = sill. */
  setOpeningDimension: (axis: number, inches: number) => void;
  /**
   * Undo the last action, re-syncing the whole scene. Returns derived UI state to
   * refresh (floor and wall finishes, lighting, room footprint), or null if there was
   * nothing to undo.
   */
  undo: () => UndoResult | null;
};

export type UndoResult = {
  floorIndex: number;
  wallIndex: number;
  lightingIndex: number;
  empty: boolean;
  room: { widthM: number; depthM: number } | null;
};

const IN_PER_M = 39.3700787;
const WALL_HEIGHT_M = 2.5;
const WALL_THICKNESS_M = 0.12;

export async function createViewport(
  canvas: HTMLCanvasElement,
  onStats: (stats: Stats) => void,
  onSelection: (selection: Selection) => void,
  onWall: (wallId: number | null) => void,
  onAddMode: (active: boolean) => void,
  onOpening: (selection: OpeningSelection) => void,
  onOpeningMode: (kind: "door" | "window" | null) => void,
  onBullpen: (items: BullpenItem[]) => void,
): Promise<ViewportHandle> {
  await init();
  assertBindingIsCurrent(Document.prototype);
  const doc = new Document();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  // Both this and the environment intensity below are set from the lighting preset once
  // `doc` is readable — see `applyLighting`.
  scene.background = new THREE.Color();

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(5.4, 3.4, 5.2);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(2.1, 0.6, 1.7);
  controls.enableDamping = true;

  const sun = new THREE.DirectionalLight(0xffffff, 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, {
    left: -7,
    right: 7,
    top: 7,
    bottom: -7,
    near: 0.1,
    far: 24,
  });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);

  // The choice lives in the Rust document; JS binds the matching look. Applied once at
  // startup so the default preset is the single source of the opening lighting.
  const applyLighting = (index: number) => {
    const preset = LIGHTING[index];
    sun.color.setHex(preset.color);
    sun.intensity = preset.intensity;
    sun.position.set(preset.sun[0], preset.sun[1], preset.sun[2]);
    scene.environmentIntensity = preset.env;
    (scene.background as THREE.Color).setHex(preset.sky);
  };
  applyLighting(doc.lighting());
  // Floor and walls each take a swappable finish, and stay two meshes so each carries
  // its own material. The floor swaps between pre-built materials (one texture set per
  // finish); the walls share a single material and swap only its tint, which keeps the
  // plaster maps to one set of texture fetches instead of one per colour.
  const floorMaterials = FLOOR_DIRS.map((dir, i) =>
    pbrMaterial(dir, FLOOR_TILE_M[i]),
  );
  const floorMesh = new THREE.Mesh(
    meshGeometry(
      doc.floor_positions(),
      doc.floor_normals(),
      doc.floor_uvs(),
      doc.floor_indices(),
    ),
    floorMaterials[doc.floor_material()],
  );
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  const wallMaterial = pbrMaterial(WALL_DIR, WALL_TILE_M, {
    color: new THREE.Color(WALL_TINTS[doc.wall_material()]),
    normalScale: new THREE.Vector2(0.35, 0.35),
  });
  const wallMesh = new THREE.Mesh(
    meshGeometry(
      doc.wall_positions(),
      doc.wall_normals(),
      doc.wall_uvs(),
      doc.wall_indices(),
    ),
    wallMaterial,
  );
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  scene.add(wallMesh);

  // Invisible per-wall boxes so a merged wall mesh stays pickable: raycasting these
  // maps a click back to a wall id. The selected one shows a translucent highlight.
  const wallPicks = new THREE.Group();
  scene.add(wallPicks);
  let selectedWall: number | null = null;

  const rebuildWallPicks = () => {
    for (const child of [...wallPicks.children]) {
      wallPicks.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
    const segs = doc.wall_segments();
    const ids = doc.wall_ids();
    for (let i = 0; i < ids.length; i++) {
      const [sx, sz, ex, ez] = [segs[i * 4], segs[i * 4 + 1], segs[i * 4 + 2], segs[i * 4 + 3]];
      const len = Math.hypot(ex - sx, ez - sz);
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(len, WALL_HEIGHT_M, WALL_THICKNESS_M + 0.06),
        new THREE.MeshBasicMaterial({
          color: 0x5b9dff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      box.position.set((sx + ex) / 2, WALL_HEIGHT_M / 2, (sz + ez) / 2);
      box.rotation.y = Math.atan2(-(ez - sz), ex - sx);
      box.userData.wallId = ids[i];
      wallPicks.add(box);
    }
  };

  const selectWall = (id: number | null) => {
    selectedWall = id;
    for (const child of wallPicks.children) {
      (child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.opacity =
        child.userData.wallId === id ? 0.32 : 0;
    }
    onWall(id);
  };

  // --- Openings (doors & windows) -----------------------------------------
  // Rust cuts the hole into the wall mesh itself; JS only draws, per opening, an
  // invisible pick box (so the hole is selectable), a selection outline, and — for a
  // window — a glass pane. All three are positioned entirely from the Rust transform,
  // exactly as furnishings are, so no geometry logic crosses the boundary.
  const openingGroup = new THREE.Group();
  scene.add(openingGroup);
  const openingOutlineMat = new THREE.LineBasicMaterial({ color: 0x5b9dff });
  const openingPickMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xbcd6ef,
    roughness: 0.08,
    metalness: 0,
    transmission: 0.7,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  type Opening3D = {
    id: number;
    pick: THREE.Mesh;
    outline: THREE.LineSegments;
    glass?: THREE.Mesh;
  };
  let openings: Opening3D[] = [];
  let selectedOpening: number | null = null;

  const disposeOpening = (o: Opening3D) => {
    for (const part of [o.pick, o.outline, o.glass]) {
      if (!part) continue;
      openingGroup.remove(part);
      (part as THREE.Mesh).geometry.dispose();
    }
  };

  // Rebuild every opening proxy from the document. Cheap at this count, and called after
  // any add/move/resize/undo since the wall mesh (and thus each hole) changes underneath.
  const rebuildOpenings = () => {
    for (const o of openings) disposeOpening(o);
    openings = [];
    for (const id of doc.opening_ids()) {
      const t = doc.opening_transform(id);
      if (t.length < 8) continue;
      const [cx, cy, cz, yaw, w, h, thick, kind] = t;
      const place = (obj: THREE.Object3D) => {
        obj.position.set(cx, cy, cz);
        obj.rotation.y = yaw;
      };
      const pick = new THREE.Mesh(new THREE.BoxGeometry(w, h, thick + 0.08), openingPickMat);
      place(pick);
      pick.userData.openingId = id;
      openingGroup.add(pick);

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, thick)),
        openingOutlineMat,
      );
      place(outline);
      outline.visible = id === selectedOpening;
      openingGroup.add(outline);

      let glass: THREE.Mesh | undefined;
      if (kind === 1) {
        glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassMat);
        place(glass);
        openingGroup.add(glass);
      }
      openings.push({ id, pick, outline, glass });
    }
    // An opening cannot outlive the wall that owns it (`Command::DeleteWall` cascades
    // them away), so a selection pointing at one that just vanished is stale. Drop it
    // here rather than at each call site — the panel reads off `selectedOpening`.
    if (selectedOpening !== null && !openings.some((o) => o.id === selectedOpening)) {
      selectOpening(null);
    }
  };

  const openingSelectionPayload = (): OpeningSelection => {
    if (selectedOpening === null) return null;
    const t = doc.opening_transform(selectedOpening);
    if (t.length < 8) return null;
    return {
      kind: t[7] === 1 ? "window" : "door",
      dims: [...doc.opening_dimensions()] as [number, number, number],
    };
  };

  const selectOpening = (id: number | null) => {
    selectedOpening = id;
    if (id === null) doc.deselect_opening();
    else doc.select_opening(id);
    for (const o of openings) o.outline.visible = o.id === id;
    onOpening(openingSelectionPayload());
  };

  // --- Furnishings ---------------------------------------------------------
  // Rust owns placement; JS owns which GLB draws each furnishing id. `placed` maps id
  // → catalog entry and PERSISTS (ids are never reused), so an undo that restores a
  // removed furnishing can rebuild its mesh from the cached template synchronously.
  const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const templates = new Map<string, THREE.Group>(); // resolved GLB scene per url
  const templateLoads = new Map<string, Promise<THREE.Group>>(); // in-flight dedupe
  type Furnishing3D = { group: THREE.Group; box: THREE.LineSegments; entry: CatalogEntry };
  const furnishings = new Map<number, Furnishing3D>();
  const placed = new Map<number, CatalogEntry>();
  let selectedId: number | null = null;
  let snapped = false;
  /**
   * Areas (m²) of what the walls enclose, largest first — refreshed by
   * `syncRoomGeometry` rather than read per frame, since only a wall edit can change it.
   * Empty means the walls enclose nothing, which is the default room's real state.
   */
  let roomAreasM2: number[] = [];

  const urlOf = (entry: CatalogEntry) => `/assets/${entry.blob}`;

  async function getTemplate(url: string): Promise<THREE.Group> {
    const cached = templates.get(url);
    if (cached) return cached;
    let load = templateLoads.get(url);
    if (!load) {
      load = gltfLoader.loadAsync(url).then((gltf) => {
        gltf.scene.traverse((node) => {
          if ((node as THREE.Mesh).isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
          }
        });
        templates.set(url, gltf.scene);
        templateLoads.delete(url);
        return gltf.scene;
      });
      templateLoads.set(url, load);
    }
    return load;
  }

  // Furnishing outline colours. Crowding shows whether or not the item is selected — it
  // is a fact about the room, not about what you happen to have clicked — so a selected
  // item that does not fit needs its own colour rather than losing one signal to the
  // other. Two overlapping copies of the same couch are both amber and the panel names
  // them identically, so without the third colour there is nothing on screen saying
  // which one a drag or an arrow key will move.
  const OUTLINE_SELECTED = 0x5b9dff;
  const OUTLINE_CROWDED = 0xffa53d;
  const OUTLINE_SELECTED_CROWDED = 0xff5c3d;

  // Ids Rust reports as overlapping another item. The document decides what crowded
  // means (`core-geometry/src/clearance.rs`); this layer only colours what it is handed.
  let crowded = new Set<number>();

  // Line width is not a lever here: WebGL renders `LineBasicMaterial` at one pixel
  // whatever `linewidth` says, so colour carries the whole distinction.
  const outlineColour = (id: number) =>
    crowded.has(id)
      ? id === selectedId
        ? OUTLINE_SELECTED_CROWDED
        : OUTLINE_CROWDED
      : OUTLINE_SELECTED;

  // Build the scene object for an id from an already-resolved template (sync).
  const buildFurnishing = (id: number, entry: CatalogEntry, template: THREE.Group) => {
    const group = new THREE.Group();
    group.userData.furnishingId = id;
    group.add(template.clone(true));
    const { w, h, d } = entry.dims_m;
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({ color: outlineColour(id) }),
    );
    box.position.y = h / 2;
    box.visible = id === selectedId || crowded.has(id);
    group.add(box);
    scene.add(group);
    furnishings.set(id, { group, box, entry });
    applyTransformFor(id, doc.furnishing_transform(id));
  };

  const disposeFurnishing = (f: Furnishing3D) => {
    scene.remove(f.group);
    f.box.geometry.dispose();
    (f.box.material as THREE.Material).dispose();
    // GLB geometries/materials are shared templates; leave them for reuse.
  };

  function applyTransformFor(id: number, out: Float32Array) {
    const f = furnishings.get(id);
    if (!f || out.length < 8) return;
    f.group.position.set(out[0], out[1], out[2]);
    f.group.rotation.y = out[3];
    f.group.scale.set(out[4], out[5], out[6]);
    if (id === selectedId) snapped = out[7] === 1;
  }

  const selectionPayload = (): Selection =>
    selectedId === null
      ? null
      : {
          title: furnishings.get(selectedId)?.entry.title ?? "furnishing",
          dims: [...doc.dimensions()] as [number, number, number],
        };

  // Re-read which items overlap and recolour every outline. Cheap enough to call on
  // each pointer move during a drag: the query is quadratic over a room's worth of
  // furniture, and the drag path already re-emits geometry per move.
  const refreshCrowding = () => {
    crowded = new Set(doc.crowded_ids());
    for (const [id, f] of furnishings) {
      f.box.visible = crowded.has(id) || id === selectedId;
      (f.box.material as THREE.LineBasicMaterial).color.setHex(outlineColour(id));
    }
  };

  const selectFurnishing = (id: number | null) => {
    selectedId = id;
    if (id === null) doc.deselect();
    else doc.select(id);
    // Covers add, remove, set-aside, re-import and undo — they all end up here.
    refreshCrowding();
    onSelection(selectionPayload());
  };

  const addFromCatalog = async (entry: CatalogEntry) => {
    const { w, h, d } = entry.dims_m;
    // The catalog id goes into the document, not just this map: `placed` dies with the
    // page, so a saved room that only knew the box dimensions would restore as
    // correctly-sized invisible furniture. `placed` stays as the JS-side cache of the
    // full entry (thumbnail, title, blob url); the document owns *which* entry it is.
    const id = doc.add_furnishing(entry.asset_id, w, h, d);
    placed.set(id, entry);
    const template = await getTemplate(urlOf(entry));
    selectedId = id; // so the fresh mesh shows its selection box
    buildFurnishing(id, entry, template);
    selectFurnishing(id);
  };

  const removeSelected = () => {
    if (selectedId === null) return;
    const id = selectedId;
    if (!doc.remove_selected()) return;
    const f = furnishings.get(id);
    if (f) {
      disposeFurnishing(f);
      furnishings.delete(id);
    }
    selectFurnishing(null);
  };

  // --- Bullpen (set aside / re-import) -------------------------------------
  // Rust owns which items are stashed and their retained scale/rotation; JS maps each
  // stashed id back to its catalog entry (via `placed`) so the tray can draw a card.
  const refreshBullpen = () => {
    const items: BullpenItem[] = [];
    for (const id of doc.stashed_ids()) {
      const entry = placed.get(id);
      if (entry) items.push({ id, entry });
    }
    onBullpen(items);
  };

  const stashSelected = () => {
    const id = doc.stash_selected();
    if (id < 0) return;
    const f = furnishings.get(id);
    if (f) {
      disposeFurnishing(f);
      furnishings.delete(id);
    }
    selectFurnishing(null);
    refreshBullpen();
  };

  const unstash = async (id: number) => {
    const out = doc.unstash(id);
    if (out.length < 8) return;
    const entry = placed.get(id);
    if (!entry) return;
    // The item was placed before, so its template is already cached (sync in practice).
    const template = await getTemplate(urlOf(entry));
    selectedId = id; // so the rebuilt mesh shows its selection box
    buildFurnishing(id, entry, template);
    selectFurnishing(id);
    refreshBullpen();
  };

  const discardStashed = (id: number) => {
    if (!doc.remove_furnishing(id)) return;
    refreshBullpen(); // no mesh exists for a stashed item, so nothing to dispose
  };

  // Reconcile the furnishing meshes with the document after an undo, which can add,
  // remove, or move any of them. Synchronous: any id that can reappear was placed
  // before, so its template is already cached.
  const reconcileFurnishings = () => {
    const ids = new Set(doc.furnishing_ids());
    for (const [id, f] of [...furnishings]) {
      if (!ids.has(id)) {
        disposeFurnishing(f);
        furnishings.delete(id);
      }
    }
    for (const id of ids) {
      if (!furnishings.has(id)) {
        const entry = placed.get(id);
        const template = entry && templates.get(urlOf(entry));
        if (entry && template) buildFurnishing(id, entry, template);
      }
      applyTransformFor(id, doc.furnishing_transform(id));
    }
  };

  const place = (x: number, z: number) => {
    if (selectedId === null) return;
    applyTransformFor(selectedId, doc.drag(x, z));
    // Live feedback: the warning tracks the item under the cursor as it moves.
    refreshCrowding();
  };

  // Timed in a batch rather than per pointer move: a single call lands under
  // performance.now()'s resolution, so per-move sampling only measures the clock.
  // With nothing selected this measures the bare boundary round-trip.
  const dragUs = (() => {
    const samples = 2000;
    const start = performance.now();
    for (let i = 0; i < samples; i++) doc.drag(2.1, (i % 340) * 0.01);
    return ((performance.now() - start) * 1000) / samples;
  })();

  const raycaster = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pointer = new THREE.Vector2();
  const hit = new THREE.Vector3();
  let dragging = false;
  let draggingOpening = false; // sliding a selected opening along its wall
  let dragMoved = false; // becomes true on the first move, when we take one undo checkpoint

  const aimAt = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
  };

  // Walk up from a raycast hit to the furnishing group that carries the id.
  const furnishingIdAt = (object: THREE.Object3D): number | null => {
    let o: THREE.Object3D | null = object;
    while (o && o.userData.furnishingId === undefined) o = o.parent;
    return o ? (o.userData.furnishingId as number) : null;
  };

  canvas.addEventListener("pointerdown", (event) => {
    aimAt(event);

    // Add-opening mode: one wall click drops a snapped door or window.
    if (openingMode) {
      const wallHit = raycaster.intersectObjects(wallPicks.children, false)[0];
      if (wallHit) {
        const wallId = wallHit.object.userData.wallId as number;
        const id = doc.add_opening(openingMode === "door" ? 0 : 1, wallId, wallHit.point.x, wallHit.point.z);
        syncRoomGeometry();
        if (id >= 0) {
          selectFurnishing(null);
          selectWall(null);
          selectOpening(id);
        }
        setAddOpening(null);
      }
      return;
    }

    // Add-wall mode: two floor clicks define a wall.
    if (addMode) {
      if (!raycaster.ray.intersectPlane(floorPlane, hit)) return;
      if (!addAnchor) {
        addAnchor = new THREE.Vector2(hit.x, hit.z);
      } else {
        doc.add_wall(addAnchor.x, addAnchor.y, hit.x, hit.z);
        syncRoomGeometry();
        rebuildWallPicks();
        setAddMode(false);
      }
      return;
    }

    // Furnishings take priority, then openings, then walls, then empty space.
    const groups = [...furnishings.values()].map((f) => f.group);
    const furnishingHit = groups.length ? raycaster.intersectObjects(groups, true)[0] : undefined;
    if (furnishingHit) {
      const id = furnishingIdAt(furnishingHit.object);
      if (id !== null) {
        selectWall(null);
        selectOpening(null);
        selectFurnishing(id);
        dragging = true;
        dragMoved = false;
        controls.enabled = false;
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }
    const openingHit = openings.length
      ? raycaster.intersectObjects(openings.map((o) => o.pick), false)[0]
      : undefined;
    if (openingHit) {
      selectFurnishing(null);
      selectWall(null);
      selectOpening(openingHit.object.userData.openingId as number);
      draggingOpening = true;
      dragMoved = false;
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    const wallHit = raycaster.intersectObjects(wallPicks.children, false)[0];
    if (wallHit) {
      selectFurnishing(null);
      selectOpening(null);
      selectWall(wallHit.object.userData.wallId as number);
      return;
    }
    selectFurnishing(null);
    selectOpening(null);
    selectWall(null);
  });

  // Rotate/scale the selected asset. Every mutation runs through Rust; JS only
  // reads back the resulting transform. Ignored while a numeric field is focused
  // so the arrows still step those inputs.
  const deleteSelectedWall = () => {
    if (selectedWall === null) return;
    doc.delete_wall(selectedWall);
    syncRoomGeometry();
    rebuildWallPicks();
    selectWall(null);
  };

  const onKey = (event: KeyboardEvent) => {
    if (document.activeElement instanceof HTMLInputElement) return;
    // Wall/opening editing works whether or not a furnishing is selected.
    if (event.key === "Escape" && (addMode || openingMode)) {
      setAddMode(false);
      setAddOpening(null);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      // A selected furnishing takes the delete, then an opening, then a wall.
      if (selectedId !== null) {
        removeSelected();
        event.preventDefault();
        return;
      }
      if (selectedOpening !== null) {
        removeSelectedOpening();
        event.preventDefault();
        return;
      }
      if (selectedWall !== null) {
        deleteSelectedWall();
        event.preventDefault();
        return;
      }
    }
    if (selectedId === null) return;
    switch (event.key) {
      case "ArrowLeft":
        applyTransformFor(selectedId, doc.rotate(-1)); // clockwise
        break;
      case "ArrowRight":
        applyTransformFor(selectedId, doc.rotate(1)); // counter-clockwise
        break;
      case "ArrowUp":
        applyTransformFor(selectedId, doc.scale_by(1));
        refreshSelection();
        break;
      case "ArrowDown":
        applyTransformFor(selectedId, doc.scale_by(-1));
        refreshSelection();
        break;
      case "r":
      case "R":
        applyTransformFor(selectedId, doc.reset_scale());
        refreshSelection();
        break;
      case "Escape":
        selectFurnishing(null);
        return;
      default:
        return;
    }
    // Only the transform cases reach here; each can turn or resize an item into a
    // neighbour, so re-check. Escape and unhandled keys returned above.
    refreshCrowding();
    event.preventDefault();
  };
  window.addEventListener("keydown", onKey);

  const refreshSelection = () => {
    if (selectedId !== null) onSelection(selectionPayload());
  };

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging && !draggingOpening) return;
    aimAt(event);
    if (!raycaster.ray.intersectPlane(floorPlane, hit)) return;
    // One checkpoint per drag gesture, taken before the first actual move.
    if (!dragMoved) {
      doc.checkpoint();
      dragMoved = true;
    }
    if (dragging) {
      place(hit.x, hit.z);
    } else if (doc.drag_opening(hit.x, hit.z)) {
      // The opening moved within the wall mesh: re-upload it and re-place the proxies.
      syncRoomGeometry();
    }
  });

  const endDrag = (event: PointerEvent) => {
    if (!dragging && !draggingOpening) return;
    dragging = false;
    draggingOpening = false;
    controls.enabled = true;
    canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Re-upload floor + wall geometry from the document after any wall edit.
  //
  // Openings rebuild with it, always. Each one is a hole in a wall, so any edit that
  // moves the wall mesh moves its openings too — and a wall delete cascades them away
  // in Rust. Three call sites had re-uploaded the walls without re-deriving the
  // openings, which left a deleted wall's door hanging in mid-air; pairing them here
  // means a new call site cannot reintroduce that.
  //
  // The detected-room areas are refreshed here for the same reason: what the walls
  // enclose is a property of the wall graph, so it can only change when the walls do.
  // Reading it here rather than per frame keeps a graph walk off the render loop, and
  // keeps it on the one path every wall edit already takes.
  const syncRoomGeometry = () => {
    floorMesh.geometry.dispose();
    floorMesh.geometry = meshGeometry(
      doc.floor_positions(),
      doc.floor_normals(),
      doc.floor_uvs(),
      doc.floor_indices(),
    );
    wallMesh.geometry.dispose();
    wallMesh.geometry = meshGeometry(
      doc.wall_positions(),
      doc.wall_normals(),
      doc.wall_uvs(),
      doc.wall_indices(),
    );
    rebuildOpenings();
    roomAreasM2 = Array.from(doc.detected_room_areas());
  };

  // Frame the camera to the current footprint so any room size fits nicely.
  const frameCamera = () => {
    const [minX, minZ, maxX, maxZ] = doc.room_bounds();
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    controls.target.set(cx, 0.4, cz);
    // Steeper look-down so tall near walls don't crowd the floor in smaller rooms.
    camera.position.set(cx + span * 0.75, span * 1.15 + 2.4, cz + span * 0.85);
    controls.update();
  };

  // A room was (re)generated: rebuild geometry and reframe. Furnishings persist and
  // keep their transforms across a room edit.
  const showRoom = () => {
    syncRoomGeometry();
    rebuildWallPicks();
    selectWall(null);
    // A room regen clears the walls and cascades their openings away; the proxies came
    // back with `syncRoomGeometry` above, so there is only the selection left to drop.
    selectOpening(null);
    for (const id of doc.furnishing_ids()) applyTransformFor(id, doc.furnishing_transform(id));
    refreshBullpen();
    frameCamera();
  };

  // Add-wall mode: null when off; holds the first clicked point once placed.
  let addAnchor: THREE.Vector2 | null = null;
  let addMode = false;
  const setAddMode = (on: boolean) => {
    addMode = on;
    addAnchor = null;
    if (on) setAddOpening(null); // the two placement modes are mutually exclusive
    canvas.style.cursor = on ? "crosshair" : "";
    onAddMode(on);
  };

  // Add-opening mode: "door" | "window" while arming a placement, else null.
  let openingMode: "door" | "window" | null = null;
  const setAddOpening = (kind: "door" | "window" | null) => {
    openingMode = kind;
    if (kind) setAddMode(false);
    canvas.style.cursor = kind ? "crosshair" : "";
    onOpeningMode(kind);
  };

  const removeSelectedOpening = () => {
    if (selectedOpening === null) return;
    if (!doc.remove_selected_opening()) return;
    syncRoomGeometry();
    selectOpening(null);
  };

  const resize = new ResizeObserver(() => {
    const { clientWidth, clientHeight } = canvas;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / Math.max(clientHeight, 1);
    camera.updateProjectionMatrix();
  });
  resize.observe(canvas);

  const wasmBytes = transferredWasmBytes();
  let last = performance.now();
  let frameMs = 16.7;
  let renderMs = 0;
  let reportedAt = last;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    frameMs = frameMs * 0.9 + (now - last) * 0.1;
    last = now;

    controls.update();
    renderer.render(scene, camera);
    renderMs = renderMs * 0.9 + (performance.now() - now) * 0.1;

    if (now - reportedAt > 250) {
      reportedAt = now;
      onStats({
        fps: 1000 / frameMs,
        frameMs,
        renderMs,
        dragUs,
        triangles: renderer.info.render.triangles,
        snapped,
        wasmBytes,
        rooms: { areasM2: roomAreasM2 },
      });
    }
  });

  const setDimension = (axis: number, inches: number) => {
    if (selectedId === null) return;
    applyTransformFor(selectedId, doc.set_dimension(axis, inches));
    refreshCrowding();
    refreshSelection();
  };

  // Dev-only probes so the e2e test can read state that isn't visible in the DOM.
  // Stripped from production by the `import.meta.env.DEV` gate.
  if (import.meta.env.DEV) {
    const probe = window as unknown as {
      __selectedYaw?: () => number | null;
      __furnishingCount?: () => number;
      __wallCount?: () => number;
      __floorTris?: () => number;
      __deleteWallById?: (id: number) => void;
      __openingCount?: () => number;
      __wallTris?: () => number;
      __addOpeningOnWall?: (kind: "door" | "window", wallId: number) => number;
      __crowdedIds?: () => number[];
      __outlines?: () => { id: number; visible: boolean; colour: number }[];
    };
    probe.__selectedYaw = () =>
      selectedId !== null ? (furnishings.get(selectedId)?.group.rotation.y ?? null) : null;
    probe.__furnishingCount = () => furnishings.size;
    probe.__wallCount = () => wallPicks.children.length;
    probe.__floorTris = () => (floorMesh.geometry.index?.count ?? 0) / 3;
    // Mirrors `deleteSelectedWall` exactly. It used to omit the openings rebuild the same
    // way that path did, so a probe-driven test agreed with the bug instead of catching it.
    probe.__deleteWallById = (id: number) => {
      doc.delete_wall(id);
      syncRoomGeometry();
      rebuildWallPicks();
    };
    // Reads the rendered set rather than re-querying Rust, so the e2e test proves the
    // outlines actually track the document instead of just re-asserting the query.
    probe.__crowdedIds = () => [...crowded].sort((a, b) => a - b);
    // Read off the live materials, so an assertion about what the room *looks* like
    // cannot pass on a stale outline the refresh forgot to recolour.
    probe.__outlines = () =>
      [...furnishings.entries()]
        .map(([id, f]) => ({
          id,
          visible: f.box.visible,
          colour: (f.box.material as THREE.LineBasicMaterial).color.getHex(),
        }))
        .sort((a, b) => a.id - b.id);
    probe.__openingCount = () => openings.length;
    probe.__wallTris = () => (wallMesh.geometry.index?.count ?? 0) / 3;
    // Drive a placement at the wall's midpoint, exercising the same snap + rebuild path
    // the pointer handler uses, without having to hit a wall pixel from screen space.
    probe.__addOpeningOnWall = (kind, wallId) => {
      const segs = doc.wall_segments();
      const ids = doc.wall_ids();
      const i = ids.indexOf(wallId);
      if (i < 0) return -1;
      const mx = (segs[i * 4] + segs[i * 4 + 2]) / 2;
      const mz = (segs[i * 4 + 1] + segs[i * 4 + 3]) / 2;
      const id = doc.add_opening(kind === "door" ? 0 : 1, wallId, mx, mz);
      syncRoomGeometry();
      if (id >= 0) selectOpening(id);
      return id;
    };
  }

  const resetScale = () => {
    if (selectedId === null) return;
    applyTransformFor(selectedId, doc.reset_scale());
    refreshSelection();
  };

  const setOpeningDimension = (axis: number, inches: number) => {
    if (selectedOpening === null) return;
    if (!doc.set_opening_dimension(axis, inches)) return;
    syncRoomGeometry();
    onOpening(openingSelectionPayload());
  };

  // The choice lives in the Rust document; JS just binds the matching material.
  const setFloorMaterial = (index: number) => {
    floorMesh.material = floorMaterials[doc.set_floor_material(index)];
  };

  const setWallMaterial = (index: number) => {
    wallMaterial.color.setHex(WALL_TINTS[doc.set_wall_material(index)]);
  };

  const setLighting = (index: number) => {
    applyLighting(doc.set_lighting(index));
  };

  return {
    dispose: () => {
      renderer.setAnimationLoop(null);
      window.removeEventListener("keydown", onKey);
      resize.disconnect();
      controls.dispose();
      renderer.dispose();
    },
    addFromCatalog,
    removeSelected,
    stashSelected,
    unstash,
    discardStashed,
    setDimension,
    resetScale,
    setFloorMaterial,
    setWallMaterial,
    setLighting,
    setRectangle: (widthM, depthM) => {
      doc.set_rectangle(widthM, depthM);
      showRoom();
    },
    setPolygon: (coordsM) => {
      doc.set_polygon(Float32Array.from(coordsM));
      showRoom();
    },
    deleteWall: (id) => {
      doc.delete_wall(id);
      syncRoomGeometry();
      // The wall is gone from the document, so its pick box has to go too — otherwise
      // the next click still selects a wall that no longer exists.
      rebuildWallPicks();
      if (selectedWall === id) selectWall(null);
    },
    wallSegments: () => Array.from(doc.wall_segments()),
    wallIds: () => Array.from(doc.wall_ids()),
    startAddWall: () => {
      selectFurnishing(null);
      selectWall(null);
      selectOpening(null);
      setAddMode(true);
    },
    deleteSelectedWall,
    startAddOpening: (kind) => {
      selectFurnishing(null);
      selectWall(null);
      selectOpening(null);
      setAddOpening(kind);
    },
    removeSelectedOpening,
    setOpeningDimension,
    undo: () => {
      if (!doc.undo()) return null;
      // Undo can touch anything, so re-sync the whole scene from the restored document.
      syncRoomGeometry();
      rebuildWallPicks();
      selectWall(null);
      if (addMode) setAddMode(false);
      if (openingMode) setAddOpening(null);
      floorMesh.material = floorMaterials[doc.floor_material()];
      wallMaterial.color.setHex(WALL_TINTS[doc.wall_material()]);
      applyLighting(doc.lighting());
      reconcileFurnishings();
      // Undo can add, remove or move any opening; `syncRoomGeometry` above already
      // rebuilt the proxies from the restored document, so only the selection is left.
      selectOpening(null);
      refreshBullpen();
      selectFurnishing(null);
      const hasRoom = doc.has_room();
      const [minX, minZ, maxX, maxZ] = doc.room_bounds();
      return {
        floorIndex: doc.floor_material(),
        wallIndex: doc.wall_material(),
        lightingIndex: doc.lighting(),
        empty: !hasRoom,
        room: hasRoom ? { widthM: maxX - minX, depthM: maxZ - minZ } : null,
      };
    },
  };
}

function transferredWasmBytes() {
  const entry = performance
    .getEntriesByType("resource")
    .find((resource) => resource.name.endsWith(".wasm")) as
    | PerformanceResourceTiming
    | undefined;
  return entry ? entry.encodedBodySize || entry.transferSize : 0;
}
