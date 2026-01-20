{ pkgs, atomi, pkgs-2511, pkgs-unstable }:
let

  all = {
    atomipkgs = (
      with atomi;
      {
        inherit
          atomiutils
          sg
          pls;
      }
    );
    nix-unstable = (
      with pkgs-unstable;
      { }
    );
    nix-2511 = (
      with pkgs-2511;
      {
        inherit
          gomplate
          infisical

          git
          gitlint
          treefmt
          shellcheck
          ;
      }
    );
  };
in
with all;
nix-2511 //
nix-unstable //
atomipkgs
