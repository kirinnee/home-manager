{ trivialBuilders, nixpkgs ? import <nixpkgs> { } }:

let
  version = "1.0.0";

  dev-loop = trivialBuilders.writeShellApplicationWithoutCheck {
    name = "dev-loop";
    inherit version;
    runtimeShell = "${nixpkgs.bash}/bin/bash";
    runtimeInputs = with nixpkgs; [ jq coreutils ];
    text = builtins.readFile ./dev-loop.sh;
  };

  dev-loop-init = trivialBuilders.writeShellApplicationWithoutCheck {
    name = "dev-loop-init";
    inherit version;
    runtimeShell = "${nixpkgs.bash}/bin/bash";
    runtimeInputs = with nixpkgs; [ jq coreutils ];
    text = builtins.readFile ./dev-loop-init.sh;
  };

  dev-loop-run = trivialBuilders.writeShellApplicationWithoutCheck {
    name = "dev-loop-run";
    inherit version;
    runtimeShell = "${nixpkgs.bash}/bin/bash";
    runtimeInputs = with nixpkgs; [ jq coreutils gnused util-linux ];
    text = builtins.readFile ./dev-loop-run.sh;
  };

  dev-loop-status = trivialBuilders.writeShellApplicationWithoutCheck {
    name = "dev-loop-status";
    inherit version;
    runtimeShell = "${nixpkgs.bash}/bin/bash";
    runtimeInputs = with nixpkgs; [ jq coreutils ];
    text = builtins.readFile ./dev-loop-status.sh;
  };

  dev-loop-cancel = trivialBuilders.writeShellApplicationWithoutCheck {
    name = "dev-loop-cancel";
    inherit version;
    runtimeShell = "${nixpkgs.bash}/bin/bash";
    runtimeInputs = with nixpkgs; [ jq coreutils ];
    text = builtins.readFile ./dev-loop-cancel.sh;
  };

  dev-loop-logs = trivialBuilders.writeShellApplicationWithoutCheck {
    name = "dev-loop-logs";
    inherit version;
    runtimeShell = "${nixpkgs.bash}/bin/bash";
    runtimeInputs = with nixpkgs; [ jq coreutils fzf less ];
    text = builtins.readFile ./dev-loop-logs.sh;
  };
in
nixpkgs.symlinkJoin {
  name = "dev-loop";
  paths = [
    dev-loop
    dev-loop-init
    dev-loop-run
    dev-loop-status
    dev-loop-cancel
    dev-loop-logs
  ];
}
