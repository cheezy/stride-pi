#!/usr/bin/env bash
# install.sh — Install Stride skills for Pi (https://github.com/badlogic/pi-mono)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cheezy/stride-pi/main/install.sh | bash
#
# Or clone and run locally:
#   ./install.sh
#
# Installs globally to ~/.pi/agent/ (Pi's auto-discovery root for all projects).
# Use --project to install into .pi/ in the current directory instead.

set -euo pipefail

REPO="https://github.com/cheezy/stride-pi.git"
GLOBAL_DIR="$HOME/.pi/agent"
MODE="global"

for arg in "$@"; do
  case "$arg" in
    --project) MODE="project" ;;
    --help|-h)
      echo "Usage: install.sh [--project]"
      echo ""
      echo "  (default)   Install globally to ~/.pi/agent/ (available in all projects)"
      echo "  --project   Install to .pi/ in the current directory"
      exit 0
      ;;
  esac
done

if [ "$MODE" = "project" ]; then
  INSTALL_DIR=".pi"
  echo "Installing Stride for Pi into .pi/ (project-local)..."
else
  INSTALL_DIR="$GLOBAL_DIR"
  echo "Installing Stride for Pi into ~/.pi/agent/ (global)..."
fi

# Create directories
mkdir -p "$INSTALL_DIR/skills"

# Clone to temp directory
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading from $REPO..."
if ! git clone --quiet --depth 1 "$REPO" "$TMPDIR/stride-pi"; then
  echo "Error: failed to clone $REPO" >&2
  echo "Verify git is installed and the repository is reachable." >&2
  exit 1
fi

# Copy skills (each skill is a directory with SKILL.md)
skill_count=$(find "$TMPDIR/stride-pi/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
echo "Installing $skill_count skills..."
for skill_dir in "$TMPDIR/stride-pi/skills"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name=$(basename "$skill_dir")
  # Skip placeholder directories (.gitkeep-only) that have no SKILL.md
  [ -f "$skill_dir/SKILL.md" ] || continue
  mkdir -p "$INSTALL_DIR/skills/$skill_name"
  cp "$skill_dir/SKILL.md" "$INSTALL_DIR/skills/$skill_name/SKILL.md"
done

# Copy AGENTS.md to project root if --project, or to global dir
if [ "$MODE" = "project" ]; then
  cp "$TMPDIR/stride-pi/AGENTS.md" ./AGENTS.md
  echo "Copied AGENTS.md to project root"
else
  cp "$TMPDIR/stride-pi/AGENTS.md" "$INSTALL_DIR/AGENTS.md"
  echo "Copied AGENTS.md to $INSTALL_DIR/"
  echo ""
  echo "Note: Copy AGENTS.md to each project that uses Stride (Pi walks up parent directories to find it):"
  echo "  cp ~/.pi/agent/AGENTS.md ./AGENTS.md"
fi

echo ""
echo "Stride for Pi installed successfully!"
echo ""
echo "Installed:"
echo "  Skills: $(find "$INSTALL_DIR/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') skills"
echo ""
echo "Next steps:"
echo "  1. Create .stride_auth.md with your API credentials (see README)"
echo "  2. Create .stride.md with your hook commands"
echo "  3. Add .stride_auth.md to .gitignore"
echo "  4. Invoke the stride-workflow skill to begin the task lifecycle"
