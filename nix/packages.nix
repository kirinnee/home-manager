{ pkgs, pkgs-2305, atomi, pkgs-240205 }:
let

  all = {
    atomipkgs = (
      with atomi;
      {
        inherit
          infisical
          pls;
      }
    );
    nix-2305 = (
      with pkgs-2305;
      { }
    );
    nix-240205 = (
      with pkgs-240205;
      {
        inherit
          gomplate
          coreutils
          gnugrep
          bash
          jq

          git

          treefmt
          shellcheck
          ;
      }
    );
  };
in
with all;
nix-2305 //
atomipkgs //
nix-240205
