/* Embedding protocol: a host page runs this demo in an iframe as an editing
 * surface, hands it a .blend to open (at boot or any time after), and asks for
 * the edited file back. @knervous/blender-web's createBlenderUi() is the typed
 * host side.
 *
 *   <iframe src="/blender/?session=/api/scene.blend&id=chair-01">
 *
 * Query parameters
 *   embed=0         show the public launcher page (Launch button, credits)
 *                   instead of going straight into Blender, the default
 *   session=<url>   a .blend fetched before boot and opened as the scene
 *   id=<string>     opaque label echoed back on every message
 *   parent=<origin> the embedding page's origin, when it is another origin (a
 *                   playground): messages are taken only from it and sent only
 *                   to it. Without it, same origin only. Embedded from another
 *                   origin, this page needs Document-Isolation-Policy (its
 *                   threads), which demo/public/_headers sends.
 *
 * Child -> parent
 *   { type: "blender-embed-progress", id, phase, percent, message }
 *   { type: "blender-embed-ready", id }                 first real frame drawn
 *   { type: "blender-embed-snapshot", id, session }     ArrayBuffer of the .blend (transferred)
 *   { type: "blender-embed-opened", id }               a blender-embed-open finished
 *   { type: "blender-embed-error", id, message }
 *
 * Parent -> child
 *   { type: "blender-embed-save" }            save the scene and reply with a snapshot
 *   { type: "blender-embed-open", session }   open this .blend (ArrayBuffer) now
 */
const params = new URLSearchParams(window.location.search);

/** Where messages may come from and go to: the named parent, else this page's own origin. */
const parentOrigin = (() => {
  const named = params.get("parent");
  if (!named) return window.location.origin;
  try {
    return new URL(named).origin;
  } catch {
    return window.location.origin;
  }
})();

export const embed = {
  // Straight into Blender (no launcher page) unless ?embed=0 asks for it.
  enabled: params.get("embed") !== "0",
  parentOrigin,
  sessionUrl: params.get("session"),
  id: params.get("id"),
  /** Where the staged session .blend lives in the module FS. */
  sessionPath: "/tmp/embed-session.blend",
};

document.documentElement.dataset.embed = String(embed.enabled);

const hasParent = () => window.parent !== window;

/** Posts `{ type: "blender-embed-<kind>", id, ...fields }` to the parent. */
export function postToParent(kind, fields = {}, transfer = []) {
  if (!hasParent()) return;
  if (kind === "progress" && !embed.enabled) return;
  window.parent.postMessage({ type: `blender-embed-${kind}`, id: embed.id, ...fields }, parentOrigin, transfer);
}

/** Calls `handlers[type]` (save, open) for the parent's requests. */
export function onParentRequest(handlers) {
  window.addEventListener("message", (event) => {
    if (event.origin !== parentOrigin || event.source !== window.parent) return;
    const kind = typeof event.data?.type === "string" ? event.data.type.replace(/^blender-embed-/, "") : "";
    const handler = handlers[kind];
    if (!handler) return;
    void Promise.resolve().then(() => handler(event.data)).catch((reason) => {
      postToParent("error", { message: reason instanceof Error ? reason.message : String(reason) });
    });
  });
}

/** Calls `handler()` whenever the parent asks for a save. */
export function onSaveRequest(handler) {
  onParentRequest({ save: handler });
}

/**
 * Asks Blender (its host load/save hooks, patches/blender 0002) to open or save
 * `path` on its next main-loop tick; resolves when it reports back. Null when
 * the build has no such hooks.
 */
export function hostFile(kind, path) {
  const module = window.Module;
  if (!module?._blender_web_host_load) return null;
  return new Promise((resolve, reject) => {
    const previous = module.onBlenderHostFile;
    module.onBlenderHostFile = (doneKind, donePath, ok) => {
      if (doneKind !== kind || donePath !== path) return previous?.(doneKind, donePath, ok);
      module.onBlenderHostFile = previous;
      if (ok) resolve();
      else reject(new Error(`Blender could not ${kind} ${path}`));
    };
    module.ccall(kind === "load" ? "blender_web_host_load" : "blender_web_host_save", null, ["string"], [path]);
  });
}
