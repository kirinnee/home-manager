{ pkgs, atomi, pkgs-2411 }:
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
    nix-2411 = (
      with pkgs-2411;
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
nix-2411 //
atomipkgs
