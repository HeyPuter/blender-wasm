#!/usr/bin/env bash
# Package a linked (and optionally optimised) build into dist/.
#
#   bash scripts/package.sh node      # dist/blender-wasm-node/      + .tar
#   bash scripts/package.sh browser   # dist/blender-wasm-browser/   + .tar
#   bash scripts/package.sh web       # dist/blender-web.tar.gz (the demo site)
#
# node / browser packages are self-contained runtimes:
#   blender.js            emscripten glue (createBlenderModule factory), unmodified:
#                         pthread workers load this exact file
#   blender.wasm.br|.zst  the module (browser: .br, node: .zst)
#   blender.data.br|.zst  preloaded scripts, datafiles, CPython stdlib, numpy
#   manifest.json         sizes and sha256 (compressed and raw), and the exact
#                         sources it was built from
#   LICENSE               GPL-3.0-or-later: Blender as a whole (its sources are
#                         GPL-2.0-or-later; Apache-2.0 dependencies make the binary GPL-3)
# The browser runtime ships inside the npm package @knervous/blender-web
# (packages/blender-web, whose build copies it into runtime/).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

FLAVOR="${1:-}"
case "$FLAVOR" in node|browser|browser-st|web) ;; *) die "usage: package.sh node|browser|browser-st|web" ;; esac

FORK_REV="$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)"
BLENDER_REV="$(git -C "$BLENDER_SRC" rev-parse HEAD 2>/dev/null || echo unknown)"
mkdir -p "$DIST"

if [ "$FLAVOR" = web ]; then
  [ -f "$ROOT/demo/public/blender.wasm.zst" ] || die "no release link in demo/public — run ./build.sh web first"
  ( cd "$ROOT/demo" && { [ -d node_modules ] || npm ci || npm install; } && npm run build )
  # Static hosts cap file sizes (Cloudflare Pages: 25 MiB). Files over 24 MiB
  # go up in parts, listed in manifest.json, which the page joins (fetchZst).
  python3 - "$ROOT/demo/dist" <<'PY'
import json, os, sys
dist = sys.argv[1]
limit = 24 * 1024 * 1024
manifest_path = os.path.join(dist, "manifest.json")
manifest = json.load(open(manifest_path))
parts, part_bytes = {}, {}
for name in sorted(os.listdir(dist)):
    path = os.path.join(dist, name)
    if not os.path.isfile(path) or os.path.getsize(path) <= limit:
        continue
    data = open(path, "rb").read()
    names = []
    for i in range(0, len(data), limit):
        part = f"{name}.part{i // limit}"
        open(os.path.join(dist, part), "wb").write(data[i:i + limit])
        names.append(part)
    os.remove(path)
    parts[name], part_bytes[name] = names, len(data)
    print(f"split {name} ({len(data) / 1048576:.1f} MB) into {len(names)} parts")
if parts:
    manifest["parts"], manifest["partBytes"] = parts, part_bytes
    json.dump(manifest, open(manifest_path, "w"), indent=2)
PY
  out="$DIST/blender-web-$FORK_REV.tar.gz"
  tar -C "$ROOT/demo" -czf "$out" dist
  log "packaged $out ($(du -h "$out" | cut -f1))"
  exit 0
fi

SRC="$ROOT/$FLAVOR"
for f in blender.js blender.wasm blender.data; do
  [ -f "$SRC/$f" ] || die "missing $SRC/$f — run ./build.sh $FLAVOR first"
done

PKG="$DIST/blender-wasm-$FLAVOR"
rm -rf "$PKG"; mkdir -p "$PKG"
cp "$SRC/blender.js" "$PKG/"
cp "$SRC/blender.wasm" "$SRC/blender.data" "$PKG/"
if [ "$FLAVOR" != node ]; then
  # Brotli only: browsers decode it natively (Content-Encoding: br) and Node's
  # zlib inflates it at install time.
  COMPRESS_ZSTD=0 bash "$ROOT/scripts/compress.sh" "$PKG/blender.wasm" "$PKG/blender.data"
else
  COMPRESS_BROTLI=0 bash "$ROOT/scripts/compress.sh" "$PKG/blender.wasm" "$PKG/blender.data"
fi
cp "$BLENDER_SRC/doc/license/GPL3-license.txt" "$PKG/LICENSE"

if [ "$FLAVOR" = node ]; then
  # The glue is CommonJS and references its own filename when spawning pthread
  # workers, so it cannot be renamed to .cjs; scope CommonJS to this directory.
  cat > "$PKG/package.json" <<JSON
{
  "name": "@knervous/blender-web-runtime-node",
  "version": "0.0.0-$FORK_REV",
  "private": true,
  "license": "GPL-3.0-or-later",
  "type": "commonjs"
}
JSON
fi

python3 - "$PKG" "$FLAVOR" "$FORK_REV" "$BLENDER_REV" "$EMSDK_VERSION" "${WASM_OPT_LEVEL:-none}" <<'PY'
import hashlib, json, os, sys
pkg, flavor, fork, blender, emsdk, opt = sys.argv[1:]
digest = lambda data: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
files, raw = {}, {}
for name in sorted(os.listdir(pkg)):
    path = os.path.join(pkg, name)
    if name in ("manifest.json", "package.json") or not os.path.isfile(path):
        continue
    data = open(path, "rb").read()
    if name in ("blender.wasm", "blender.data"):
        raw[name] = digest(data)
    else:
        files[name] = digest(data)
json.dump({
    "flavor": flavor,
    "forkRevision": fork,
    "blenderRevision": blender,
    "emsdk": emsdk,
    "wasmOpt": opt,
    "files": files,
    "raw": raw,
}, open(os.path.join(pkg, "manifest.json"), "w"), indent=2)
PY
rm -f "$PKG/blender.wasm" "$PKG/blender.data"

out="$DIST/blender-wasm-$FLAVOR-$FORK_REV.tar"
tar -C "$DIST" -cf "$out" "blender-wasm-$FLAVOR"
log "packaged $PKG and $out ($(du -h "$out" | cut -f1)); npm: packages/blender-web (npm run build)"
