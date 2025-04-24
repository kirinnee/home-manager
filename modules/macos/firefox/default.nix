{ lib
, stdenvNoCC
, fetchurl
, undmg
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "firefox";
  version = "137.0.2";

  src = fetchurl {
    name = "Firefox.dmg";
    url = "https://download-installer.cdn.mozilla.net/pub/firefox/releases/${finalAttrs.version}/mac/en-US/Firefox%20${finalAttrs.version}.dmg";
    hash = "sha256:1m8yc0sxad0mg0lw2q1v10dfskcawsvk3kwvq2i9xjxx8wnr2f03";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [ undmg ];

  sourceRoot = "Firefox.app";

  installPhase = ''
    runHook preInstall

    mkdir -p $out/Applications/Firefox.app
    cp -R . $out/Applications/Firefox.app

    runHook postInstall
  '';

  meta = with lib; {
    description = "No shady privacy policies or back doors for advertisers. Just a lightning fast browser that doesn’t sell you out";
    homepage = "https://www.mozilla.org/en-US/firefox/new";
    license = with licenses; [ unfree ];
    sourceProvenance = with sourceTypes; [ binaryNativeCode ];
    maintainers = with maintainers; [ ];
    platforms = [ "aarch64-darwin" "x86_64-darwin" ];
  };
})
