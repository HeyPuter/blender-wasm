import type { EngineSide, MaterialState, Rgba } from "@knervous/blender-web";

export type GizmoMode = "position" | "rotation" | "scale";

/**
 * What the editor needs from an engine: the core adapter for it
 * (@knervous/blender-web's BabylonSide, LiteSide or ThreeSide), plus the
 * editing tools the core leaves to apps: gizmos, picking, primitives, material
 * edits, markers for Blender's lights and cameras, and content loaded outside
 * the project. All of it uses the engine's own API, on the app's own engine
 * and scene (the app keeps its render loop); the adapter reads the result on
 * the next sync. `N` is the engine's node type.
 *
 * `babylonViewport`, `liteViewport` and `threeViewport` make one; an app with
 * another engine implements this.
 */
export interface Viewport<N> {
  readonly engine: string;
  readonly side: EngineSide<N, unknown>;
  /** Formats the engine opens by itself (outside the project). */
  readonly formats: string[];
  /** The download the engine makes of its own scene, if it has one. */
  readonly nativeExport?: { label: string; file: string };
  /** Whether the viewport has transform gizmos. */
  readonly gizmos?: boolean;
  /** A tap on the canvas: the project entity or untracked root under it, or null. */
  onPick(listener: (node: N | null) => void): void;
  /** A gizmo drag or camera move ended (time to refresh and maybe auto-sync). */
  onEditEnd(listener: () => void): void;
  attachGizmo(node: N | null): void;
  setGizmoMode(mode: GizmoMode): void;
  nameOf(node: N): string;
  /** Loads a file into the engine outside the project; returns a line for the log. */
  openUntracked(file: File): Promise<string>;
  untracked(): N[];
  adoptUntracked(): string[];
  /** Deletes an untracked node. */
  disposeUntracked(node: N): void;
  exportNative?(): Promise<BlobPart>;
  /** A new mesh with its own material, tracked into the project. */
  addPrimitive(kind: "box" | "sphere", color: Rgba): N;
  /** Deletes a node with the engine's API (an entity's deletion syncs). */
  deleteNode(node: N): void;
  /** Puts a project material (or none) on a mesh's first slot. */
  assignMaterial(node: N, name: string | null): void;
  /** A new engine material; returns its name. */
  createMaterial(name: string, state: MaterialState): string;
  /** Edits a project material's properties on the engine material. */
  editMaterial(name: string, state: MaterialState): void;
  /** Markers for entities the engine does not draw (Blender's lights and cameras). */
  decorate(): void;
}

/* Linear (glTF, Principled BSDF) colour <-> the sRGB hex a colour picker shows. */
const toSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function linearToHex(rgb: readonly number[]): string {
  return "#" + rgb.slice(0, 3).map((c) => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255).toString(16).padStart(2, "0")).join("");
}

export function hexToLinear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)];
}
