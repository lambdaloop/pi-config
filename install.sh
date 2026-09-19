#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./install.sh [--overwrite]

  --overwrite  Back up conflicting files, then replace them with Stow links.
EOF
}

overwrite=false
case "${1:-}" in
  "") ;;
  --overwrite|-f) overwrite=true ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

command -v stow >/dev/null 2>&1 || {
  printf 'stow is required but was not found\n' >&2
  exit 1
}

# Use the real directory behind ~/.pi when it is a symlink. This avoids GNU
# Stow path mismatches on systems where the home directory is symlinked.
target_root="$HOME"
if [[ -e "$HOME/.pi" ]]; then
  target_root=$(dirname -- "$(readlink -f "$HOME/.pi")")
fi

# Keep ~/.pi and ~/.pi/agent as real directories so Stow links individual
# tracked files instead of folding the entire ~/.pi directory into the repo.
mkdir -p "$target_root/.pi/agent"

if "$overwrite"; then
  backup_root="$target_root/.pi-config-backups/$(date +%Y%m%d-%H%M%S)"
  backed_up=false

  # Move only files supplied by this package; credentials and runtime state are
  # outside the package and are never touched.
  while IFS= read -r -d '' source; do
    relative=${source#"$repo_root/"}
    target="$target_root/$relative"
    if [[ -e "$target" || -L "$target" ]]; then
      mkdir -p "$backup_root/$(dirname -- "$relative")"
      mv -- "$target" "$backup_root/$relative"
      backed_up=true
    fi
  done < <(find "$repo_root/.pi" -type f -print0)

  if "$backed_up"; then
    printf 'Backed up conflicting files to %s\n' "$backup_root"
  fi
fi

# GNU Stow refuses to operate when the stow directory and the target
# directory are the same, so keep the package in a dedicated stow directory.
# The package entry is a symlink to this repo, which may live anywhere.
stow_root="$target_root/.dotfiles"
mkdir -p "$stow_root"
ln -sfn "$repo_root" "$stow_root/pi-config"

stow -d "$stow_root" -t "$target_root" pi-config
printf 'Pi configuration linked into %s/.pi/agent\n' "$HOME"
