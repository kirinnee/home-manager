{ nixpkgs }:
with nixpkgs;
let trivialBuilders = import ./trivialBuilders.nix { inherit lib stdenv stdenvNoCC lndir runtimeShell shellcheck; }; in
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
  # klaude: run-from-source wrapper. Wraps crc-kirin (Claude remote-control) in a
  # persistent zellij session. zellij is put on PATH; crc-kirin/fzf come from the
  # host PATH (crc-kirin is now a kfleet-generated command in ~/.kfleet/bin + user tooling).
  klaude = nixpkgs.writeShellScriptBin "klaude" ''
    export PATH="${nixpkgs.lib.makeBinPath [ nixpkgs.zellij ]}:$PATH"
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/klaude-ts/src/index.ts "$@"
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
