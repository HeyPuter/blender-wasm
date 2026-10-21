#!/usr/bin/env bash
# Kept for existing callers: the headless relink now lives in
# link_blender_headless.sh, shared by the node and browser targets.
exec env TARGET=node bash "$(dirname "${BASH_SOURCE[0]}")/link_blender_headless.sh" "$@"
