{ lib
, stdenvNoCC
, fetchurl
, undmg
, profile
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "aptakube";
  version = "1.7.4";

  src = fetchurl {
    name = "Aptakube.dmg";
    url = "https://github.com/aptakube/aptakube/releases/download/${finalAttrs.version}/Aptakube_${finalAttrs.version}_universal.dmg";
    hash = "sha256:07gjx8ba401mpjh24hw6z33ry2wndzvywfmssp1al3ircq560g0r";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [ undmg ];

  sourceRoot = "Aptakube.app";

  installPhase = ''
    runHook preInstall

    mkdir -p $out/Applications/Aptakube.app
    cp -R . $out/Applications/Aptakube.app

    runHook postInstall
  '';

  meta = with lib; {
    description = "Simplify your Kubernetes operation with a faster and easy to use desktop client.";
    homepage = "https://aptakube.com";
    license = with licenses; [ unfree ];
    sourceProvenance = with sourceTypes; [ binaryNativeCode ];
    maintainers = with maintainers; [ ];
    platforms = [ "aarch64-darwin" "x86_64-darwin" ];
  };
})
