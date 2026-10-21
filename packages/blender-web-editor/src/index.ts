/**
 * An editor HUD on @knervous/blender-web. `mountEditor` docks a panel over an
 * app's Babylon.js, Babylon Lite or three.js canvas and makes the app's scene
 * and Blender (WebAssembly, in this tab) one project: edit in the engine, run
 * Python or direct RNA calls in Blender, sync both ways. With a hosted Blender
 * UI (`blenderUi`), one button swaps to the full Blender interface on the same
 * .blend and back; the way back is an ordinary sync.
 *
 * The viewport (`babylonViewport`, `liteViewport`, `threeViewport` from this
 * package's subpaths, or an app's own `Viewport`) supplies the engine side;
 * the app keeps its engine, scene and render loop.
 */
import {
  BLENDER_IMPORTS, Project, ProjectRunError, type Change, type Conflict, type ProjectPlugin, type Rgba,
  type RnaInput, type SyncResult,
} from "@knervous/blender-web";
import {
  createBlenderSession, runtimeInstalled, type BootProgress, type BrowserBlenderSession, type ThreadsOption,
} from "@knervous/blender-web/browser";
import { createBlenderUi, returnFromBlenderUi, showBlenderUi, type BlenderUi } from "@knervous/blender-web/ui";
import { HUD_CSS, HUD_HTML } from "./hud.ts";
import { hexToLinear, linearToHex, type GizmoMode, type Viewport } from "./viewport.ts";

export { hexToLinear, linearToHex, type GizmoMode, type Viewport } from "./viewport.ts";

export interface EditorOptions<N> {
  /** The element over the canvas the HUD docks into (made `position: relative` if it is static). */
  container: HTMLElement;
  viewport: Viewport<N>;
  /** Where the runtime is served (default "blender-runtime/", e.g. the package's runtime/ on a CDN). */
  runtimeUrl?: string | URL;
  /** The pthread build, the single-threaded (JSPI) one, or "auto" by isolation (default). */
  threads?: ThreadsOption;
  /** A hosted Blender UI (the fork's web build); without it there is no UI swap. */
  blenderUi?: string | URL;
  /** The panel heading (default "Blender ⇄ <engine>"). */
  title?: string;
  /** The Python panel's starting script. */
  python?: string;
}

export interface Editor {
  /** Null until Blender has booted (or when its runtime is not served). */
  readonly project: Project | null;
  readonly session: BrowserBlenderSession | null;
  readonly ui: BlenderUi | null;
  /** Resolves once Blender has booted and the first scene is in (false: no runtime). */
  readonly ready: Promise<boolean>;
  /** Opens a file as the project (.blend, anything Blender imports) or engine-only. */
  openFile(file: File, options?: { engineOnly?: boolean }): Promise<void>;
  /** Shows the full Blender UI on the project's .blend. */
  showBlenderUi(): Promise<void>;
  /** Takes the UI's edits back and shows the engine again. */
  returnFromBlenderUi(): Promise<void>;
  /** Redraws the outliner and pending list (after the app edits the scene itself). */
  refresh(): void;
  dispose(): void;
}

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement("style");
  style.dataset.blenderWebEditor = "";
  style.textContent = HUD_CSS;
  document.head.append(style);
}

/** A copy backed by a plain ArrayBuffer (Blob refuses views of shared memory). */
const ownBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

/** A JSON value from the API panel, or the text as a string. */
function parseValue(text: string): RnaInput {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
    if (Array.isArray(value) && value.every((v) => typeof v === "number")) return value;
  } catch { /* plain text */ }
  return text;
}

export function mountEditor<N extends object>(options: EditorOptions<N>): Editor {
  const view = options.viewport;
  const side = view.side;
  injectStyles();

  const root = document.createElement("div");
  root.className = "bwe";
  root.innerHTML = HUD_HTML;
  // The HUD positions against the container; leave an app's own positioning alone.
  const madeRelative = getComputedStyle(options.container).position === "static";
  if (madeRelative) options.container.style.position = "relative";
  options.container.append(root);

  const $ = <T extends HTMLElement = HTMLElement>(name: string, type?: new () => T): T => {
    const element = root.querySelector(`[data-bwe="${name}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`[data-bwe=${name}] missing`);
    if (type && !(element instanceof type)) throw new Error(`[data-bwe=${name}] is not a ${type.name}`);
    return element as T;
  };
  const button = (name: string): HTMLButtonElement => $(name, HTMLButtonElement);

  $("title").textContent = options.title ?? `Blender ⇄ ${view.engine}`;
  for (const element of root.querySelectorAll("[data-bwe-engine]")) element.textContent = view.engine;
  const ui = {
    status: $("status"), log: $("log"), outliner: $("outliner"), pending: $("pending"),
    python: $("python", HTMLTextAreaElement),
  };
  if (options.python !== undefined) ui.python.value = options.python;

  const cleanups: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void): void => {
    window.addEventListener(type, handler);
    cleanups.push(() => window.removeEventListener(type, handler));
  };

  function log(line: string): void {
    ui.log.textContent += line + "\n";
    if ((ui.log.textContent ?? "").length > 200_000) ui.log.textContent = (ui.log.textContent ?? "").slice(-150_000);
    ui.log.scrollTop = ui.log.scrollHeight;
  }
  function setStatus(text: string, kind = ""): void {
    ui.status.textContent = text;
    ui.status.className = `bwe-status ${kind}`;
  }

  /* Hooks in use: a readable trace of what crosses, and conflicts surfaced. */
  const tracePlugin: ProjectPlugin = {
    name: "editor-trace",
    hooks: {
      onConflict: (conflict: Conflict) => log(conflict.field === "material"
        ? `[conflict] material ${conflict.id}: kept ${conflict.kept}`
        : `[conflict] ${nameOf(conflict.id)}.${conflict.field}: kept ${conflict.kept}`),
      afterRun: (report) => { if (report.log.length) log(`[blender] ${report.log.join("; ")}`); },
    },
  };

  let project: Project | null = null;
  let session: BrowserBlenderSession | null = null;
  let blenderUi: BlenderUi | null = null;

  /** Names as of the last agreed state too, so a deleted entity still logs by name. */
  let knownNames = new Map<string, string>();
  const nameOf = (id: string): string => {
    const node = side.node(id);
    return (node && view.nameOf(node)) ?? project?.agreed.entities[id]?.name ?? knownNames.get(id) ?? id.slice(0, 6);
  };

  function describe(change: Change): string {
    switch (change.op) {
      case "create": return `+ ${change.entity.name}`;
      case "delete": return `− ${nameOf(change.id)}`;
      case "update": return `~ ${nameOf(change.id)}.${change.field}`;
      case "geometry": return `~ ${nameOf(change.id)} mesh (${change.mesh.vertexCount} verts)`;
      case "material": return `~ material ${change.name}`;
    }
  }

  /** Buttons stay disabled while Blender works; `data-off` ones stay off. */
  const actionButtons = (): NodeListOf<HTMLButtonElement> => root.querySelectorAll(".bwe-panel button");
  let busy = false;
  async function blenderTask(label: string, task: (p: Project) => Promise<SyncResult>): Promise<void> {
    if (!project) { setStatus("Blender's runtime is not available", "error"); return; }
    const started = performance.now();
    knownNames = new Map(Object.values(project.agreed.entities).map((e) => [e.id, e.name]));
    busy = true;
    setStatus(`${label}…`, "busy");
    actionButtons().forEach((b) => { b.disabled = true; });
    try {
      const { sent, received } = await task(project);
      const ms = Math.round(performance.now() - started);
      setStatus(`${label}: done in ${ms} ms · sent ${sent.length}, received ${received.length}`);
      log(`[sync] sent ${sent.length ? sent.map(describe).join(", ") : "nothing"} · received ${received.length ? received.map(describe).join(", ") : "nothing"}`);
    } catch (error) {
      if (error instanceof ProjectRunError) log(error.traceback);
      setStatus(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      console.error(error);
    } finally {
      busy = false;
      view.decorate();
      actionButtons().forEach((b) => { b.disabled = "off" in b.dataset; });
      refresh();
    }
  }

  /* ------------------------------------------------------------ selection */
  let selected: N | null = null;

  function setGizmoMode(mode: GizmoMode): void {
    view.setGizmoMode(mode);
    for (const b of $("gizmo-modes").children) b.classList.toggle("on", b instanceof HTMLElement && b.dataset.mode === mode);
  }
  function select(node: N | null): void {
    selected = node;
    view.attachGizmo(node);
    refresh();
  }
  view.onPick((node) => select(node));
  view.onEditEnd(() => { refresh(); scheduleAutoSync(); });

  function refresh(): void {
    const pending = project ? project.pending() : [];
    const states = new Map<string, string>();
    for (const change of pending) {
      if (change.op === "update") states.set(change.id, [states.get(change.id), change.field].filter(Boolean).join(", "));
      if (change.op === "create") states.set(change.id, "new");
    }

    ui.outliner.replaceChildren();
    const entities = side.read();
    const depth = (id: string): number => { let d = 0; for (let p = entities[id]?.parent; p; p = entities[p]?.parent) d++; return d; };
    const ordered = Object.values(entities).sort((a, b) => a.name.localeCompare(b.name));
    const roots = ordered.filter((e) => !e.parent || !entities[e.parent]);
    const visit = (id: string): void => {
      const entity = entities[id];
      const li = document.createElement("li");
      li.style.paddingLeft = `${6 + depth(id) * 14}px`;
      li.append(entity.name);
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = entity.kind;
      li.append(kind);
      if (states.has(id)) {
        const state = document.createElement("span");
        state.className = "state";
        state.textContent = `· ${states.get(id)}`;
        li.append(state);
      }
      if (side.node(id) === selected) li.classList.add("selected");
      li.onclick = () => select(side.node(id) ?? null);
      ui.outliner.append(li);
      for (const child of ordered) if (child.parent === id) visit(child.id);
    };
    for (const entity of roots) visit(entity.id);
    for (const node of view.untracked()) {
      const li = document.createElement("li");
      li.className = "untracked";
      li.textContent = view.nameOf(node);
      if (node === selected) li.classList.add("selected");
      li.onclick = () => select(node);
      ui.outliner.append(li);
    }

    ui.pending.replaceChildren();
    for (const change of pending) {
      const li = document.createElement("li");
      li.textContent = describe(change);
      ui.pending.append(li);
    }
    if (!pending.length) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = project ? "In sync with Blender." : "";
      ui.pending.append(li);
    }
    $("sync").textContent = pending.length ? `Sync with Blender (${pending.length})` : "Sync with Blender";
    showMaterial();
  }

  /* ------------------------------------------------------------ materials */
  /* Slot 0 of the selected mesh: which material it uses (assignment) and that
   * material's properties. Both are pending changes until the next sync.
   * Colours are linear, as in glTF and Principled BSDF; the picker shows sRGB. */
  const matPanel = $("material-panel");
  const matName = $("mat-name", HTMLSelectElement);
  const matColor = $("mat-color", HTMLInputElement);
  const matMetallic = $("mat-metallic", HTMLInputElement);
  const matRoughness = $("mat-roughness", HTMLInputElement);
  let newMaterialCount = 0;

  const selectedEntity = () => {
    const id = side.idOf(selected);
    return id ? side.read()[id] ?? null : null;
  };

  function showMaterial(): void {
    const entity = selectedEntity();
    matPanel.hidden = !entity || entity.kind !== "mesh";
    if (!entity || matPanel.hidden) return;
    const current = entity.materials[0] ?? "";
    const materials = side.readMaterials();
    matName.replaceChildren(new Option("(none)", ""), ...Object.keys(materials).sort().map((n) => new Option(n, n)));
    matName.value = current;
    const state = current ? materials[current] : undefined;
    for (const input of [matColor, matMetallic, matRoughness]) input.disabled = !state;
    if (!state) return;
    matColor.value = linearToHex(state.color);
    matMetallic.value = String(state.metallic);
    matRoughness.value = String(state.roughness);
  }

  function assignSlot0(name: string | null): void {
    if (!selectedEntity() || !selected) return;
    view.assignMaterial(selected, name);
    refresh();
    scheduleAutoSync();
  }

  function editMaterial(): void {
    const name = matName.value;
    const state = name ? side.readMaterials()[name] : undefined;
    if (!state) return;
    view.editMaterial(name, {
      color: [...hexToLinear(matColor.value), state.color[3]],
      metallic: Number(matMetallic.value),
      roughness: Number(matRoughness.value),
    });
    refresh();
  }

  matName.onchange = () => assignSlot0(matName.value || null);
  button("mat-new").onclick = () => {
    const name = `material_${++newMaterialCount}`;
    assignSlot0(view.createMaterial(name, { color: [0.6, 0.6, 0.6, 1], metallic: 0, roughness: 0.5 }));
  };
  for (const input of [matColor, matMetallic, matRoughness]) {
    input.addEventListener("input", editMaterial);
    input.addEventListener("change", scheduleAutoSync);
  }

  let autoSyncTimer = 0;
  function scheduleAutoSync(): void {
    if (!$("auto-sync", HTMLInputElement).checked || busy || !project?.pending().length) return;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = window.setTimeout(() => void blenderTask("Auto-sync", (p) => p.sync()), 700);
  }

  /* ---------------------------------------------------------------- files */
  async function openFile(file: File, { engineOnly = false } = {}): Promise<void> {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const blenderCan = BLENDER_IMPORTS.includes(ext);
    const engineCan = view.formats.includes(ext);
    if (blenderCan && !(engineOnly && engineCan)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await blenderTask(`Open ${file.name}`, (p) => p.open(file.name, bytes));
    } else if (engineCan) {
      try {
        log(await view.openUntracked(file));
        refresh();
      } catch (error) {
        setStatus(`Open failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } else {
      setStatus(`Neither side opens .${ext}`, "error");
    }
  }

  /* ------------------------------------------------------------ Blender API */
  /* Direct RNA reads and writes (the runtime's embind API, no Python). A set
   * changes Blender's scene like any Blender edit, so a sync follows to bring
   * it back to the engine. */
  const apiPath = $("api-path", HTMLInputElement);
  const apiValue = $("api-value", HTMLInputElement);
  button("api-get").onclick = async () => {
    if (!session) { setStatus("No Blender yet"); return; }
    try {
      const value = await session.api.get(apiPath.value);
      apiValue.value = JSON.stringify(value);
      log(`[api] ${apiPath.value} = ${JSON.stringify(value)}`);
    } catch (error) {
      setStatus(`Get failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };
  button("api-set").onclick = () => void blenderTask(`Set ${apiPath.value}`, async (p) => {
    if (!session) throw new Error("No Blender yet");
    const ok = await session.api.set(apiPath.value, parseValue(apiValue.value));
    log(`[api] ${apiPath.value} ← ${apiValue.value}${ok ? "" : " (refused: no such path, or the value does not fit)"}`);
    return p.sync();
  });

  /* ----------------------------------------------------------- Blender UI */
  /* The full Blender interface, booted hidden at mount so a swap is instant:
   * showing it hands over the project's .blend; coming back saves the UI's
   * scene and adopts it, an ordinary sync. */
  const uiBar = $("ui-bar");
  const uiStatus = $("ui-status");
  const uiOpen = button("ui-open");
  let uiReady = false;
  if (options.blenderUi) {
    blenderUi = createBlenderUi({
      url: options.blenderUi,
      container: root,
      onProgress: (p) => {
        uiStatus.textContent = `${p.phase}${typeof p.fraction === "number" ? ` ${Math.round(p.fraction * 100)}%` : ""}`;
        if (!uiReady) uiOpen.title = `Blender UI: ${p.phase}…`;
      },
    });
    blenderUi.element.className = "bwe-ui-frame";
    blenderUi.element.setAttribute("allow", "cross-origin-isolated; fullscreen; clipboard-read; clipboard-write");
    uiOpen.dataset.off = "";
    uiOpen.disabled = true;
    uiOpen.title = "Blender UI: starting…";
    blenderUi.ready.then(() => {
      uiReady = true;
      delete uiOpen.dataset.off;
      uiOpen.disabled = busy;
      uiOpen.title = "Swap to the full Blender UI";
    }, (error: unknown) => {
      uiOpen.title = `Blender UI failed: ${error instanceof Error ? error.message : String(error)}`;
    });
  } else {
    uiOpen.hidden = true;
  }

  function swapped(on: boolean): void {
    root.classList.toggle("bwe-swapped", on);
    uiBar.hidden = !on;
  }

  async function toBlenderUi(): Promise<void> {
    if (!blenderUi || !project || !uiReady) return;
    setStatus("Handing the scene to the Blender UI…", "busy");
    try {
      // Pending engine edits reach Blender first, so the UI opens what the engine shows.
      if (project.pending().length) await project.sync();
      await showBlenderUi(project, blenderUi);
      swapped(true);
      uiStatus.textContent = "";
      setStatus("In the Blender UI");
    } catch (error) {
      setStatus(`Blender UI: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function fromBlenderUi(): Promise<void> {
    if (!blenderUi || !blenderUi.visible) return;
    uiStatus.textContent = "saving…";
    const ui = blenderUi;
    await blenderTask("Bring the Blender UI edits back", async (p) => {
      try { return await returnFromBlenderUi(p, ui); } finally { swapped(false); }
    });
  }
  uiOpen.onclick = () => void toBlenderUi();
  button("ui-back").onclick = () => void fromBlenderUi();

  /* --------------------------------------------------------------- wiring */
  function download(name: string, bytes: BlobPart, type: string): void {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const GIZMO_KEYS: Record<string, GizmoMode> = { w: "position", e: "rotation", r: "scale" };
  let shiftHeld = false;
  listen("keydown", (event) => {
    shiftHeld = event.shiftKey;
    if (root.classList.contains("bwe-swapped")) return;
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
      if (event.target === ui.python && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        button("run-python").click();
      }
      return;
    }
    // Shortcuts only for the page itself, not for other inputs the app has.
    if (event.target instanceof HTMLElement && event.target !== document.body && !options.container.contains(event.target)) return;
    const mode = GIZMO_KEYS[event.key.toLowerCase()];
    if (mode && view.gizmos) setGizmoMode(mode);
    if ((event.key === "Delete" || event.key === "Backspace") && selected) button("delete").click();
  });
  listen("keyup", (event) => { shiftHeld = event.shiftKey; });

  const opener = $("open", HTMLInputElement);
  opener.addEventListener("change", async () => {
    const file = opener.files?.[0];
    opener.value = "";
    if (file) await openFile(file, { engineOnly: shiftHeld });
  });
  const host = options.container;
  const onDragOver = (event: DragEvent): void => { event.preventDefault(); root.classList.add("bwe-dragging"); };
  const onDragLeave = (): void => root.classList.remove("bwe-dragging");
  const onDrop = async (event: DragEvent): Promise<void> => {
    event.preventDefault();
    root.classList.remove("bwe-dragging");
    for (const file of event.dataTransfer?.files ?? []) await openFile(file, { engineOnly: event.shiftKey });
  };
  host.addEventListener("dragover", onDragOver);
  host.addEventListener("dragleave", onDragLeave);
  host.addEventListener("drop", onDrop);
  cleanups.push(() => {
    host.removeEventListener("dragover", onDragOver);
    host.removeEventListener("dragleave", onDragLeave);
    host.removeEventListener("drop", onDrop);
  });

  const addPrimitive = (kind: "box" | "sphere", color: Rgba): void => {
    select(view.addPrimitive(kind, color));
    scheduleAutoSync();
  };

  button("new-blender").onclick = () => void blenderTask("New Blender scene", (p) => p.newScene());
  button("sync").onclick = () => void blenderTask("Sync", (p) => p.sync());
  button("run-python").onclick = () => void blenderTask("Run Python", (p) => p.sync({ script: ui.python.value }));
  for (const b of $("gizmo-modes").children) {
    if (b instanceof HTMLElement) b.onclick = () => setGizmoMode(GIZMO_KEYS[b.dataset.key ?? "w"]);
  }
  button("add-box").onclick = () => addPrimitive("box", [0.08, 0.37, 0.75, 1]);
  button("add-sphere").onclick = () => addPrimitive("sphere", [0.69, 0.07, 0.1, 1]);
  button("delete").onclick = () => {
    if (!selected) return;
    const node = selected;
    select(null);
    if (side.idOf(node)) view.deleteNode(node);
    else view.disposeUntracked(node);
    refresh();
    scheduleAutoSync();
  };
  button("adopt").onclick = () => {
    if (!view.untracked().length) { setStatus("Nothing outside the project to adopt"); return; }
    const ids = view.adoptUntracked();
    setStatus(`Adopted ${ids.length} node(s); they reach Blender on the next sync`);
    refresh();
    scheduleAutoSync();
  };

  button("dl-blend").onclick = async () => {
    if (!project) { setStatus("No Blender yet"); return; }
    download("scene.blend", ownBytes(await project.exportBlend()), "application/x-blender");
  };
  button("dl-glb").onclick = () => void blenderTask("Export .glb", async (p) => {
    const result = await p.sync({ script: 'import bpy\nbpy.ops.export_scene.gltf(filepath="/out/export.glb", export_format="GLB", export_apply=True)' });
    const glb = result.report.files["/out/export.glb"];
    if (glb) download("scene.glb", ownBytes(glb), "model/gltf-binary");
    return result;
  });
  const nativeExport = view.nativeExport;
  const dlNative = button("dl-native");
  dlNative.hidden = !nativeExport || !view.exportNative;
  if (nativeExport) {
    dlNative.textContent = nativeExport.label;
    dlNative.onclick = async () => {
      if (view.exportNative) download(nativeExport.file, await view.exportNative(), "application/octet-stream");
    };
  }
  $("gizmo-modes").hidden = !view.gizmos;

  /* Boot progress: bytes while downloading, then Blender's start phases. */
  function showBootProgress(progress: BootProgress): void {
    $("boot-progress").hidden = progress.phase === "ready";
    $("boot-fill").style.width = `${Math.round(progress.fraction * 100)}%`;
    const mb = (n: number) => (n / 1048576).toFixed(0);
    setStatus(progress.phase === "download" && progress.total
      ? `${progress.detail} · ${mb(progress.loaded)} / ${mb(progress.total)} MB`
      : `${progress.detail}…`, progress.phase === "ready" ? "" : "busy");
  }

  let disposed = false;
  async function boot(): Promise<boolean> {
    const manifest = await runtimeInstalled(options.runtimeUrl);
    if (disposed) return false;
    if (!manifest) {
      $("runtime").textContent = "not found";
      setStatus(`Blender's runtime is not served at ${String(options.runtimeUrl ?? "blender-runtime/")}. ${view.engine}-only editing still works.`, "error");
      refresh();
      return false;
    }
    session = createBlenderSession({ runtimeUrl: options.runtimeUrl, threads: options.threads ?? "auto", onProgress: showBootProgress });
    project = new Project({
      session,
      scene: side,
      plugins: [tracePlugin],
      onLine: (line) => { if (line.trim() && !line.startsWith("<<<")) log(line); },
    });
    await blenderTask("New Blender scene", (p) => p.newScene());
    const flavor = session.flavor === "mt" ? "pthreads" : "single-threaded (JSPI)";
    $("runtime").textContent = `WebAssembly in this tab · ${flavor} · build ${manifest.forkRevision}`;
    log(`[session] Blender (${flavor}) booted once in ${(session.bootMs / 1000).toFixed(1)} s; requests reuse it`);
    return true;
  }
  const ready = boot();
  refresh();

  return {
    get project() { return project; },
    get session() { return session; },
    get ui() { return blenderUi; },
    ready,
    openFile,
    showBlenderUi: toBlenderUi,
    returnFromBlenderUi: fromBlenderUi,
    refresh,
    dispose() {
      disposed = true;
      clearTimeout(autoSyncTimer);
      for (const cleanup of cleanups) cleanup();
      blenderUi?.dispose();
      session?.close();
      root.remove();
      if (madeRelative) options.container.style.position = "";
    },
  };
}
