rec {
  proxy = {
    ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
    ANTHROPIC_AUTH_TOKEN = "\"$API_CLI_PROXY_TOKEN\"";
  };
  zai = proxy // {
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "glm-4.5-air";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "glm-5";
    ANTHROPIC_DEFAULT_OPUS_MODEL = "glm-5";
  };
  anthropic = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-6";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-5-20250929";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
  };
  codex = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "gpt-5.3-codex";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "gpt-5.1-codex";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "gpt-5.1-codex-mini";
  };
  gemini = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "gemini-3-pro-preview";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "gemini-3-flash-preview";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "gemini-2.5-flash";
  };
}
