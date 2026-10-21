import type * as BABYLON from "@babylonjs/core";
import { BabylonSide } from "@knervous/blender-web/babylon";
import type { GizmoMode, Viewport } from "./viewport.ts";

type TransformNode = BABYLON.TransformNode;
type Node = BABYLON.Node;

export interface BabylonViewportOptions {
  /** Add a grid and two lights (default false: the app's scene is the app's). */
  helpers?: boolean;
}

/**
 * The editor's view of an app's Babylon.js scene. `api` is the app's Babylon
 * (`import * as BABYLON from "@babylonjs/core"`, or the playground's global
 * BABYLON) with its loaders and serializers registered; the scene's active
 * camera and render loop stay the app's.
 */
export function babylonViewport(api: typeof BABYLON, scene: BABYLON.Scene, options: BabylonViewportOptions = {}): Viewport<TransformNode> {
  if (options.helpers) {
    new api.HemisphericLight("editor-sky", new api.Vector3(0, 1, 0), scene).intensity = 0.8;
    new api.DirectionalLight("editor-sun", new api.Vector3(-0.5, -1, -0.3), scene).intensity = 0.9;
    const lines: BABYLON.Vector3[][] = [];
    for (let i = -10; i <= 10; i++) lines.push([new api.Vector3(i, 0, -10), new api.Vector3(i, 0, 10)], [new api.Vector3(-10, 0, i), new api.Vector3(10, 0, i)]);
    const grid = api.MeshBuilder.CreateLineSystem("editor-grid", { lines }, scene);
    grid.color = new api.Color3(0.32, 0.32, 0.35);
    grid.isPickable = false;
  }

  const side = new BabylonSide(api, scene);
  /** Materials made here and not yet on a tracked mesh (so not yet project materials). */
  const created = new Map<string, BABYLON.PBRMaterial>();
  /** Content loaded into Babylon outside the project (until adopted). */
  let untracked: TransformNode[] = [];
  const untrackedRootOf = (node: Node | null): TransformNode | null => {
    for (let n = node; n; n = n.parent) if (n instanceof api.TransformNode && untracked.includes(n)) return n;
    return null;
  };

  const gizmos = new api.GizmoManager(scene);
  gizmos.usePointerToAttachGizmos = false;
  gizmos.positionGizmoEnabled = true;
  let attached: TransformNode | null = null;

  const pick: ((node: TransformNode | null) => void)[] = [];
  const editEnd: (() => void)[] = [];
  scene.onPointerObservable.add((info) => {
    if (info.type === api.PointerEventTypes.POINTERTAP && info.event.button === 0) {
      const mesh = info.pickInfo?.hit ? info.pickInfo.pickedMesh : null;
      const node = side.entityOf(mesh) ?? untrackedRootOf(mesh);
      for (const listener of pick) listener(node);
    } else if (info.type === api.PointerEventTypes.POINTERUP) {
      for (const listener of editEnd) listener();
    }
  });

  return {
    engine: "Babylon.js",
    side,
    gizmos: true,
    formats: ["glb", "gltf", "obj", "stl", "babylon", "usdz", "usda", "usdc", "usd"],
    nativeExport: { label: ".babylon", file: "scene.babylon" },
    onPick: (listener) => { pick.push(listener); },
    onEditEnd: (listener) => { editEnd.push(listener); },
    attachGizmo(node) {
      attached = node;
      gizmos.attachToNode(node);
    },
    setGizmoMode(mode: GizmoMode) {
      gizmos.positionGizmoEnabled = mode === "position";
      gizmos.rotationGizmoEnabled = mode === "rotation";
      gizmos.scaleGizmoEnabled = mode === "scale";
      gizmos.attachToNode(attached);
    },
    nameOf: (node) => node.name,
    async openUntracked(file) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const camera = scene.activeCamera;
      // A File, not its bytes: the text formats refuse an ArrayBufferView source.
      const container = await api.LoadAssetContainerAsync(file, scene, { pluginExtension: `.${ext}`, name: file.name });
      container.addAllToScene();
      if (camera) scene.activeCamera = camera;
      untracked.push(...[...container.transformNodes, ...container.meshes].filter((n) => !n.parent));
      return `opened ${file.name} in Babylon, outside the project (${container.meshes.length} meshes)`;
    },
    untracked() {
      untracked = untracked.filter((n) => !n.isDisposed());
      return untracked;
    },
    adoptUntracked() {
      const ids = side.track(untracked);
      untracked = [];
      return ids;
    },
    disposeUntracked(node) {
      node.dispose(false, true);
      untracked = untracked.filter((n) => n !== node);
    },
    exportNative: async () => JSON.stringify(await api.SceneSerializer.SerializeAsync(scene)),
    addPrimitive(kind, color) {
      const name = `${kind}_${Math.random().toString(16).slice(2, 6)}`;
      const mesh = kind === "box"
        ? api.MeshBuilder.CreateBox(name, { size: 1 }, scene)
        : api.MeshBuilder.CreateSphere(name, { diameter: 1, segments: 16 }, scene);
      const material = new api.PBRMaterial(`${name}_material`, scene);
      side.materialAdapter.write(material, { color, metallic: 0, roughness: 0.6 });
      mesh.material = material;
      side.track([mesh]);
      return mesh;
    },
    deleteNode(node) {
      node.dispose(false, false);
      untracked = untracked.filter((n) => n !== node);
    },
    assignMaterial(node, name) {
      if (!(node instanceof api.Mesh)) return;
      const material = name ? side.material(name) ?? created.get(name) ?? null : null;
      if (node.material instanceof api.MultiMaterial) node.material.subMaterials[0] = material;
      else node.material = material;
    },
    createMaterial(name, state) {
      const material = new api.PBRMaterial(name, scene);
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
        if (!node || node.getChildMeshes(true).some((m) => m.metadata?.marker)) continue;
        const light = entity.kind === "light";
        const marker = light
          ? api.MeshBuilder.CreateSphere(`${entity.name}_marker`, { diameter: 0.3, segments: 8 }, scene)
          : api.MeshBuilder.CreateBox(`${entity.name}_marker`, { width: 0.5, height: 0.35, depth: 0.25 }, scene);
        const material = new api.StandardMaterial(`${entity.name}_marker`, scene);
        material.emissiveColor = light ? new api.Color3(1, 0.85, 0.3) : new api.Color3(0.6, 0.6, 0.65);
        material.disableLighting = true;
        material.wireframe = !light;
        marker.material = material;
        marker.parent = node;
        marker.metadata = { marker: true };
      }
    },
  };
}
