# Base Claude Code settings for multi-account configuration
{
  Notification = [
    {
      matcher = "";
      hooks = [
        {
          type = "command";
          command = "speak 'Claude is waiting for you'";
        }
      ];
    }
  ];
  Stop = [
    {
      matcher = "";
      hooks = [
        {
          type = "command";
          command = "speak 'Task complete'";
        }
      ];
    }
  ];
}
