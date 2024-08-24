{ nixpkgs, profile }:
with nixpkgs;
rec {
  arc = import ./arc/default.nix { inherit lib stdenvNoCC fetchurl undmg; };
  firefox = import ./firefox/default.nix { inherit lib stdenvNoCC fetchurl undmg; };
  beekeeper-studio = import ./beekeeper-studio/default.nix { inherit lib stdenvNoCC fetchurl _7zz; xattr = darwin.xattr; };
  httpie = import ./httpie/default.nix { inherit lib stdenvNoCC fetchurl undmg profile; };
  zed = import ./zed/default.nix { inherit lib stdenvNoCC fetchurl _7zz profile; };
  aptakube = import ./aptakube/default.nix { inherit lib stdenvNoCC fetchurl undmg profile; };
}
