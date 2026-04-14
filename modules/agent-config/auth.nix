rec {
  proxy = {
    baseUrl = "http://127.0.0.1:8317";
    token = "\"$API_CLI_PROXY_TOKEN\"";
  };

  providers = {
    zai = { opus = "glm-5-turbo"; sonnet = "glm-4.7"; haiku = "glm-4.5-air"; };
    anthropic = { opus = "claude-opus-4-6"; sonnet = "claude-sonnet-4-6"; haiku = "claude-haiku-4-5-20251001"; };
    openai = { opus = "gpt-5.4"; sonnet = "gpt-5.4"; haiku = "gpt-5.4-mini"; };
    kimi = { opus = "kimi-k2.5"; sonnet = "kimi-k2.5"; haiku = "kimi-k2.5"; };
    friendli = { opus = "zai-org/GLM-5.1"; sonnet = "zai-org/GLM-4.7"; haiku = "MiniMaxAI/MiniMax-M2.5"; };
    fireworks = { opus = "accounts/fireworks/routers/kimi-k2p5-turbo"; sonnet = "accounts/fireworks/routers/kimi-k2p5-turbo"; haiku = "accounts/fireworks/routers/kimi-k2p5-turbo"; };
    seed = { opus = "doubao-seed-2.0-pro"; sonnet = "doubao-seed-2.0-code"; haiku = "doubao-seed-2.0-lite"; };
    mm = { opus = "minimax-m2.7"; sonnet = "minimax-m2.7"; haiku = "minimax-m2.7"; };
    cerebras = { opus = "zai-glm-4.7"; sonnet = "zai-glm-4.7"; haiku = "zai-glm-4.7"; };
  };

  # Claude uses Anthropic-compatible env vars
  mkClaudeEnv = provider: {
    ANTHROPIC_BASE_URL = proxy.baseUrl;
    ANTHROPIC_AUTH_TOKEN = proxy.token;
    ANTHROPIC_DEFAULT_OPUS_MODEL = providers.${provider}.opus;
    ANTHROPIC_DEFAULT_SONNET_MODEL = providers.${provider}.sonnet;
    ANTHROPIC_DEFAULT_HAIKU_MODEL = providers.${provider}.haiku;
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
