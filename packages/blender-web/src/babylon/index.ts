import type * as BABYLON from "@babylonjs/core";
import type {
  Change, EngineSide, EntityKind, EntityState, Field, MaterialAdapter, MaterialAssignment, MaterialState, MeshData,
  Transform,
} from "../project/index.ts";

/**
 * Babylon.js side of a project (`@knervous/blender-web/babylon`): the core
 * adapter between Babylon nodes and the shared description.
 *
 * It reads the scene as Babylon holds it. Move a node, set `mesh.material`,
 * change a PBRMaterial's colour, or dispose a node with Babylon's own API,
 * and the next sync carries it. It writes what Blender changed back the same
 * way. Editing tools are left to the app.
 *
 * Every project entity lives under one root that turns Y 180° and mirrors Z,
 * so node values are the shared description's glTF-space values unchanged.
 * That is the root Babylon's glTF loader builds, so loaded glTF content keeps
 * its coordinates. Project meshes keep glTF's counter-clockwise winding and
 * are oriented the way that loader orients them, so a mesh crosses as-is.
 *
 * Babylon itself comes from the app (`new BabylonSide(BABYLON, scene)`): the
 * adapter only imports Babylon's types, so it always uses the app's copy of
 * the engine (one copy of each class, so `instanceof` holds, whatever the
 * bundler or playground). Pass the namespace or just the classes in
 * `BabylonApi`.
 *
 * Field adapters translate each field between a node and the shared
 * description; the material adapter does the same for material properties.
 * Pass replacements to customise either.
 */
export type BabylonApi = Pick<typeof BABYLON,
  "Color3" | "Material" | "Mesh" | "MultiMaterial" | "PBRMaterial" | "Quaternion" | "StandardMaterial" | "SubMesh"
  | "TransformNode" | "VertexBuffer" | "VertexData">;

type Node = BABYLON.Node;
type Scene = BABYLON.Scene;
type TransformNode = BABYLON.TransformNode;
type Mesh = BABYLON.Mesh;
type Material = BABYLON.Material;
type VertexData = BABYLON.VertexData;

export interface FieldAdapter<V> {
  read(node: TransformNode, side: BabylonSide): V;
  write(node: TransformNode, value: V, side: BabylonSide): void;
}

export type FieldAdapters = { [F in Field]: FieldAdapter<EntityState[F]> };

interface EntityMetadata {
  bwId?: string;
  bwKind?: EntityKind;
  /** The slot list last written or read, for slot count when no material is set. */
  bwMaterials?: (string | null)[];
}

const metadataOf = (node: Node): EntityMetadata => node.metadata ?? {};

export const defaultAdapters: FieldAdapters = {
  name: {
    read: (node) => node.name,
    write: (node, value) => { node.name = value; },
  },
  parent: {
    read: (node, side) => side.idOf(node.parent instanceof side.api.TransformNode ? node.parent : null),
    write: (node, value, side) => { node.parent = (value && side.node(value)) || side.root; },
  },
  transform: {
    read: (node, side) => {
      const r = node.rotationQuaternion ?? side.api.Quaternion.FromEulerVector(node.rotation);
      return {
        t: [node.position.x, node.position.y, node.position.z],
        r: [r.x, r.y, r.z, r.w],
        s: [node.scaling.x, node.scaling.y, node.scaling.z],
      } satisfies Transform;
    },
    write: (node, value, side) => {
      node.position.set(...value.t);
      node.rotationQuaternion = new side.api.Quaternion(...value.r);
      node.scaling.set(...value.s);
    },
  },
  visible: {
    read: (node) => node.isEnabled(false),
    write: (node, value) => node.setEnabled(value),
  },
  materials: {
    read: (node, side) => side.slotsOf(node),
    write: (node, value, side) => side.assignSlots(node, value),
  },
};

/**
 * PBRMaterial and StandardMaterial both read and write (Standard has no
 * metallic, and its roughness maps to specularPower). Other materials read
 * as a neutral default and are left alone on write.
 */
export function babylonMaterialAdapter(api: BabylonApi): MaterialAdapter<Material> {
  return {
    read(material) {
      if (material instanceof api.PBRMaterial) {
        const c = material.albedoColor;
        return { color: [c.r, c.g, c.b, material.alpha], metallic: material.metallic ?? 0, roughness: material.roughness ?? 0.5 };
      }
      if (material instanceof api.StandardMaterial) {
        const c = material.diffuseColor;
        return { color: [c.r, c.g, c.b, material.alpha], metallic: 0, roughness: 1 - Math.min(1, material.specularPower / 128) };
      }
      return { color: [0.8, 0.8, 0.8, material.alpha], metallic: 0, roughness: 0.5 };
    },
    write(material, state) {
      if (material instanceof api.PBRMaterial) {
        material.albedoColor = new api.Color3(state.color[0], state.color[1], state.color[2]);
        material.metallic = state.metallic;
        material.roughness = state.roughness;
      } else if (material instanceof api.StandardMaterial) {
        material.diffuseColor = new api.Color3(state.color[0], state.color[1], state.color[2]);
        material.specularPower = (1 - state.roughness) * 128;
      } else {
        return;
      }
      material.alpha = state.color[3];
    },
  };
}

export interface BabylonSideOptions {
  adapters?: Partial<FieldAdapters>;
  materialAdapter?: MaterialAdapter<Material>;
  /** Makes the material for a name Blender introduces (default: a PBRMaterial). */
  createMaterial?: (name: string, scene: Scene) => Material;
}

export class BabylonSide implements EngineSide<TransformNode, Material> {
  readonly root: TransformNode;
  private readonly entities = new Map<string, TransformNode>();
  /** Project materials by name: Blender's, and those tracked meshes use. */
  private readonly materials = new Map<string, Material>();
  private readonly adapters: FieldAdapters;
  /** Reads and writes material properties (the default handles PBR and Standard materials). */
  readonly materialAdapter: MaterialAdapter<Material>;
  private readonly createMaterial: (name: string, scene: Scene) => Material;

  /** `api`: the app's Babylon (`import * as BABYLON from "@babylonjs/core"`), or the classes in BabylonApi. */
  constructor(readonly api: BabylonApi, readonly scene: Scene, options: BabylonSideOptions = {}) {
    this.adapters = { ...defaultAdapters, ...options.adapters };
    this.materialAdapter = options.materialAdapter ?? babylonMaterialAdapter(api);
    this.createMaterial = options.createMaterial ?? ((name, s) => new api.PBRMaterial(name, s));
    // Exactly the root Babylon's glTF loader builds in a left-handed scene, so a
    // project looks as the same file would through that loader, and loaded
    // glTF content keeps its own coordinates.
    this.root = new api.TransformNode("project-root", scene);
    this.root.rotationQuaternion = new api.Quaternion(0, 1, 0, 0);
    this.root.scaling.z = -1;
  }

  // --- lookups ------------------------------------------------------------------
  node(id: string): TransformNode | undefined {
    const node = this.entities.get(id);
    return node && this.alive(node) ? node : undefined;
  }

  idOf(node: TransformNode | null): string | null {
    const id = node ? metadataOf(node).bwId : undefined;
    return id && this.node(id) === node ? id : null;
  }

  entityOf(node: TransformNode | null): TransformNode | null {
    for (let n: Node | null = node; n && n !== this.root; n = n.parent) {
      const id = metadataOf(n).bwId;
      const entity = id ? this.node(id) : undefined;
      if (entity === n) return entity;
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
        kind: metadataOf(node).bwKind ?? "empty",
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
    return node instanceof this.api.Mesh ? readMesh(this.api, node) : null;
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
    const created: [TransformNode, EntityState][] = [];
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
        this.node(change.id)?.dispose(false, false);
        this.prune();
      }
    }
  }

  // --- tracking engine content ---------------------------------------------------
  /**
   * Two kinds of content, by where it sits:
   * - under a glTF loader's `__root__` (the same transform as the project
   *   root): already glTF space. It moves under the project root with its
   *   local transforms and vertex data as they are.
   * - anywhere else: Babylon's own space. The project root is a mirror in X,
   *   so each node's transform is conjugated by it (t.x, q.y and q.z change
   *   sign) and its vertices are mirrored in X, with triangles reversed and V
   *   flipped. The node looks the same as before and Blender gets a proper,
   *   unmirrored object.
   */
  track(nodes: TransformNode[]): string[] {
    const ids: string[] = [];
    const visit = (node: TransformNode, native: boolean): void => {
      if (native) mirrorTransform(this.api, node);
      if (!this.idOf(node)) {
        const id = newId();
        if (node instanceof this.api.Mesh && node.getTotalVertices() > 0) {
          const data = this.api.VertexData.ExtractFromMesh(node);
          applyMesh(this.api, node, native ? canonicalFromBabylon(data) : canonicalFromGltf(data, node));
          this.register(node, id, "mesh");
          metadataOf(node).bwMaterials = this.slotsOf(node);
        } else {
          this.register(node, id, "empty");
        }
        ids.push(id);
      }
      for (const child of node.getChildren((c): c is TransformNode => c instanceof this.api.TransformNode, true)) visit(child, native);
    };
    for (const node of nodes) {
      if (node.name === "__root__") {
        // Not content: its children are glTF-space nodes under the same transform as ours.
        for (const child of node.getChildren((c): c is TransformNode => c instanceof this.api.TransformNode, true)) {
          child.parent = this.root;
          visit(child, false);
        }
        if (node.getChildren().length === 0) node.dispose();
      } else if (node.isDescendantOf(this.root)) {
        visit(node, false);
      } else {
        // Babylon world space: the transform relative to the project root is
        // the world transform conjugated by the root's mirror.
        node.computeWorldMatrix(true);
        const scaling = node.absoluteScaling.clone();
        const rotation = node.absoluteRotationQuaternion.clone();
        const position = node.absolutePosition.clone();
        node.parent = this.root;
        node.position.copyFrom(position);
        node.rotationQuaternion = rotation;
        node.scaling.copyFrom(scaling);
        // visit() conjugates this node and everything under it.
        visit(node, true);
      }
    }
    return ids;
  }

  // --- materials -------------------------------------------------------------------
  /** The slot list of a node, as material names (registering materials it meets). */
  slotsOf(node: TransformNode): (string | null)[] {
    const recorded = metadataOf(node).bwMaterials ?? [];
    if (!(node instanceof this.api.Mesh)) return recorded;
    const material = node.material;
    if (!material) return recorded.map(() => null);
    if (material instanceof this.api.MultiMaterial) return material.subMaterials.map((m) => (m ? this.nameOf(m) : null));
    return [this.nameOf(material)];
  }

  /** Puts materials on a node's slots by project name. */
  assignSlots(node: TransformNode, names: (string | null)[]): void {
    const meta = metadataOf(node);
    meta.bwMaterials = [...names];
    node.metadata = meta;
    if (!(node instanceof this.api.Mesh)) return;
    const materials = names.map((name) => (name ? this.materials.get(name) ?? null : null));
    if (materials.length <= 1) {
      node.material = materials[0] ?? null;
      return;
    }
    const multi = node.material instanceof this.api.MultiMaterial ? node.material : new this.api.MultiMaterial(`${node.name}_slots`, this.scene);
    multi.subMaterials = materials;
    node.material = multi;
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
      material = this.createMaterial(name, this.scene);
      this.materials.set(name, material);
    }
    this.materialAdapter.write(material, state);
  }

  // --- internals ------------------------------------------------------------------
  private alive(node: TransformNode): boolean {
    return !node.isDisposed() && node.isDescendantOf(this.root);
  }

  /** Forgets entities whose nodes were disposed or moved out of the project. */
  private prune(): void {
    for (const [id, node] of this.entities) if (!this.alive(node)) this.entities.delete(id);
  }

  private writeField(node: TransformNode, field: Field, value: unknown): void {
    switch (field) {
      case "name": return this.adapters.name.write(node, String(value), this);
      case "parent": return this.adapters.parent.write(node, typeof value === "string" ? value : null, this);
      case "transform": if (isTransform(value)) this.adapters.transform.write(node, value, this); return;
      case "visible": return this.adapters.visible.write(node, Boolean(value), this);
      case "materials": if (isSlotList(value)) this.adapters.materials.write(node, value, this); return;
    }
  }

  private register(node: TransformNode, id: string, kind: EntityKind): void {
    node.metadata = { ...node.metadata, bwId: id, bwKind: kind, bwMaterials: metadataOf(node).bwMaterials ?? [] };
    this.entities.set(id, node);
  }

  private create(entity: EntityState, mesh: MeshData | undefined): TransformNode {
    const node = entity.kind === "mesh" && mesh
      ? this.buildMesh(entity.name, mesh)
      : new this.api.TransformNode(entity.name, this.scene);
    node.parent = this.root;
    this.register(node, entity.id, entity.kind);
    this.adapters.name.write(node, entity.name, this);
    this.adapters.transform.write(node, entity.transform, this);
    this.adapters.visible.write(node, entity.visible, this);
    return node;
  }

  private buildMesh(name: string, mesh: MeshData): Mesh {
    const node = new this.api.Mesh(name, this.scene);
    applyMesh(this.api, node, mesh);
    return node;
  }

  private replaceGeometry(id: string, mesh: MeshData): void {
    const node = this.node(id);
    if (!node) return;
    if (node instanceof this.api.Mesh) {
      applyMesh(this.api, node, mesh);
      this.assignSlots(node, metadataOf(node).bwMaterials ?? []);
      return;
    }
    // An empty that became a mesh: swap the node, keep children and fields.
    const replacement = this.buildMesh(node.name, mesh);
    replacement.metadata = node.metadata;
    replacement.parent = node.parent;
    replacement.position.copyFrom(node.position);
    replacement.rotationQuaternion = node.rotationQuaternion?.clone() ?? this.api.Quaternion.FromEulerVector(node.rotation);
    replacement.scaling.copyFrom(node.scaling);
    replacement.setEnabled(node.isEnabled(false));
    for (const child of node.getChildren()) child.parent = replacement;
    this.entities.set(id, replacement);
    node.dispose(true);
    this.assignSlots(replacement, metadataOf(replacement).bwMaterials ?? []);
  }
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

const newId = (): string => crypto.randomUUID().replaceAll("-", "");

/** Conjugates a node's local transform by the project root's mirror in X. */
function mirrorTransform(api: BabylonApi, node: TransformNode): void {
  const r = node.rotationQuaternion ?? api.Quaternion.FromEulerVector(node.rotation);
  node.position.x = -node.position.x;
  node.rotationQuaternion = new api.Quaternion(r.x, -r.y, -r.z, r.w);
}

/** Vertex data a glTF loader produced (already glTF space) as mesh data, grouped by sub-mesh. */
function canonicalFromGltf(data: VertexData, mesh: Mesh): MeshData {
  const out = expand(data, false, false, false);
  out.groups = mesh.subMeshes?.length ? mesh.subMeshes.map((sub) => [sub.materialIndex, sub.indexStart, sub.indexCount]) : out.groups;
  return out;
}

/**
 * Babylon-space vertex data (left-handed: clockwise front faces, bottom-left
 * UVs) as glTF-space mesh data under the mirrored root: X mirrored,
 * triangles reversed, V flipped.
 */
function canonicalFromBabylon(data: VertexData): MeshData {
  return expand(data, true, true, true);
}

function expand(data: VertexData, mirrorX: boolean, reverse: boolean, flipV: boolean): MeshData {
  const positions = data.positions ?? [];
  const normals = data.normals ?? [];
  const uvs = data.uvs;
  const indices = data.indices ?? Array.from({ length: positions.length / 3 }, (_, i) => i);
  const n = indices.length;
  const out: MeshData = {
    vertexCount: n,
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: uvs ? new Float32Array(n * 2) : undefined,
    groups: [[0, 0, n]],
  };
  const sx = mirrorX ? -1 : 1;
  for (let tri = 0; tri < n; tri += 3) {
    const corners = reverse
      ? [indices[tri], indices[tri + 2], indices[tri + 1]]
      : [indices[tri], indices[tri + 1], indices[tri + 2]];
    corners.forEach((vertex, k) => {
      const v = tri + k;
      for (let c = 0; c < 3; c++) {
        const sign = c === 0 ? sx : 1;
        out.positions[v * 3 + c] = sign * positions[vertex * 3 + c];
        out.normals[v * 3 + c] = sign * (normals[vertex * 3 + c] ?? 0);
      }
      if (uvs && out.uvs) {
        out.uvs[v * 2] = uvs[vertex * 2];
        out.uvs[v * 2 + 1] = flipV ? 1 - uvs[vertex * 2 + 1] : uvs[vertex * 2 + 1];
      }
    });
  }
  return out;
}

/** glTF-space mesh data onto a Babylon mesh, one sub-mesh per material group. */
function applyMesh(api: BabylonApi, node: Mesh, mesh: MeshData): void {
  const data = new api.VertexData();
  data.positions = mesh.positions;
  data.normals = mesh.normals;
  if (mesh.uvs) {
    const uvs = new Float32Array(mesh.uvs);
    for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
    data.uvs = uvs;
  }
  data.indices = Uint32Array.from({ length: mesh.vertexCount }, (_, i) => i);
  // Blender's evaluated mesh replaces the vertices, so per-vertex data it does
  // not send (skin weights, tangents, colours, extra UVs) no longer lines up;
  // stale skin buffers make the GPU skin garbage. Drop it, and the skeleton and
  // morph targets bound to the old vertices.
  const sent = new Set<string>([api.VertexBuffer.PositionKind, api.VertexBuffer.NormalKind]);
  if (data.uvs) sent.add(api.VertexBuffer.UVKind);
  for (const kind of node.getVerticesDataKinds()) if (!sent.has(kind)) node.removeVerticesData(kind);
  node.skeleton = null;
  node.morphTargetManager = null;
  data.applyToMesh(node, true);
  // What Babylon's own glTF loader sets for glTF's counter-clockwise data under
  // the mirrored root in a left-handed scene (Babylon 9 orients per mesh).
  node.sideOrientation = api.Material.ClockWiseSideOrientation;
  node.subMeshes = [];
  for (const [slot, start, count] of mesh.groups) {
    new api.SubMesh(slot, 0, mesh.vertexCount, start, count, node);
  }
  if (node.subMeshes.length === 0) node.subMeshes.push(new api.SubMesh(0, 0, mesh.vertexCount, 0, mesh.vertexCount, node));
}

/** A project mesh's data as stored (already glTF space, unindexed or not). */
function readMesh(api: BabylonApi, node: Mesh): MeshData | null {
  const positions = node.getVerticesData(api.VertexBuffer.PositionKind);
  const normals = node.getVerticesData(api.VertexBuffer.NormalKind);
  if (!positions || !normals) return null;
  const uvs = node.getVerticesData(api.VertexBuffer.UVKind);
  const indices = node.getIndices() ?? Array.from({ length: positions.length / 3 }, (_, i) => i);
  const n = indices.length;
  const out: MeshData = {
    vertexCount: n,
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    uvs: uvs ? new Float32Array(n * 2) : undefined,
    groups: node.subMeshes.map((sub) => [sub.materialIndex, sub.indexStart, sub.indexCount]),
  };
  for (let v = 0; v < n; v++) {
    const vertex = indices[v];
    for (let c = 0; c < 3; c++) {
      out.positions[v * 3 + c] = positions[vertex * 3 + c];
      out.normals[v * 3 + c] = normals[vertex * 3 + c];
    }
    if (uvs && out.uvs) {
      out.uvs[v * 2] = uvs[vertex * 2];
      out.uvs[v * 2 + 1] = 1 - uvs[vertex * 2 + 1];
    }
  }
  return out;
}
