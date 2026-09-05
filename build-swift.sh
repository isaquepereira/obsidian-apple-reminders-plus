#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OBJC_SRC="$SCRIPT_DIR/objc/reminders-cli.m"
BIN_DIR="$SCRIPT_DIR/bin"
OUTPUT="$BIN_DIR/reminders-cli"

mkdir -p "$BIN_DIR"

echo "Compiling reminders-cli (Objective-C, universal x86_64 + arm64)..."

clang "$OBJC_SRC" \
  -o "$OUTPUT" \
  -O2 \
  -fobjc-arc \
  -arch x86_64 -arch arm64 \
  -mmacosx-version-min=11.0 \
  -framework Foundation \
  -framework EventKit \
  -framework AppKit

chmod +x "$OUTPUT"

echo "Built: $OUTPUT"
file "$OUTPUT"
