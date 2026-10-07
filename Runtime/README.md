# Bedrock plugin API v1

Build and run the Launcher project after quitting Discord. Its build copies the runtime next to the executable. No browser debugger, separate Node installation, or JavaScript build step is needed to use Bedrock. The launcher installs `bootstrap.cjs` before Discord's application entry point, then closes the inspector port. The bootstrap supplies the plugin loader and renderer preload for the rest of the session.

In Discord's User Settings, **Bedrock → Plugins** provides search, enable switches, details, **Open plugins folder**, and **Find new plugins**. This is independently implemented; Equicord's settings behavior informed the design, but its GPL source is not included.

## Locations

```text
%LOCALAPPDATA%\Bedrock\
    settings.json
    plugins\
        example\
            plugin.json
            renderer.js
            style.css
            README.md
    data\
        bedrock.example\
            settings.json
```

Copy `Examples/example` into the plugins directory and choose **Find new plugins**. New packages are enabled by default. Enable state and plugin settings survive restarts. Rescanning discovers additions; editing or removing already loaded packages currently requires restarting Discord. Disable a plugin before editing its files.

## Package files

The loader inspects only immediate plugin folders containing `plugin.json`. Every executable entry point, README, and icon is declared explicitly; filenames alone never execute code. Other files can be imported or fetched by that plugin. All declared paths must resolve inside its folder. Duplicate IDs and invalid manifests are reported in the Plugins page. Disabled packages are inspected without executing their entry points.

```json
{
    "manifestVersion": 1,
    "apiVersion": 1,
    "id": "sebis.example",
    "name": "Example",
    "version": "1.0.0",
    "description": "A short explanation for the plugin card.",
    "entrypoints": {
        "main": "main.js",
        "renderer": "renderer.js"
    },
    "readme": "README.md"
}
```

Required: `manifestVersion`, `apiVersion`, `id`, `name`, `version`, `entrypoints`. IDs use lowercase letters, digits, dots, underscores or hyphens and must be unique. `description`, `readme`, and `icon` are optional. Main and renderer are independently optional, but at least one is required. `.js` and `.mjs` entry points are supported. Prefer `main.js` and `renderer.js`, or `main/index.js` and `renderer/index.js`.

Entry points also accept an extensible definition:

```json
"main": { "runtime": "javascript", "path": "main.js" }
```

Only `javascript` is implemented. A future runtime can extend this object with fields such as an assembly path and type without changing the package layout. `.NET` entry points and Vencord/Equicord compatibility are not implemented.

README details support headings, paragraphs, bold, inline code, fenced code, bullet lists, and links. Raw HTML is displayed as text. Unsafe link schemes are rejected. Optional package icons appear on plugin cards.

## Lifecycle and context

Each entry point exports `start(ctx)` and optionally `stop()`. Use ES module syntax. For main packages, an optional `package.json` containing `{"type":"module"}` makes the module type explicit. Main entry modules are loaded synchronously so they can register window hooks before Discord creates a window; top-level `await` is unsupported there. `start()` itself may be async.

```js
export function start(ctx) {
    ctx.log.info('Starting', ctx.id);
    ctx.events.on('settings.changed', event => {
        if (event.id === ctx.id) ctx.log.info('Settings changed');
    });
}
```

For a real timer, register its cleanup immediately after creating it:

```js
export function start(ctx) {
    const timer = setInterval(() => ctx.log.info('Tick'), 1000);
    ctx.cleanup(() => clearInterval(timer));
}
```

`ctx` is a new context for this plugin and this activation. Main and renderer get separate contexts. Each owns its cleanup, logging prefix, persisted settings and hooks.

| API | Behavior |
| --- | --- |
| `ctx.id`, `ctx.manifest` | Package identity and a metadata copy. |
| `ctx.signal` | AbortSignal cancelled when the context stops. Use it for fetches and async work. |
| `ctx.log.info/warn/error(...args)` | Prefixes console output with the plugin ID. |
| `ctx.settings.get(key, fallback)` | Reads a saved JSON value. |
| `ctx.settings.set(key, value)` | Persists a JSON value; await it in the renderer. |
| `ctx.settings.delete(key)` / `all()` | Removes a key or returns a settings copy. Await renderer deletion. |
| `ctx.cleanup(disposer)` | Owns a cleanup function; returns an idempotent disposer. |
| `ctx.events.on(name, callback)` | Subscribes until disposal; returns an unsubscribe function. |
| `ctx.events.emit(name, value)` | Sends a JSON payload across main and renderer. Await it in the renderer. |
| `ctx.patches.before(object, method, (args, receiver) => {})` | Alters the mutable argument array before calling the method. |
| `ctx.patches.after(object, method, (args, result, receiver) => {})` | Returning a value replaces the result; undefined leaves it unchanged. |
| `ctx.patches.instead(object, method, (args, next, receiver) => {})` | Replaces the call; use `next(...args)` to continue the patch chain. |
| `ctx.requireRestart(reason)` | Displays a restart notice on the plugin card. It does not itself defer start/stop. |

Patch methods return disposers and restore the original property when the final Bedrock patch is removed. Multiple plugins can patch the same method. Register ordinary DOM listeners, timers, observers and other resources with `ctx.cleanup()`; Bedrock cannot undo arbitrary untracked side effects. Patches operate on synchronous return values; they do not await the method's returned promise.

Normal plugin events deliver `{id, value}`, where `id` identifies the sender. The built-in `settings.changed` event identifies the affected plugin. Renderer settings events contain `{id, settings}`; main events contain `{id, key, value}` or `{id, key, deleted:true}`. Main also receives `window.created` with the BrowserWindow.

Disabling aborts the context and disposes owned resources, cancels pending module waits, then calls `stop()`. A stop failure does not skip cleanup. `stop()` is limited to ten seconds. Plugins must respect `ctx.signal` to avoid late work after disabling; JavaScript already executing cannot be forcibly unloaded. Re-enabling calls `start()` with a fresh context but reuses the imported module, so reset mutable module state in your lifecycle methods.

### Renderer APIs

```js
export async function start(ctx) {
    const target = await ctx.webpack.waitFor(value => typeof value?.someMethod === 'function');
    if (ctx.signal.aborted) return;
    ctx.patches.after(target, 'someMethod', (args, result) => result);
    ctx.styles.add('.my-element { color: red; }');
}
```

`ctx.styles.add(css)` adds an owned style element and returns its disposer. Relative ES imports and `fetch(new URL('./style.css', import.meta.url))` work through Bedrock's package protocol. `ctx.webpack.find(predicate)` searches loaded Discord module exports. `ctx.webpack.waitFor(predicate)` resolves when a matching module loads, or rejects if the plugin stops first. This API avoids eagerly executing unrelated Discord modules. Module exports and the settings adapter depend on Discord internals and can require updates after Discord changes.

For manual debugging, the renderer exposes `Bedrock.plugins.list()`, `await Bedrock.plugins.setEnabled(id, enabled)`, and `await Bedrock.plugins.rescan()`.

Launch with `--devtools` to open renderer DevTools without editing Discord's settings or reopening the Node inspector. `Bedrock.debug.status()` reports settings hook counts, discovered React/layout types, and observed/cached module counts.

### Main APIs

```js
export function start(ctx) {
    ctx.windows.beforeCreate(options => { options.transparent = true; });
    ctx.windows.onCreated(window => ctx.log.info('Window', window.id));
}
```

`ctx.windows.beforeCreate(callback)` supplies mutable Electron BrowserWindow options before construction. `onCreated(callback)` receives newly created windows. Both return owned disposers. `all()` returns currently tracked windows. Window construction changes are applied to future windows. Enabling these hooks while windows exist, or removing an applied hook, displays a restart notice. Existing-window WinAPI changes, native titlebar handling, and a transparency plugin remain separate follow-up work. CSS comes from user plugins.

Main plugins run inside Discord's Node process and can import Node built-ins or use `createRequire(import.meta.url)` to load a compatible `.node` addon. Plugins are trusted code, not sandboxed packages; there is no host-imposed catalogue or compilation requirement. Addons must match Electron's architecture and ABI.

## Verification

```powershell
node --test Runtime/tests/plugins.test.cjs
.\Launcher\tests\smoke.ps1
npm install --prefix Runtime/tests/obj electron@42.7.1 react@18.3.1 react-dom@18.3.1
node Runtime/tests/obj/node_modules/electron/install.js
.\Runtime\tests\electron-smoke.ps1
.\Runtime\tests\electron-smoke.ps1 -ThroughInspector
```

The Electron fixture checks the real sandboxed preload/context bridge, preserved existing preload, settings layout injection, rendered React switches, plugin cleanup and re-enable, relative imports, cross-process settings/events, Markdown, and origin restriction. Dependencies are test-only; the runtime uses Discord's Electron and React. Tests use isolated temporary data and do not launch or alter Discord.
