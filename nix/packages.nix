{ pkgs, atomi, pkgs-2505, pkgs-unstable }:
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
    nix-2505 = (
      with pkgs-2505;
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
nix-2505 //
nix-unstable //
atomipkgs
