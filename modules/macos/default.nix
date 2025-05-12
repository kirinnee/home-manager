{ nixpkgs, profile }:
with nixpkgs;
rec {
  beekeeper-studio = import ./beekeeper-studio/default.nix { inherit lib stdenvNoCC fetchurl _7zz; xattr = darwin.xattr; };
}
