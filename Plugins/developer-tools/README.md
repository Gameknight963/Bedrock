# MCP Bridge

Connects the Bedrock MCP server to Discord for UI inspection. Enable this plugin
in the Plugins page, then start the MCP server through your MCP client.

- Inspect elements using CSS selectors, including their classes and parents.
- Read computed CSS and matching rules on an element and its ancestors.
- Capture a window screenshot.
- Disable the plugin to remove the inspector and close its named pipe immediately.

The bridge uses `Bedrock-Dev-<process ID>` Windows named pipes. It does not open
a debugger or a TCP port. It offers fixed inspection commands, without an
arbitrary JavaScript evaluation command.

If more than one window or Bedrock instance is available, use the IDs returned
by the MCP `status` tool to choose the target. Inspection can include private
information displayed in Discord, so enable the plugin when you want to inspect it.
