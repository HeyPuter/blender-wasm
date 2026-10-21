/// <reference types="vite/client" />
/* SDK sync vs the previous whole-scene path, on the same in-tab Blender.
 *
 * legacy: what the demo did before the project model: every operation runs Blender,
 *   saves the .blend, exports the whole scene as GLB, and Babylon disposes its
 *   container and loads the GLB again (the transform push is the old
 *   APPLY_TRANSFORMS script, verbatim).
 * sdk: Project + BabylonSide; typed changes out, only Blender's changes in.
 *
 * One mode per page load (?mode=sdk | ?mode=legacy), so heaps do not mix.
 * Results land in the table and on window.__bench.
 */
import * as BABYLON from "@babylonjs/core";
import {
  ArcRotateCamera, Color4, Engine, HemisphericLight, LoadAssetContainerAsync, Matrix, Quaternion, Scene, Vector3,
  type AssetContainer, type TransformNode,
} from "@babylonjs/core";
import "@babylonjs/loaders";
import { Project, type BlenderRunner, type BlenderSession } from "@knervous/blender-web";
import { createBlenderRunner, createBlenderSession, runtimeInstalled } from "@knervous/blender-web/browser";
import { BabylonSide } from "@knervous/blender-web/babylon";

const requested = new URLSearchParams(location.search).get("mode");
const mode = requested === "legacy" || requested === "session" ? requested : "sdk";
document.getElementById("mode")!.textContent = mode;
const status = (text: string): void => { document.getElementById("status")!.textContent = text; };

const engine = new Engine(document.getElementById("viewport") as HTMLCanvasElement, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.16, 0.16, 0.17, 1);
const camera = new ArcRotateCamera("camera", -Math.PI / 2.5, Math.PI / 3, 26, new Vector3(0, 1, 0), scene);
camera.attachControl(true);
new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
engine.runRenderLoop(() => scene.render());

/* ------------------------------------------------------------ metering */
interface Run { ms: number; bytesIn: number; bytesOut: number }
const size = (files: Record<string, Uint8Array>): number => Object.values(files).reduce((n, f) => n + f.byteLength, 0);

class MeteredRunner implements BlenderRunner {
  last: Run = { ms: 0, bytesIn: 0, bytesOut: 0 };
  constructor(private readonly inner: BlenderRunner) {}
  async run(job: Parameters<BlenderRunner["run"]>[0]): ReturnType<BlenderRunner["run"]> {
    const started = performance.now();
    const result = await this.inner.run(job);
    this.last = { ms: performance.now() - started, bytesIn: size(job.files) + job.code.length, bytesOut: size(result.files) };
    return result;
  }
}

/** The same metering around a persistent session's requests. */
class MeteredSession implements BlenderSession {
  last: Run = { ms: 0, bytesIn: 0, bytesOut: 0 };
  constructor(private readonly inner: BlenderSession) {}
  async request(request: Parameters<BlenderSession["request"]>[0]): ReturnType<BlenderSession["request"]> {
    const started = performance.now();
    const result = await this.inner.request(request);
    const blendIn = request.load?.kind === "blend" ? request.load.bytes.byteLength : 0;
    this.last = {
      ms: performance.now() - started,
      bytesIn: size(request.files) + JSON.stringify(request.job).length + blendIn,
      bytesOut: size(result.files),
    };
    return result;
  }
}

const counts = { meshesCreated: 0, meshesDisposed: 0, geometriesCreated: 0, geometriesDisposed: 0 };
scene.onNewMeshAddedObservable.add(() => counts.meshesCreated++);
scene.onMeshRemovedObservable.add(() => counts.meshesDisposed++);
scene.onNewGeometryAddedObservable.add(() => counts.geometriesCreated++);
scene.onGeometryRemovedObservable.add(() => counts.geometriesDisposed++);

const heap = (): number => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;

interface Step {
  step: string; totalMs: number; blenderMs: number; pageMs: number; bytesIn: number; bytesOut: number;
  meshesCreated: number; meshesDisposed: number; geometriesCreated: number; heapMB: number; sceneMeshes: number;
}
const steps: Step[] = [];

async function measure(name: string, runner: { last: Run }, work: () => Promise<void>): Promise<void> {
  status(`${name}…`);
  const before = { ...counts };
  const started = performance.now();
  await work();
  // Include what the page pays to show the result: first render after apply.
  await scene.whenReadyAsync();
  scene.render();
  const totalMs = performance.now() - started;
  steps.push({
    step: name,
    totalMs,
    blenderMs: runner.last.ms,
    pageMs: totalMs - runner.last.ms,
    bytesIn: runner.last.bytesIn,
    bytesOut: runner.last.bytesOut,
    meshesCreated: counts.meshesCreated - before.meshesCreated,
    meshesDisposed: counts.meshesDisposed - before.meshesDisposed,
    geometriesCreated: counts.geometriesCreated - before.geometriesCreated,
    heapMB: heap() / 1048576,
    sceneMeshes: scene.meshes.length,
  });
  render();
}

/* ------------------------------------------------------------ scenario */
const SETUP = `
import bpy
mats = []
for i, c in enumerate([(0.8, 0.2, 0.2, 1), (0.2, 0.6, 0.9, 1), (0.9, 0.7, 0.2, 1), (0.3, 0.8, 0.4, 1)]):
    m = bpy.data.materials.new(f"mat{i}")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = c
    mats.append(m)
for i in range(36):
    x, y = (i % 6) * 2.5 - 6.25, (i // 6) * 2.5 - 6.25
    kind = i % 3
    if kind == 0:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=(x, y, 1))
    elif kind == 1:
        bpy.ops.mesh.primitive_monkey_add(location=(x, y, 1))
    else:
        bpy.ops.mesh.primitive_cube_add(location=(x, y, 1))
        b = bpy.context.object.modifiers.new("bevel", "BEVEL")
        b.width, b.segments = 0.2, 4
    o = bpy.context.object
    o.name = f"obj{i:02d}"
    o.data.materials.append(mats[i % 4])
`;
const bevel = (name: string): string =>
  `import bpy\nb = bpy.data.objects['${name}'].modifiers.new('b', 'BEVEL')\nb.width, b.segments, b.limit_method = 0.05, 3, 'NONE'`;
const recolour = (rgb: string): string =>
  `import bpy\nbpy.data.materials['mat1'].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (${rgb}, 1)`;

/* The previous path, kept only here for comparison. */
const EPILOGUE = `
import bpy as _bpy, json as _json
_bpy.ops.wm.save_as_mainfile(filepath="/out/session.blend", check_existing=False)
_bpy.ops.export_scene.gltf(
    filepath="/out/scene.glb", export_format="GLB",
    export_cameras=True, export_lights=True, export_extras=True, export_yup=True,
    export_apply=True)
_json.dump({"objects": [o.name for o in _bpy.context.scene.objects]}, open("/out/report.json", "w"))
`;
const APPLY_TRANSFORMS = `
import bpy, json
from mathutils import Matrix
to_gltf = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
from_gltf = to_gltf.inverted()
job = json.load(open("/job/transforms.json"))
for name, m in job["transforms"].items():
    obj = bpy.data.objects.get(name)
    if obj is None or obj.type in {"CAMERA", "LIGHT"}:
        continue
    local_gltf = Matrix((m[0:4], m[4:8], m[8:12], m[12:16])).transposed()
    obj.matrix_local = from_gltf @ local_gltf @ to_gltf
`;

async function legacy(runner: MeteredRunner): Promise<void> {
  let blend: Uint8Array | null = null;
  let container: AssetContainer | null = null;
  const run = async (code: string, files: Record<string, Uint8Array> = {}): Promise<void> => {
    const staged = { ...files, ...(blend ? { "/in/session.blend": blend } : {}) };
    const result = await runner.run({ code: code + "\n" + EPILOGUE, blendFile: blend ? "/in/session.blend" : undefined, files: staged });
    blend = result.files["/out/session.blend"];
    const next = await LoadAssetContainerAsync(result.files["/out/scene.glb"], scene, { pluginExtension: ".glb" });
    container?.dispose();
    container = next;
    next.addAllToScene();
    scene.activeCamera = camera;
  };
  const move = async (name: string): Promise<void> => {
    const node = scene.getNodes().find((n): n is TransformNode => n.name === name && "position" in n);
    if (!node) throw new Error(`${name} not loaded`);
    node.position.x += 1;
    const m = Matrix.Compose(node.scaling, node.rotationQuaternion ?? Quaternion.FromEulerVector(node.rotation), node.position);
    const transforms = { [name]: Array.from(m.asArray()) };
    await run(APPLY_TRANSFORMS, { "/job/transforms.json": new TextEncoder().encode(JSON.stringify({ transforms })) });
  };
  await measure("setup (36 objects)", runner, () => run(SETUP));
  for (const round of [1, 2]) {
    await measure(`move 1 object #${round}`, runner, () => move(round === 1 ? "obj07" : "obj13"));
    await measure(`bevel 1 object #${round}`, runner, () => run(bevel(round === 1 ? "obj04" : "obj05")));
    await measure(`recolour 1 material #${round}`, runner, () => run(recolour(round === 1 ? "0.1, 0.9, 0.5" : "0.9, 0.1, 0.5")));
    await measure(`idle reload #${round}`, runner, () => run(""));
  }
}

async function sdk(runner: MeteredRunner | MeteredSession): Promise<void> {
  const side = new BabylonSide(BABYLON, scene);
  const project = runner instanceof MeteredSession
    ? new Project({ session: runner, scene: side })
    : new Project({ blender: runner, scene: side });
  const move = async (name: string): Promise<void> => {
    const entity = Object.values(side.read()).find((e) => e.name === name);
    const node = entity && side.node(entity.id);
    if (!node) throw new Error(`${name} not in the project`);
    node.position.x += 1;
    await project.sync();
  };
  await measure("setup (36 objects)", runner, async () => { await project.newScene(); await project.sync({ script: SETUP }); });
  for (const round of [1, 2]) {
    await measure(`move 1 object #${round}`, runner, () => move(round === 1 ? "obj07" : "obj13"));
    await measure(`bevel 1 object #${round}`, runner, async () => { await project.sync({ script: bevel(round === 1 ? "obj04" : "obj05") }); });
    await measure(`recolour 1 material #${round}`, runner, async () => { await project.sync({ script: recolour(round === 1 ? "0.1, 0.9, 0.5" : "0.9, 0.1, 0.5") }); });
    await measure(`idle sync #${round}`, runner, async () => { await project.sync(); });
  }
}

/* ------------------------------------------------------------ output */
const kb = (n: number): string => (n / 1024).toFixed(0);
function render(): void {
  const table = document.getElementById("results")!;
  table.innerHTML = "<tr><th>step</th><th>total ms</th><th>blender</th><th>page</th><th>in KB</th><th>out KB</th><th>mesh +/−</th><th>heap MB</th></tr>"
    + steps.map((s) => `<tr><td>${s.step}</td><td>${s.totalMs.toFixed(0)}</td><td>${s.blenderMs.toFixed(0)}</td><td>${s.pageMs.toFixed(0)}</td>`
      + `<td>${kb(s.bytesIn)}</td><td>${kb(s.bytesOut)}</td><td>${s.meshesCreated}/${s.meshesDisposed}</td><td>${s.heapMB.toFixed(1)}</td></tr>`).join("");
}

async function main(): Promise<void> {
  if (!crossOriginIsolated) { status("not cross-origin isolated"); return; }
  // The Vite plugin serves the runtime package here.
  const runtimeUrl = new URL("blender-runtime/", document.baseURI);
  if (!(await runtimeInstalled(runtimeUrl))) { status("no Blender runtime at blender-runtime/"); return; }
  let bootMs = 0;
  if (mode === "session") {
    const live = createBlenderSession({ runtimeUrl, onProgress: (p) => status(`${p.detail} (${Math.round(p.fraction * 100)}%)`) });
    // Boot once (compile, data, Blender start), reported apart from the steps.
    status("booting the session…");
    await live.boot();
    bootMs = live.bootMs;
    Object.assign(window, { __boot: { compileMs: live.compileMs, startMs: live.startMs, phases: live.phases } });
    await sdk(new MeteredSession(live));
  } else {
    const runner = new MeteredRunner(createBlenderRunner({ runtimeUrl }));
    // Warm the runtime once (compile + data fetch), outside the measurements.
    status("warming the runtime…");
    const warm = performance.now();
    await runner.run({ code: "print('warm')\n", files: {} });
    bootMs = performance.now() - warm;
    await (mode === "legacy" ? legacy(runner) : sdk(runner));
  }

  status("measuring memory (measureUserAgentSpecificMemory may wait for a GC)…");
  let uaMemoryMB: number | null = null;
  const measureMemory = (performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> })
    .measureUserAgentSpecificMemory;
  if (measureMemory) {
    // Present but refused in some embedders; the per-step JS heap still stands.
    const result = await Promise.race([
      measureMemory.call(performance).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 45_000)),
    ]);
    if (result) uaMemoryMB = result.bytes / 1048576;
  }
  const summary = { mode, bootMs, steps, finalHeapMB: heap() / 1048576, uaMemoryMB, sceneMeshes: scene.meshes.length, geometries: scene.geometries.length, counts };
  Object.assign(window, { __bench: summary });
  document.getElementById("memory")!.textContent =
    `boot/warm ${(bootMs / 1000).toFixed(1)} s · JS heap ${summary.finalHeapMB.toFixed(1)} MB · page memory ${uaMemoryMB?.toFixed(1) ?? "n/a"} MB · ${summary.sceneMeshes} meshes, ${summary.geometries} geometries`;
  status("done");
}

void main().catch((error) => { status(`failed: ${error instanceof Error ? error.message : String(error)}`); console.error(error); });
