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

    # Defensive: kloop runs the .ts sources directly via Bun. A bare path src (./.)
    # copies untracked files into the store, so strip any stray compiled artifacts —
    # a locally-emitted .js must never shadow its .ts sibling in the packaged source
    # (a partially-regenerated default-prompts.js once leaked an unsubstituted
    # {scratchDir} into prompts and broke verdict detection).
    find src \( -name '*.js' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -delete
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
