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

    NO_PULL=0
    if [ "''${1:-}" = "--no-pull" ]; then NO_PULL=1; shift; fi

    if [ "$#" -eq 0 ]; then
      echo "usage: kloge-deploy [--no-pull] <host> [host...]" >&2
      echo "  e.g. kloge-deploy box kirin@pebox" >&2
      echo "" >&2
      echo "  Pulls the loge pool from the LLM cluster, then for each host:" >&2
      echo "  build image -> push creds -> start container -> refresh ~/.secrets." >&2
      echo "  --no-pull reuses the pool already in ~/.kloge." >&2
      exit 64
    fi

    # nix profile first: non-interactive ssh gets a minimal PATH, and the system
    # docker (with its compose v2 plugin) must still win over nothing at all.
    REMOTE_PATH='export PATH="$HOME/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"'

    # 1. Refresh the pool from the cluster. Only this machine can: the LLM
    #    cluster authorizes the DevOps role and the boxes have no kubectl access.
    #    That asymmetry is the whole reason the pool travels by rsync.
    if [ "$NO_PULL" = "0" ]; then
      echo "==> pulling loge pool from the cluster"
      kloge pull
    else
      echo "==> skipping pull (--no-pull); using the pool already in ~/.kloge"
    fi

    # 2. Local container, so the Mac serves the same tokens it hands out.
    echo "==> [local] restarting CLIProxyAPI"
    kloge up

    for host in "$@"; do
      echo "==> [$host] building patched image"
      ssh "$host" "''${REMOTE_PATH}; cd ~/.config/home-manager && kloge build"

      echo "==> [$host] pushing auth + config + compose"
      # --no-up: with the patched tag, the default (start) path hard-fails.
      # Upstream is the source of truth: let the push drop remote-only creds.
      kloge push "$host" --no-up --yes

      echo "==> [$host] starting container"
      ssh "$host" "''${REMOTE_PATH}; cd ~/.kloge && docker compose up -d"

      # 3. THE STEP THAT IS EASY TO MISS. Pushing the pool updates ~/.kloge but
      #    NOT ~/.secrets: load-secrets only projects auth/claude-N.json into
      #    LOGE_CLAUDE_N_TOKEN during home-manager activation. Without this a
      #    rotated token reaches the box yet every claude-auto-loge* agent keeps
      #    authenticating with the previous one, which looks like a credential
      #    bug rather than a stale-activation one.
      echo "==> [$host] refreshing ~/.secrets (home-manager activation)"
      ssh "$host" "''${REMOTE_PATH}; cd ~/.config/home-manager && hms"

      echo "==> [$host] verifying"
      ssh "$host" "''${REMOTE_PATH}; docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | grep -i kloge || { echo 'NO kloge container on $host' >&2; exit 1; }"
      # Prove the tokens actually landed, rather than trusting that hms ran.
      # `grep -c` prints 0 AND exits 1 on no-match, so a naive `|| echo 0`
      # emits "0\n0" and the numeric test then dies on a two-line value.
      ssh "$host" "''${REMOTE_PATH}; n=\$( { grep -c LOGE_CLAUDE \"\$HOME/.secrets\" 2>/dev/null; true; } | head -1 ); s=\$( { grep -c LOGE_CLAUDE \"\$HOME/.config/home-manager/secrets.enc.yaml\" 2>/dev/null; true; } | head -1 ); n=\''${n:-0}; s=\''${s:-0}; echo \"    ~/.secrets: \$n loge token(s) | sops: \$s (must be 0)\"; [ \"\$n\" -gt 0 ] && [ \"\$s\" -eq 0 ]"
      echo "✓ $host"
    done

    echo ""
    echo "✓ all hosts deployed. NOTE: this machine's own ~/.secrets is refreshed"
    echo "  by \`hms\` (needs sudo on darwin), so run that separately if the pool changed."
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
