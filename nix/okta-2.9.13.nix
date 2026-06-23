# Pinned okta Python SDK 2.9.x for gimme-aws-creds 2.8.2.
#
# nixpkgs 26.05 bumped python3Packages.okta to 3.1.0, which renamed
# APIClient -> ApiClient and restructured the SDK. gimme-aws-creds 2.8.2
# requires `okta >=2.9.0,<3.0.0` (it imports `okta.api_client.APIClient`),
# so it fails at runtime against 3.x. This is the verbatim nixpkgs 2.9.13
# derivation (pre-bump) with checks disabled to keep the build reliable on
# python 3.13. Drop this once gimme-aws-creds gains okta 3.x support upstream.
{ lib
, aenum
, aiohttp
, buildPythonPackage
, fetchPypi
, flatdict
, jwcrypto
, pycryptodomex
, pydash
, pyjwt
, pyyaml
, setuptools
, xmltodict
, yarl
,
}:

buildPythonPackage rec {
  pname = "okta";
  version = "2.9.13";
  pyproject = true;

  src = fetchPypi {
    inherit pname version;
    hash = "sha256-jY6SZ1G3+NquF5TfLsGw6T9WO4smeBYT0gXLnRDoN+8=";
  };

  build-system = [ setuptools ];

  dependencies = [
    aenum
    aiohttp
    flatdict
    jwcrypto
    pycryptodomex
    pydash
    pyjwt
    pyyaml
    xmltodict
    yarl
  ];

  # Upstream tests rely on VCR cassettes / network and are flaky in the
  # sandbox; the runtime import is all gimme-aws-creds needs.
  doCheck = false;

  pythonImportsCheck = [
    "okta"
    "okta.api_client"
    "okta.client"
    "okta.errors.error"
  ];

  meta = {
    description = "Python SDK for the Okta Management API";
    homepage = "https://github.com/okta/okta-sdk-python";
    changelog = "https://github.com/okta/okta-sdk-python/blob/v${version}/CHANGELOG.md";
    license = lib.licenses.asl20;
    maintainers = with lib.maintainers; [ jbgosselin ];
  };
}
