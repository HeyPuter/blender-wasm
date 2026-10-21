/// <reference types="vite/client" />
/* The editor demo: an app sets up its own Babylon.js, Babylon Lite or three.js
 * scene (camera, lights, render loop) and mounts @knervous/blender-web-editor
 * over it. The editor makes that scene and Blender (WebAssembly, in this tab)
 * one project, and swaps to the full Blender UI on the same .blend and back.
 *
 * ?engine=babylon|lite|three picks the engine (only that one is loaded);
 * ?threads=1|0 forces the pthread or single-threaded runtime; ?runtime=<url>
 * loads the runtime from elsewhere (e.g. the package's runtime/ on a CDN);
 * ?ui=<url> uses a hosted Blender UI instead of public/blender-ui/.
 */
import { mountEditor, type Editor, type Viewport } from "@knervous/blender-web-editor";

const ENGINES = { babylon: "Babylon.js", lite: "Babylon Lite", three: "three.js" } as const;
type EngineKey = keyof typeof ENGINES;
const isEngine = (value: string | null): value is EngineKey => value !== null && value in ENGINES;

const params = new URLSearchParams(location.search);
const requested = params.get("engine");
const engineKey: EngineKey = isEngine(requested) ? requested : "babylon";
document.title = `Blender ⇄ ${ENGINES[engineKey]}`;

const nav = document.getElementById("engines");
for (const [key, name] of Object.entries(ENGINES)) {
  const link = document.createElement("a");
  link.href = `?${new URLSearchParams({ ...Object.fromEntries(params), engine: key })}`;
  link.textContent = name;
  if (key === engineKey) link.className = "on";
  nav?.append(link);
}

const stage = document.getElementById("stage");
const canvas = document.getElementById("viewport");
if (!(stage instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) throw new Error("#stage or #viewport missing");

/* --------------------------------------------------------------- engines */
// Each one is the app's own setup; the editor only gets the scene.
async function babylon(): Promise<Viewport<object>> {
  const BABYLON = await import("@babylonjs/core");
  await import("@babylonjs/loaders");
  await import("@babylonjs/serializers");
  const { babylonViewport } = await import("@knervous/blender-web-editor/babylon");
  const engine = new BABYLON.Engine(canvas as HTMLCanvasElement, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.16, 0.16, 0.17, 1);
  const camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 3, Math.PI / 3, 14, BABYLON.Vector3.Zero(), scene);
  camera.attachControl(canvas, true);
  camera.wheelPrecision = 30;
  camera.minZ = 0.05;
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
  return babylonViewport(BABYLON, scene, { helpers: true });
}

async function lite(): Promise<Viewport<object>> {
  const LITE = await import("@babylonjs/lite");
  const { liteViewport } = await import("@knervous/blender-web-editor/lite");
  const engine = await LITE.createEngine(canvas as HTMLCanvasElement);
  const scene = LITE.createSceneContext(engine);
  scene.clearColor = { r: 0.16, g: 0.16, b: 0.17, a: 1 };
  LITE.addToScene(scene, LITE.createHemisphericLight([0, 1, 0], 0.8));
  LITE.addToScene(scene, LITE.createDirectionalLight([-0.5, -1, -0.3], 0.9));
  const camera = LITE.createArcRotateCamera(-Math.PI / 3, Math.PI / 3, 14, LITE.vec3(0, 0, 0));
  LITE.addToScene(scene, camera);
  LITE.attachControl(camera, canvas as HTMLCanvasElement, scene);
  await LITE.registerScene(scene);
  // The render loop: its promise settles only when the engine stops.
  void LITE.startEngine(engine);
  return liteViewport(LITE, engine, scene, canvas as HTMLCanvasElement);
}

async function three(): Promise<Viewport<object>> {
  const THREE = await import("three");
  const [{ OrbitControls }, { TransformControls }, { GLTFLoader }, { GLTFExporter }, { threeViewport }] = await Promise.all([
    import("three/addons/controls/OrbitControls.js"), import("three/addons/controls/TransformControls.js"),
    import("three/addons/loaders/GLTFLoader.js"), import("three/addons/exporters/GLTFExporter.js"),
    import("@knervous/blender-web-editor/three"),
  ]);
  const view = canvas as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color().setRGB(0.16, 0.16, 0.17, THREE.SRGBColorSpace);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 1000);
  camera.position.set(6, 7, 10);
  const orbit = new OrbitControls(camera, view);
  orbit.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444448, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(5, 10, 3);
  scene.add(sun, new THREE.GridHelper(20, 20, 0x525259, 0x3a3a3f));
  const resize = (): void => {
    const { clientWidth: width, clientHeight: height } = view;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(view);
  resize();
  renderer.setAnimationLoop(() => { orbit.update(); renderer.render(scene, camera); });
  return threeViewport(THREE, scene, camera, view, { TransformControls, GLTFLoader, GLTFExporter, orbit });
}

const viewport = await (engineKey === "three" ? three() : engineKey === "lite" ? lite() : babylon());

/* ---------------------------------------------------------------- editor */
// The full Blender UI: public/blender-ui/ (npm run blender:ui) or a hosted one.
const uiUrl = params.get("ui") ?? new URL("blender-ui/index.html", document.baseURI).href;
const uiInstalled = params.has("ui") || await fetch(new URL("manifest.json", uiUrl), { cache: "no-store" })
  .then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("json"), () => false);

const forced = params.get("threads");
const editor: Editor = mountEditor({
  container: stage,
  viewport,
  runtimeUrl: params.get("runtime") ?? undefined,
  threads: forced === "1" ? true : forced === "0" ? false : "auto",
  blenderUi: uiInstalled ? uiUrl : undefined,
});
Object.assign(window, { editor });
