{ nixpkgs ? import <nixpkgs> { } }:

let
  version = "2.0.0";
  pname = "dev-loop";

in
nixpkgs.stdenv.mkDerivation {
  inherit pname version;
  src = ./.;

  nativeBuildInputs = [ nixpkgs.bun nixpkgs.makeWrapper ];

  # No build phase - we use bun's interpreter mode
  buildPhase = ''
    export HOME=$TMPDIR
    bun install --frozen-lockfile
  '';

  installPhase = ''
    mkdir -p $out/lib/dev-loop
    mkdir -p $out/bin

    # Copy source files and dependencies
    cp -r src $out/lib/dev-loop/
    cp package.json $out/lib/dev-loop/
    cp -r node_modules $out/lib/dev-loop/

    # Create wrapper script that runs bun in interpreter mode
    makeWrapper ${nixpkgs.bun}/bin/bun $out/bin/dev-loop \
      --add-flags "run $out/lib/dev-loop/src/index.ts"
  '';

  meta = {
    description = "Spec-driven development loop with multi-reviewer consensus";
    mainProgram = "dev-loop";
  };
}
