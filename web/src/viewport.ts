import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import init, { Document } from "./wasm/wasm_bindings.js";

// Front vector measured off the GLB: the backrest sits at -Z, so the model already
// faces +Z and needs no correction. Real catalog assets will not be so lucky.
const CHAIR_URL = "/assets/sheen-chair.glb";
const CHAIR_FRONT_YAW = 0;

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

/** Real-world size in inches `[width, depth, height]`, or null when nothing is selected. */
export type Selection = { dims: [number, number, number] } | null;

export type ViewportHandle = {
  dispose: () => void;
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

  const chair = new THREE.Group();
  chair.visible = false; // shown once a room exists
  scene.add(chair);
  const gltf = await new GLTFLoader().loadAsync(CHAIR_URL);
  gltf.scene.rotation.y = CHAIR_FRONT_YAW;
  gltf.scene.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  chair.add(gltf.scene);

  // Selection outline: an edge box at the asset's catalog size, parented to the
  // chair so it inherits position, yaw, and scale for free. dimensions() reads
  // inches at the current (unit) scale, so this is the true base extent.
  const base = doc.dimensions();
  const [bw, bd, bh] = [base[0] / IN_PER_M, base[1] / IN_PER_M, base[2] / IN_PER_M];
  const selectionBox = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(bw, bh, bd)),
    new THREE.LineBasicMaterial({ color: 0x5b9dff }),
  );
  selectionBox.position.y = bh / 2;
  selectionBox.visible = false;
  chair.add(selectionBox);

  let snapped = false;
  const applyTransform = (out: Float32Array) => {
    chair.position.set(out[0], out[1], out[2]);
    chair.rotation.y = out[3];
    chair.scale.set(out[4], out[5], out[6]);
    snapped = out[7] === 1;
  };
  const place = (x: number, z: number) => applyTransform(doc.drag(x, z));

  let selected = false;
  const select = (on: boolean) => {
    selected = on;
    selectionBox.visible = on;
    onSelection(on ? { dims: [...doc.dimensions()] as [number, number, number] } : null);
  };

  // Timed in a batch rather than per pointer move: a single call lands under
  // performance.now()'s resolution, so per-move sampling only measures the clock.
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

    // Chair takes priority, then walls, then empty space.
    if (raycaster.intersectObject(chair, true).length > 0) {
      selectWall(null);
      select(true);
      dragging = true;
      dragMoved = false;
      controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    const wallHit = raycaster.intersectObjects(wallPicks.children, false)[0];
    if (wallHit) {
      select(false);
      selectWall(wallHit.object.userData.wallId as number);
      return;
    }
    select(false);
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
    if ((event.key === "Delete" || event.key === "Backspace") && selectedWall !== null) {
      deleteSelectedWall();
      event.preventDefault();
      return;
    }
    if (!selected) return;
    switch (event.key) {
      case "ArrowLeft":
        applyTransform(doc.rotate(-1)); // clockwise
        break;
      case "ArrowRight":
        applyTransform(doc.rotate(1)); // counter-clockwise
        break;
      case "ArrowUp":
        applyTransform(doc.scale_by(1));
        select(true); // refresh the dimensions panel
        break;
      case "ArrowDown":
        applyTransform(doc.scale_by(-1));
        select(true);
        break;
      case "r":
      case "R":
        applyTransform(doc.reset_scale());
        select(true);
        break;
      case "Escape":
        select(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  };
  window.addEventListener("keydown", onKey);

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

  // A room was (re)generated: rebuild geometry, drop the chair in, reveal it, reframe.
  const showRoom = () => {
    syncRoomGeometry();
    rebuildWallPicks();
    selectWall(null);
    applyTransform(doc.chair_transform());
    chair.visible = true;
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
    applyTransform(doc.set_dimension(axis, inches));
    if (selected) {
      onSelection({ dims: [...doc.dimensions()] as [number, number, number] });
    }
  };

  // Dev-only probe so the e2e test can read yaw (scale/reset are visible in the
  // panel; rotation isn't). Stripped from production by the `import.meta.env.DEV` gate.
  if (import.meta.env.DEV) {
    const probe = window as unknown as {
      __chairYaw?: () => number;
      __wallCount?: () => number;
      __floorTris?: () => number;
      __deleteWallById?: (id: number) => void;
    };
    probe.__chairYaw = () => chair.rotation.y;
    probe.__wallCount = () => wallPicks.children.length;
    probe.__floorTris = () => (floorMesh.geometry.index?.count ?? 0) / 3;
    probe.__deleteWallById = (id: number) => {
      doc.delete_wall(id);
      syncRoomGeometry();
      rebuildWallPicks();
    };
  }

  const resetScale = () => {
    applyTransform(doc.reset_scale());
    if (selected) {
      onSelection({ dims: [...doc.dimensions()] as [number, number, number] });
    }
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
      select(false);
      selectWall(null);
      setAddMode(true);
    },
    deleteSelectedWall,
    undo: () => {
      if (!doc.undo()) return null;
      // Undo can touch anything, so re-sync the whole scene from the restored document.
      syncRoomGeometry();
      rebuildWallPicks();
      select(false);
      selectWall(null);
      if (addMode) setAddMode(false);
      floorMesh.material = floorMaterials[doc.floor_material()];
      const hasRoom = doc.has_room();
      chair.visible = hasRoom;
      applyTransform(doc.chair_transform());
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
