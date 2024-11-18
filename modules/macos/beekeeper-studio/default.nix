{ lib
, fetchurl
, _7zz
, stdenvNoCC
, xattr
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "beekeeper-studio";
  version = "4.6.8";


  src = fetchurl {
    name = "Beekeeper-Studio.dmg";
    url = "https://github.com/beekeeper-studio/beekeeper-studio/releases/download/v${finalAttrs.version}/Beekeeper-Studio-${finalAttrs.version}-arm64.dmg";
    hash = "sha256:0z7772x0fdzw6kb05yl8vx7j3n24f19mamvwgjlp61i59m0f4xv0";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [ _7zz ];

  sourceRoot = "Beekeeper Studio.app";

  installPhase = ''
    runHook preInstall
    echo "hello"
    mkdir -p "$out/Applications/Beekeeper Studio.app"
    cp -R . "$out/Applications/Beekeeper Studio.app"
    ${xattr}/bin/xattr -c "$out/Applications/Beekeeper Studio.app"
    runHook postInstall
  '';

  meta = with lib; {
    description = "Modern and easy to use SQL client for MySQL, Postgres, SQLite, SQL Server, and more. Linux, MacOS, and Windows";
    homepage = "https://github.com/beekeeper-studio/beekeeper-studio";
    license = with licenses; [ unfree ];
    sourceProvenance = with sourceTypes; [ binaryNativeCode ];
    maintainers = with maintainers; [ ];
    platforms = [ "aarch64-darwin" ];
  };
})
