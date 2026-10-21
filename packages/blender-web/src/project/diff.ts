import type { FieldTranslator, MaterialTranslator } from "./translators.ts";
import type { Change, EntityState, Field, MaterialState, MeshData, Snapshot } from "./types.ts";
import { BLENDER_WRITABLE, SCENE_FIELDS } from "./types.ts";

type Translators = Record<Field, FieldTranslator>;

/**
 * The scene's edits since the last agreed state: material properties that
 * differ (for materials the scene's entities use), then entities that are new,
 * gone, or have a field that differs. `previous` is the agreed value, which
 * Blender checks before writing (conflict detection).
 */
export function diffToBlender(
  agreed: Snapshot,
  scene: Record<string, EntityState>,
  sceneMaterials: Record<string, MaterialState>,
  translators: Translators,
  materialTranslator: MaterialTranslator,
): Change[] {
  const changes: Change[] = [];
  const used = new Set(Object.values(scene).flatMap((e) => e.materials).filter((m): m is string => Boolean(m)));
  for (const name of used) {
    const value = sceneMaterials[name];
    const before = agreed.materials[name];
    if (value && (!before || !materialTranslator.equal(before, value))) {
      changes.push({ op: "material", name, value, previous: before });
    }
  }
  for (const [id, entity] of Object.entries(scene)) {
    const before = agreed.entities[id];
    if (!before) {
      changes.push({ op: "create", id, entity });
      continue;
    }
    for (const field of BLENDER_WRITABLE) {
      if (!translators[field].equal(before[field], entity[field])) {
        changes.push({ op: "update", id, field, value: entity[field], previous: before[field] });
      }
    }
  }
  for (const id of Object.keys(agreed.entities)) {
    if (!scene[id]) changes.push({ op: "delete", id });
  }
  return changes;
}

/**
 * What the scene must do to match Blender's report: compared against what the
 * scene holds now, so the scene's own edits that Blender accepted produce no
 * change, and only Blender's work (scripts, UI edits, normalisation such as a
 * renamed duplicate, conflicts it won) comes back.
 */
export function diffToScene(
  scene: Record<string, EntityState>,
  sceneMaterials: Record<string, MaterialState>,
  report: { entities: Record<string, EntityState>; materials: Record<string, MaterialState> },
  geometry: Record<string, MeshData>,
  translators: Translators,
  materialTranslator: MaterialTranslator,
): Change[] {
  const changes: Change[] = [];
  for (const [name, value] of Object.entries(report.materials)) {
    const before = sceneMaterials[name];
    if (!before || !materialTranslator.equal(before, value)) changes.push({ op: "material", name, value });
  }
  for (const [id, entity] of Object.entries(report.entities)) {
    const before = scene[id];
    if (!before) {
      changes.push({ op: "create", id, entity, mesh: geometry[id] });
      continue;
    }
    for (const field of SCENE_FIELDS) {
      if (!translators[field].equal(before[field], entity[field])) {
        changes.push({ op: "update", id, field, value: entity[field], previous: before[field] });
      }
    }
    if (geometry[id]) changes.push({ op: "geometry", id, mesh: geometry[id] });
  }
  for (const id of Object.keys(scene)) {
    if (!report.entities[id]) changes.push({ op: "delete", id });
  }
  return changes;
}
