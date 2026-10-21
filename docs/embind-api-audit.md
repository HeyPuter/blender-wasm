# Direct JS interface to Blender: embind / generated SDK audit

Read-only audit (grep and file reads only; nothing built or run). Paths are relative to the
repository root unless noted. Anything not checked is marked **unverified**.

**Measured since (2026-10-20, persistent session in the browser):** a request with no work (idle sync) is
3–8 ms round trip, all fixed overhead (1 ms poll, JSON, FS writes, worker messages); a single-transform
sync is 5–11 ms; a bevel that changes one mesh is 40–120 ms (mostly evaluating and encoding that mesh); a
`.blend` export is ~19 ms. The Python `depsgraph_update_post` handler does fire in `--background` server
mode: an in-place vertex edit was detected and only that mesh was resent.

## 1. RNA as generator source

- makesrna runs in this tree (`build-blender/bin/makesrna.{js,wasm}`, built to wasm and run under node).
  Generated output in `build-blender/source/blender/makesrna/`:
  - `RNA_prototypes.hh` (724,637 bytes): 1,736 `extern struct StructRNA *RNA_<Name>` declarations, plus
    the `rna_<struct>_<prop>` PropertyRNA declarations (about 11k lines mention `rna_`).
  - `intern/rna_*_gen.cc`: about 80 files, 30.4 MB total (rna_ID_gen 404 KB, rna_mesh_gen, rna_modifier_gen, ...).
- **`RNA_blender_cpp.h` is NOT generated in this tree**, and the fork's makesrna has no reference to it
  (`grep blender_cpp blender/source/blender/makesrna` finds nothing). The C++ wrapper API that older
  Blenders produced is gone in this 5.x base. So "parse RNA_blender_cpp.h" is not an option; the
  generator source is either (a) the runtime RNA tables (`StructRNA`/`PropertyRNA` walked via
  `RNA_struct_*`, `RNA_property_*`), or (b) a new makesrna output pass we would add, or (c) parsing the
  `RNA_def_*` calls in `blender/source/blender/makesrna/intern/rna_*.cc`.
- Hand-written definitions (`makesrna/intern/*.cc`, line-count based, so a lower bound on macros inside
  loops/helpers): `RNA_def_struct(` 1,037; `RNA_def_property(` 8,333; `RNA_def_function(` 994;
  `RNA_def_function_*`/`RNA_def_parameter` 3,067 lines. 117 `rna_*.cc` files.
- Scene-sync subset (per-file `RNA_def_struct` / `RNA_def_property` / `RNA_def_function`):
  rna_object 11/136/18, rna_mesh 22/117/12, rna_material 5/91/3, rna_scene 39/647/19,
  rna_collection 9/26/7, rna_modifier 94/870/3, rna_depsgraph 3/24/7, rna_ID 15/50/29,
  rna_main 2/12/0, rna_context 1/20/1. Sum roughly 200 structs, 2,000 properties, 100 functions.
  Excluded bulk: rna_userdef 65/759, rna_space 55/623, rna_nodetree 65/421, rna_wm 23/134, rna_ui 9/78, brush, etc.
  Modifier structs dominate the count but are uniform in shape (type tag + props).
- Note the scene-sync protocol (`packages/blender-web/src/project/protocol.py`, 483 lines) uses only: object name/parent/
  matrix/visibility/custom prop (`bw_id`), material slots and a few material props, mesh creation and
  evaluated mesh readout. That is a much smaller set than the subset above.

## 2. Zero-copy evaluated mesh access

Current Python path (`packages/blender-web/src/project/protocol.py::mesh_payload`): `evaluated_get`, `to_mesh()`,
`calc_loop_triangles`, then six `foreach_get` copies into numpy, a stable argsort by material, an
un-indexed re-expansion of positions/normals/uvs, Y-up conversion, sha1 fingerprint, written to the FS as a `.bin`.

C++ APIs that expose the same data in place (all in `blender/source/blender/`):
- Evaluated object: `DEG_get_evaluated(depsgraph, ob)` (`depsgraph/DEG_depsgraph_query.hh:101`) then
  `BKE_object_get_evaluated_mesh(const Object*)` (`blenkernel/BKE_object.hh:519`; `_no_subsurf` variant at 517).
- Mesh accessors declared in `makesdna/DNA_mesh_types.h` (`Mesh` struct, 5.x AttributeStorage layout):
  `vert_positions()` (l.347, `Span<float3>`), `face_offsets()` (370), `corner_verts()` (383),
  `corner_tris()` (428, `Span<int3>`, lazily cached), `corner_tri_faces()` (433), `corner_normals()` (538,
  lazy cache), `material_index_max()` (444). Material indices and UV maps are attributes, read through
  `mesh.attributes()` (`bke::AttributeAccessor`): `"material_index"` (int, face domain),
  UV map attributes are float2 on the corner domain (name from `CustomData`/AttributeStorage, **exact
  5.x UV attribute naming unverified**). `Mesh` holds both `attribute_storage` (l.184) and legacy
  `vert_data/edge_data/face_data/corner_data` CustomData (l.187-190), so some layers may still live in CustomData
  in this commit (**which one holds UVs here is unverified**).
- A flat span is `ptr + length`. JS can read it via `HEAPF32.subarray(ptr>>2, (ptr>>2)+3*n)`; wasm32 pointers
  are 32-bit (memory max 4 GB, link_blender_headless.sh).
- Needed export wrapper (C, one function): given object name (or a stable handle) and a depsgraph, return a small
  struct in wasm memory: `{ n_verts, n_corners, n_tris, co*, corner_vert*, tri*, tri_face*, corner_normal*,
  uv*, material_per_face*, version }`. Corner-tris and corner-normals are lazy caches; the wrapper must call the
  accessors first (they compute on demand, thread-safe via the mesh runtime), and must not hold the pointers
  past evaluation.
- JS-side work that stays: expanding to unindexed buffers (or use indexed vertex+corner buffers and let the
  scene side index), sorting by material (or emit `tri_face -> material_index` and group in JS), Y-up
  conversion (trivial in JS), hashing.
- Lifetime: evaluated meshes are owned by the depsgraph copy-on-eval data and are replaced on any re-evaluation,
  undo, file load, or `load_post`. Pointers are valid only until the next depsgraph evaluate or Main change on
  Blender's thread. Memory growth (ALLOW_MEMORY_GROWTH=1) detaches the old `ArrayBuffer` for non-shared memory;
  with `-pthread` memory is a SharedArrayBuffer and views are `.subarray` over the growable buffer, but JS
  must re-create views after growth (the glue refreshes HEAP* views via `updateMemoryViews`). Safest is to
  copy out with `.slice()` while on Blender's thread-synchronised call, or hand out a version number and
  make views transient.

## 3. Calling into Blender from JS: threading

- Link flags (`scripts/link_blender_headless.sh`): `-pthread -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=0
  -sMAIN_MODULE=1 -sMODULARIZE=1 -sERROR_ON_UNDEFINED_SYMBOLS=0 -sPTHREAD_POOL_SIZE=4
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,ENV,HEAPU8,HEAPU16,HEAPF32 -sFORCE_FILESYSTEM=1
  -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB`. `main()` runs on a worker pthread; the JS (main) thread is free.
  `main()` never returns in headless; Python `serve()` is the loop (`packages/blender-web/src/project/protocol.py:457`), polling
  `/ipc/request.json` with `time.sleep(0.001)`. That 1 ms poll plus JSON and FS file round trips is the fixed
  cost described in the brief; measured at 3–8 ms for an empty request (see the note at the top).
- **Thread rule.** Blender's "main" thread is the proxied pthread (`BLI_thread_is_main()` =
  `pthread_equal(pthread_self(), mainid)`, `blenlib/intern/threads.cc:180`). A plain exported C function called
  from the JS main thread through `ccall` is *proxied* by emscripten to the thread that owns... **unverified**:
  with PROXY_TO_PTHREAD, JS-called `_export()` on the browser/main JS thread runs *on the JS thread itself* (it
  is a direct wasm call into shared memory), not on the Blender pthread, unless it is a pthread-proxied call.
  Calling Blender data APIs from the JS thread would race with the Blender thread and, under Python, the GIL.
  So JS must never call RNA/DNA/depsgraph functions directly; it must post work to the Blender thread.
- Existing patterns in the fork's web code (all GUI build; none unified for headless):
  - `blender/source/creator/creator.cc`: `blender_web_device_ready()` (l.33; re-enters `main()` once the
    WebGPU device is ready) and `blender_web_mount_provider(int mountId, const char *path)` (l.43; mounts a
    JS FS provider via `wasmfs_create_provider_backend`). Both are under `#ifdef __EMSCRIPTEN__`; whether they
    are compiled into the headless link is **unverified** (creator.cc has WITH_HEADLESS-independent EMSCRIPTEN guard at l.10).
  - `windowmanager/intern/wm_files.cc`: `blender_web_set_has_fsaccess(int)` (l.3233),
    `blender_web_file_open_at(const char*)` (l.3274), `blender_web_file_save_at(const char*)` (l.3283). These
    only set a flag/string (`g_web_open_pending`, `g_web_save_pending`); they run on whichever thread calls them.
  - `windowmanager/intern/wm.cc:727-760`: `wm_main_step` runs under `emscripten_set_main_loop_arg(...)` on the
    proxied-main pthread and polls these flags every tick (`wm_web_poll_pending_file_open`). **This is the
    existing "drain a mailbox on Blender's main thread" idiom.** It exists only in the GUI main loop
    (WM_main, non-headless); headless `--background` with `serve()` has no such tick.
  - Reverse direction: `MAIN_THREAD_ASYNC_EM_ASM` (wm_files.cc lines 3366, 4122, 4161) posts from Blender's
    thread to the browser main thread (file picker hooks). No `emscripten_proxy_sync` or
    `emscripten_sync_run_in_main_runtime_thread` use found in source/creator, intern/ghost, or windowmanager
    (grep of `EM_JS|EM_ASM|emscripten_` over `blender/source` and `blender/intern` returned only these files:
    creator.cc, wm.cc, wm_window.cc, wm_files.cc, gpu/webgpu/*, ghost GHOST_SystemWeb/WindowWeb).
- GIL: Python runs `serve()` holding the GIL on the Blender thread nearly always (it sleeps in
  `time.sleep(0.001)`, which releases it). A C export that touches `bpy`-owned objects from the JS thread
  must not call back into Python. C++ data API calls (BKE/DEG/RNA) do not need the GIL, only Blender's own
  thread discipline (they are not thread-safe against the main thread mutating Main).
- Safest dispatch: a lock-free single-slot (or ring) mailbox in shared wasm memory, written by JS (typed),
  and drained on the Blender thread. In headless, either (a) a tiny native loop replacing `serve()`'s
  `os.path.exists()` poll (calls `emscripten_futex_wait`/`pthread_cond_wait`, with JS doing `Atomics.notify`
  on the futex word), or (b) keep Python's loop but have it read the mailbox via a one-call C function
  (`ctypes`, no FS). (a) is the clean target.

## 4. Operators and depsgraph from C

- Run an operator: `WM_operator_name_call(bContext*, const char *opstring, wm::OpCallContext, PointerRNA *props, const wmEvent*)`
  and `WM_operator_name_call_ptr(C, wmOperatorType*, ctx, PointerRNA*, event)` and
  `WM_operator_name_call_with_properties` (`windowmanager/WM_api.hh:1101-1112`); `WM_operator_call_py` at l.1125.
  Properties are an `IDProperty`-backed `PointerRNA`; set with `RNA_*_set` helpers. Needs a valid `bContext`
  (the process `C` created in `main()`; **how to reach it from an export: via a file-static set in creator.cc, unverified**).
- Evaluate: `BKE_scene_graph_evaluated_ensure(Depsgraph*, Main*)` and `BKE_scene_graph_update_tagged(depsgraph, bmain)`
  (`blenkernel/BKE_scene.hh:231-232`); `BKE_scene_ensure_depsgraph(Main*, Scene*, ViewLayer*)` (l.344);
  `CTX_data_ensure_evaluated_depsgraph(C)` (`BKE_context.hh:496`); `DEG_evaluate_on_refresh` is declared at
  `depsgraph/DEG_depsgraph.hh:201`; tag with `DEG_id_tag_update(ID*, flags)` (l.123).
- Update tracking replacing the Python `depsgraph_update_post` handler (`protocol.py:358`, which iterates
  `depsgraph.updates` and checks `is_updated_geometry`):
  - The Python handler is fired from `BKE_callback_exec_id_depsgraph(..., BKE_CB_EVT_DEPSGRAPH_UPDATE_POST)`
    (`blenkernel/intern/scene.cc:2784`, enum `BKE_callbacks.hh:95`).
  - C-level alternatives: `DEG_editors_set_update_cb(DEG_EditorUpdateIDCb, DEG_EditorUpdateSceneCb)`
    (`DEG_depsgraph.hh:225`) gives per-ID callbacks with `DEGEditorUpdateContext{bmain, depsgraph, scene, view_layer}`;
    the ID's `recalc` flags (`ID_RECALC_GEOMETRY` etc.) are readable in the callback before
    `DEG_ids_clear_recalc` (l.161). **Caveat:** this slot is a single global callback pair already used by the
    editors (and maybe by the headless build); replacing it is invasive. Safer: add one more C++ callback
    in `BKE_callback` (a native `bCallbackFuncStore`) for `DEPSGRAPH_UPDATE_POST` that appends `(ID*, recalc)`
    into a shared-memory ring buffer with a monotonically increasing sequence. Whether editor update callbacks
    fire at all in `--background` is **unverified**.

## 5. Embind practicalities

- Nothing in the repo uses embind today: `grep -n 'embind|lembind|--bind' scripts/*.sh Makefile` found no hit.
- MAIN_MODULE=1 + embind: embind registers via static initialisers and works in side/main modules in
  principle, but this is **unverified for this link** and not tested. MAIN_MODULE=1 already exports all symbols
  (that is why numpy's SIDE_MODULEs resolve), and the link already uses `-sERROR_ON_UNDEFINED_SYMBOLS=0` and a
  stub object (`scripts/undef_symbols.txt`), so adding `-lembind` adds runtime glue (about a few hundred KB of JS plus
  some KB of wasm for the registry, estimate **unverified**) and per-binding overhead in the module. Current wasm size:
  `dist/blender-wasm-browser/blender.wasm.br` 18.8 MB, `.zst` 20.0 MB; a few thousand generated bindings
  would add on the order of 1-3 MB raw (estimate, **unverified**).
- Threading: embind functions are called synchronously on whichever thread invokes `Module.fn(...)`. With
  PROXY_TO_PTHREAD, `Module` in the JS/main-thread realm calls wasm directly on the JS thread (not proxied), so
  they race with Blender. Emscripten pthread proxying (`emscripten::val`, `emscripten_proxy_sync`) is for
  C++ calling the main thread, not the reverse. Direction JS->Blender-thread needs the mailbox above. Embind
  calls are fine for pure functions (reading a version counter, reading memory addresses of already-prepared snapshots).
- Plain exports alternative: `EMSCRIPTEN_KEEPALIVE extern "C"` functions plus `cwrap/ccall` (both already in
  `EXPORTED_RUNTIME_METHODS`) and typed views over `HEAPU8/HEAPF32` (already exported; HEAP32/HEAPU32 would be
  added). Zero new runtime, tiny size, same thread constraints. Under MAIN_MODULE=1 all non-hidden symbols are
  reachable by name anyway; `-sEXPORTED_FUNCTIONS` is only needed to keep them from being dropped in LTO builds.
  Ready for use: functions are callable as `Module._blender_web_foo`.

## Recommended tiered SDK surface

**Tier 0: hot path without Python/FS (smallest set of C exports).**
1. `bw_submit(request_ptr, len)`: write a typed request record (a fixed binary header + the existing
   JSON as bytes, optional) into a shared-memory mailbox and notify via futex; `bw_poll(id)` / blocking wait
   via `Atomics.wait` on a status word in `HEAP32` (JS waits in a worker, not on the page thread).
   Dispatch inside Blender stays Python at first. Note this CPython has no `_ctypes` (built without libffi), so
   `serve()` cannot read the mailbox through ctypes: it needs a tiny built-in C module (e.g. `_bw_mailbox`,
   added to CPython's static builtins or registered by Blender's `bpy` init) exposing `wait()`/`read()`. That removes
   the FS file + `os.path.exists` poll + 1 ms sleep: expected to cut most of the fixed 5-40 ms (**estimate**).
2. `bw_mesh_view(object_id, out_struct*)` returning the pointers/counts listed in section 2, valid until
   `bw_release_snapshot()`; JS copies with typed-array views.
3. `bw_updates_since(seq, out*)`: ring buffer of `(ID name hash, recalc flags)` populated by a native
   `DEPSGRAPH_UPDATE_POST` callback; replaces the Python handler's per-update iteration.
Build changes: add the exported functions to a new `source/creator/` file (or `windowmanager/intern`);
add `-sEXPORTED_FUNCTIONS` entries (and `HEAP32,HEAPU32` runtime methods) in `scripts/link_blender_headless.sh`;
no embind, no new libs; relink only (the file is part of the existing target). Python-side change: `serve()`
replaced by a mailbox wait.

**Tier 1: RNA-driven typed accessors for the scene-sync subset (~200 structs, ~2,000 props).**
Generate from the runtime RNA tables (a small native walker, or an extra makesrna output) a flat table of
`(struct, prop, type, offset-or-getter)` and export two generic C functions: `bw_rna_get(ptr, prop_id, out)` /
`bw_rna_set(...)`, plus a generated TypeScript interface from the same table. Handles for ID pointers are
`(session-id, ID name)` tokens, not raw pointers, to avoid stale pointers. Build change: add a makesrna output
pass (CMake custom command next to `makesrna` in `blender/source/blender/makesrna/intern/CMakeLists.txt`), or
generate from the Python `bpy.types` introspection offline into a checked-in `.ts`/`.json` (no Blender link change).
Embind is optional here; with the generic accessors, it is not needed.

**Tier 2: full generated surface (1,736 structs, 8,000+ properties, ~1,000 functions).**
Same generator, all structs; embind (`-lembind`) or a generated `switch` dispatcher. Needs per-function wrappers
for RNA functions (`RNA_def_function`) with context arguments; operators via `WM_operator_name_call` and
`PointerRNA` property marshalling. Expect measurable link-time and size growth (**unverified**), longer compile of
the generated file (rna_*_gen.cc are already 30 MB of source), and an API-stability burden on every Blender bump.

## Main risks
- **Threading/GIL:** exports called from the JS thread run on the JS thread (**unverified assumption, confirm before building**);
  all Blender calls need to be dispatched to the proxied pthread. Python holds the GIL on that thread.
- **Pointer lifetime:** evaluated mesh spans die on re-evaluation, undo, `load_post`; also wasm memory growth
  invalidates view objects (SharedArrayBuffer growth semantics). Use snapshot/versioned views.
- **Lazy caches:** `corner_tris()` and `corner_normals()` compute on first access; call them on the Blender thread.
- **bContext:** most operators need the global context; its reachability from an export is unverified.
- **Update tracking:** `DEG_editors_set_update_cb` is a single global slot; prefer a new native callback in BKE_callbacks.
- **Size:** 18.8 MB brotli already; embind and generated bindings add more (unquantified).
- **Maintenance:** the pinned fork (6b031d3) has no `RNA_blender_cpp.h`; a generated typed surface depends on
  RNA internals that change between 5.x releases; DNA attribute storage (AttributeStorage vs CustomData) is mid-transition.
