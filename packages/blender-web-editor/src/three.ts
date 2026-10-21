import type * as THREE from "three";
import type { TransformControls as TransformControlsType } from "three/addons/controls/TransformControls.js";
import type { GLTFExporter as GLTFExporterType } from "three/addons/exporters/GLTFExporter.js";
import type { GLTFLoader as GLTFLoaderType } from "three/addons/loaders/GLTFLoader.js";
import { ThreeSide } from "@knervous/blender-web/three";
import type { GizmoMode, Viewport } from "./viewport.ts";

type Object3D = THREE.Object3D;

/** three.js addons the viewport can use; each is optional. */
export interface ThreeAddons {
  TransformControls?: typeof TransformControlsType;
  GLTFLoader?: typeof GLTFLoaderType;
  GLTFExporter?: typeof GLTFExporterType;
  /** Orbit (or other) camera controls to pause while a gizmo drags. */
  orbit?: { enabled: boolean };
}

/**
 * The editor's view of an app's three.js scene. `api` is the app's three
 * (`import * as THREE from "three"`); its renderer, camera and render loop
 * stay the app's. Gizmos, glTF opening and glTF export come from the addons
 * passed in.
 */
export function threeViewport(api: typeof THREE, scene: THREE.Scene, camera: THREE.Camera, canvas: HTMLCanvasElement,
  addons: ThreeAddons = {}): Viewport<Object3D> {
  const side = new ThreeSide(api, scene);
  const created = new Map<string, THREE.MeshStandardMaterial>();
  let untracked: Object3D[] = [];
  const untrackedRootOf = (node: Object3D | null): Object3D | null => {
    for (let n = node; n; n = n.parent) if (untracked.includes(n)) return n;
    return null;
  };

  const pick: ((node: Object3D | null) => void)[] = [];
  const editEnd: (() => void)[] = [];
  const gizmo = addons.TransformControls ? new addons.TransformControls(camera, canvas) : null;
  if (gizmo) {
    scene.add(gizmo.getHelper());
    gizmo.addEventListener("dragging-changed", (event) => {
      if (addons.orbit) addons.orbit.enabled = !event.value;
      if (!event.value) for (const listener of editEnd) listener();
    });
  }

  // A tap is a pointer down and up without much movement in between.
  const raycaster = new api.Raycaster();
  let down: THREE.Vector2 | null = null;
  canvas.addEventListener("pointerdown", (event) => { down = new api.Vector2(event.clientX, event.clientY); });
  canvas.addEventListener("pointerup", (event) => {
    const start = down;
    down = null;
    if (!start || event.button !== 0 || gizmo?.dragging) return;
    if (start.distanceTo(new api.Vector2(event.clientX, event.clientY)) > 4) {
      for (const listener of editEnd) listener();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new api.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ), camera);
    const hit = raycaster.intersectObjects([side.root, ...untracked], true).find((h) => h.object.visible);
    const object = hit?.object ?? null;
    const node = side.entityOf(object) ?? untrackedRootOf(object);
    for (const listener of pick) listener(node);
  });

  return {
    engine: "three.js",
    side,
    gizmos: Boolean(gizmo),
    formats: addons.GLTFLoader ? ["glb", "gltf"] : [],
    nativeExport: addons.GLTFExporter ? { label: "three .glb", file: "scene-three.glb" } : undefined,
    onPick: (listener) => { pick.push(listener); },
    onEditEnd: (listener) => { editEnd.push(listener); },
    attachGizmo(node) {
      if (!gizmo) return;
      if (node) gizmo.attach(node);
      else gizmo.detach();
    },
    setGizmoMode(mode: GizmoMode) {
      gizmo?.setMode(mode === "position" ? "translate" : mode === "rotation" ? "rotate" : "scale");
    },
    nameOf: (node) => node.name || node.type,
    async openUntracked(file) {
      if (!addons.GLTFLoader) throw new Error("no GLTFLoader passed to threeViewport");
      const url = URL.createObjectURL(file);
      let root: Object3D;
      try { root = (await new addons.GLTFLoader().loadAsync(url)).scene; } finally { URL.revokeObjectURL(url); }
      if (!root.name) root.name = file.name;
      scene.add(root);
      untracked.push(root);
      let meshes = 0;
      root.traverse((n) => { if (n instanceof api.Mesh) meshes++; });
      return `opened ${file.name} in three.js, outside the project (${meshes} meshes)`;
    },
    untracked() {
      untracked = untracked.filter((n) => n.parent !== null);
      return untracked;
    },
    adoptUntracked() {
      const ids = side.track(untracked);
      untracked = [];
      return ids;
    },
    disposeUntracked(node) {
      node.removeFromParent();
      node.traverse((n) => { if (n instanceof api.Mesh) n.geometry.dispose(); });
      untracked = untracked.filter((n) => n !== node);
    },
    addPrimitive(kind, color) {
      const name = `${kind}_${Math.random().toString(16).slice(2, 6)}`;
      const material = new api.MeshStandardMaterial({ name: `${name}_material` });
      side.materialAdapter.write(material, { color, metallic: 0, roughness: 0.6 });
      const mesh = new api.Mesh(kind === "box" ? new api.BoxGeometry(1, 1, 1) : new api.SphereGeometry(0.5, 32, 16), material);
      mesh.name = name;
      scene.add(mesh);
      side.track([mesh]);
      return mesh;
    },
    deleteNode(node) {
      node.removeFromParent();
      node.traverse((n) => { if (n instanceof api.Mesh) n.geometry.dispose(); });
      untracked = untracked.filter((n) => n !== node);
    },
    assignMaterial(node, name) {
      if (!(node instanceof api.Mesh)) return;
      const material = (name && (side.material(name) ?? created.get(name))) || side.emptySlot;
      if (Array.isArray(node.material)) node.material = [material, ...node.material.slice(1)];
      else node.material = material;
    },
    createMaterial(name, state) {
      const material = new api.MeshStandardMaterial({ name });
      side.materialAdapter.write(material, state);
      created.set(material.name, material);
      return material.name;
    },
    editMaterial(name, state) {
      const material = side.material(name);
      if (material) side.materialAdapter.write(material, state);
    },
    decorate() {
      for (const [id, entity] of Object.entries(side.read())) {
        if (entity.kind !== "light" && entity.kind !== "camera") continue;
        const node = side.node(id);
        if (!node || node.children.some((c) => c.userData.marker)) continue;
        const light = entity.kind === "light";
        const marker = new api.Mesh(
          light ? new api.SphereGeometry(0.15, 12, 8) : new api.BoxGeometry(0.5, 0.35, 0.25),
          new api.MeshBasicMaterial({ color: light ? 0xffd94d : 0x999aa6, wireframe: !light }),
        );
        marker.name = `${entity.name}_marker`;
        marker.userData = { marker: true };
        node.add(marker);
      }
    },
    exportNative: addons.GLTFExporter ? async () => {
      const Exporter = addons.GLTFExporter;
      if (!Exporter) throw new Error("no GLTFExporter");
      const glb = await new Exporter().parseAsync([side.root, ...untracked], { binary: true });
      return glb instanceof ArrayBuffer ? glb : JSON.stringify(glb);
    } : undefined,
  };
}
