import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/**
 * Renders catalog GLBs to data-URL thumbnails on demand, client-side. One small
 * offscreen renderer, reused; renders are serialised (a single GL context) and cached
 * by url. The panel calls this lazily as cards scroll into view, so it scales to a
 * large catalog without a build-time thumbnail pipeline.
 */
export type Thumbnailer = {
  render: (url: string) => Promise<string>;
  dispose: () => void;
};

export function createThumbnailer(size = 192): Thumbnailer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(size, size, false);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.9;
  pmrem.dispose();

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(2, 3, 2.5);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const cache = new Map<string, string>();
  let tail: Promise<unknown> = Promise.resolve(); // serialise renders on the one context

  const renderOne = async (url: string): Promise<string> => {
    const cached = cache.get(url);
    if (cached) return cached;
    const gltf = await loader.loadAsync(url);
    const obj = gltf.scene;
    scene.add(obj);
    try {
      const box = new THREE.Box3().setFromObject(obj);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const radius = sphere.radius || 1;
      const dir = new THREE.Vector3(1, 0.7, 1).normalize();
      const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15;
      camera.position.copy(sphere.center).add(dir.multiplyScalar(dist));
      camera.lookAt(sphere.center);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      const dataUrl = renderer.domElement.toDataURL("image/png");
      cache.set(url, dataUrl);
      return dataUrl;
    } finally {
      scene.remove(obj);
    }
  };

  return {
    render: (url) => {
      const next = tail.then(
        () => renderOne(url),
        () => renderOne(url),
      );
      tail = next.catch(() => {});
      return next;
    },
    dispose: () => renderer.dispose(),
  };
}
