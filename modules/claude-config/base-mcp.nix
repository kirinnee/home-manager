{
  beeper = {
    transport = {
      type = "http";
      url = "http://localhost:23373/v0/mcp";
    };
    disabled = false;
  };
  browser = {
    command = "npx";
    args = [
      "-y"
      "@browsermcp/mcp@latest"
    ];
    disabled = false;
  };
}
