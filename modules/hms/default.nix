{ trivialBuilders, nixpkgs ? import <nixpkgs> { } }:

let
  version = "1.0.0";

  # Create a package that provides all three scripts
  package = nixpkgs.symlinkJoin {
    name = "hms-${version}";
    paths = [
      (trivialBuilders.writeShellApplicationWithoutCheck {
        name = "hms";
        inherit version;
        runtimeShell = "${nixpkgs.bash}/bin/bash";
        runtimeInputs = with nixpkgs; [ home-manager ];
        text = builtins.readFile ./bin/hms;
      })
      (trivialBuilders.writeShellApplicationWithoutCheck {
        name = "hmsz";
        inherit version;
        runtimeShell = "${nixpkgs.bash}/bin/bash";
        text = builtins.readFile ./bin/hmsz;
      })
      (trivialBuilders.writeShellApplicationWithoutCheck {
        name = "nix-init";
        inherit version;
        runtimeShell = "${nixpkgs.bash}/bin/bash";
        text = builtins.readFile ./bin/nix-init;
      })
    ];
  };
in
package
