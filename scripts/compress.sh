#!/usr/bin/env bash
# Compress runtime artifacts for shipping.
#
#   bash scripts/compress.sh <file> [more...]
#
# Writes <file>.zst when COMPRESS_ZSTD=1 (default), and <file>.br when
# COMPRESS_BROTLI=1 (default) and `brotli` is installed. Originals are left in
# place.
#
#   .zst  what the Node runtime reads, via node:zlib (22.15+). Level ZSTD_LEVEL (default 21, --ultra).
#         Levels above 21 raise the window past 64 MB, which zstddec and some
#         decoders refuse; keep 21 unless every consumer is known to cope.
#   .br   for serving over HTTP with `Content-Encoding: br`, which every
#         browser decodes natively with no JS decoder. Quality BROTLI_QUALITY
#         (default 11), window 24 (the largest browsers accept).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[ $# -ge 1 ] || die "usage: compress.sh <file> [more...]"
COMPRESS_ZSTD="${COMPRESS_ZSTD:-1}"
[ "$COMPRESS_ZSTD" = 0 ] || command -v zstd >/dev/null || die "zstd not installed"

ZSTD_LEVEL="${ZSTD_LEVEL:-21}"
BROTLI_QUALITY="${BROTLI_QUALITY:-11}"
COMPRESS_BROTLI="${COMPRESS_BROTLI:-1}"
if [ "$COMPRESS_BROTLI" = 1 ] && ! command -v brotli >/dev/null; then
  log "brotli not installed — skipping .br (brew install brotli / apt install brotli)"
  COMPRESS_BROTLI=0
fi

mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }
size() { wc -c < "$1" | tr -d ' '; }

for file in "$@"; do
  [ -f "$file" ] || die "no such file: $file"
  raw=$(size "$file")
  line="$(basename "$file"): $(mb "$raw") ->"
  if [ "$COMPRESS_ZSTD" = 1 ]; then
    zstd -q -f --ultra -"$ZSTD_LEVEL" -T0 "$file" -o "$file.zst"
    line="$line zst $(mb "$(size "$file.zst")")"
  fi
  if [ "$COMPRESS_BROTLI" = 1 ]; then
    brotli -f -q "$BROTLI_QUALITY" -w 24 -o "$file.br" "$file"
    line="$line br $(mb "$(size "$file.br")")"
  fi
  log "$line"
done
