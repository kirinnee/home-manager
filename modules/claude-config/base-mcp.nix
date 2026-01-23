# Base MCP server configurations for Claude Code multi-account setup
# Import this and use lib.recursiveUpdate to add account-specific servers

{}:

{
  context7 = {
    command = "env";
    args = [
      "HTTP_BACKEND_URL=https://mcp.context7.com/mcp"
      "npx"
      "-y"
      "@context7/mcp-cli"
    ];
    disabled = false;
  };

  beeper = {
    transport = {
      type = "http";
      url = "http://localhost:23373/v0/mcp";
    };
    disabled = false;
  };

  browser = {
    command = "npx";
    args = [ "-y" "@browsermcp/mcp@latest" ];
    disabled = false;
  };

  pipedream_personal = {
    transport = {
      type = "http";
      url = "https://mcp.pipedream.net/v2/pipedream_personal";
    };
    disabled = false;
  };

  pipedream_liftoff = {
    transport = {
      type = "http";
      url = "https://mcp.pipedream.net/v2/pipedream_liftoff";
    };
    disabled = false;
  };

  pipedream_atomi = {
    transport = {
      type = "http";
      url = "https://mcp.pipedream.net/v2/pipedream_atomi";
    };
    disabled = false;
  };

  atlassian = {
    transport = {
      type = "sse";
      url = "https://mcp.atlassian.com/v1/sse";
    };
    disabled = false;
  };
}
