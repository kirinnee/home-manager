{ nixpkgs ? import <nixpkgs> { } }:

# Run-from-source (matches the active kautopilot line in modules/default.nix):
# a thin wrapper that execs `bun run` against the in-repo source. node_modules
# is installed locally with `bun install`; config is read from the live repo.
#
# Runtime tools khost shells out to (sops, age, cloudflared, coreutils) are put
# on PATH here; docker comes from OrbStack on the host PATH.
let
  runtimeDeps = with nixpkgs; [
    bun
    sops
    age
    cloudflared
    coreutils
  ];
in
nixpkgs.writeShellScriptBin "khost" ''
  export PATH="${nixpkgs.lib.makeBinPath runtimeDeps}:$PATH"
  exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/khost-ts/src/index.ts "$@"
''
