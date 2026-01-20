{ trivialBuilders, nixpkgs ? import <nixpkgs> { } }:

let name = "speak"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplicationWithoutCheck {
  inherit name version;
  runtimeShell = "${nixpkgs.bash}/bin/bash";
  runtimeInputs = (
    with nixpkgs;
    if stdenv.isDarwin then
      [ ]
    else
      [ espeak-ng ]
  );
  text = script;
}
