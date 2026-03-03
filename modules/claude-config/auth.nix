rec {
  proxy = {
    ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
    ANTHROPIC_AUTH_TOKEN = "\"$API_CLI_PROXY_TOKEN\"";
  };
  zai = proxy // {
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "glm-4.5-air";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "glm-4.7";
    ANTHROPIC_DEFAULT_OPUS_MODEL = "glm-5";
  };
  gwen = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "gwen3-coder-plus";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "gwen3-coder-plus";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "gwen3-coder-plus";
  };
  anthropic = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-6";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
  };
  codex = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "gpt-5.3-codex";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "gpt-5.1-codex";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "gpt-5.1-codex-mini";
  };
  gemini = proxy // {
    ANTHROPIC_DEFAULT_OPUS_MODEL = "gemini-3.1-pro-high";
    ANTHROPIC_DEFAULT_SONNET_MODEL = "gemini-3.1-pro-low";
    ANTHROPIC_DEFAULT_HAIKU_MODEL = "gemini-3.1-pro-low";
  };
}
