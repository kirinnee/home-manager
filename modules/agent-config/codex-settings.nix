# Codex CLI config.toml settings
# Uses model_providers to route through local proxy via OpenAI Responses API
{
  model_provider = "proxy";
  forced_login_method = "api";
  model_reasoning_effort = "high";
  approval_policy = "on-request";
  sandbox_mode = "workspace-write";

  sandbox_workspace_write = {
    network_access = true;
  };

  model_providers = {
    proxy = {
      name = "Proxy";
      base_url = "http://127.0.0.1:8317/v1";
      env_key = "OPENAI_API_KEY";
    };
  };
}
