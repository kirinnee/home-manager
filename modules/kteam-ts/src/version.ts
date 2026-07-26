/** Single source of truth for the kteam version string.
 *
 *  Three copies used to drift independently — the CLI banner (index.ts), the
 *  daemon health payload (session-manager health()), and package.json — and in
 *  fact HAD drifted in-tree ('0.2.1' vs '0.2.0' vs '0.2.0') with nothing
 *  comparing them. Both the CLI and the daemon now import this constant, so the
 *  only way CLI and daemon disagree at runtime is a stale daemon process still
 *  executing an OLDER source tree after a deploy — which is exactly the skew the
 *  version exchange in api-client/api-server surfaces to the operator.
 *
 *  Bump the PATCH here whenever a change adds or alters a daemon route/command
 *  so a still-running old daemon can be recognised as stale. Keep package.json's
 *  `version` in step when you cut a release; this constant is what actually
 *  travels on the wire. */
export const KTEAM_VERSION = '0.2.1';
