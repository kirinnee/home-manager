rec {
  proxy = {
    ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
    ANTHROPIC_AUTH_TOKEN = "\"$API_CLI_PROXY_TOKEN\"";
  };
  zai = proxy // {
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "glm-4.5-air";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "glm-4.7";
    ANTHROPIC_DEFAULT_OPUS_MODEL = "glm-5-turbo";
  };
  kimi = proxy // {
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "kimi-k2.5";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "kimi-k2.5";
    ANTHROPIC_DEFAULT_OPUS_MODEL = "kimi-k2.5";
  };
  seed = proxy // {
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "doubao-seed-2.0-lite";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "doubao-seed-2.0-code";
    ANTHROPIC_DEFAULT_OPUS_MODEL = "doubao-seed-2.0-pro";
  };
  mm = proxy // {
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "minimax-m2.7";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "minimax-m2.7";
    ANTHROPIC_DEFAULT_OPUS_MODEL = "minimax-m2.7";
  };
  cerebras = proxy // {
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "zai-glm-4.7";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "zai-glm-4.7";
    ANTHROPIC_DEFAULT_OPUS_MODEL = "zai-glm-4.7";
  };
  anthropic = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-6";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
  };
  codex = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "gpt-5.4";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "gpt-5.4";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "gpt-5.1-codex-mini";
  };
  gemini = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "gemini-3.1-pro-preview";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "gemini-3-flash-preview";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "gemini-3.1-flash-lite-preview";
  };
  ag = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "gemini-3.1-pro-high";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "gemini-3.1-pro-low";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "gemini-3.1-pro-low";
  };
}
