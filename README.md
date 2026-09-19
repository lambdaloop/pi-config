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

On a completely new machine, install Pi and GNU Stow first, then clone this
repository:

```bash
# Install Pi using your normal Node/npm setup, then:
git clone git@github.com:lambdaloop/pi-config.git
cd pi-config
./install.sh
pi
```

Pi will install the missing npm packages listed in `settings.json` on first
startup (network access is required). Authenticate separately with `/login`.
The configured local-model entries only work if their servers are reachable
from the new machine.

Package specs are currently unpinned, so a new machine may receive newer
package releases. Pin the `npm:` entries if exact package reproducibility is
important.

## Update

Edit the linked files in `~/.pi/agent` or this repository; they are the same
files. Commit and push changes:

```bash
git add .
git commit -m "Update Pi config"
git push
```
