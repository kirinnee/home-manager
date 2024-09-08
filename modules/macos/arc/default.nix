{ lib
, stdenvNoCC
, fetchurl
, undmg
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "arc";
  version = "1.59.0-53388";
  src = fetchurl {
    name = "Arc.dmg";
    url = "https://releases.arc.net/release/Arc-${finalAttrs.version}.dmg";
    hash = "sha256:1arsvg2k6dwg54gii691k1cdgv9vh54lyf0inplrc0xzg7471nsq";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [ undmg ];

  sourceRoot = "Arc.app";

  installPhase = ''
    runHook preInstall

    mkdir -p $out/Applications/Arc.app
    cp -R . $out/Applications/Arc.app

    runHook postInstall
  '';

  meta = with lib; {
    description = "A browser that doesn’t just meet your needs — it anticipates them";
    homepage = "https://arc.net/";
    license = with licenses; [ unfree ];
    sourceProvenance = with sourceTypes; [ binaryNativeCode ];
    maintainers = with maintainers; [ ];
    platforms = [ "aarch64-darwin" "x86_64-darwin" ];
  };
})
