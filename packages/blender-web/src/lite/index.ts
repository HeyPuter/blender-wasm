import type * as LITE from "@babylonjs/lite";
import type {
  Change, EngineSide, EntityKind, EntityState, Field, MaterialAdapter, MaterialAssignment, MaterialState, MeshData,
  Transform,
} from "../project/index.ts";

/**
 * Babylon Lite side of a project (`@knervous/blender-web/lite`): the core
 * adapter between Lite scene nodes and the shared description.
 *
 * It reads the scene as Lite holds it. Move a node, set `mesh.material`,
 * change a material's factors, or `removeFromScene` a node with Lite's own
 * API, and the next sync carries it. It writes what Blender changed back the
 * same way. Editing tools are left to the app.
 *
 * Lite comes from the app (`new LiteSide(LITE, engine, scene)`): the adapter
 * imports only Lite's types, so it uses the app's copy of Lite and its scene
 * registries. Pass the namespace or just the functions in `LiteApi`.
 *
 * Layout. Every project entity lives under a root that mirrors X, the same
 * transform Lite's glTF loader gives its `__root__`, so node values are the
 * shared description's glTF-space values and loaded glTF keeps its place. A
 * Lite mesh has one material, so a mesh entity is a node whose child meshes
 * are its material slots (as Lite's loader lays out a glTF node's
 * primitives); `slotMeshes(node)` lists them.
 *
 * Field adapters translate each field between a node and the shared
 * description; the material adapter does the same for material properties.
 */
export type LiteApi = Pick<typeof LITE,
  "addToScene" | "createMeshFromData" | "createPbrMaterial" | "createTransformNode" | "decomposeMat4"
  | "getMeshGeometry" | "isPbrMaterial" | "isStandardMaterial" | "removeFromScene" | "setSubtreeVisible">;

type SceneNode = LITE.SceneNode;
type Mesh = LITE.Mesh;
type Material = LITE.Material;

export interface FieldAdapter<V> {
  read(node: SceneNode, side: LiteSide): V;
  write(node: SceneNode, value: V, side: LiteSide): void;
}

export type FieldAdapters = { [F in Field]: FieldAdapter<EntityState[F]> };

interface EntityData {
  bwId?: string;
  bwKind?: EntityKind;
  /** The slot list last written or read (slot count for meshes without slot meshes). */
  bwMaterials?: (string | null)[];
  /** The entity's own visibility, as last written or read (Lite cascades visibility down). */
  bwVisible?: boolean;
  /** On a slot mesh: its material slot. */
  bwSlot?: number;
}

/** The adapter's per-node data, kept apart from Lite's own `metadata`. */
const entityData = new WeakMap<object, EntityData>();
const dataOf = (node: object): EntityData => {
  let data = entityData.get(node);
  if (!data) {
    data = {};
    entityData.set(node, data);
  }
  return data;
};

/** Lite's own test for a mesh: it carries GPU geometry. */
export const isMesh = (node: unknown): node is Mesh => typeof node === "object" && node !== null && "_gpu" in node;

const isSceneNode = (node: unknown): node is SceneNode =>
  typeof node === "object" && node !== null && "children" in node && "position" in node;

/*
 * Winding (measured on Lite 1.36). Lite's glTF loader stores glTF's
 * counter-clockwise triangles as they are and draws them right under its
 * mirrored `__root__`, so meshes under the project root are stored in the
 * shared description's order. Lite's own primitives use Babylon's
 * convention (clockwise front faces in Lite's world), so tracking one
 * mirrors it in X and reverses its triangles.
 */

export const defaultAdapters: FieldAdapters = {
  name: {
    read: (node) => node.name,
    write: (node, value) => { node.name = value; },
  },
  parent: {
    read: (node, side) => side.idOf(isSceneNode(node.parent) ? node.parent : null),
    write: (node, value, side) => side.reparent(node, (value && side.node(value)) || side.root),
  },
  transform: {
    read: (node) => {
      const r = node.rotationQuaternion;
      return {
        t: [node.position.x, node.position.y, node.position.z],
        r: [r.x, r.y, r.z, r.w],
        s: [node.scaling.x, node.scaling.y, node.scaling.z],
      } satisfies Transform;
    },
    write: (node, value) => {
      node.position.set(...value.t);
      node.rotationQuaternion.set(...value.r);
      node.scaling.set(...value.s);
    },
  },
  visible: {
    read: (node, side) => side.ownVisibility(node),
    write: (node, value, side) => side.setOwnVisibility(node, value),
  },
  materials: {
    read: (node, side) => side.slotsOf(node),
    write: (node, value, side) => side.assignSlots(node, value),
  },
};

/**
 * PBR materials read and write `baseColorFactor`, `metallicFactor` and
 * `roughnessFactor` (glTF's defaults when unset); Standard materials their
 * diffuse colour and alpha, with roughness mapped to specularPower. Others
 * read as a neutral default and are left alone.
 */
export function liteMaterialAdapter(api: LiteApi): MaterialAdapter<Material> {
  return {
    read(material) {
      if (api.isPbrMaterial(material)) {
        const c = material.baseColorFactor ?? [1, 1, 1, 1];
        return {
          color: [c[0], c[1], c[2], material.alpha ?? c[3]],
          metallic: material.metallicFactor ?? 1,
          roughness: material.roughnessFactor ?? 1,
        };
      }
      if (api.isStandardMaterial(material)) {
        const c = material.diffuseColor;
        return { color: [c[0], c[1], c[2], material.alpha], metallic: 0, roughness: 1 - Math.min(1, material.specularPower / 128) };
      }
      return { color: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.5 };
    },
    write(material, state) {
      if (api.isPbrMaterial(material)) {
        material.baseColorFactor = [state.color[0], state.color[1], state.color[2], state.color[3]];
        material.metallicFactor = state.metallic;
        material.roughnessFactor = state.roughness;
        material.alpha = state.color[3];
      } else if (api.isStandardMaterial(material)) {
        material.diffuseColor = [state.color[0], state.color[1], state.color[2]];
        material.alpha = state.color[3];
        material.specularPower = (1 - state.roughness) * 128;
      }
    },
  };
}

export interface LiteSideOptions {
  adapters?: Partial<FieldAdapters>;
  materialAdapter?: MaterialAdapter<Material>;
  /** Makes the material for a name Blender introduces (default: a PBR material). */
  createMaterial?: (name: string) => Material;
}

export class LiteSide implements EngineSide<SceneNode, Material> {
  readonly root: SceneNode;
  /** Reads and writes material properties (the default handles PBR and Standard materials). */
  readonly materialAdapter: MaterialAdapter<Material>;
  /** What an empty slot renders with (a Lite mesh needs a material to draw); reads as no material. */
  readonly emptySlot: Material;
  private readonly entities = new Map<string, SceneNode>();
  private readonly materials = new Map<string, Material>();
  private readonly adapters: FieldAdapters;
  private readonly createMaterial: (name: string) => Material;

  /**
   * `api`: the app's Lite (`import * as LITE from "@babylonjs/lite"`), or the
   * functions in LiteApi. Adds the project root to `scene`.
   */
  constructor(readonly api: LiteApi, readonly engine: LITE.EngineContext, readonly scene: LITE.SceneContext,
    options: LiteSideOptions = {}) {
    this.adapters = { ...defaultAdapters, ...options.adapters };
    this.materialAdapter = options.materialAdapter ?? liteMaterialAdapter(api);
    this.createMaterial = options.createMaterial ?? ((name) => api.createPbrMaterial({ name }));
    this.emptySlot = api.createPbrMaterial({ name: "", baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.5 });
    // The transform Lite's glTF loader gives its __root__: a mirror in X.
    this.root = api.createTransformNode("project-root", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
    api.addToScene(scene, this.root);
  }

  // --- lookups ------------------------------------------------------------------
  node(id: string): SceneNode | undefined {
    const node = this.entities.get(id);
    return node && this.alive(node) ? node : undefined;
  }

  idOf(node: SceneNode | null): string | null {
    const id = node ? dataOf(node).bwId : undefined;
    return id && this.node(id) === node ? id : null;
  }

  entityOf(node: SceneNode | null): SceneNode | null {
    for (let n: unknown = node; isSceneNode(n) && n !== this.root; n = n.parent) {
      const id = dataOf(n).bwId;
      if (id && this.node(id) === n) return n;
    }
    return null;
  }

  ids(): string[] {
    this.prune();
    return [...this.entities.keys()];
  }

  material(name: string): Material | undefined {
    return this.materials.get(name);
  }

  /** A mesh entity's material-slot meshes, in slot order. */
  slotMeshes(node: SceneNode): Mesh[] {
    return node.children.filter((c): c is Mesh => isMesh(c) && dataOf(c).bwSlot !== undefined)
      .sort((a, b) => (dataOf(a).bwSlot ?? 0) - (dataOf(b).bwSlot ?? 0));
  }

  // --- SceneSide ------------------------------------------------------------------
  read(): Record<string, EntityState> {
    this.prune();
    const out: Record<string, EntityState> = {};
    for (const [id, node] of this.entities) {
      out[id] = {
        id,
        kind: dataOf(node).bwKind ?? "empty",
        name: this.adapters.name.read(node, this),
        parent: this.adapters.parent.read(node, this),
        transform: this.adapters.transform.read(node, this),
        visible: this.adapters.visible.read(node, this),
        materials: this.adapters.materials.read(node, this),
      };
    }
    return out;
  }

  readMaterials(): Record<string, MaterialState> {
    return Object.fromEntries([...this.materials].map(([name, m]) => [name, this.materialAdapter.read(m)]));
  }

  meshData(id: string): MeshData | null {
    const node = this.node(id);
    if (!node) return null;
    const parts: MeshData[] = [];
    for (const mesh of this.slotMeshes(node)) {
      const geometry = this.api.getMeshGeometry(mesh);
      if (geometry) parts.push(expand(geometry, dataOf(mesh).bwSlot ?? 0, false, false, false));
    }
    return parts.length ? concat(parts) : null;
  }

  materialsOf(id: string): MaterialAssignment[] {
    const node = this.node(id);
    return (node ? this.slotsOf(node) : [])
      .filter((name): name is string => Boolean(name))
      .map((name) => {
        const material = this.materials.get(name);
        return { name, props: material ? this.materialAdapter.read(material) : undefined };
      });
  }

  apply(changes: Change[]): void {
    for (const change of changes) if (change.op === "material") this.upsertMaterial(change.name, change.value);
    const created: [SceneNode, EntityState, MeshData | undefined][] = [];
    for (const change of changes) {
      if (change.op === "create") created.push([this.create(change.entity), change.entity, change.mesh]);
    }
    // Parents after every create, so order within a report does not matter.
    for (const [node, entity, mesh] of created) {
      this.adapters.parent.write(node, entity.parent, this);
      dataOf(node).bwMaterials = [...entity.materials];
      if (mesh) this.setGeometry(node, mesh);
      this.adapters.materials.write(node, entity.materials, this);
      this.adapters.visible.write(node, entity.visible, this);
    }
    for (const change of changes) {
      if (change.op === "update") {
        const node = this.node(change.id);
        if (node) this.writeField(node, change.field, change.value);
      } else if (change.op === "geometry") {
        const node = this.node(change.id);
        if (node) {
          this.setGeometry(node, change.mesh);
          this.assignSlots(node, dataOf(node).bwMaterials ?? []);
        }
      } else if (change.op === "delete") {
        const node = this.node(change.id);
        if (node) this.detach(node);
        this.prune();
      }
    }
  }

  // --- tracking engine content ---------------------------------------------------
  /**
   * Makes nodes already in the scene project entities. Two kinds, by where
   * they sit:
   * - under a glTF `__root__` (the same mirror as the project root): glTF
   *   space already. They move under the project root as they are.
   * - anywhere else: Lite's own space. Each node's transform is conjugated by
   *   the root's mirror and its meshes rebuilt mirrored in X, so it looks the
   *   same and Blender gets a proper, unmirrored object.
   * A bare mesh becomes the single slot of a new entity node in its place.
   */
  track(nodes: SceneNode[]): string[] {
    const ids: string[] = [];
    const visit = (node: SceneNode, native: boolean): void => {
      if (native) mirrorLocal(node);
      let entity = node;
      if (isMesh(node)) entity = this.wrap(node);
      if (!this.idOf(entity)) {
        const id = crypto.randomUUID().replaceAll("-", "");
        const slots = entity.children.filter(isMesh);
        slots.forEach((mesh, slot) => { dataOf(mesh).bwSlot = slot; });
        if (native) for (const mesh of slots) this.rebuildMirrored(entity, mesh);
        this.register(entity, id, slots.length ? "mesh" : "empty");
        dataOf(entity).bwMaterials = this.slotsOf(entity);
        dataOf(entity).bwVisible = entity.visible !== false;
        ids.push(id);
      }
      for (const child of [...entity.children]) {
        if (isSceneNode(child) && !(isMesh(child) && dataOf(child).bwSlot !== undefined)) visit(child, native);
      }
    };
    for (const node of nodes) {
      if (node.name === "__root__") {
        for (const child of [...node.children]) {
          if (!isSceneNode(child)) continue;
          this.reparent(child, this.root);
          visit(child, false);
        }
      } else if (this.underRoot(node)) {
        visit(node, false);
      } else {
        // Lite's world space: relative to the project root, a node's transform
        // is its world transform conjugated by the root's mirror (visit does that).
        const world = this.api.decomposeMat4(node.worldMatrix);
        this.reparent(node, this.root);
        node.position.set(world.translation.x, world.translation.y, world.translation.z);
        node.rotationQuaternion.set(world.rotation.x, world.rotation.y, world.rotation.z, world.rotation.w);
        node.scaling.set(world.scale.x, world.scale.y, world.scale.z);
        visit(node, true);
      }
    }
    return ids;
  }

  // --- materials -------------------------------------------------------------------
  /** The slot list of a node, as material names (registering materials it meets). */
  slotsOf(node: SceneNode): (string | null)[] {
    const meshes = this.slotMeshes(node);
    const recorded = dataOf(node).bwMaterials;
    if (!meshes.length) return recorded ?? [];
    const slots = meshes.map((mesh) => (mesh.material === this.emptySlot ? null : this.nameOf(mesh.material)));
    // A mesh without slots still draws its one group with the empty material: it has no slots.
    if (recorded?.length === 0 && slots.every((slot) => slot === null)) return [];
    return slots;
  }

  /** Puts materials on a node's slot meshes by project name. */
  assignSlots(node: SceneNode, names: (string | null)[]): void {
    dataOf(node).bwMaterials = [...names];
    for (const mesh of this.slotMeshes(node)) {
      const name = names[dataOf(mesh).bwSlot ?? 0];
      const material = (name && this.materials.get(name)) || this.emptySlot;
      if (mesh.material !== material) mesh.material = material;
    }
  }

  private nameOf(material: Material): string {
    if (material.name && this.materials.get(material.name) === material) return material.name;
    let name = material.name || `material_${crypto.randomUUID().slice(0, 6)}`;
    for (let n = 1; this.materials.has(name) && this.materials.get(name) !== material; n++) {
      name = `${material.name}.${String(n).padStart(3, "0")}`;
    }
    material.name = name;
    this.materials.set(name, material);
    return name;
  }

  private upsertMaterial(name: string, state: MaterialState): void {
    let material = this.materials.get(name);
    if (!material) {
      material = this.createMaterial(name);
      material.name = name;
      this.materials.set(name, material);
    }
    this.materialAdapter.write(material, state);
  }

  // --- visibility -------------------------------------------------------------------
  /** An entity's own visibility; Lite's flags cascade, so one hidden by an ancestor reads as last known. */
  ownVisibility(node: SceneNode): boolean {
    const data = dataOf(node);
    if (this.hiddenAbove(node)) return data.bwVisible ?? true;
    data.bwVisible = node.visible !== false;
    return data.bwVisible;
  }

  /** Sets an entity's own visibility, keeping descendants that are hidden themselves hidden. */
  setOwnVisibility(node: SceneNode, visible: boolean): void {
    dataOf(node).bwVisible = visible;
    this.api.setSubtreeVisible(node, visible && !this.hiddenAbove(node));
    if (!visible || this.hiddenAbove(node)) return;
    const rehide = (n: SceneNode): void => {
      for (const child of n.children) {
        if (!isSceneNode(child)) continue;
        if (dataOf(child).bwId && dataOf(child).bwVisible === false) this.api.setSubtreeVisible(child, false);
        else rehide(child);
      }
    };
    rehide(node);
  }

  private hiddenAbove(node: SceneNode): boolean {
    for (let n: unknown = node.parent; isSceneNode(n) && n !== this.root; n = n.parent) {
      if (dataOf(n).bwId && dataOf(n).bwVisible === false) return true;
    }
    return false;
  }

  // --- internals ------------------------------------------------------------------
  /** Moves a node under `parent`, keeping its local transform, in both parent and children links. */
  reparent(node: SceneNode, parent: SceneNode): void {
    if (node.parent === parent) return;
    if (isSceneNode(node.parent)) {
      const siblings = node.parent.children;
      const at = siblings.indexOf(node);
      if (at >= 0) siblings.splice(at, 1);
    }
    node.parent = parent;
    if (!parent.children.includes(node)) parent.children.push(node);
  }

  private underRoot(node: SceneNode): boolean {
    for (let n: unknown = node.parent; isSceneNode(n); n = n.parent) if (n === this.root) return true;
    return false;
  }

  private alive(node: SceneNode): boolean {
    return this.underRoot(node) && !(isMesh(node) && Boolean(Reflect.get(node, "_disposed")));
  }

  private prune(): void {
    for (const [id, node] of this.entities) if (!this.alive(node)) this.entities.delete(id);
  }

  private register(node: SceneNode, id: string, kind: EntityKind): void {
    const data = dataOf(node);
    data.bwId = id;
    data.bwKind = kind;
    data.bwMaterials ??= [];
    this.entities.set(id, node);
  }

  private writeField(node: SceneNode, field: Field, value: unknown): void {
    switch (field) {
      case "name": return this.adapters.name.write(node, String(value), this);
      case "parent": return this.adapters.parent.write(node, typeof value === "string" ? value : null, this);
      case "transform": if (isTransform(value)) this.adapters.transform.write(node, value, this); return;
      case "visible": return this.adapters.visible.write(node, Boolean(value), this);
      case "materials": if (isSlotList(value)) this.adapters.materials.write(node, value, this); return;
    }
  }

  private create(entity: EntityState): SceneNode {
    const node = this.api.createTransformNode(entity.name);
    this.reparent(node, this.root);
    this.api.addToScene(this.scene, node);
    this.register(node, entity.id, entity.kind);
    this.adapters.name.write(node, entity.name, this);
    this.adapters.transform.write(node, entity.transform, this);
    return node;
  }

  /** Replaces a mesh entity's slot meshes with ones built from `mesh` (Lite retires removed meshes). */
  private setGeometry(node: SceneNode, mesh: MeshData): void {
    for (const old of this.slotMeshes(node)) this.removeChild(node, old);
    for (const [slot, start, count] of mesh.groups.length ? mesh.groups : [[0, 0, mesh.vertexCount] as [number, number, number]]) {
      const part = slice(mesh, start, count);
      const built = this.api.createMeshFromData(this.engine, `${node.name}_slot${slot}`, part.positions, part.normals,
        part.indices, part.uvs);
      dataOf(built).bwSlot = slot;
      built.material = this.emptySlot;
      this.reparent(built, node);
      this.api.addToScene(this.scene, built);
    }
    dataOf(node).bwKind = "mesh";
  }

  /** A bare mesh as an entity: a node in its place holding it as slot 0. */
  private wrap(mesh: Mesh): SceneNode {
    const parent = isSceneNode(mesh.parent) ? mesh.parent : this.root;
    const node = this.api.createTransformNode(mesh.name);
    node.position.set(mesh.position.x, mesh.position.y, mesh.position.z);
    const r = mesh.rotationQuaternion;
    node.rotationQuaternion.set(r.x, r.y, r.z, r.w);
    node.scaling.set(mesh.scaling.x, mesh.scaling.y, mesh.scaling.z);
    node.visible = mesh.visible;
    this.reparent(node, parent);
    this.api.addToScene(this.scene, node);
    this.reparent(mesh, node);
    mesh.position.set(0, 0, 0);
    mesh.rotationQuaternion.set(0, 0, 0, 1);
    mesh.scaling.set(1, 1, 1);
    dataOf(mesh).bwSlot = 0;
    return node;
  }

  /** Rebuilds a Lite-space mesh as glTF-space data under the mirrored root. */
  private rebuildMirrored(node: SceneNode, mesh: Mesh): void {
    const geometry = this.api.getMeshGeometry(mesh);
    if (!geometry) return;
    // Lite space to the shared description: X mirrored (the root mirrors it
    // back) and triangles reversed from Lite's clockwise front faces.
    const data = expand(geometry, 0, true, true, false);
    const part = slice(data, 0, data.vertexCount);
    const built = this.api.createMeshFromData(this.engine, mesh.name, part.positions, part.normals, part.indices, part.uvs);
    dataOf(built).bwSlot = dataOf(mesh).bwSlot;
    built.material = mesh.material;
    built.visible = mesh.visible;
    this.removeChild(node, mesh);
    this.reparent(built, node);
    this.api.addToScene(this.scene, built);
  }

  private removeChild(node: SceneNode, child: SceneNode): void {
    const at = node.children.indexOf(child);
    if (at >= 0) node.children.splice(at, 1);
    this.api.removeFromScene(this.scene, child);
  }

  private detach(node: SceneNode): void {
    if (isSceneNode(node.parent)) {
      const at = node.parent.children.indexOf(node);
      if (at >= 0) node.parent.children.splice(at, 1);
    }
    this.api.removeFromScene(this.scene, node);
    node.parent = null;
  }
}

/** Conjugates a node's local transform by the root's mirror in X. */
function mirrorLocal(node: SceneNode): void {
  const r = node.rotationQuaternion;
  node.position.x = -node.position.x;
  node.rotationQuaternion.set(r.x, -r.y, -r.z, r.w);
}

const isNumbers = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length && value.every((v) => typeof v === "number");

function isTransform(value: unknown): value is Transform {
  if (typeof value !== "object" || value === null) return false;
  return isNumbers(Reflect.get(value, "t"), 3) && isNumbers(Reflect.get(value, "r"), 4)
    && isNumbers(Reflect.get(value, "s"), 3);
}

const isSlotList = (value: unknown): value is (string | null)[] =>
  Array.isArray(value) && value.every((v) => v === null || typeof v === "string");

interface Geometry { positions: Float32Array; normals: Float32Array; indices: Uint32Array; uvs?: Float32Array }

/** Indexed Lite geometry as unindexed mesh data (one group). */
function expand(geometry: Geometry, slot: number, mirrorX: boolean, reverse: boolean, flipV: boolean): MeshData {
  const { positions, normals, indices, uvs } = geometry;
  const n = indices.length;
  const out: MeshData = {
    vertexCount: n,
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: uvs ? new Float32Array(n * 2) : undefined,
    groups: [[slot, 0, n]],
  };
  const sx = mirrorX ? -1 : 1;
  for (let tri = 0; tri < n; tri += 3) {
    const corners = reverse ? [indices[tri], indices[tri + 2], indices[tri + 1]] : [indices[tri], indices[tri + 1], indices[tri + 2]];
    corners.forEach((vertex, k) => {
      const v = tri + k;
      out.positions[v * 3] = sx * positions[vertex * 3];
      out.positions[v * 3 + 1] = positions[vertex * 3 + 1];
      out.positions[v * 3 + 2] = positions[vertex * 3 + 2];
      out.normals[v * 3] = sx * normals[vertex * 3];
      out.normals[v * 3 + 1] = normals[vertex * 3 + 1];
      out.normals[v * 3 + 2] = normals[vertex * 3 + 2];
      if (uvs && out.uvs) {
        out.uvs[v * 2] = uvs[vertex * 2];
        out.uvs[v * 2 + 1] = flipV ? 1 - uvs[vertex * 2 + 1] : uvs[vertex * 2 + 1];
      }
    });
  }
  return out;
}

function concat(parts: MeshData[]): MeshData {
  const n = parts.reduce((sum, p) => sum + p.vertexCount, 0);
  const hasUv = parts.every((p) => p.uvs);
  const out: MeshData = {
    vertexCount: n,
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: hasUv ? new Float32Array(n * 2) : undefined,
    groups: [],
  };
  let at = 0;
  for (const part of parts) {
    out.positions.set(part.positions, at * 3);
    out.normals.set(part.normals, at * 3);
    if (out.uvs && part.uvs) out.uvs.set(part.uvs, at * 2);
    out.groups.push([part.groups[0]?.[0] ?? 0, at, part.vertexCount]);
    at += part.vertexCount;
  }
  return out;
}

/** One group of mesh data as indexed Lite geometry (the shared order, as Lite's glTF loader stores it). */
function slice(mesh: MeshData, start: number, count: number): Geometry {
  const positions = mesh.positions.slice(start * 3, (start + count) * 3);
  const normals = mesh.normals.slice(start * 3, (start + count) * 3);
  const uvs = mesh.uvs?.slice(start * 2, (start + count) * 2);
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return { positions, normals, indices, uvs };
}
