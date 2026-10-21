/** The HUD's markup and styles, scoped under `.bwe` so it can sit in any page. */

export const HUD_HTML = `
<div class="bwe-drop" data-bwe="drop">Drop a .blend, .glb, .obj, .fbx …</div>
<aside class="bwe-panel">
  <header>
    <h1 data-bwe="title">Blender</h1>
    <p class="bwe-hint">Blender: <span data-bwe="runtime">…</span></p>
    <p class="bwe-status" data-bwe="status">Starting…</p>
    <div class="bwe-progress" data-bwe="boot-progress" hidden><div data-bwe="boot-fill"></div></div>
  </header>
  <section>
    <h2>Open</h2>
    <div class="bwe-row">
      <button data-bwe="new-blender">New Blender scene</button>
      <label class="bwe-button">Open file…<input data-bwe="open" type="file" hidden
        accept=".blend,.glb,.gltf,.babylon,.obj,.fbx,.stl,.ply,.usdz,.usda,.usdc" /></label>
      <button data-bwe="ui-open" title="">Blender UI</button>
    </div>
    <p class="bwe-hint">.blend and anything Blender imports open as the project. Shift+open a glTF to load it into
      <span data-bwe-engine></span> only, outside the project until you adopt it.</p>
  </section>
  <section>
    <h2>Sync</h2>
    <div class="bwe-row">
      <button data-bwe="sync" class="bwe-accent">Sync with Blender</button>
      <label class="bwe-hint bwe-inline"><input data-bwe="auto-sync" type="checkbox" /> Auto-sync after edits</label>
    </div>
    <ul class="bwe-pending" data-bwe="pending"></ul>
  </section>
  <section>
    <h2>Edit in <span data-bwe-engine></span></h2>
    <div class="bwe-row" data-bwe="gizmo-modes">
      <button data-mode="position" data-key="w" class="on">Move (W)</button>
      <button data-mode="rotation" data-key="e">Rotate (E)</button>
      <button data-mode="scale" data-key="r">Scale (R)</button>
    </div>
    <div class="bwe-row">
      <button data-bwe="add-box">Add box</button>
      <button data-bwe="add-sphere">Add sphere</button>
      <button data-bwe="delete">Delete</button>
      <button data-bwe="adopt">Adopt outside content</button>
    </div>
    <div class="bwe-material" data-bwe="material-panel" hidden>
      <div class="bwe-row">
        <label class="bwe-hint bwe-inline">Material <select data-bwe="mat-name"></select></label>
        <button data-bwe="mat-new">New</button>
      </div>
      <div class="bwe-row">
        <label class="bwe-hint bwe-inline">Colour <input data-bwe="mat-color" type="color" /></label>
        <label class="bwe-hint bwe-inline">Metallic <input data-bwe="mat-metallic" type="range" min="0" max="1" step="0.05" /></label>
        <label class="bwe-hint bwe-inline">Roughness <input data-bwe="mat-roughness" type="range" min="0" max="1" step="0.05" /></label>
      </div>
    </div>
    <ul class="bwe-outliner" data-bwe="outliner"></ul>
  </section>
  <section>
    <h2>Blender API</h2>
    <div class="bwe-row">
      <input class="bwe-path" data-bwe="api-path" spellcheck="false" value='objects["Cube"].location' />
    </div>
    <div class="bwe-row">
      <button data-bwe="api-get">Get</button>
      <input class="bwe-value" data-bwe="api-value" spellcheck="false" placeholder="value (JSON)" />
      <button data-bwe="api-set">Set</button>
    </div>
    <p class="bwe-hint">Direct RNA calls (embind), no Python: any bpy.data path. A set syncs back like any Blender edit.</p>
  </section>
  <section>
    <h2>Python in Blender</h2>
    <textarea data-bwe="python" spellcheck="false">import bpy
bpy.ops.mesh.primitive_monkey_add(location=(0, -3, 1.5))
monkey = bpy.context.object
monkey.modifiers.new("row", "ARRAY").count = 3
bpy.ops.object.shade_smooth()
mat = bpy.data.materials.new("orange")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.35, 0.05, 1)
monkey.data.materials.append(mat)</textarea>
    <div class="bwe-row"><button data-bwe="run-python">Run (Ctrl+Enter)</button></div>
  </section>
  <section>
    <h2>Download</h2>
    <div class="bwe-row">
      <button data-bwe="dl-blend">.blend</button>
      <button data-bwe="dl-glb">.glb</button>
      <button data-bwe="dl-native" hidden></button>
    </div>
  </section>
  <section class="bwe-grow">
    <h2>Blender output</h2>
    <pre class="bwe-log" data-bwe="log"></pre>
  </section>
</aside>
<div class="bwe-ui-bar" data-bwe="ui-bar" hidden>
  <strong>Blender</strong><span data-bwe="ui-status"></span><span class="bwe-spacer"></span>
  <button data-bwe="ui-back" class="bwe-accent">Back to <span data-bwe-engine></span></button>
</div>`;

export const HUD_CSS = `
.bwe { --bwe-bg: #1d1d1f; --bwe-panel: #262628ee; --bwe-line: #3a3a3d; --bwe-text: #e6e6e6; --bwe-muted: #9a9aa0;
  --bwe-accent: #e87d0d; --bwe-accent-2: #4fa3e0; color-scheme: dark; font: 13px/1.4 system-ui, sans-serif; color: var(--bwe-text); }
.bwe * { box-sizing: border-box; }
.bwe .bwe-panel { position: absolute; top: 0; right: 0; bottom: 0; width: 330px; z-index: 10; overflow: auto;
  display: flex; flex-direction: column; background: var(--bwe-panel); border-left: 1px solid var(--bwe-line); }
.bwe.bwe-swapped .bwe-panel { display: none; }
.bwe header, .bwe section { padding: 9px 12px; border-bottom: 1px solid var(--bwe-line); }
.bwe section.bwe-grow { flex: 1; display: flex; flex-direction: column; min-height: 140px; }
.bwe h1 { font-size: 15px; margin: 0 0 6px; }
.bwe h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--bwe-muted); margin: 0 0 7px; }
.bwe .bwe-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.bwe button, .bwe .bwe-button, .bwe select, .bwe input.bwe-path, .bwe input.bwe-value {
  font: inherit; color: var(--bwe-text); background: #333336; border: 1px solid var(--bwe-line);
  border-radius: 4px; padding: 4px 8px; cursor: pointer; }
.bwe input.bwe-path { flex: 1; cursor: text; font: 12px ui-monospace, monospace; }
.bwe input.bwe-value { flex: 1; min-width: 60px; cursor: text; font: 12px ui-monospace, monospace; }
.bwe button:hover:not(:disabled), .bwe .bwe-button:hover { border-color: var(--bwe-muted); }
.bwe button:disabled { opacity: 0.45; cursor: default; }
.bwe button.on { border-color: var(--bwe-accent-2); color: #fff; }
.bwe .bwe-accent { border-color: var(--bwe-accent); }
.bwe .bwe-hint { color: var(--bwe-muted); font-size: 12px; margin: 4px 0 0; }
.bwe .bwe-inline { display: inline-flex; align-items: center; gap: 4px; margin: 0; }
.bwe .bwe-status { margin: 6px 0 0; color: var(--bwe-muted); }
.bwe .bwe-status.busy { color: var(--bwe-accent); }
.bwe .bwe-status.error { color: #ff6b6b; white-space: pre-wrap; }
.bwe textarea { width: 100%; height: 110px; resize: vertical; font: 12px/1.4 ui-monospace, monospace; color: var(--bwe-text);
  background: #1a1a1c; border: 1px solid var(--bwe-line); border-radius: 4px; padding: 8px; }
.bwe .bwe-outliner { list-style: none; margin: 4px 0 0; padding: 0; max-height: 170px; overflow: auto; }
.bwe .bwe-outliner li { padding: 2px 6px; border-radius: 3px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bwe .bwe-outliner li:hover { background: #303033; }
.bwe .bwe-outliner li.selected { background: #3a4a5a; }
.bwe .bwe-outliner li .kind { color: var(--bwe-muted); margin-left: 6px; font-size: 11px; }
.bwe .bwe-outliner li .state { margin-left: 6px; font-size: 11px; color: var(--bwe-accent); }
.bwe .bwe-outliner li.untracked { color: var(--bwe-muted); }
.bwe .bwe-outliner li.untracked::after { content: " · engine only"; color: var(--bwe-accent-2); font-size: 11px; }
.bwe .bwe-pending { list-style: none; margin: 4px 0 0; padding: 0; font: 11px/1.4 ui-monospace, monospace; color: var(--bwe-accent); max-height: 100px; overflow: auto; }
.bwe .bwe-pending li.none { color: var(--bwe-muted); font-family: inherit; }
.bwe .bwe-material { border: 1px solid var(--bwe-line); border-radius: 4px; padding: 6px 8px; margin: 4px 0 6px; }
.bwe .bwe-material[hidden] { display: none; }
.bwe .bwe-material input[type="range"] { width: 64px; }
.bwe .bwe-log { flex: 1; margin: 0; overflow: auto; font: 11px/1.35 ui-monospace, monospace; color: #b8b8bd;
  background: #1a1a1c; border: 1px solid var(--bwe-line); border-radius: 4px; padding: 8px; white-space: pre-wrap; }
.bwe .bwe-progress { height: 4px; margin-top: 6px; background: var(--bwe-line); border-radius: 2px; overflow: hidden; }
.bwe .bwe-progress[hidden] { display: none; }
.bwe [data-bwe="boot-fill"] { height: 100%; width: 0; background: var(--bwe-accent); transition: width 0.2s ease-out; }
.bwe .bwe-drop { position: absolute; inset: 16px; right: 346px; display: none; place-items: center; z-index: 9;
  border: 2px dashed var(--bwe-accent-2); border-radius: 8px; font-size: 18px; background: rgb(0 0 0 / 0.4); pointer-events: none; }
.bwe.bwe-dragging .bwe-drop { display: grid; }
.bwe .bwe-ui-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 12; display: flex; align-items: center; gap: 10px;
  padding: 5px 10px; background: #262628; border-bottom: 1px solid var(--bwe-line); }
.bwe .bwe-ui-bar[hidden] { display: none; }
.bwe .bwe-ui-bar .bwe-spacer { flex: 1; }
.bwe-ui-frame { position: absolute; left: 0; right: 0; bottom: 0; top: 34px; width: 100%; height: calc(100% - 34px); z-index: 11; background: #1d1d1f; }
`;
