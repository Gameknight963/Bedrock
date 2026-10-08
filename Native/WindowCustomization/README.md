# Window customization module

Build this project or the Launcher project in Visual Studio. The Launcher build packages `window.node` with the window customization plugin automatically.

- `window.c` manages window styles and native frame messages.
- `exports.c` exposes the operations through Node-API.
- `node.def` lists the Node-API imports used by this module.
- `delay-load.c` resolves those imports from the running executable, so the module can load in both Node.js and Discord.

The window handle must belong to the current process and thread. Customizations restore their owned style bits when disposed, and stop referring to the HWND when Windows destroys it.
