{ pkgs ? import <nixpkgs> { } }:
pkgs.stdenv.mkDerivation {
  name = "okta-0.10.0";
  src = pkgs.fetchurl {
    url = "https://github.com/okta/okta-cli/releases/download/okta-cli-tools-0.10.0/okta-cli-macos-0.10.0-x86_64.zip";
    sha256 = "3a82e5dc6bfd7c6415706b92da8b61d04ea45d47373aece3acf7697fa3b25949";
  };
  nativeBuildInputs = [ pkgs.unzip ];
  buildInputs = [ pkgs.unzip ];
  phases = [ "installPhase" "patchPhase" ];
  installPhase = ''
    mkdir -p $out/bin
    cp $src $out/bin/okta
    chmod +x $out/bin/okta
  '';
}
