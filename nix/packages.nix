{ pkgs, atomi, pkgs-2505 }:
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
atomipkgs
