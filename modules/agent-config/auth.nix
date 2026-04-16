rec {
  proxy = {
    baseUrl = "http://127.0.0.1:8317";
    token = "\"$API_CLI_PROXY_TOKEN\"";
  };

  providers = {
    zai = {
      opus = "glm-5-turbo";
      sonnet = "glm-4.7";
      haiku = "glm-4.5-air";
      models = [
        { id = "glm-5.1"; name = "glm51"; sonnet = "glm-5-turbo"; haiku = "glm-4.7"; }
        { id = "glm-5"; name = "glm5"; sonnet = "glm-5-turbo"; haiku = "glm-4.7"; }
        { id = "glm-5-turbo"; name = "glm5turbo"; }
        { id = "glm-4.7"; name = "glm47"; }
        { id = "glm-4.6"; name = "glm46"; }
        { id = "glm-4.5-air"; name = "glm45air"; }
      ];
    };
    anthropic = {
      opus = "claude-opus-4-6";
      sonnet = "claude-sonnet-4-6";
      haiku = "claude-haiku-4-5-20251001";
      models = [
        { id = "claude-opus-4-6"; name = "opus46"; }
        { id = "claude-sonnet-4-6"; name = "sonnet46"; }
        { id = "claude-haiku-4-5-20251001"; name = "haiku45"; }
      ];
    };
    openai = {
      opus = "gpt-5.4";
      sonnet = "gpt-5.4";
      haiku = "gpt-5.4-mini";
      models = [
        { id = "gpt-5.4"; name = "gpt54"; }
        { id = "gpt-5.3-codex"; name = "gpt53codex"; }
        { id = "gpt-5.4-mini"; name = "gpt54mini"; }
      ];
    };
    kimi = {
      opus = "kimi-k2.5";
      sonnet = "kimi-k2.5";
      haiku = "kimi-k2.5";
      models = [
        { id = "kimi-k2.5"; name = "kimi"; }
      ];
    };
    friendli = {
      opus = "zai-org/GLM-5.1";
      sonnet = "zai-org/GLM-4.7";
      haiku = "MiniMaxAI/MiniMax-M2.5";
      models = [
        { id = "zai-org/GLM-5.1"; name = "glm51-friendli"; }
        { id = "zai-org/GLM-5"; name = "glm5-friendli"; }
        { id = "zai-org/GLM-4.7"; name = "glm47-friendli"; }
        { id = "MiniMaxAI/MiniMax-M2.5"; name = "mm25-friendli"; }
      ];
    };
    fireworks = {
      opus = "accounts/fireworks/routers/kimi-k2p5-turbo";
      sonnet = "accounts/fireworks/routers/kimi-k2p5-turbo";
      haiku = "accounts/fireworks/routers/kimi-k2p5-turbo";
      models = [
        { id = "accounts/fireworks/routers/kimi-k2p5-turbo"; name = "kimi-fireworks"; }
      ];
    };
    seed = {
      opus = "doubao-seed-2.0-pro";
      sonnet = "doubao-seed-2.0-code";
      haiku = "doubao-seed-2.0-lite";
      models = [
        { id = "doubao-seed-2.0-pro"; name = "seed2pro"; }
        { id = "doubao-seed-2.0-code"; name = "seed2code"; }
        { id = "doubao-seed-2.0-lite"; name = "seed2lite"; }
      ];
    };
    mm = {
      opus = "minimax-m2.7";
      sonnet = "minimax-m2.7";
      haiku = "minimax-m2.7";
      models = [
        { id = "minimax-m2.7"; name = "mm27"; }
        { id = "MiniMax-M2.5"; name = "mm25"; }
      ];
    };
    samba = {
      opus = "mm25";
      sonnet = "mm25";
      haiku = "mm25";
      models = [
        { id = "mm25"; name = "mm25-samba"; }
      ];
    };
    cerebras = {
      opus = "zai-glm-4.7";
      sonnet = "zai-glm-4.7";
      haiku = "zai-glm-4.7";
      models = [
        { id = "zai-glm-4.7"; name = "cerebras-glm47"; }
      ];
    };
  };

  # Claude uses Anthropic-compatible env vars
  # opus/sonnet/haiku: when set, override the provider's default for that slot
  mkClaudeEnv = provider: { opus ? null, sonnet ? null, haiku ? null }:
    let
      p = providers.${provider};
    in
    {
      ANTHROPIC_BASE_URL = proxy.baseUrl;
      ANTHROPIC_AUTH_TOKEN = proxy.token;
      ANTHROPIC_DEFAULT_OPUS_MODEL = if opus != null then opus else p.opus;
      ANTHROPIC_DEFAULT_SONNET_MODEL = if sonnet != null then sonnet else p.sonnet;
      ANTHROPIC_DEFAULT_HAIKU_MODEL = if haiku != null then haiku else p.haiku;
    };

  # Codex uses OpenAI-compatible env vars (reads OPENAI_API_KEY at runtime)
  mkCodexEnv = provider: {
    OPENAI_API_KEY = proxy.token;
    OPENAI_BASE_URL = proxy.baseUrl;
  };

  # Gemini uses GEMINI_API_KEY (placeholder until user adds key)
  mkGeminiEnv = _: {
    GEMINI_API_KEY = proxy.token;
  };

  # OpenCode uses OPENAI_API_KEY for OpenAI-compatible endpoints
  mkOpencodeEnv = provider: {
    OPENAI_API_KEY = proxy.token;
  };

  # Convenience: all provider names
  providerNames = builtins.attrNames providers;
}
