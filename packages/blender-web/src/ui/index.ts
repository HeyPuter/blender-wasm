/**
 * The full Blender UI in an iframe, behind a typed bridge
 * (`@knervous/blender-web/ui`). The UI is the fork's web build (./build.sh
 * web, demo/dist), hosted somewhere that sends Document-Isolation-Policy (see
 * demo/public/_headers) so it can run its threads inside any page.
 *
 * Boot it once, keep it hidden, and swap to it whenever: `showBlenderUi`
 * hands it the project's session (`project.exportBlend()`), and
 * `returnFromBlenderUi` takes its edits back (`project.adoptBlend()`, an
 * ordinary sync: only what changed comes back to the scene).
 */
import type { Project, SyncResult } from "../project/index.ts";

export interface BlenderUiProgress {
  phase: string;
  /** 0..1 when known. */
  fraction?: number;
  message?: string;
}

export interface BlenderUiOptions {
  /** The UI site (its index.html), e.g. "https://blender-ui.example.com/". */
  url: string | URL;
  /** Where the iframe goes (default: document.body). It starts hidden (transparent, not display:none, so it boots). */
  container?: HTMLElement;
  /** A .blend to open at boot (otherwise Blender's startup scene). */
  session?: Uint8Array;
  onProgress?: (progress: BlenderUiProgress) => void;
}

export interface BlenderUi {
  /** The iframe: size and place it; `show()`/`hide()` toggle it. */
  readonly element: HTMLIFrameElement;
  /** Resolves once Blender has drawn its first frame. */
  readonly ready: Promise<void>;
  /** Opens a .blend now, without reloading. */
  open(blend: Uint8Array): Promise<void>;
  /** Saves the UI's scene and returns it. */
  save(): Promise<Uint8Array>;
  show(): void;
  hide(): void;
  readonly visible: boolean;
  /** Removes the iframe (and Blender with it). */
  dispose(): void;
}

type Message =
  | { type: "blender-embed-progress"; phase?: string; percent?: number; message?: string }
  | { type: "blender-embed-ready" }
  | { type: "blender-embed-opened" }
  | { type: "blender-embed-snapshot"; session: ArrayBuffer }
  | { type: "blender-embed-error"; message?: string };

const isMessage = (data: unknown): data is Message =>
  typeof data === "object" && data !== null && "type" in data && typeof data.type === "string"
  && data.type.startsWith("blender-embed-");

/** A copy backed by a plain ArrayBuffer (transferable, and never a view of shared memory). */
const ownBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

/** Boots the Blender UI in a hidden iframe. */
export function createBlenderUi(options: BlenderUiOptions): BlenderUi {
  const url = new URL(options.url, typeof document === "undefined" ? undefined : document.baseURI);
  const origin = url.origin;
  const id = crypto.randomUUID();
  url.searchParams.set("embed", "1");
  url.searchParams.set("id", id);
  url.searchParams.set("parent", window.location.origin);
  let bootSession: string | null = null;
  if (options.session) {
    bootSession = URL.createObjectURL(new Blob([ownBuffer(options.session)], { type: "application/x-blender" }));
    url.searchParams.set("session", bootSession);
  }

  const element = document.createElement("iframe");
  element.title = "Blender";
  element.style.border = "0";
  // Hidden by opacity, not display: a display:none frame gets no animation
  // frames, so Blender would never draw (or report ready) until shown.
  let visible = false;
  const applyVisibility = (): void => {
    element.style.opacity = visible ? "1" : "0";
    element.style.pointerEvents = visible ? "auto" : "none";
    element.tabIndex = visible ? 0 : -1;
    element.setAttribute("aria-hidden", String(!visible));
  };
  applyVisibility();
  element.src = url.href;

  // One request of each kind at a time; replies are matched by type.
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let pendingOpen: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let pendingSave: { resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  let booted = false;

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== origin || event.source !== element.contentWindow || !isMessage(event.data)) return;
    const data = event.data;
    switch (data.type) {
      case "blender-embed-progress":
        options.onProgress?.({ phase: data.phase ?? "loading", fraction: typeof data.percent === "number" ? data.percent / 100 : undefined, message: data.message });
        break;
      case "blender-embed-ready":
        booted = true;
        if (bootSession) URL.revokeObjectURL(bootSession);
        resolveReady();
        break;
      case "blender-embed-opened":
        pendingOpen?.resolve();
        pendingOpen = null;
        break;
      case "blender-embed-snapshot":
        pendingSave?.resolve(new Uint8Array(data.session));
        pendingSave = null;
        break;
      case "blender-embed-error": {
        const error = new Error(data.message ?? "Blender UI error");
        if (!booted) rejectReady(error);
        pendingOpen?.reject(error);
        pendingSave?.reject(error);
        pendingOpen = null;
        pendingSave = null;
        break;
      }
    }
  };
  window.addEventListener("message", onMessage);
  (options.container ?? document.body).append(element);

  const post = (message: object, transfer: Transferable[] = []): void => {
    element.contentWindow?.postMessage(message, origin, transfer);
  };

  return {
    element,
    ready,
    async open(blend) {
      await ready;
      if (pendingOpen) throw new Error("A Blender UI open is already in progress");
      const done = new Promise<void>((resolve, reject) => { pendingOpen = { resolve, reject }; });
      const buffer = ownBuffer(blend);
      post({ type: "blender-embed-open", session: buffer }, [buffer]);
      return done;
    },
    async save() {
      await ready;
      if (pendingSave) throw new Error("A Blender UI save is already in progress");
      const done = new Promise<Uint8Array>((resolve, reject) => { pendingSave = { resolve, reject }; });
      post({ type: "blender-embed-save" });
      return done;
    },
    show() { visible = true; applyVisibility(); element.focus(); },
    hide() { visible = false; applyVisibility(); },
    get visible() { return visible; },
    dispose() {
      window.removeEventListener("message", onMessage);
      element.remove();
      if (bootSession) URL.revokeObjectURL(bootSession);
    },
  };
}

/** Swaps to the UI: hands it the project's session and shows it. */
export async function showBlenderUi(project: Project, ui: BlenderUi): Promise<void> {
  await ui.open(await project.exportBlend());
  ui.show();
}

/** Swaps back: takes the UI's edits into the project (an ordinary sync) and hides it. */
export async function returnFromBlenderUi(project: Project, ui: BlenderUi): Promise<SyncResult> {
  const blend = await ui.save();
  ui.hide();
  return project.adoptBlend(blend);
}
