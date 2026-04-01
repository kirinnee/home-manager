{
  beeper = {
    transport = {
      type = "http";
      url = "http://localhost:23373/v0/mcp";
    };
    disabled = false;
  };
  playwright = {
    command = "npx";
    args = [
      "@playwright/mcp@latest"
    ];
    disabled = false;
  };
}
