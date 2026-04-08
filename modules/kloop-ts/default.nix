{ nixpkgs ? import <nixpkgs> { } }:

let
  version = "3.1.0-dev-2";
  pname = "kloop";

in
nixpkgs.stdenv.mkDerivation {
  inherit pname version;
  src = ./.;

  nativeBuildInputs = [ nixpkgs.bun nixpkgs.makeWrapper ];

  buildPhase = ''
    export HOME=$TMPDIR
    bun install --frozen-lockfile
  '';

  installPhase = ''
    mkdir -p $out/lib/kloop
    mkdir -p $out/bin

    cp -r src $out/lib/kloop/
    cp package.json $out/lib/kloop/
    cp -r node_modules $out/lib/kloop/

    makeWrapper ${nixpkgs.bun}/bin/bun $out/bin/kloop \
      --add-flags "run $out/lib/kloop/src/index.ts"
  '';

  meta = {
    description = "Spec-driven development loop with multi-reviewer consensus";
    mainProgram = "kloop";
  };
}
