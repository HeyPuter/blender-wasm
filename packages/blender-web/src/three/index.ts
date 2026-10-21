import type * as THREE from "three";
import type {
  Change, EngineSide, EntityKind, EntityState, Field, MaterialAdapter, MaterialAssignment, MaterialState, MeshData,
  Transform,
} from "../project/index.ts";

/**
 * three.js side of a project (`@knervous/blender-web/three`): the core
 * adapter between Object3Ds and the shared description.
 *
 * It reads the scene as three.js holds it. Move an object, set
 * `mesh.material`, change a material's colour, or remove an object from the
 * project root with three.js's own API, and the next sync carries it. It
 * writes what Blender changed back the same way. Editing tools are left to
 * the app.
 *
 * three.js is Y up, right handed and counter-clockwise, as glTF is, so the
 * project root is an identity Group and node values are the shared
 * description's values unchanged. Meshes keep glTF's UV origin (top left),
 * as GLTFLoader leaves them; textures on them want `flipY = false`.
 *
 * three.js itself comes from the app (`new ThreeSide(THREE, scene)`): the
 * adapter only imports three's types, so it always uses the app's copy (one
 * copy of each class, so `instanceof` holds, whatever the bundler or
 * playground). Pass the namespace or just the classes in `ThreeApi`.
 *
 * Field adapters translate each field between an Object3D and the shared
 * description; the material adapter does the same for material properties.
 * Pass replacements to customise either.
 */
export type ThreeApi = Pick<typeof THREE,
  "BufferAttribute" | "BufferGeometry" | "Camera" | "Color" | "Group" | "Light" | "LinearSRGBColorSpace" | "Mesh"
  | "MeshStandardMaterial">;

type Object3D = THREE.Object3D;
type Material = THREE.Material;
type Mesh = THREE.Mesh;
type BufferGeometry = THREE.BufferGeometry;

export interface FieldAdapter<V> {
  read(node: Object3D, side: ThreeSide): V;
  write(node: Object3D, value: V, side: ThreeSide): void;
}

export type FieldAdapters = { [F in Field]: FieldAdapter<EntityState[F]> };

interface EntityData {
  bwId?: string;
  bwKind?: EntityKind;
  /** The slot list last written or read, for slot count on non-meshes. */
  bwMaterials?: (string | null)[];
}

const dataOf = (node: Object3D): EntityData => node.userData;

export const defaultAdapters: FieldAdapters = {
  name: {
    read: (node) => node.name,
    write: (node, value) => { node.name = value; },
  },
  parent: {
    read: (node, side) => side.idOf(node.parent),
    write: (node, value, side) => { ((value && side.node(value)) || side.root).add(node); },
  },
  transform: {
    read: (node) => ({
      t: [node.position.x, node.position.y, node.position.z],
      r: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
      s: [node.scale.x, node.scale.y, node.scale.z],
    } satisfies Transform),
    write: (node, value) => {
      node.position.set(...value.t);
      node.quaternion.set(...value.r);
      node.scale.set(...value.s);
    },
  },
  visible: {
    read: (node) => node.visible,
    write: (node, value) => { node.visible = value; },
  },
  materials: {
    read: (node, side) => side.slotsOf(node),
    write: (node, value, side) => side.assignSlots(node, value),
  },
};

const numberOf = (material: Material, key: string): number | undefined => {
  const value = Reflect.get(material, key);
  return typeof value === "number" ? value : undefined;
};

/**
 * Any material with a `color` reads and writes it (linear, three's working
 * space), plus `metalness` and `roughness` where it has them
 * (MeshStandardMaterial, MeshPhysicalMaterial). Opacity is the alpha.
 */
export function threeMaterialAdapter(api: ThreeApi): MaterialAdapter<Material> {
  return {
    read(material) {
      const color = Reflect.get(material, "color");
      const c = color instanceof api.Color ? color : new api.Color(0.8, 0.8, 0.8);
      return {
        color: [c.r, c.g, c.b, material.opacity],
        metallic: numberOf(material, "metalness") ?? 0,
        roughness: numberOf(material, "roughness") ?? 0.5,
      };
    },
    write(material, state) {
      const color = Reflect.get(material, "color");
      if (color instanceof api.Color) color.setRGB(state.color[0], state.color[1], state.color[2], api.LinearSRGBColorSpace);
      if (numberOf(material, "metalness") !== undefined) Reflect.set(material, "metalness", state.metallic);
      if (numberOf(material, "roughness") !== undefined) Reflect.set(material, "roughness", state.roughness);
      material.opacity = state.color[3];
      material.transparent = state.color[3] < 1;
      material.needsUpdate = true;
    },
  };
}

export interface ThreeSideOptions {
  adapters?: Partial<FieldAdapters>;
  materialAdapter?: MaterialAdapter<Material>;
  /** Makes the material for a name Blender introduces (default: a MeshStandardMaterial). */
  createMaterial?: (name: string) => Material;
}

export class ThreeSide implements EngineSide<Object3D, Material> {
  readonly root: THREE.Group;
  private readonly entities = new Map<string, Object3D>();
  /** Project materials by name: Blender's, and those tracked meshes use. */
  private readonly materials = new Map<string, Material>();
  private readonly adapters: FieldAdapters;
  /** Reads and writes material properties (the default handles any material with a colour). */
  readonly materialAdapter: MaterialAdapter<Material>;
  private readonly createMaterial: (name: string) => Material;
  /** What an empty slot renders with (three.js meshes always have a material); reads as no material. */
  readonly emptySlot: Material;

  /**
   * `api`: the app's three.js (`import * as THREE from "three"`), or the
   * classes in ThreeApi. Adds the project root to `scene` (any Object3D).
   */
  constructor(readonly api: ThreeApi, readonly scene: Object3D, options: ThreeSideOptions = {}) {
    this.root = new api.Group();
    this.emptySlot = new api.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5 });
    this.adapters = { ...defaultAdapters, ...options.adapters };
    this.materialAdapter = options.materialAdapter ?? threeMaterialAdapter(api);
    this.createMaterial = options.createMaterial ?? ((name) => new api.MeshStandardMaterial({ name }));
    this.root.name = "project-root";
    scene.add(this.root);
  }

  // --- lookups ------------------------------------------------------------------
  node(id: string): Object3D | undefined {
    const node = this.entities.get(id);
    return node && this.alive(node) ? node : undefined;
  }

  idOf(node: Object3D | null): string | null {
    const id = node ? dataOf(node).bwId : undefined;
    return id && this.node(id) === node ? id : null;
  }

  entityOf(node: Object3D | null): Object3D | null {
    for (let n = node; n && n !== this.root; n = n.parent) {
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
    return node instanceof this.api.Mesh ? readGeometry(node.geometry) : null;
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
    const created: [Object3D, EntityState][] = [];
    for (const change of changes) {
      if (change.op === "create") created.push([this.create(change.entity, change.mesh), change.entity]);
    }
    // Parents after every create, so order within a report does not matter.
    for (const [node, entity] of created) {
      this.adapters.parent.write(node, entity.parent, this);
      this.adapters.materials.write(node, entity.materials, this);
    }
    for (const change of changes) {
      if (change.op === "update") {
        const node = this.node(change.id);
        if (node) this.writeField(node, change.field, change.value);
      } else if (change.op === "geometry") {
        this.replaceGeometry(change.id, change.mesh);
      } else if (change.op === "delete") {
        const node = this.node(change.id);
        node?.removeFromParent();
        node?.traverse((n) => { if (n instanceof this.api.Mesh) n.geometry.dispose(); });
        this.prune();
      }
    }
  }

  // --- tracking engine content ---------------------------------------------------
  track(nodes: Object3D[]): string[] {
    const ids: string[] = [];
    const visit = (tracked: Object3D): void => {
      let node = tracked;
      if (!this.idOf(node)) {
        const id = newId();
        if (node instanceof this.api.Mesh && node.geometry instanceof this.api.BufferGeometry && node.geometry.getAttribute("position")) {
          const data = readGeometry(node.geometry);
          if (data && isSkinned(node)) {
            // Skin attributes do not survive the rebuild (and Blender sends none
            // back): a skinned mesh joins the project as a plain mesh in its bind pose.
            node = this.swapForMesh(node, buildGeometry(this.api, data), node.material);
          } else if (data) {
            node.geometry.dispose();
            node.geometry = buildGeometry(this.api, data);
          }
          this.register(node, id, "mesh");
          dataOf(node).bwMaterials = this.slotsOf(node);
        } else {
          this.register(node, id, node instanceof this.api.Light ? "light" : node instanceof this.api.Camera ? "camera" : "empty");
        }
        ids.push(id);
      }
      for (const child of [...node.children]) visit(child);
    };
    for (const node of nodes) {
      if (!isDescendant(node, this.root)) this.root.attach(node);
      visit(node);
    }
    return ids;
  }

  // --- materials -------------------------------------------------------------------
  /** The slot list of a node, as material names (registering materials it meets). */
  slotsOf(node: Object3D): (string | null)[] {
    if (!(node instanceof this.api.Mesh)) return dataOf(node).bwMaterials ?? [];
    const materials: Material[] = Array.isArray(node.material) ? node.material : [node.material];
    const slots = materials.map((m) => (m === this.emptySlot ? null : this.nameOf(m)));
    // A mesh without slots still draws with the empty material: it has no slots.
    if (dataOf(node).bwMaterials?.length === 0 && slots.every((slot) => slot === null)) return [];
    return slots;
  }

  /** Puts materials on a node's slots by project name. */
  assignSlots(node: Object3D, names: (string | null)[]): void {
    dataOf(node).bwMaterials = [...names];
    if (!(node instanceof this.api.Mesh)) return;
    const materials = names.map((name) => (name && this.materials.get(name)) || this.emptySlot);
    node.material = materials.length <= 1 ? materials[0] ?? this.emptySlot : materials;
  }

  /**
   * A material's project name, registering it on first sight. An unnamed
   * material gets a name; one named like a different material is renamed
   * `name.001` (Blender's convention), since names are the identity.
   */
  private nameOf(material: Material): string {
    if (material.name && this.materials.get(material.name) === material) return material.name;
    let name = material.name || `material_${newId().slice(0, 6)}`;
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

  // --- internals ------------------------------------------------------------------
  private alive(node: Object3D): boolean {
    return isDescendant(node, this.root);
  }

  /** Forgets entities whose objects left the project root. */
  private prune(): void {
    for (const [id, node] of this.entities) if (!this.alive(node)) this.entities.delete(id);
  }

  private writeField(node: Object3D, field: Field, value: unknown): void {
    switch (field) {
      case "name": return this.adapters.name.write(node, String(value), this);
      case "parent": return this.adapters.parent.write(node, typeof value === "string" ? value : null, this);
      case "transform": if (isTransform(value)) this.adapters.transform.write(node, value, this); return;
      case "visible": return this.adapters.visible.write(node, Boolean(value), this);
      case "materials": if (isSlotList(value)) this.adapters.materials.write(node, value, this); return;
    }
  }

  private register(node: Object3D, id: string, kind: EntityKind): void {
    const data = dataOf(node);
    data.bwId = id;
    data.bwKind = kind;
    data.bwMaterials ??= [];
    this.entities.set(id, node);
  }

  private create(entity: EntityState, mesh: MeshData | undefined): Object3D {
    const node = entity.kind === "mesh" && mesh ? new this.api.Mesh(buildGeometry(this.api, mesh), this.emptySlot) : new this.api.Group();
    this.root.add(node);
    this.register(node, entity.id, entity.kind);
    this.adapters.name.write(node, entity.name, this);
    this.adapters.transform.write(node, entity.transform, this);
    this.adapters.visible.write(node, entity.visible, this);
    return node;
  }

  private replaceGeometry(id: string, mesh: MeshData): void {
    const node = this.node(id);
    if (!node) return;
    // A skinned mesh cannot take Blender's evaluated vertices (they carry no
    // skin weights; its shader would collapse them): it is swapped like an empty.
    if (node instanceof this.api.Mesh && !isSkinned(node)) {
      node.geometry.dispose();
      node.geometry = buildGeometry(this.api, mesh);
      this.assignSlots(node, dataOf(node).bwMaterials ?? []);
      return;
    }
    // An empty that became a mesh, or a skinned mesh.
    const replacement = this.swapForMesh(node, buildGeometry(this.api, mesh), this.emptySlot);
    this.entities.set(id, replacement);
    this.assignSlots(replacement, dataOf(replacement).bwMaterials ?? []);
  }

  /** A plain mesh in a node's place: its children, fields and spot among its siblings. */
  private swapForMesh(node: Object3D, geometry: BufferGeometry, material: Material | Material[]): Mesh {
    const replacement = new this.api.Mesh(geometry, material);
    replacement.name = node.name;
    replacement.userData = node.userData;
    replacement.position.copy(node.position);
    replacement.quaternion.copy(node.quaternion);
    replacement.scale.copy(node.scale);
    replacement.visible = node.visible;
    for (const child of [...node.children]) replacement.add(child);
    const parent = node.parent ?? this.root;
    const at = parent.children.indexOf(node);
    parent.add(replacement);
    if (at >= 0) {
      // Keep sibling order (outliners and exports follow it).
      parent.children.splice(parent.children.indexOf(replacement), 1);
      parent.children.splice(at, 0, replacement);
    }
    node.removeFromParent();
    if (node instanceof this.api.Mesh) node.geometry.dispose();
    return replacement;
  }
}

const isSkinned = (node: Object3D): boolean => "isSkinnedMesh" in node && node.isSkinnedMesh === true;

const isNumbers = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length && value.every((v) => typeof v === "number");

function isTransform(value: unknown): value is Transform {
  if (typeof value !== "object" || value === null) return false;
  return isNumbers(Reflect.get(value, "t"), 3) && isNumbers(Reflect.get(value, "r"), 4)
    && isNumbers(Reflect.get(value, "s"), 3);
}

const isSlotList = (value: unknown): value is (string | null)[] =>
  Array.isArray(value) && value.every((v) => v === null || typeof v === "string");

const newId = (): string => crypto.randomUUID().replaceAll("-", "");

function isDescendant(node: Object3D, ancestor: Object3D): boolean {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** glTF-space mesh data as an unindexed BufferGeometry, one group per material slot. */
function buildGeometry(api: ThreeApi, mesh: MeshData): BufferGeometry {
  const geometry = new api.BufferGeometry();
  geometry.setAttribute("position", new api.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new api.BufferAttribute(mesh.normals, 3));
  if (mesh.uvs) geometry.setAttribute("uv", new api.BufferAttribute(mesh.uvs, 2));
  for (const [slot, start, count] of mesh.groups) geometry.addGroup(start, count, slot);
  if (mesh.groups.length === 0) geometry.addGroup(0, mesh.vertexCount, 0);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A geometry's triangles as glTF-space mesh data (unindexed). UVs are taken
 * as they are; three.js's own primitives use a bottom-left origin, so flip
 * them (`1 - v`) before tracking one if its UVs matter.
 */
function readGeometry(geometry: BufferGeometry): MeshData | null {
  const position = geometry.getAttribute("position");
  if (!position) return null;
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const index = geometry.getIndex();
  const n = index ? index.count : position.count;
  const out: MeshData = {
    vertexCount: n,
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: uv ? new Float32Array(n * 2) : undefined,
    groups: geometry.groups.length
      ? geometry.groups.map((g) => [g.materialIndex ?? 0, g.start, Math.min(g.count, n - g.start)])
      : [[0, 0, n]],
  };
  for (let v = 0; v < n; v++) {
    const vertex = index ? index.getX(v) : v;
    out.positions[v * 3] = position.getX(vertex);
    out.positions[v * 3 + 1] = position.getY(vertex);
    out.positions[v * 3 + 2] = position.getZ(vertex);
    out.normals[v * 3] = normal.getX(vertex);
    out.normals[v * 3 + 1] = normal.getY(vertex);
    out.normals[v * 3 + 2] = normal.getZ(vertex);
    if (uv && out.uvs) {
      out.uvs[v * 2] = uv.getX(vertex);
      out.uvs[v * 2 + 1] = uv.getY(vertex);
    }
  }
  return out;
}
