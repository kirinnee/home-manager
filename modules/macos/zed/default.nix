{ lib
, stdenvNoCC
, fetchurl
, _7zz
, profile
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "zed";
  version = "0.132.3";

  src = fetchurl {
    name = "Zed.dmg";
    url = "https://github.com/zed-industries/zed/releases/download/v${finalAttrs.version}/Zed-${profile.arch}.dmg";
    hash = "sha256-Hz3gZiiWuPI5irnlNSjua68uZAl4O3KyoeEt+ZqSf+Q=";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [ _7zz ];

  sourceRoot = "Zed.app";

  installPhase = ''
    runHook preInstall

    mkdir -p $out/Applications/Zed.app
    cp -R . $out/Applications/Zed.app

    runHook postInstall
  '';

  meta = with lib; {
    description = "Code at the speed of thought";
    homepage = "https://zed.dev";
    license = with licenses; [ unfree ];
    sourceProvenance = with sourceTypes; [ binaryNativeCode ];
    maintainers = with maintainers; [  ];
    platforms = [ "aarch64-darwin" "x86_64-darwin" ];
  };
})
