# Pi configuration

Portable Pi configuration managed as a Stow package.

## Install

From this directory:

```bash
./install.sh
```

This links the tracked files into `~/.pi/agent`. If files already exist there,
Stow will refuse to overwrite them. To back up and replace conflicting files:

```bash
./install.sh --overwrite
```

Backups are stored under `~/.pi-config-backups/`. Credentials, sessions,
caches, and installed npm package contents are never touched.

After installing on a new machine, authenticate separately with `/login` and
install/update the packages listed in `settings.json` as needed.

## Update

Edit the linked files in `~/.pi/agent` or this repository; they are the same
files. Commit and push changes:

```bash
git add .
git commit -m "Update Pi config"
git push
```
