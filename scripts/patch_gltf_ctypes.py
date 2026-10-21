#!/usr/bin/env python3
"""Guard the glTF addon's ctypes-dependent imports in the staged asset tree.

This CPython is cross-compiled without libffi, so `_ctypes` does not exist. The
glTF addon imports draco/meshopt at module scope (blender/exp/export.py line 14
and friends), which pulls in ctypes and makes `export_scene.gltf` fail outright
with ModuleNotFoundError before it exports anything.

Both are compression extensions, both are disabled in this build
(WITH_DRACO=OFF, WITH_MESHOPTIMIZER=OFF), and both are only ever *called* behind
`if export_settings['gltf_draco_mesh_compression']`. So guarding the import is
semantically correct rather than papering over a missing capability: the code
paths that would use them are unreachable here.

Only the staged copy is modified; blender/ in the source tree is untouched.

Usage: patch_gltf_ctypes.py <stage-dir>
"""
import pathlib
import re
import sys

TARGET = re.compile(
    r"^(?P<indent>[ \t]*)"
    r"(?P<stmt>from\s+\S+\s+import\s+(?:draco|meshopt)\s+as\s+\w+"
    r"|import\s+ctypes"
    r"|from\s+ctypes\s+import\s+\*)"
    r"[ \t]*$",
    re.MULTILINE,
)


def guard(match: re.Match) -> str:
    indent = match.group("indent")
    stmt = match.group("stmt")
    return (
        f"{indent}try:\n"
        f"{indent}    {stmt}\n"
        f"{indent}except ImportError:  # libffi-less CPython; draco/meshopt disabled\n"
        f"{indent}    pass"
    )


# Upstream bug in io/com/library.py: dll_exists() correctly treats a missing
# library as `path is None`, but the *error message* in the else branch calls
# path.absolute() unconditionally — so it raises AttributeError exactly when the
# library is absent. Draco is absent in this build (WITH_DRACO=OFF), so the
# addon's is_draco_available() probe crashes before any export happens.
DLL_MESSAGE_BUG = "path.absolute())"
DLL_MESSAGE_FIX = '(path.absolute() if path is not None else "<not found>"))'


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    root = pathlib.Path(sys.argv[1]) / "5.3" / "scripts" / "addons_core" / "io_scene_gltf2"
    if not root.is_dir():
        print(f"patch_gltf_ctypes: {root} not found", file=sys.stderr)
        return 1

    patched = []
    for path in sorted(root.rglob("*.py")):
        text = path.read_text(encoding="utf8")
        rewritten = TARGET.sub(guard, text)
        if path.name == "library.py" and DLL_MESSAGE_BUG in rewritten:
            # Only the else-branch occurrence is unguarded; the success branch
            # is already inside `if exists:` so path cannot be None there.
            head, _, tail = rewritten.rpartition(DLL_MESSAGE_BUG)
            rewritten = head + DLL_MESSAGE_FIX + tail
        if rewritten != text:
            path.write_text(rewritten, encoding="utf8")
            patched.append(path.relative_to(root).as_posix())

    print(f">>   patched {len(patched)} glTF addon file(s) for ctypes-less CPython")
    for name in patched:
        print(f">>     {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
