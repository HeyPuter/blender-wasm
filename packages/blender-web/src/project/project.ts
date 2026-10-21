import { diffToBlender, diffToScene } from "./diff.ts";
import { PROTOCOL_SOURCE } from "./protocol.generated.ts";
import {
  defaultTranslators, materialPropertiesTranslator, type FieldTranslator, type MaterialTranslator,
} from "./translators.ts";
import type {
  BlenderCommand, BlenderJob, BlenderRunner, BlenderSession, Change, Conflict, ConflictSubject, Direction, EntityState, Field,
  MaterialState, MeshData, RunReport, SceneSide, Side, Snapshot,
} from "./types.ts";

/**
 * Extension points, called in this order around a sync:
 *
 *   pending changes ─ filterChange(toBlender) ─ conflictPolicy ─ beforeRun ─▶ Blender
 *   Blender ─▶ afterRun ─ onConflict ─ filterChange(toScene) ─ scene.apply ─ afterApply
 *
 * Every hook is optional; plugins compose in registration order.
 */
export interface ProjectHooks {
  /** Return a replacement change, `null` to drop it, or nothing to keep it. */
  filterChange?(change: Change, direction: Direction): Change | null | void;
  /**
   * Who wins when both sides changed something since the last agreed state
   * (default: Blender): an entity field, or with field "material" a material's
   * properties (id is then the material name).
   */
  conflictPolicy?(id: string, field: ConflictSubject): Side | void;
  /** Last look at the job: add commands, a script, handlers. */
  beforeRun?(job: BlenderJob): BlenderJob | void;
  afterRun?(report: RunReport): void;
  onConflict?(conflict: Conflict): void;
  afterApply?(changes: Change[], direction: Direction): void;
}

export interface ProjectPlugin {
  name: string;
  hooks?: ProjectHooks;
  /** Replace how a field compares or reshapes its values (`materials` is slot assignment). */
  translators?: Partial<Record<Field, FieldTranslator>>;
  /** Replace how material properties compare or reshape. */
  materialTranslator?: MaterialTranslator;
  /**
   * Extra Blender-side commands: name -> Python source defining
   * `handle(cmd, by_id, api)`. A command `{ op: name, ... }` reaches it.
   */
  blenderHandlers?: Record<string, string>;
}

export interface ProjectOptions {
  /** A persistent Blender: requests cost only their own work. Preferred. */
  session?: BlenderSession;
  /** Or one Blender run per request (opens and saves the .blend each time). */
  blender?: BlenderRunner;
  scene: SceneSide;
  /** protocol.py source; defaults to the one shipped with this package. */
  protocol?: string;
  plugins?: ProjectPlugin[];
  onLine?: (line: string) => void;
}

export interface SyncOptions {
  /** bpy script run after the scene's changes are applied. */
  script?: string;
  /** Extra files staged for the script (path -> bytes). */
  files?: Record<string, Uint8Array>;
  /** Extra commands (e.g. for plugin handlers), after the scene's changes. */
  commands?: BlenderCommand[];
}

/** One sync's outcome. */
export interface SyncResult {
  sent: Change[];
  received: Change[];
  report: RunReport;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Blender raised while handling a request (bad script, failed command). */
export class ProjectRunError extends Error {
  constructor(readonly traceback: string, readonly output: string) {
    super(traceback.trim().split("\n").at(-1) ?? "Blender request failed");
  }
}

/**
 * A working project with Blender on one side and an engine scene on the
 * other. Blender's .blend is the persistent truth; `agreed` is the last state
 * both sides matched. A sync sends only what the scene changed since then and
 * receives only what Blender changed beyond that, mesh data included only
 * for geometry whose fingerprint moved.
 */
export class Project {
  private readonly plugins: ProjectPlugin[] = [];
  private readonly translators: Record<Field, FieldTranslator> = defaultTranslators();
  private materialTranslator: MaterialTranslator = materialPropertiesTranslator;
  private agreedState: Snapshot = { entities: {}, materials: {} };
  private blendBytes: Uint8Array | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProjectOptions) {
    if (!options.session && !options.blender) throw new Error("Project needs a Blender session or runner");
    for (const plugin of options.plugins ?? []) this.use(plugin);
  }

  use(plugin: ProjectPlugin): this {
    this.plugins.push(plugin);
    Object.assign(this.translators, plugin.translators);
    if (plugin.materialTranslator) this.materialTranslator = plugin.materialTranslator;
    return this;
  }

  /**
   * The last .blend Blender wrote, or null. With a session this is only
   * refreshed by exportBlend(); use that when the file must be current.
   */
  get blend(): Uint8Array | null {
    return this.blendBytes;
  }

  /** The session as a .blend, including the scene's pending edits (synced first). */
  async exportBlend(): Promise<Uint8Array> {
    if (!this.options.session) {
      await this.sync();
      if (!this.blendBytes) throw new Error("no .blend yet");
      return this.blendBytes;
    }
    const result = await this.enqueue(() => this.run({ blend: null, sendPending: true, save: true }));
    if (!result.report.blend) throw new Error("Blender wrote no .blend");
    return result.report.blend;
  }

  /** The last state both sides agreed on. */
  get agreed(): Snapshot {
    return this.agreedState;
  }

  /** The scene's edits a sync would send now (after toBlender filters). */
  pending(): Change[] {
    const scene = this.options.scene;
    const changes = diffToBlender(
      this.agreedState, scene.read(), scene.readMaterials(), this.translators, this.materialTranslator,
    );
    return this.filter(changes, "toBlender");
  }

  /** Blender's default startup scene; replaces the session and the scene's entities. */
  newScene(): Promise<SyncResult> {
    return this.enqueue(() => this.run({ blend: null, commands: [], fresh: true, load: "factory" }));
  }

  /**
   * Opens a file as the session: a .blend as-is, anything Blender imports
   * into an empty scene. The scene's pending edits are discarded.
   */
  open(name: string, bytes: Uint8Array): Promise<SyncResult> {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "blend") {
      return this.enqueue(() => this.run({ blend: bytes, commands: [], fresh: true }));
    }
    const importer = IMPORTERS[ext];
    if (!importer) return Promise.reject(new Error(`Blender does not import .${ext} here`));
    const path = `/in/source.${ext}`;
    return this.enqueue(() => this.run({
      blend: null,
      commands: [],
      fresh: true,
      load: "empty",
      script: `import bpy\npath = ${JSON.stringify(path)}\n${importer}`,
      files: { [path]: bytes },
    }));
  }

  /** Send the scene's pending edits, run an optional script, take Blender's results. */
  sync(options: SyncOptions = {}): Promise<SyncResult> {
    // A session keeps the scene; a one-shot run reopens the last .blend.
    const blend = this.options.session ? null : this.blendBytes;
    return this.enqueue(() => this.run({ blend, sendPending: true, ...options }));
  }

  /**
   * A .blend edited elsewhere (Blender's UI) becomes the session. The scene's
   * pending edits are replayed onto it; where both sides changed a field,
   * conflictPolicy decides.
   */
  adoptBlend(bytes: Uint8Array): Promise<SyncResult> {
    return this.enqueue(() => this.run({ blend: bytes, sendPending: true }));
  }

  // ---------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private filter(changes: Change[], direction: Direction): Change[] {
    const out: Change[] = [];
    for (const original of changes) {
      let change: Change | null = original;
      for (const plugin of this.plugins) {
        if (!change || !plugin.hooks?.filterChange) continue;
        const result = plugin.hooks.filterChange(change, direction);
        if (result === null) change = null;
        else if (result) change = result;
      }
      if (change) out.push(change);
    }
    return out;
  }

  private policy(id: string, field: ConflictSubject): Side {
    for (const plugin of this.plugins) {
      const side = plugin.hooks?.conflictPolicy?.(id, field);
      if (side) return side;
    }
    return "blender";
  }

  /** Translators' toScene reshaping, applied to Blender's changes before the filters. */
  private shapeForScene(changes: Change[]): Change[] {
    return changes.map((change) => {
      if (change.op === "update") {
        const toScene = this.translators[change.field].toScene;
        return toScene ? { ...change, value: toScene(change.value) } : change;
      }
      if (change.op === "material" && this.materialTranslator.toScene) {
        return { ...change, value: this.materialTranslator.toScene(change.value) };
      }
      return change;
    });
  }

  private toCommands(changes: Change[], files: Record<string, Uint8Array>): BlenderCommand[] {
    const scene = this.options.scene;
    const commands: BlenderCommand[] = [];
    // Materials first: an assignment or create in the same run may name one.
    const ordered = [...changes].sort((a, b) => Number(b.op === "material") - Number(a.op === "material"));
    for (const change of ordered) {
      if (change.op === "material") {
        const translator = this.materialTranslator;
        commands.push({
          op: "material",
          name: change.name,
          value: translator.toBlender ? translator.toBlender(change.value) : change.value,
          ...(change.previous ? { expect: change.previous } : {}),
          policy: this.policy(change.name, "material"),
        });
      } else if (change.op === "delete") {
        commands.push({ op: "delete", id: change.id });
      } else if (change.op === "update") {
        const translator = this.translators[change.field];
        commands.push({
          op: "update",
          id: change.id,
          field: change.field,
          value: translator.toBlender ? translator.toBlender(change.value) : change.value,
          expect: change.previous,
          policy: this.policy(change.id, change.field),
        });
      } else if (change.op === "create") {
        const mesh = change.mesh ?? scene.meshData(change.id);
        const file = `/job/geo/${change.id}.bin`;
        if (mesh) files[file] = encodeMesh(mesh);
        commands.push({
          op: "create",
          entity: change.entity,
          mesh: mesh ? { file, vertexCount: mesh.vertexCount, hasUv: Boolean(mesh.uvs) } : undefined,
          materials: change.materials ?? scene.materialsOf(change.id),
        });
      }
    }
    return commands;
  }

  private async run(request: {
    blend: Uint8Array | null;
    commands?: BlenderCommand[];
    sendPending?: boolean;
    fresh?: boolean;
    /** Replace the session with Blender's startup scene or an empty one (when no blend). */
    load?: "factory" | "empty";
    save?: boolean;
    script?: string;
    files?: Record<string, Uint8Array>;
  }): Promise<SyncResult> {
    const scene = this.options.scene;
    const files: Record<string, Uint8Array> = { ...request.files };
    const sent = request.sendPending ? this.pending() : [];
    const sceneNow = scene.read();

    // Geometry the scene already shows, by Blender's fingerprint: not re-sent.
    const known: Record<string, string> = {};
    if (!request.fresh) {
      for (const id of Object.keys(sceneNow)) {
        const hash = this.agreedState.entities[id]?.geometry;
        if (hash) known[id] = hash;
      }
    }

    let job: BlenderJob = {
      commands: [...this.toCommands(sent, files), ...(request.commands ?? [])],
      script: request.script,
      known,
      handlers: Object.assign({}, ...this.plugins.map((p) => p.blenderHandlers ?? {})),
      reportGeometry: true,
    };
    for (const plugin of this.plugins) job = plugin.hooks?.beforeRun?.(job) ?? job;

    let result: { output: string; files: Record<string, Uint8Array> };
    const session = this.options.session;
    if (session) {
      const load = request.blend
        ? { kind: "blend" as const, bytes: request.blend }
        : request.load ? { kind: request.load } : undefined;
      result = await session.request({ job, files, load, save: request.save, onLine: this.options.onLine });
    } else if (this.options.blender) {
      // One-shot: the run opens the .blend from argv and always saves.
      if (request.load === "empty" && job.script) {
        job = { ...job, script: `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\n${job.script}` };
      }
      files["/job/project.json"] = encoder.encode(JSON.stringify(job));
      if (request.blend) files["/in/session.blend"] = request.blend;
      result = await this.options.blender.run({
        code: this.options.protocol ?? PROTOCOL_SOURCE,
        blendFile: request.blend ? "/in/session.blend" : undefined,
        files,
        onLine: this.options.onLine,
      });
    } else {
      throw new Error("no Blender");
    }
    const report = decodeReport(result);
    for (const plugin of this.plugins) plugin.hooks?.afterRun?.(report);
    for (const conflict of report.conflicts) {
      for (const plugin of this.plugins) plugin.hooks?.onConflict?.(conflict);
    }

    const received = this.filter(
      this.shapeForScene(diffToScene(
        sceneNow, scene.readMaterials(), report.snapshot, report.geometry, this.translators, this.materialTranslator,
      )),
      "toScene",
    );
    scene.apply(received);
    for (const plugin of this.plugins) plugin.hooks?.afterApply?.(received, "toScene");

    this.agreedState = report.snapshot;
    if (report.blend) this.blendBytes = report.blend;
    return { sent, received, report };
  }
}

const IMPORTERS: Record<string, string> = {
  glb: "bpy.ops.import_scene.gltf(filepath=path)",
  gltf: "bpy.ops.import_scene.gltf(filepath=path)",
  obj: "bpy.ops.wm.obj_import(filepath=path)",
  fbx: "bpy.ops.import_scene.fbx(filepath=path)",
  stl: "bpy.ops.wm.stl_import(filepath=path)",
  ply: "bpy.ops.wm.ply_import(filepath=path)",
};
export const BLENDER_IMPORTS = ["blend", ...Object.keys(IMPORTERS)];

/** The .bin layout protocol.py reads and writes: positions, normals, then uvs. */
export function encodeMesh(mesh: MeshData): Uint8Array {
  const parts = [mesh.positions, mesh.normals, ...(mesh.uvs ? [mesh.uvs] : [])];
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(out.buffer);
}

interface GeometryMeta {
  vertexCount: number;
  hasUv: boolean;
  groups: [number, number, number][];
  hash: string;
}

export function decodeMesh(bytes: Uint8Array, meta: GeometryMeta): MeshData {
  // Copy: the bytes may sit at an offset Float32Array cannot view.
  const floats = new Float32Array(bytes.slice().buffer);
  const n = meta.vertexCount;
  return {
    vertexCount: n,
    positions: floats.subarray(0, n * 3),
    normals: floats.subarray(n * 3, n * 6),
    uvs: meta.hasUv ? floats.subarray(n * 6, n * 8) : undefined,
    groups: meta.groups,
  };
}

interface ReportJson {
  error?: string;
  timings?: Record<string, number>;
  entities: Record<string, EntityState>;
  materials: Record<string, MaterialState>;
  geometry: Record<string, GeometryMeta>;
  conflicts: Conflict[];
  missing: string[];
  log: string[];
}

function decodeReport(result: { output: string; files: Record<string, Uint8Array> }): RunReport {
  const raw = result.files["/out/report.json"];
  if (!raw) throw new ProjectRunError("Blender wrote no report", result.output);
  const json: ReportJson = JSON.parse(decoder.decode(raw));
  if (json.error) throw new ProjectRunError(json.error, result.output);
  const geometry: Record<string, MeshData> = {};
  for (const [id, meta] of Object.entries(json.geometry)) {
    const bytes = result.files[`/out/geo/${id}.bin`];
    if (bytes) geometry[id] = decodeMesh(bytes, meta);
  }
  return {
    snapshot: { entities: json.entities, materials: json.materials },
    geometry,
    conflicts: json.conflicts,
    missing: json.missing,
    log: json.log,
    output: result.output,
    blend: result.files["/out/session.blend"],
    timings: json.timings ?? {},
    files: result.files,
  };
}
