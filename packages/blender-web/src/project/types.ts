/**
 * The shared description both sides of a project are translated into.
 *
 * Everything is in glTF space: Y up, right handed, metres, quaternions as
 * [x, y, z, w]. Blender's Z-up is converted in protocol.py and nowhere else;
 * a scene side converts its own conventions in its field adapters.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Rgba = [number, number, number, number];

/** A node's transform relative to its parent entity (or the scene root). */
export interface Transform {
  t: Vec3;
  r: Quat;
  s: Vec3;
}

export type EntityKind = "mesh" | "empty" | "light" | "camera" | "other";

/** One object, as both sides agree to describe it. `id` is stable across renames. */
export interface EntityState {
  id: string;
  name: string;
  kind: EntityKind;
  parent: string | null;
  transform: Transform;
  visible: boolean;
  /** Material per slot, by material name. */
  materials: (string | null)[];
  /** Blender's fingerprint of the evaluated mesh; only Blender computes it. */
  geometry?: string;
}

export interface MaterialState {
  color: Rgba;
  metallic: number;
  roughness: number;
}

export interface Snapshot {
  entities: Record<string, EntityState>;
  materials: Record<string, MaterialState>;
}

/**
 * Triangles as consecutive vertex triples (counter-clockwise, glTF), grouped
 * by material slot: groups are [slot, firstVertex, vertexCount].
 */
export interface MeshData {
  vertexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  groups: [number, number, number][];
}

/** Fields a change can carry; every one has a Blender writer in protocol.py. */
export type Field = "name" | "parent" | "transform" | "visible" | "materials";
export const BLENDER_WRITABLE: readonly Field[] = ["name", "parent", "transform", "visible", "materials"];
export const SCENE_FIELDS: readonly Field[] = ["name", "parent", "transform", "visible", "materials"];

export interface MaterialAssignment {
  name: string;
  props?: MaterialState;
}

export type Change =
  | { op: "create"; id: string; entity: EntityState; mesh?: MeshData; materials?: MaterialAssignment[] }
  | { op: "delete"; id: string }
  | { op: "update"; id: string; field: Field; value: unknown; previous: unknown }
  | { op: "geometry"; id: string; mesh: MeshData }
  /** A material's properties, by name. `previous` is the agreed value (toBlender only). */
  | { op: "material"; name: string; value: MaterialState; previous?: MaterialState };

/** toBlender: the scene's edits on their way out. toScene: Blender's results on their way in. */
export type Direction = "toBlender" | "toScene";

export type Side = "blender" | "scene";

/** What a conflict is about: an entity field, or (id = material name) a material's properties. */
export type ConflictSubject = Field | "material";

export interface Conflict {
  id: string;
  field: ConflictSubject;
  blender: unknown;
  scene: unknown;
  kept: Side;
}

/** What one Blender run reported, after decoding. */
export interface RunReport {
  snapshot: Snapshot;
  geometry: Record<string, MeshData>;
  conflicts: Conflict[];
  missing: string[];
  log: string[];
  output: string;
  /** The session .blend, when the run saved one (always for one-shot runs). */
  blend?: Uint8Array;
  /** Seconds since the request started, at the end of each phase (Blender's clock). */
  timings: Record<string, number>;
  files: Record<string, Uint8Array>;
}

/** The serialized job protocol.py reads from /job/project.json. */
export interface BlenderJob {
  commands: BlenderCommand[];
  script?: string;
  known: Record<string, string>;
  handlers: Record<string, string>;
  reportGeometry: boolean;
}

export type BlenderCommand = { op: string; [key: string]: unknown };

/**
 * Runs Blender once: `code` against an optional staged .blend, with `files`
 * staged into the module FS, returning everything written under /out.
 */
export interface BlenderRunner {
  run(job: {
    code: string;
    blendFile?: string;
    files: Record<string, Uint8Array>;
    onLine?: (line: string) => void;
  }): Promise<{ output: string; files: Record<string, Uint8Array> }>;
}

/**
 * A persistent Blender serving protocol.py requests (server mode): booted
 * once, it keeps the scene in memory, so a request costs only its own work.
 * `load` replaces the session first; `save` writes /out/session.blend.
 * Files come back keyed as a one-shot run writes them (/out/...).
 */
export interface BlenderSession {
  request(request: {
    job: BlenderJob;
    files: Record<string, Uint8Array>;
    load?: { kind: "factory" | "empty" } | { kind: "blend"; bytes: Uint8Array };
    save?: boolean;
    onLine?: (line: string) => void;
  }): Promise<{ output: string; files: Record<string, Uint8Array> }>;
}

/**
 * The other side of the project: an engine scene (Babylon, three.js, ...).
 * It reads its tracked entities into the shared description and applies
 * changes coming from Blender. Untracked content is its own business.
 */
export interface SceneSide {
  read(): Record<string, EntityState>;
  readMaterials(): Record<string, MaterialState>;
  /** Mesh data for an entity the scene created, for its first trip to Blender. */
  meshData(id: string): MeshData | null;
  materialsOf(id: string): MaterialAssignment[];
  apply(changes: Change[]): void;
}

/**
 * An engine adapter (`/babylon`, `/three`): the SceneSide for that engine, plus
 * lookups between engine objects and project ids. It is the core only: the
 * engine's own API edits the scene (move a node, assign or edit a material,
 * dispose a node), and the adapter reads that state on the next sync. Editing
 * tools (gizmos, pickers, outliners, primitives) are built on top.
 * `N` is the engine's node type, `M` its material type.
 */
export interface EngineSide<N, M> extends SceneSide {
  /** The node every project entity lives under. */
  readonly root: N;
  /** A live entity's node (disposed or detached nodes are no longer entities). */
  node(id: string): N | undefined;
  /** The entity id of a node that is one, else null. */
  idOf(node: N | null): string | null;
  /** The entity a node belongs to (itself or its nearest entity ancestor), if any. */
  entityOf(node: N | null): N | null;
  ids(): string[];
  /**
   * Makes engine content project entities: each node and its descendants,
   * moved under the root keeping their world placement, meshes rewritten into
   * the shared winding and layout. They reach Blender on the next sync.
   * Returns the new ids.
   */
  track(nodes: N[]): string[];
  /** The engine material behind a project material name (Blender's or one a tracked mesh uses). */
  material(name: string): M | undefined;
}

/** Reads and writes a material's shared properties on an engine material. */
export interface MaterialAdapter<M> {
  read(material: M): MaterialState;
  write(material: M, state: MaterialState): void;
}

/** An object as Blender's API lists it: `id` is the project's bw_id, if it has one. */
export interface BlenderObjectInfo {
  id: string | null;
  name: string;
  kind: EntityKind;
  /** The parent's bw_id, else its name; null at the top. */
  parent: string | null;
}

/** An RNA value as Blender's API returns it (enums as identifiers, ID pointers as names, collections as lengths). */
export type RnaValue = number | boolean | string | number[] | boolean[] | null;

/** What `set` and operator properties accept. */
export type RnaInput = number | boolean | string | number[];

export type OperatorResult = "FINISHED" | "CANCELLED" | "PASS_THROUGH" | "NOT_FOUND";

/**
 * Blender's direct API (embind, the headless builds' bw_api): typed calls on
 * Blender's own RNA, for hosts that drive Blender without writing Python.
 * Python stays available (`python`, and scripts in `Project.sync`). Every call
 * runs on Blender's thread between requests. Paths are in bpy.data syntax,
 * e.g. `objects["Cube"].location`. Edits made here are Blender's: the next
 * `Project.sync()` brings them to the scene.
 */
export interface BlenderApi {
  get(path: string): Promise<RnaValue>;
  /** Sets a property and runs its RNA update; false when the path or value does not fit. */
  set(path: string, value: RnaInput): Promise<boolean>;
  /** Runs an operator (`"mesh.primitive_cube_add"` or `"MESH_OT_primitive_cube_add"`). */
  call(operator: string, props?: Record<string, RnaInput>): Promise<OperatorResult>;
  /** Runs a Python statement; false if it raised. */
  python(code: string): Promise<boolean>;
  objects(): Promise<BlenderObjectInfo[]>;
  /** An object's evaluated mesh (by bw_id or name), in glTF space, grouped by material slot. */
  mesh(idOrName: string): Promise<MeshData | null>;
}
