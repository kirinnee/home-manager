{
  beeper = {
    transport = {
      type = "http";
      url = "http://localhost:23373/v0/mcp";
    };
    disabled = false;
  };
  clickup = {
    transport = {
      type = "http";
      url = "https://mcp.clickup.com/mcp";
    };
    disabled = false;
  };
  browser = {
    command = "npx";
    args = [ "-y" "@browsermcp/mcp@latest" ];
    disabled = false;
  };
}
