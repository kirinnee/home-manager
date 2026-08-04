{ nixpkgs }:
with nixpkgs;
let
  trivialBuilders = import ./trivialBuilders.nix { inherit lib stdenv stdenvNoCC lndir runtimeShell shellcheck; };
in
rec {
  backup-folder = import ./backup-folder/default.nix { inherit nixpkgs trivialBuilders; };
  k8s-update = import ./k8s-update/default.nix { inherit nixpkgs trivialBuilders; };
  k8s-merge = import ./k8s-merge/default.nix { inherit nixpkgs trivialBuilders; };
  oci-oke-allow-my-ip = import ./oci-oke-allow-my-ip/default.nix { inherit nixpkgs trivialBuilders; };
  load-secrets = import ./load-secrets/default.nix { inherit nixpkgs trivialBuilders; };
  khost = import ./khost-ts/default.nix { inherit nixpkgs; };
  hms = import ./hms/default.nix { inherit trivialBuilders nixpkgs; };
  # Run-from-source (dynamic): a thin wrapper that execs `bun run` against the
  # in-repo source, so edits take effect immediately with no rebuild. Building it
  # as a derivation with `src = ./.` would copy kloop-ts (incl. node_modules) into
  # the store on every eval — slow. node_modules is installed locally via `bun install`.
  kloop = nixpkgs.writeShellScriptBin "kloop" ''
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/kloop-ts/src/index.ts "$@"
  '';
  kautopilot = nixpkgs.writeShellScriptBin "kautopilot" ''
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/kautopilot-ts/src/index.ts "$@"
  '';
  # kteam: detached, resumable Claude/Codex teammates. Every harness runs in
  # tmux while kteamd watches it and stores its protocol under ~/.kteam.
  kteam = nixpkgs.writeShellScriptBin "kteam" ''
    export PATH="${nixpkgs.lib.makeBinPath [ nixpkgs.tmux ]}:$PATH"
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/kteam-ts/src/index.ts "$@"
  '';
  kteamd = nixpkgs.writeShellScriptBin "kteamd" ''
    export PATH="${nixpkgs.lib.makeBinPath [ nixpkgs.tmux ]}:$PATH"
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/kteam-ts/src/daemon-entry.ts "$@"
  '';
  # kloge: pull the loge credential pool out of the LLM cluster and run
  # CLIProxyAPI in Docker (locally or pushed to a box). docker comes from
  # OrbStack on the host PATH; bash/git/jq/rsync/ssh/curl/coreutils are bundled here.
  kloge = nixpkgs.writeShellScriptBin "kloge" ''
    export PATH="${nixpkgs.lib.makeBinPath [ nixpkgs.bash nixpkgs.gitMinimal nixpkgs.jq nixpkgs.rsync nixpkgs.openssh nixpkgs.curl nixpkgs.coreutils ]}:$PATH"
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/kloge-ts/src/index.ts "$@"
  '';
  # kloge-deploy: one command to get a remote box onto the CURRENT patched image.
  #
  # `kloge push` deliberately refuses to move Docker images, and the default
  # image is a LOCALLY built tag (kloge-cliproxy:patched). So a bare
  # `kloge push <host>` aborts before transferring anything — leaving the box
  # with neither the image nor the refreshed credentials, while a stale
  # container keeps running unpatched upstream. That failure is silent enough
  # that all three hosts drifted for ~5 days.
  #
  # The only sequence that works is build-there, push --no-up, start-there.
  # This wraps it. Remote commands set PATH explicitly because a
  # non-interactive ssh does NOT get the nix profile (`kloge: not found`).
  kloge-deploy = nixpkgs.writeShellScriptBin "kloge-deploy" ''
    export PATH="${nixpkgs.lib.makeBinPath [ nixpkgs.bash nixpkgs.gitMinimal nixpkgs.jq nixpkgs.rsync nixpkgs.openssh nixpkgs.curl nixpkgs.coreutils ]}:$PATH"
    set -euo pipefail

    if [ "$#" -eq 0 ]; then
      echo "usage: kloge-deploy <host> [host...]     e.g. kloge-deploy box kirin@pebox" >&2
      exit 64
    fi

    # nix profile first: non-interactive ssh gets a minimal PATH, and the system
    # docker (with its compose v2 plugin) must still win over nothing at all.
    REMOTE_PATH='export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"'

    for host in "$@"; do
      echo "==> [$host] building patched image"
      ssh "$host" "''${REMOTE_PATH}; cd ~/.config/home-manager && kloge build"

      echo "==> [$host] pushing auth + config + compose"
      # --no-up: with the patched tag, the default (start) path hard-fails.
      kloge push "$host" --no-up

      echo "==> [$host] starting container"
      ssh "$host" "''${REMOTE_PATH}; cd ~/.kloge && docker compose up -d"

      echo "==> [$host] verifying"
      ssh "$host" "''${REMOTE_PATH}; docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -i kloge || { echo 'NO kloge container on $host' >&2; exit 1; }"
      echo "✓ $host"
    done

    echo "✓ all hosts deployed"
  '';
  # kfleet: run-from-source wrapper. Generates the claude/codex/gemini/opencode
  # account wrappers + config dirs from ~/.kfleet/config.yaml (replaces the old
  # Nix multi-* agent modules). Also generates `commands` (flag-prepended
  # executables like crc-kirin/yolo-kirin) into ~/.kfleet/bin. `kfleet apply`
  # after editing the config.
  kfleet = nixpkgs.writeShellScriptBin "kfleet" ''
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/kfleet-ts/src/index.ts "$@"
  '';
  # loctl: run-from-source wrapper (matches the old `loctl-wrapper` package, which
  # bundled no extra tools and relied on host PATH). Replaces the `loctl` flake
  # input — a `path:` input copied the whole 328MB checkout (node_modules + compiled
  # binaries) into the store on every eval. node_modules lives at the loctl checkout,
  # so bun resolves deps there; assets.ts resolves assets from the source tree.
  loctl = nixpkgs.writeShellScriptBin "loctl" ''
    exec ${nixpkgs.bun}/bin/bun run /Users/erng/Workspace/work/vungle/loctl/src/index.ts "$@"
  '';
}
