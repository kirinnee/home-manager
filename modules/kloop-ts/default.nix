{ nixpkgs ? import <nixpkgs> { } }:

let
  version = "3.1.0-dev-2";
  pname = "kloop";

in
nixpkgs.stdenv.mkDerivation {
  inherit pname version;
  src = ./.;

  nativeBuildInputs = [ nixpkgs.bun nixpkgs.makeWrapper ];

  installPhase = ''
    mkdir -p $out/lib/kloop
    mkdir -p $out/bin

    cp dist/index.js $out/lib/kloop/
    cp package.json $out/package.json

    makeWrapper ${nixpkgs.bun}/bin/bun $out/bin/kloop \
      --add-flags "$out/lib/kloop/index.js"
  '';

  meta = {
    description = "Spec-driven development loop with multi-reviewer consensus";
    mainProgram = "kloop";
  };
}
