# Blender side of the project protocol (see DESIGN.md).
#
# A request: apply the job's commands, run the job's script, then report the
# whole scene in the shared description and write mesh data only for objects
# whose geometry fingerprint differs from what the caller already has.
# Everything crosses in glTF space (Y up, right handed); Blender's Z-up is
# converted here and nowhere else.
#
# job                  { commands, script, known: {id: geometryHash}, handlers: {name: source},
#                        reportGeometry: bool }
# /job/geo/<id>.bin    mesh data for create commands
# <out>/report.json    { entities, materials, geometry, conflicts, missing, log }
# <out>/geo/<id>.bin   mesh data for changed geometry
# <out>/session.blend  the session, when the request asks for it
#
# Two ways to run it:
#   one-shot  Blender opens the session .blend from argv, handles
#             /job/project.json into /out and saves (a run per request).
#   server    (BW_SERVER = True before this source) Blender boots once and
#             serves requests from /ipc/request.json for as long as it lives:
#             the scene stays in memory, a .blend is loaded or saved only when a
#             request asks, and fingerprints are recomputed only for geometry
#             the depsgraph reports changed. See serve(). The single-threaded
#             build polls from Blender's main between JSPI sleeps (poll()).
#
# NumPy buffers are 32-bit throughout: foreach_get/foreach_set and the binary
# payloads are float32/int32, never the 64-bit defaults.
import bpy
import hashlib
import json
import os
import shutil
import time
import traceback
import uuid

import numpy as np
from mathutils import Matrix, Quaternion, Vector

TO_GLTF = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
FROM_GLTF = TO_GLTF.inverted()
EPS = 1e-5
KINDS = {"MESH": "mesh", "EMPTY": "empty", "LIGHT": "light", "CAMERA": "camera"}

# Per-request state, reset by handle().
LOG, CONFLICTS, MISSING = [], [], []
OUT = "/out"


# --- identity -------------------------------------------------------------------
def entity_id(obj):
    if "bw_id" not in obj:
        obj["bw_id"] = uuid.uuid4().hex
    return obj["bw_id"]


def objects_by_id():
    return {obj["bw_id"]: obj for obj in bpy.data.objects if "bw_id" in obj}


# --- fields, read ------------------------------------------------------------
def read_transform(obj):
    t, r, s = (TO_GLTF @ obj.matrix_local @ FROM_GLTF).decompose()
    return {"t": [t.x, t.y, t.z], "r": [r.x, r.y, r.z, r.w], "s": [s.x, s.y, s.z]}


def read_visible(obj):
    return not obj.hide_viewport and not obj.hide_get()


def read_entity(obj):
    return {
        "id": entity_id(obj),
        "name": obj.name,
        "kind": KINDS.get(obj.type, "other"),
        "parent": entity_id(obj.parent) if obj.parent else None,
        "transform": read_transform(obj),
        "visible": read_visible(obj),
        "materials": read_slots(obj),
    }


def read_material(mat):
    color, metallic, roughness = list(mat.diffuse_color), mat.metallic, mat.roughness
    if mat.use_nodes and mat.node_tree:
        bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf:
            color = list(bsdf.inputs["Base Color"].default_value)
            metallic = bsdf.inputs["Metallic"].default_value
            roughness = bsdf.inputs["Roughness"].default_value
    return {"color": [float(c) for c in color], "metallic": float(metallic), "roughness": float(roughness)}


# --- fields, write --------------------------------------------------------------
def write_transform(obj, value):
    t, r, s = value["t"], value["r"], value["s"]
    local = Matrix.LocRotScale(Vector(t), Quaternion((r[3], r[0], r[1], r[2])), Vector(s))
    obj.matrix_local = FROM_GLTF @ local @ TO_GLTF


def write_visible(obj, value):
    obj.hide_viewport = False
    obj.hide_set(not value)


def write_parent(obj, value, by_id):
    world = obj.matrix_world.copy()
    obj.parent = by_id.get(value) if value else None
    obj.matrix_world = world


def same(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, float) or isinstance(b, float):
        return abs(float(a) - float(b)) < EPS
    return a == b


def read_slots(obj):
    return [slot.material.name if slot.material else None for slot in obj.material_slots]


def write_slots(obj, names):
    """Material per slot, by name: materials the run created or Blender had."""
    data = obj.data
    if data is None or not hasattr(data, "materials"):
        return
    wanted = [bpy.data.materials.get(name) if name else None for name in names]
    missing = [name for name, mat in zip(names, wanted) if name and mat is None]
    if missing:
        raise ValueError(f"no material named {missing!r} (send it as a material command first)")
    while len(data.materials) > len(wanted):
        data.materials.pop()
    for index, mat in enumerate(wanted):
        if index < len(data.materials):
            data.materials[index] = mat
        else:
            data.materials.append(mat)


FIELD_READ = {
    "name": lambda obj: obj.name,
    "materials": read_slots,
    "transform": read_transform,
    "visible": read_visible,
    "parent": lambda obj: entity_id(obj.parent) if obj.parent else None,
}


# --- mesh data ------------------------------------------------------------------
# Layout of a .bin: float32 positions[3n], normals[3n], then uvs[2n] if present;
# n = vertexCount, triangles are consecutive vertex triples, grouped by material.
def mesh_payload(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        count = len(mesh.loop_triangles)
        if count == 0:
            return None
        tri_loops = np.empty(count * 3, dtype=np.int32)
        mesh.loop_triangles.foreach_get("loops", tri_loops)
        tri_material = np.empty(count, dtype=np.int32)
        mesh.loop_triangles.foreach_get("material_index", tri_material)
        loop_vertex = np.empty(len(mesh.loops), dtype=np.int32)
        mesh.loops.foreach_get("vertex_index", loop_vertex)
        co = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", co)
        corner_normals = np.empty(len(mesh.loops) * 3, dtype=np.float32)
        mesh.corner_normals.foreach_get("vector", corner_normals)

        order = np.argsort(tri_material, kind="stable").astype(np.int32)
        loops = tri_loops.reshape(-1, 3)[order].reshape(-1)
        materials = tri_material[order]
        pos = co.reshape(-1, 3)[loop_vertex[loops]]
        nor = corner_normals.reshape(-1, 3)[loops]
        pos = np.ascontiguousarray(np.stack((pos[:, 0], pos[:, 2], -pos[:, 1]), axis=1), dtype=np.float32)
        nor = np.ascontiguousarray(np.stack((nor[:, 0], nor[:, 2], -nor[:, 1]), axis=1), dtype=np.float32)
        parts = [pos.tobytes(), nor.tobytes()]
        has_uv = mesh.uv_layers.active is not None
        if has_uv:
            uv = np.empty(len(mesh.loops) * 2, dtype=np.float32)
            mesh.uv_layers.active.data.foreach_get("uv", uv)
            uv = uv.reshape(-1, 2)[loops].copy()
            uv[:, 1] = 1.0 - uv[:, 1]
            parts.append(np.ascontiguousarray(uv, dtype=np.float32).tobytes())

        groups, start = [], 0
        values, counts = np.unique(materials, return_counts=True)
        for value, tris in zip(values.tolist(), counts.tolist()):
            groups.append([int(value), start * 3, int(tris) * 3])
            start += int(tris)
        data = b"".join(parts)
        # Fingerprint quantised values: modifier evaluation (bevel, ...) is not
        # bit-for-bit repeatable across runs, and a raw-bytes hash would resend
        # an unchanged mesh every time.
        quantised = [np.round(pos * 1e4).astype(np.int32), np.round(nor * 1e4).astype(np.int32)]
        if has_uv:
            quantised.append(np.round(uv * 1e5).astype(np.int32))
        # Slot names stay out: assignment travels as the `materials` field.
        digest = hashlib.sha1(b"".join(q.tobytes() for q in quantised) + json.dumps(groups).encode()).hexdigest()
        return {"vertexCount": int(count * 3), "hasUv": has_uv, "groups": groups, "hash": digest}, data
    finally:
        evaluated.to_mesh_clear()


def build_mesh(name, spec):
    raw = np.fromfile(spec["file"], dtype=np.float32)
    n = spec["vertexCount"]
    pos = raw[: n * 3].reshape(-1, 3)
    verts = np.stack((pos[:, 0], -pos[:, 2], pos[:, 1]), axis=1)
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(n)
    mesh.vertices.foreach_set("co", np.ascontiguousarray(verts, dtype=np.float32).reshape(-1))
    tris = n // 3
    mesh.loops.add(n)
    mesh.loops.foreach_set("vertex_index", np.arange(n, dtype=np.int32))
    mesh.polygons.add(tris)
    mesh.polygons.foreach_set("loop_start", np.arange(0, n, 3, dtype=np.int32))
    mesh.polygons.foreach_set("loop_total", np.full(tris, 3, dtype=np.int32))
    if spec.get("hasUv"):
        uv = raw[n * 6: n * 8].reshape(-1, 2).copy()
        uv[:, 1] = 1.0 - uv[:, 1]
        mesh.uv_layers.new(name="UVMap").data.foreach_set("uv", np.ascontiguousarray(uv, dtype=np.float32).reshape(-1))
    mesh.update()
    mesh.validate()
    # Welds the per-triangle vertices back into a connected, editable mesh.
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def ensure_material(name, props):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf and props:
        bsdf.inputs["Base Color"].default_value = props["color"]
        bsdf.inputs["Metallic"].default_value = props["metallic"]
        bsdf.inputs["Roughness"].default_value = props["roughness"]
    if props:
        mat.diffuse_color = props["color"]
        mat.metallic = props["metallic"]
        mat.roughness = props["roughness"]
    return mat


# --- commands ---------------------------------------------------------------------


def cmd_create(cmd, by_id):
    entity = cmd["entity"]
    data = build_mesh(entity["name"], cmd["mesh"]) if cmd.get("mesh") else None
    obj = bpy.data.objects.new(entity["name"], data)
    bpy.context.scene.collection.objects.link(obj)
    obj["bw_id"] = entity["id"]
    by_id[entity["id"]] = obj
    if data is not None:
        for mat in cmd.get("materials", []):
            data.materials.append(ensure_material(mat["name"], mat.get("props")))
    if entity.get("parent"):
        obj.parent = by_id.get(entity["parent"])
    write_transform(obj, entity["transform"])
    write_visible(obj, entity.get("visible", True))
    LOG.append(f"created {obj.name}")


def cmd_delete(cmd, by_id):
    obj = by_id.pop(cmd["id"], None)
    if obj is None:
        MISSING.append(cmd["id"])
        return
    LOG.append(f"deleted {obj.name}")
    bpy.data.objects.remove(obj, do_unlink=True)


def cmd_update(cmd, by_id):
    obj = by_id.get(cmd["id"])
    if obj is None:
        MISSING.append(cmd["id"])
        return
    field = cmd["field"]
    if "expect" in cmd and field in FIELD_READ:
        current = FIELD_READ[field](obj)
        if not same(current, cmd["expect"]):
            # Blender changed this field since the last agreed state too.
            CONFLICTS.append({"id": cmd["id"], "field": field, "blender": current,
                              "scene": cmd["value"], "kept": cmd.get("policy", "blender")})
            if cmd.get("policy", "blender") == "blender":
                return
    if field == "transform":
        write_transform(obj, cmd["value"])
    elif field == "name":
        obj.name = cmd["value"]
    elif field == "visible":
        write_visible(obj, cmd["value"])
    elif field == "parent":
        write_parent(obj, cmd["value"], by_id)
    elif field == "materials":
        write_slots(obj, cmd["value"])
    else:
        raise ValueError(f"no Blender writer for field {field!r}")
    LOG.append(f"{field} {obj.name}")


def cmd_material(cmd, by_id):
    existing = bpy.data.materials.get(cmd["name"])
    if existing is not None and "expect" in cmd:
        current = read_material(existing)
        if not same(current, cmd["expect"]):
            CONFLICTS.append({"id": cmd["name"], "field": "material", "blender": current,
                              "scene": cmd["value"], "kept": cmd.get("policy", "blender")})
            if cmd.get("policy", "blender") == "blender":
                return
    ensure_material(cmd["name"], cmd["value"])
    LOG.append(f"material {cmd['name']}")


BUILTIN_HANDLERS = {"create": cmd_create, "delete": cmd_delete, "update": cmd_update, "material": cmd_material}

# Plugin handlers: each source defines handle(cmd, by_id, api). Compiled once per source.
API = {"read_entity": read_entity, "write_transform": write_transform, "log": LOG.append,
       "TO_GLTF": TO_GLTF, "FROM_GLTF": FROM_GLTF}
_COMPILED = {}


def handlers_for(job):
    handlers = dict(BUILTIN_HANDLERS)
    for name, source in job.get("handlers", {}).items():
        if source not in _COMPILED:
            scope = {}
            exec(compile(source, f"<handler {name}>", "exec"), scope)
            _COMPILED[source] = scope["handle"]
        handlers[name] = (lambda handle: lambda cmd, by_id: handle(cmd, by_id, API))(_COMPILED[source])
    return handlers


# --- fingerprint cache (server mode) -----------------------------------------------
# bw_id -> (signature, meta). A cached fingerprint is reused while the object's
# signature holds and the depsgraph has not reported a geometry update for it.
FINGERPRINTS = {}
DIRTY_OBJECTS, DIRTY_MESHES = set(), set()
TRACKING = False


def geometry_signature(obj):
    data = obj.data
    return (data.name, len(data.vertices), len(data.polygons),
            tuple((m.name, m.type, m.show_viewport) for m in obj.modifiers))


@bpy.app.handlers.persistent
def _track_updates(scene, depsgraph):
    for update in depsgraph.updates:
        if not update.is_updated_geometry:
            continue
        idb = getattr(update.id, "original", update.id)
        if isinstance(idb, bpy.types.Object):
            DIRTY_OBJECTS.add(idb.name)
        elif isinstance(idb, bpy.types.Mesh):
            DIRTY_MESHES.add(idb.name)


@bpy.app.handlers.persistent
def _forget(*_args):
    FINGERPRINTS.clear()
    DIRTY_OBJECTS.clear()
    DIRTY_MESHES.clear()


def fingerprint(obj, entity_id_, known, depsgraph):
    """meta (with hash) for obj, writing mesh data when the caller lacks it."""
    signature = geometry_signature(obj)
    cached = FINGERPRINTS.get(entity_id_)
    clean = (TRACKING and cached is not None and cached[0] == signature
             and obj.name not in DIRTY_OBJECTS and obj.data.name not in DIRTY_MESHES)
    if clean and known.get(entity_id_) == cached[1]["hash"]:
        return cached[1], False
    payload = mesh_payload(obj, depsgraph)
    if not payload:
        FINGERPRINTS.pop(entity_id_, None)
        return None, False
    meta, data = payload
    FINGERPRINTS[entity_id_] = (signature, meta)
    if known.get(entity_id_) == meta["hash"]:
        return meta, False
    with open(f"{OUT}/geo/{entity_id_}.bin", "wb") as handle:
        handle.write(data)
    return meta, True


# --- a request -------------------------------------------------------------------
def handle(job, out, save):
    global OUT
    OUT = out
    LOG.clear()
    CONFLICTS.clear()
    MISSING.clear()
    os.makedirs(f"{OUT}/geo", exist_ok=True)
    timings = {}
    started = time.perf_counter()

    handlers = handlers_for(job)
    by_id = objects_by_id()
    for cmd in job.get("commands", []):
        handlers[cmd["op"]](cmd, by_id)
    timings["commands"] = time.perf_counter() - started

    if job.get("script"):
        exec(compile(job["script"], "<script>", "exec"), {"__name__": "__main__", "bpy": bpy})
    timings["script"] = time.perf_counter() - started

    depsgraph = bpy.context.evaluated_depsgraph_get()
    known = job.get("known", {})
    entities, geometry, used = {}, {}, set()
    for obj in bpy.context.scene.objects:
        entity = read_entity(obj)
        used.update(m for m in entity["materials"] if m)
        if obj.type == "MESH" and job.get("reportGeometry", True):
            meta, written = fingerprint(obj, entity["id"], known, depsgraph)
            if meta:
                entity["geometry"] = meta["hash"]
                if written:
                    geometry[entity["id"]] = meta
        entities[entity["id"]] = entity
    DIRTY_OBJECTS.clear()
    DIRTY_MESHES.clear()
    timings["report"] = time.perf_counter() - started

    materials = {name: read_material(bpy.data.materials[name]) for name in used if name in bpy.data.materials}
    if save:
        bpy.ops.wm.save_as_mainfile(filepath=f"{OUT}/session.blend", check_existing=False, copy=True)
    timings["save"] = time.perf_counter() - started
    json.dump({"entities": entities, "materials": materials, "geometry": geometry,
               "conflicts": CONFLICTS, "missing": MISSING, "log": LOG, "timings": timings,
               "blender": bpy.app.version_string}, open(f"{OUT}/report.json", "w"))


# --- server mode -----------------------------------------------------------------
REQUEST = "/ipc/request.json"


def load(spec):
    """Replace the session: a staged .blend, Blender's startup scene, or an empty one."""
    if spec["kind"] == "blend":
        bpy.ops.wm.open_mainfile(filepath=spec["path"], load_ui=False)
    else:
        # The server started with --factory-startup, so the home file is the
        # factory scene; read_factory_settings would also reset preferences and
        # re-register every add-on (slow, and noisy tracebacks).
        bpy.ops.wm.read_homefile(use_empty=spec["kind"] == "empty", load_ui=False)
    _forget()


def poll():
    """One server step: handles the pending request, if there is one. True if it did."""
    if not os.path.exists(REQUEST):
        return False
    request = json.load(open(REQUEST))
    os.remove(REQUEST)
    # One request at a time, and /out is where a one-shot run (and so any
    # job script) writes its files: start each request with it empty. The
    # host collects everything under it after BW_DONE.
    out = "/out"
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    try:
        if request.get("load"):
            load(request["load"])
        handle(request["job"], out, save=request.get("save", False))
    except BaseException:
        json.dump({"error": traceback.format_exc()}, open(f"{out}/report.json", "w"))
    print(f"<<<BW_DONE {request['id']}>>>", flush=True)
    return True


def serve():
    global TRACKING
    TRACKING = True
    bpy.app.handlers.depsgraph_update_post.append(_track_updates)
    bpy.app.handlers.load_post.append(_forget)
    print("<<<BW_READY>>>", flush=True)
    if os.environ.get("BLENDER_WASM_POLL"):
        # Single-threaded build: Blender's main runs BLENDER_WASM_POLL
        # (`__bw_poll__()`) between JSPI sleeps, which hand the thread back to
        # the worker's event loop. Return so the script ends and that loop starts.
        import builtins
        builtins.__bw_poll__ = poll
        return
    while True:
        if not poll():
            time.sleep(0.001)


if globals().get("BW_SERVER"):
    serve()
else:
    handle(json.load(open("/job/project.json")), "/out", save=True)
