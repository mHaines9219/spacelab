import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import init, { Document } from "./wasm/wasm_bindings.js";

const TEX_ROOT = "/assets/textures";
// Directory per floor finish; index matches Rust's `FloorMaterial` ordinal.
const FLOOR_DIRS = ["wood-light", "wood-dark", "tile", "concrete"] as const;
// Metres of floor spanned by one texture repeat, tuned per finish so plank/tile
// scale reads as real. UVs arrive in metres, so repeat = 1 / tile-size.
const FLOOR_TILE_M = [1.0, 1.0, 1.2, 2.5];
const WALL_DIR = "drywall";
const WALL_TILE_M = 2.5;

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

export type ViewportHandle = {
  dispose: () => void;
  /** Place a catalog asset in the room and select it. */
  addFromCatalog: (entry: CatalogEntry) => Promise<void>;
  /** Remove the selected furnishing, if any. */
  removeSelected: () => void;
  /** Set one dimension in inches: axis 0 = width, 1 = depth, 2 = height. */
  setDimension: (axis: number, inches: number) => void;
  /** Restore the selected asset to its catalog proportions. */
  resetScale: () => void;
  /** Choose the floor finish by index (matches Rust's FloorMaterial ordinal). */
  setFloorMaterial: (index: number) => void;
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
  /**
   * Undo the last action, re-syncing the whole scene. Returns derived UI state to
   * refresh (floor finish, room footprint), or null if there was nothing to undo.
   */
  undo: () => UndoResult | null;
};

export type UndoResult = {
  floorIndex: number;
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
): Promise<ViewportHandle> {
  await init();
  const doc = new Document();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(5.4, 3.4, 5.2);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(2.1, 0.6, 1.7);
  controls.enableDamping = true;

  const sun = new THREE.DirectionalLight(0xffffff, 3.4);
  sun.position.set(3.5, 6, 4.5);
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

  // Floor takes a swappable finish; walls take a fixed matte drywall look. Two
  // meshes so each carries its own material.
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

  const wallMesh = new THREE.Mesh(
    meshGeometry(
      doc.wall_positions(),
      doc.wall_normals(),
      doc.wall_uvs(),
      doc.wall_indices(),
    ),
    pbrMaterial(WALL_DIR, WALL_TILE_M, {
      color: new THREE.Color(0xf4f1ea),
      normalScale: new THREE.Vector2(0.35, 0.35),
    }),
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

  // Build the scene object for an id from an already-resolved template (sync).
  const buildFurnishing = (id: number, entry: CatalogEntry, template: THREE.Group) => {
    const group = new THREE.Group();
    group.userData.furnishingId = id;
    group.add(template.clone(true));
    const { w, h, d } = entry.dims_m;
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({ color: 0x5b9dff }),
    );
    box.position.y = h / 2;
    box.visible = id === selectedId;
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

  const selectFurnishing = (id: number | null) => {
    selectedId = id;
    if (id === null) doc.deselect();
    else doc.select(id);
    for (const [fid, f] of furnishings) f.box.visible = fid === id;
    onSelection(selectionPayload());
  };

  const addFromCatalog = async (entry: CatalogEntry) => {
    const { w, h, d } = entry.dims_m;
    const id = doc.add_furnishing(w, h, d);
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
    if (selectedId !== null) applyTransformFor(selectedId, doc.drag(x, z));
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

    // Furnishings take priority, then walls, then empty space.
    const groups = [...furnishings.values()].map((f) => f.group);
    const furnishingHit = groups.length ? raycaster.intersectObjects(groups, true)[0] : undefined;
    if (furnishingHit) {
      const id = furnishingIdAt(furnishingHit.object);
      if (id !== null) {
        selectWall(null);
        selectFurnishing(id);
        dragging = true;
        dragMoved = false;
        controls.enabled = false;
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }
    const wallHit = raycaster.intersectObjects(wallPicks.children, false)[0];
    if (wallHit) {
      selectFurnishing(null);
      selectWall(wallHit.object.userData.wallId as number);
      return;
    }
    selectFurnishing(null);
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
    // Wall editing works whether or not a furnishing is selected.
    if (event.key === "Escape" && addMode) {
      setAddMode(false);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      // A selected furnishing takes the delete; otherwise a selected wall does.
      if (selectedId !== null) {
        removeSelected();
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
    event.preventDefault();
  };
  window.addEventListener("keydown", onKey);

  const refreshSelection = () => {
    if (selectedId !== null) onSelection(selectionPayload());
  };

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    aimAt(event);
    if (raycaster.ray.intersectPlane(floorPlane, hit)) {
      // One checkpoint per drag gesture, taken before the first actual move.
      if (!dragMoved) {
        doc.checkpoint();
        dragMoved = true;
      }
      place(hit.x, hit.z);
    }
  });

  const endDrag = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    controls.enabled = true;
    canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Re-upload floor + wall geometry from the document after any wall edit.
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
    for (const id of doc.furnishing_ids()) applyTransformFor(id, doc.furnishing_transform(id));
    frameCamera();
  };

  // Add-wall mode: null when off; holds the first clicked point once placed.
  let addAnchor: THREE.Vector2 | null = null;
  let addMode = false;
  const setAddMode = (on: boolean) => {
    addMode = on;
    addAnchor = null;
    canvas.style.cursor = on ? "crosshair" : "";
    onAddMode(on);
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
      });
    }
  });

  const setDimension = (axis: number, inches: number) => {
    if (selectedId === null) return;
    applyTransformFor(selectedId, doc.set_dimension(axis, inches));
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
    };
    probe.__selectedYaw = () =>
      selectedId !== null ? (furnishings.get(selectedId)?.group.rotation.y ?? null) : null;
    probe.__furnishingCount = () => furnishings.size;
    probe.__wallCount = () => wallPicks.children.length;
    probe.__floorTris = () => (floorMesh.geometry.index?.count ?? 0) / 3;
    probe.__deleteWallById = (id: number) => {
      doc.delete_wall(id);
      syncRoomGeometry();
      rebuildWallPicks();
    };
  }

  const resetScale = () => {
    if (selectedId === null) return;
    applyTransformFor(selectedId, doc.reset_scale());
    refreshSelection();
  };

  // The choice lives in the Rust document; JS just binds the matching material.
  const setFloorMaterial = (index: number) => {
    floorMesh.material = floorMaterials[doc.set_floor_material(index)];
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
    setDimension,
    resetScale,
    setFloorMaterial,
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
    },
    wallSegments: () => Array.from(doc.wall_segments()),
    wallIds: () => Array.from(doc.wall_ids()),
    startAddWall: () => {
      selectFurnishing(null);
      selectWall(null);
      setAddMode(true);
    },
    deleteSelectedWall,
    undo: () => {
      if (!doc.undo()) return null;
      // Undo can touch anything, so re-sync the whole scene from the restored document.
      syncRoomGeometry();
      rebuildWallPicks();
      selectWall(null);
      if (addMode) setAddMode(false);
      floorMesh.material = floorMaterials[doc.floor_material()];
      reconcileFurnishings();
      selectFurnishing(null);
      const hasRoom = doc.has_room();
      const [minX, minZ, maxX, maxZ] = doc.room_bounds();
      return {
        floorIndex: doc.floor_material(),
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
