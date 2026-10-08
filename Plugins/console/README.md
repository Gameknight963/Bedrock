# Console

Shows a Windows console for Bedrock messages. Enable **Show console** to open it, including after a Bedrock restart. Turn the setting off to hide the console window. The process stays attached so its output handles remain usable.

**Show Discord output** includes Discord messages alongside Bedrock logs. Turn it off to reduce noise.

## Output filtering

Bedrock messages use a separate log feed and are written directly to the console. The plugin redirects JavaScript stdout and stderr and changes Windows standard output handles when filtering Discord output.

Native libraries that cached an output handle before the plugin started can still write through that handle. GPU and other child processes can also retain their own handles. This setting therefore does not guarantee that every Discord message is hidden. Launcher messages printed before plugin startup are unaffected.

## Windows console behavior

`AllocConsole` creates a console when Discord has none. The visibility setting uses `ShowWindow` to hide and show the existing console. The plugin opens `CONOUT$` explicitly so Bedrock messages do not depend on Node retaining a valid stdout handle after detaching and reconnecting.

Closing a console using its window close button can terminate attached processes. Use the plugin setting to hide it instead.

## Log files

Enable **Write logs to file** to save Bedrock messages to `BedrockData/logs/latest.log`. At the next launcher startup, the previous file is renamed with a timestamp. Bedrock keeps the ten most recent archives. Enabling file logging during a session starts recording from that point; the next launch also records launcher diagnostics.

**Include Discord logs in files** adds captured JavaScript output from the main process and renderer. It does not capture every native message or output from child processes. Log files can contain personal information from plugins or Discord; review them before sharing.

File logging continues while the console is hidden or the Console plugin is disabled. Its saved settings are read by the bootstrap and launcher.
