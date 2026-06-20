rec {
  proxy = {
    baseUrl = "http://127.0.0.1:8317";
    token = "\"$API_CLI_PROXY_TOKEN\"";
  };

  providers = {
    zai = {
      opus = "glm-5.2";
      sonnet = "glm-4.7";
      haiku = "glm-4.5-air";
      models = [
        { id = "glm-5.2"; name = "glm52"; sonnet = "glm-5-turbo"; haiku = "glm-4.7"; }
      ];
    };
    anthropic = {
      opus = "claude-opus-4-8";
      sonnet = "claude-sonnet-4-6";
      haiku = "claude-haiku-4-5-20251001";
      fable = "claude-fable-5";
      models = [
        { id = "claude-opus-4-8"; name = "opus48"; }
        { id = "claude-sonnet-4-6"; name = "sonnet46"; }
        { id = "claude-haiku-4-5-20251001"; name = "haiku45"; }
      ];
    };
    openai = {
      opus = "gpt-5.5";
      sonnet = "gpt-5.5";
      haiku = "gpt-5.5";
      models = [
        { id = "gpt-5.5"; name = "gpt55"; }
      ];
    };
    deepseek = {
      opus = "deepseek-v4-pro";
      sonnet = "deepseek-v4-pro";
      haiku = "deepseek-v4-flash";
      models = [
        { id = "deepseek-v4-pro"; name = "dsv4p"; }
        { id = "deepseek-v4-flash"; name = "dsv4f"; }
      ];
    };
    mm = {
      opus = "minimax-m3";
      sonnet = "minimax-m3";
      haiku = "minimax-m3";
      models = [
        { id = "minimax-m3"; name = "mm3"; }
      ];
    };
  };

  # Claude uses Anthropic-compatible env vars
  # opus/sonnet/haiku/fable: when set, override the provider's default for that slot
  # Fable tier defaults to the provider's best model (p.opus); a provider can pin
  # it via a `fable` key (e.g. anthropic → claude-fable-5).
  mkClaudeEnv = provider: { opus ? null, sonnet ? null, haiku ? null, fable ? null }:
    let
      p = providers.${provider};
    in
    {
      ANTHROPIC_BASE_URL = proxy.baseUrl;
      ANTHROPIC_AUTH_TOKEN = proxy.token;
      ANTHROPIC_DEFAULT_OPUS_MODEL = if opus != null then opus else p.opus;
      ANTHROPIC_DEFAULT_SONNET_MODEL = if sonnet != null then sonnet else p.sonnet;
      ANTHROPIC_DEFAULT_HAIKU_MODEL = if haiku != null then haiku else p.haiku;
      ANTHROPIC_DEFAULT_FABLE_MODEL = if fable != null then fable else (p.fable or p.opus);
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
