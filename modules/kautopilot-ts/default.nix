{ nixpkgs ? import <nixpkgs> { } }:

let
  version = "0.2.0";
  pname = "kautopilot";

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
    mkdir -p $out/lib/kautopilot
    mkdir -p $out/bin

    cp -r src $out/lib/kautopilot/
    cp package.json $out/lib/kautopilot/
    cp -r node_modules $out/lib/kautopilot/

    makeWrapper ${nixpkgs.bun}/bin/bun $out/bin/kautopilot \
      --add-flags "run $out/lib/kautopilot/src/index.ts"
  '';

  meta = {
    description = "End-to-end task completion from ticket to merge-ready PR";
    mainProgram = "kautopilot";
  };
}
