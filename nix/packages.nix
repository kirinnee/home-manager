{ pkgs, atomi, pkgs-stable, pkgs-unstable }:
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
    nix-stable = (
      with pkgs-stable;
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
nix-stable //
nix-unstable //
atomipkgs
