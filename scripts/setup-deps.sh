#!/usr/bin/env bash
#
# Installs the Solidity dependencies at EXACT revisions.
#
# Why a script and not git submodules: this repo is published from a .zip, and a zip
# cannot carry a gitlink — the submodule entry (mode 160000) simply does not exist
# outside a git tree. A `.gitmodules` without the gitlinks is decorative:
# `git submodule update --init` does nothing.
#
# The revs below are the same ones development used. Without them, a bare
# `forge install` grabs each upstream's HEAD, and the build can break without anyone
# having changed a line here.
set -euo pipefail

cd "$(dirname "$0")/../contracts"

FORGE_STD_REV="bf647bd6046f2f7da30d0c2bf435e5c76a780c1b" # v1.16.2
SOLMATE_REV="89365b880c4f3c786bdd453d4b8e8fe410344a69"

if ! command -v forge >/dev/null 2>&1; then
  echo "forge not found. Install Foundry: https://book.getfoundry.sh/getting-started/installation" >&2
  exit 1
fi

# `--no-git` clones the libs without registering them as submodules — which is exactly
# what this repo wants: contracts/lib/ is gitignored here, the deps are installed, not
# versioned.
#
# There is no "is this a git repo?" check. There was one, and it was WRONG: it aborted
# with "run git init first" in a directory where `forge install --no-git` works
# perfectly. A guard whose only effect is to stop the user guards nothing.
# Verified: extract the zip into any directory, no git, run this — it works.

echo "installing forge-std @ ${FORGE_STD_REV:0:8}"
forge install "foundry-rs/forge-std@${FORGE_STD_REV}" --no-git

echo "installing solmate @ ${SOLMATE_REV:0:8}"
forge install "transmissions11/solmate@${SOLMATE_REV}" --no-git

echo
echo "done. verify with: cd contracts && forge build"
