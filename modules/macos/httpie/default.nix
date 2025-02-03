{ lib
, stdenvNoCC
, fetchurl
, undmg
, profile
}:

let
  r = {
    aarch64 = "-arm64";
    x86_64 = "";
  };
in

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "httpie";
  version = "2025.1.0";

  src = fetchurl {
    name = "HTTPie.dmg";
    url = "https://github.com/httpie/desktop/releases/download/v${finalAttrs.version}/HTTPie-${finalAttrs.version}${r."${profile.arch}"}.dmg";
    hash = "sha256:1652wynnpyjs8dzbg1fxm3cwzb3gby28jj4jcnrf85dfjf95j065";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [ undmg ];

  sourceRoot = "HTTPie.app";

  installPhase = ''
    runHook preInstall

    mkdir -p $out/Applications/HTTPie.app
    cp -R . $out/Applications/HTTPie.app

    runHook postInstall
  '';

  meta = with lib; {
    description = "HTTPie is making APIs simple and intuitive for those building the tools of our time.";
    homepage = "https://httpie.io";
    license = with licenses; [ unfree ];
    sourceProvenance = with sourceTypes; [ binaryNativeCode ];
    maintainers = with maintainers; [ ];
    platforms = [ "aarch64-darwin" "x86_64-darwin" ];
  };
})
