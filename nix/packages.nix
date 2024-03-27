{ pkgs, pkgs-2305, atomi, pkgs-feb-05-24 }:
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
    feb-05-24 = (
      with pkgs-feb-05-24;
      {
        inherit
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
feb-05-24
