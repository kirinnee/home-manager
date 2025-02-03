{ lib
, fetchurl
, _7zz
, stdenvNoCC
, xattr
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "beekeeper-studio";
  version = "5.0.9";


  src = fetchurl {
    name = "Beekeeper-Studio.dmg";
    url = "https://github.com/beekeeper-studio/beekeeper-studio/releases/download/v${finalAttrs.version}/Beekeeper-Studio-${finalAttrs.version}-arm64.dmg";
    hash = "sha256:1a6h6xdbjzxdciir54py63p8d9d86z2193qfi8ai1gws6y3ysi95";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [ _7zz ];

  sourceRoot = "Beekeeper Studio.app";

  installPhase = ''
    runHook preInstall

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
