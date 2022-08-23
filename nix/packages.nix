{ nixpkgs ? import <nixpkgs> { } }:
let
  pkgs = {
    atomi = (
      with import (fetchTarball "https://github.com/kirinnee/test-nix-repo/archive/refs/tags/v7.0.0.tar.gz");
      {
        inherit pls;
      }
    );
    "Unstable 11th August 2022" = (
      with import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/ebcea6302e4b221e79656f7a718f5cb55affde2f.tar.gz") { };
      {
        inherit
          pre-commit
          git
          shfmt
          shellcheck
          nixpkgs-fmt
          bash
          coreutils
          jq
          gnugrep;
        prettier = nodePackages.prettier;
      }
    );
  };
in
with pkgs;
pkgs.atomi // pkgs."Unstable 11th August 2022"
