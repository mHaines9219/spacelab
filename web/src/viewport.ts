import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import init, { Spike } from "./wasm/wasm_bindings.js";

// Front vector measured off the GLB: the backrest sits at -Z, so the model already
// faces +Z and needs no correction. Real catalog assets will not be so lucky.
const CHAIR_URL = "/assets/sheen-chair.glb";
const CHAIR_FRONT_YAW = 0;

export type Stats = {
  fps: number;
  frameMs: number;
  renderMs: number;
  dragUs: number;
  triangles: number;
  snapped: boolean;
  wasmBytes: number;
};

export async function createViewport(
  canvas: HTMLCanvasElement,
  onStats: (stats: Stats) => void,
) {
  await init();
  const spike = new Spike();

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

  const shell = new THREE.Mesh(
    shellGeometry(spike),
    new THREE.MeshStandardMaterial({
      color: 0xdedad2,
      roughness: 0.9,
      metalness: 0,
    }),
  );
  shell.castShadow = true;
  shell.receiveShadow = true;
  scene.add(shell);

  const chair = new THREE.Group();
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

  let snapped = false;
  const place = (x: number, z: number) => {
    const out = spike.drag(x, z);
    chair.position.set(out[0], out[1], out[2]);
    chair.rotation.y = out[3];
    snapped = out[4] === 1;
  };

  // Timed in a batch rather than per pointer move: a single call lands under
  // performance.now()'s resolution, so per-move sampling only measures the clock.
  const dragUs = (() => {
    const samples = 2000;
    const start = performance.now();
    for (let i = 0; i < samples; i++) spike.drag(2.1, (i % 340) * 0.01);
    return ((performance.now() - start) * 1000) / samples;
  })();

  const raycaster = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pointer = new THREE.Vector2();
  const hit = new THREE.Vector3();
  let dragging = false;

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
    if (raycaster.intersectObject(chair, true).length === 0) return;
    dragging = true;
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    aimAt(event);
    if (raycaster.ray.intersectPlane(floorPlane, hit)) place(hit.x, hit.z);
  });

  const endDrag = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    controls.enabled = true;
    canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  place(2.1, 1.7);

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

  return () => {
    renderer.setAnimationLoop(null);
    resize.disconnect();
    controls.dispose();
    renderer.dispose();
  };
}

function shellGeometry(spike: Spike) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(spike.shell_positions(), 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(spike.shell_normals(), 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(spike.shell_indices(), 1));
  return geometry;
}

function transferredWasmBytes() {
  const entry = performance
    .getEntriesByType("resource")
    .find((resource) => resource.name.endsWith(".wasm")) as
    | PerformanceResourceTiming
    | undefined;
  return entry ? entry.encodedBodySize || entry.transferSize : 0;
}
