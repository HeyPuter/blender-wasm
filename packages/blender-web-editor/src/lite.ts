import type * as LITE from "@babylonjs/lite";
import { LiteSide, isMesh } from "@knervous/blender-web/lite";
import type { GizmoMode, Viewport } from "./viewport.ts";

type SceneNode = LITE.SceneNode;

/**
 * The editor's view of an app's Babylon Lite scene. `api` is the app's Lite
 * (`import * as LITE from "@babylonjs/lite"`); the engine, its scene
 * registration and render loop stay the app's. No gizmos: Lite's gizmos are a
 * toolkit of their own.
 */
export function liteViewport(api: typeof LITE, engine: LITE.EngineContext, scene: LITE.SceneContext,
  canvas: HTMLCanvasElement): Viewport<SceneNode> {
  const side = new LiteSide(api, engine, scene);
  let untracked: SceneNode[] = [];
  const created = new Map<string, LITE.Material>();
  const picker = api.createGpuPicker(scene);

  const pick: ((node: SceneNode | null) => void)[] = [];
  const editEnd: (() => void)[] = [];
  let down: [number, number] | null = null;
  canvas.addEventListener("pointerdown", (event) => { down = [event.clientX, event.clientY]; });
  canvas.addEventListener("pointerup", async (event) => {
    const start = down;
    down = null;
    if (!start || event.button !== 0) return;
    if (Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 4) {
      for (const listener of editEnd) listener();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const info = await api.pickAsync(picker, event.clientX - rect.left, event.clientY - rect.top);
    const mesh = info.hit && isMesh(info.pickedMesh) ? info.pickedMesh : null;
    let node: SceneNode | null = side.entityOf(mesh);
    if (!node && mesh) {
      for (let n: unknown = mesh; n && typeof n === "object" && "children" in n; n = Reflect.get(n, "parent")) {
        const found = untracked.find((u) => u === n);
        if (found) { node = found; break; }
      }
    }
    for (const listener of pick) listener(node);
  });

  const meshesUnder = (node: SceneNode): number => {
    let count = 0;
    const walk = (n: SceneNode): void => {
      if (isMesh(n)) count++;
      for (const child of n.children) walk(child);
    };
    walk(node);
    return count;
  };

  const remove = (node: SceneNode): void => {
    const parent = node.parent;
    if (parent && "children" in parent && Array.isArray(parent.children)) {
      const at = parent.children.indexOf(node);
      if (at >= 0) parent.children.splice(at, 1);
    }
    api.removeFromScene(scene, node);
    node.parent = null;
  };

  return {
    engine: "Babylon Lite",
    side,
    formats: ["glb", "gltf"],
    onPick: (listener) => { pick.push(listener); },
    onEditEnd: (listener) => { editEnd.push(listener); },
    attachGizmo() {},
    setGizmoMode(_mode: GizmoMode) {},
    nameOf: (node) => node.name,
    async openUntracked(file) {
      const container = await api.loadGltf(engine, file);
      api.addToScene(scene, container);
      const roots = container.entities.filter((e): e is SceneNode => "children" in e && "position" in e);
      untracked.push(...roots);
      return `opened ${file.name} in Babylon Lite, outside the project (${roots.reduce((n, r) => n + meshesUnder(r), 0)} meshes)`;
    },
    untracked() {
      untracked = untracked.filter((n) => n.parent !== null || n.name === "__root__");
      return untracked;
    },
    adoptUntracked() {
      const ids = side.track(untracked);
      untracked = [];
      return ids;
    },
    disposeUntracked(node) {
      remove(node);
      untracked = untracked.filter((n) => n !== node);
    },
    addPrimitive(kind, color) {
      const mesh = kind === "box" ? api.createBox(engine, 1) : api.createSphere(engine, { diameter: 1, segments: 16 });
      mesh.name = `${kind}_${Math.random().toString(16).slice(2, 6)}`;
      const material = api.createPbrMaterial({ name: `${mesh.name}_material` });
      side.materialAdapter.write(material, { color, metallic: 0, roughness: 0.6 });
      mesh.material = material;
      api.addToScene(scene, mesh);
      side.track([mesh]);
      return side.entityOf(mesh) ?? mesh;
    },
    deleteNode(node) {
      remove(node);
      untracked = untracked.filter((n) => n !== node);
    },
    assignMaterial(node, name) {
      const slot = side.slotMeshes(node)[0];
      if (!slot) return;
      slot.material = (name && (side.material(name) ?? created.get(name))) || side.emptySlot;
    },
    createMaterial(name, state) {
      const material = api.createPbrMaterial({ name });
      side.materialAdapter.write(material, state);
      created.set(name, material);
      return name;
    },
    editMaterial(name, state) {
      const material = side.material(name);
      if (material) side.materialAdapter.write(material, state);
    },
    decorate() {
      for (const [id, entity] of Object.entries(side.read())) {
        if (entity.kind !== "light" && entity.kind !== "camera") continue;
        const node = side.node(id);
        if (!node || node.children.some((c) => c.name.endsWith("_marker"))) continue;
        const light = entity.kind === "light";
        const marker = light ? api.createSphere(engine, { diameter: 0.3, segments: 8 }) : api.createBox(engine, 0.4);
        marker.name = `${entity.name}_marker`;
        marker.material = api.createPbrMaterial({
          baseColorFactor: light ? [1, 0.85, 0.3, 1] : [0.6, 0.6, 0.65, 1], metallicFactor: 0, roughnessFactor: 1,
        });
        node.children.push(marker);
        marker.parent = node;
        api.addToScene(scene, marker);
      }
    },
  };
}
