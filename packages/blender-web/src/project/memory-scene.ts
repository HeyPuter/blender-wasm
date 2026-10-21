import type { Change, EntityState, MaterialAssignment, MaterialState, MeshData, SceneSide } from "./types.ts";

/**
 * A scene side with no engine: it keeps entities, materials and meshes in
 * plain objects. Useful for pipelines and tests (Node, workers) that want the
 * project model, its typed changes and conflict handling, without rendering.
 * Edit it through `entities` / `materials` / `meshes` and sync.
 */
export class MemoryScene implements SceneSide {
  readonly entities = new Map<string, EntityState>();
  readonly materials = new Map<string, MaterialState>();
  readonly meshes = new Map<string, MeshData>();

  read(): Record<string, EntityState> {
    return Object.fromEntries([...this.entities].map(([id, e]) => [id, structuredClone(e)]));
  }

  readMaterials(): Record<string, MaterialState> {
    return Object.fromEntries(this.materials);
  }

  meshData(id: string): MeshData | null {
    return this.meshes.get(id) ?? null;
  }

  materialsOf(id: string): MaterialAssignment[] {
    return (this.entities.get(id)?.materials ?? [])
      .filter((name): name is string => Boolean(name))
      .map((name) => ({ name, props: this.materials.get(name) }));
  }

  /** Adds an entity of the scene's own (a create on the next sync). */
  add(entity: EntityState, mesh?: MeshData): void {
    this.entities.set(entity.id, structuredClone(entity));
    if (mesh) this.meshes.set(entity.id, mesh);
  }

  /** Changes one field of an entity (an update on the next sync). */
  set<F extends keyof EntityState>(id: string, field: F, value: EntityState[F]): void {
    const entity = this.entities.get(id);
    if (!entity) throw new Error(`no entity ${id}`);
    entity[field] = value;
  }

  remove(id: string): void {
    this.entities.delete(id);
    this.meshes.delete(id);
  }

  apply(changes: Change[]): void {
    for (const change of changes) {
      switch (change.op) {
        case "material": this.materials.set(change.name, change.value); break;
        case "create": this.add(change.entity, change.mesh); break;
        case "delete": this.remove(change.id); break;
        case "geometry": this.meshes.set(change.id, change.mesh); break;
        case "update": {
          const entity = this.entities.get(change.id);
          if (entity) Object.assign(entity, { [change.field]: structuredClone(change.value) });
          break;
        }
      }
    }
  }
}
