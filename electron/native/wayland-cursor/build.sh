#!/usr/bin/env bash
# Builds the Wayland cursor/click monitor and screen capture helpers used on
# Linux Wayland sessions.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../bin/linux-x64/recordly-wayland-cursor"
gen="$here/build"
proto="$(pkg-config --variable=pkgdatadir wayland-protocols)"
mkdir -p "$gen" "$(dirname "$out")"
for xml in \
	"$proto/staging/ext-image-capture-source/ext-image-capture-source-v1.xml" \
	"$proto/staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml" \
	"$proto/staging/ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1.xml" \
	"$proto/unstable/xdg-output/xdg-output-unstable-v1.xml"; do
	name="$(basename "$xml" .xml)"
	wayland-scanner client-header "$xml" "$gen/$name-client.h"
	wayland-scanner private-code "$xml" "$gen/$name.c"
done
cc -O2 -Wall -I"$gen" -o "$out" "$here/main.c" "$gen"/*.c $(pkg-config --cflags --libs wayland-client)
echo "built $out"
capture="$here/../bin/linux-x64/recordly-wayland-capture"
cc -O2 -Wall -I"$gen" -o "$capture" "$here/../wayland-capture/main.c" "$gen"/*.c $(pkg-config --cflags --libs wayland-client)
echo "built $capture"
