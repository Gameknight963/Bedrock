# Bedrock plugin API v1

Build and run the Launcher project after quitting Discord. Its build copies the runtime next to the executable. No browser debugger, separate Node installation, or JavaScript build step is needed to use Bedrock. The launcher installs `bootstrap.cjs` before Discord's application entry point, then closes the inspector port. The bootstrap supplies the plugin loader and renderer preload for the rest of the session.

In Discord's User Settings, **Bedrock → Plugins** provides search, enable switches, and a detail page with **Details** and **Settings** tabs. **Open plugins folder** opens your installed packages; **Refresh plugins** discovers new ones and unloads removed or invalid packages. This is independently implemented; Equicord's settings behavior informed the design, but its GPL source is not included.

## Locations

`BedrockData` lives beside `BedrockLauncher.exe`, independently of the working directory. Each build has its own data folder. Builds update bundled plugin files without replacing settings, themes, or other installed plugins. Keep `BedrockData` when updating or moving Bedrock, and use a writable installation folder.

```text
BedrockData\
    settings.json
    themes.json
    themes\
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

Copy `Examples/example` into the plugins directory and choose **Refresh plugins**. New packages are enabled by default. Enable state and plugin settings survive restarts. Refreshing discovers additions and unloads removed or invalid packages, including their owned resources. Saved data is retained if you reinstall a plugin. Editing an already loaded package still requires restarting Discord; disable it before editing its files.

## Package files

The loader inspects only immediate plugin folders containing `plugin.json`. Every executable entry point, README, and icon is declared explicitly; filenames alone never execute code. Other files can be imported or fetched by that plugin. All declared paths must resolve inside its folder. Duplicate IDs and invalid manifests are reported in the Plugins page. Disabled packages are inspected without executing their entry points.

```json
{
    "manifestVersion": 2,
    "id": "example.plugin",
    "name": "Example",
    "version": "1.0.0",
    "description": "A short explanation for the plugin card.",
    "entrypoints": {
        "main": { "runtime": "javascript", "path": "main.js", "requiresApi": "1.0.0" },
        "renderer": { "runtime": "javascript", "path": "renderer.js", "requiresApi": "1.0.0" }
    },
    "readme": "README.md"
}
```

Required: `manifestVersion`, `id`, `name`, `version`, `entrypoints`. IDs use lowercase letters, digits, dots, underscores or hyphens and must be unique. `description`, `readme`, and `icon` are optional. Main and renderer are independently optional, but at least one is required. `.js` and `.mjs` entry points are supported. Prefer `main.js` and `renderer.js`, or `main/index.js` and `renderer/index.js`.

Each entry point must be an object declaring `runtime`, `path` and `requiresApi`. Only the `javascript` runtime is supported. The current JavaScript API version is `1.0.0`.

`requiresApi` is a semantic version, not a version range. Bedrock accepts requirements with the same major version that are no newer than its API, comparing minor and patch versions in order. For example, API `1.3.2` accepts `1.2.0` and `1.3.2`, but rejects `1.3.3` and `2.0.0`. Prerelease versions follow semantic-version precedence; build metadata does not affect compatibility. Requirements are checked before executing any plugin code.

`manifestVersion: 2` identifies this package format. The old string entry points and top-level `apiVersion` are no longer accepted.

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

### Cleanup and patches

- Patch methods return disposers. Removing the final Bedrock patch restores the original property; multiple plugins can patch the same method.
- Patches operate on synchronous return values. They do not await a returned promise.
- Register DOM listeners, timers, observers and other resources with `ctx.cleanup()`. Bedrock cannot undo untracked side effects.

### Events

- Ordinary plugin events deliver `{id, value}`; `id` identifies the sender.
- `settings.changed` identifies the affected plugin. Renderer events contain `{id, settings}`; main events contain `{id, key, value}` or `{id, key, deleted:true}`.
- Main also receives `window.created` with the BrowserWindow.

### Disabling and re-enabling

- Disabling aborts the context, disposes owned resources, cancels pending module waits, then calls `stop()`.
- `stop()` has a ten-second limit. A failure does not skip cleanup.
- Respect `ctx.signal` to avoid late work after disabling. JavaScript already executing cannot be forcibly unloaded.
- Re-enabling calls `start()` with a fresh context and reuses the imported module. Reset mutable module state in your lifecycle methods.

## Plugin settings

Export a settings definition from either entry point. `Bedrock.definePluginSettings` and `Bedrock.OptionType` are available in both main and renderer plugins before the module loads.

```js
const { definePluginSettings, OptionType } = Bedrock;

export const settings = definePluginSettings({
    showIndicator: {
        type: OptionType.BOOLEAN,
        label: 'Show indicator',
        description: 'Show an indicator beside messages.',
        default: true,
        onChange(value) { console.log('Indicator:', value); }
    }
});

export function start(ctx) {
    ctx.log.info('Indicator enabled:', settings.store.showIndicator);
}
```

Bedrock generates the plugin's **Settings** tab from this definition. Values are owned and saved by the main process, then synchronized to renderer windows. Defaults are used when no value has been saved. Existing `ctx.settings` methods still work.

### Definitions and controls

Every setting has a `type`, `description`, and `default`. The optional `label` supplies the control's title; otherwise its key is used. Consecutive settings with the same `section` are grouped beneath a heading.

| Type | Control and options |
| --- | --- |
| `OptionType.BOOLEAN` | Switch. |
| `OptionType.STRING` | Text field; `multiline: true` uses a text area. Optional `placeholder`. |
| `OptionType.NUMBER` | Number field with optional `min`, `max`, and `step`. |
| `OptionType.SELECT` | Dropdown with `options: [{label: 'First', value: 'first'}]`. Values can be strings, numbers, or booleans. |
| `OptionType.SLIDER` | Slider requiring `min` and `max`, with optional `step`. |

Switches and dropdowns save immediately. Text and number fields save when you leave the field; Enter also saves a single-line field. Sliders save when you release the pointer or a key. Each setting has a **Reset** button.

### Reading and changing values

- `settings.store.showIndicator` reads the current value. Assigning it queues a validated save; errors are logged under the plugin's ID.
- `await settings.set('showIndicator', false)` saves a value and lets you handle an error. `await settings.flush()` waits for queued assignments.
- `await settings.reset('showIndicator')` saves its default value.
- `settings.subscribe((key, value) => ...)` observes committed changes and returns an unsubscribe function. Subscriptions are cleared when the plugin stops; use `ctx.cleanup()` if you also want to own the disposer.
- Renderer React components can call `settings.use(['showIndicator'])` to subscribe and receive an object containing those values.

The exported object is bound before `start()` and unbound when the context stops. Its callbacks run only while that entry point is active. Main and renderer can declare the same setting, but its data definition must agree; callbacks remain local to each runtime. Disabled plugins retain definitions already loaded during this session. A plugin that has never been enabled must be enabled once to load its definitions.

### Validation and restart notices

- Built-in type, choice and range checks run in the main owner as well as the language API.
- Optional `isValid(value)` returns `true`, `false`, or an error message. It runs in the declaring runtime when using its settings API; the Settings tab also uses renderer validators. Main validators additionally run on writes received by the main owner.
- `restartNeeded: true` marks an individual setting. Bedrock shows a **Restart Discord** button when its value differs from the value at startup. Changing it back clears that setting's notice.
- Restarting goes through the adjacent Bedrock launcher, so the next Discord process also receives the bootstrap. A restart marker does not defer callbacks: the plugin decides when to apply the value.

Definitions contain the UI data, while callbacks stay in JavaScript. Only values are saved in the plugin's `data/<id>/settings.json`. This boundary lets a future native owner or another language use the same definitions and UI.

## CSS themes

Open **Bedrock → Themes**, then choose **Open themes folder**. Copy your CSS files into `BedrockData\themes` and enable the themes you want. New files appear automatically and start disabled. Enabled themes apply in filename order, so later files can override earlier ones.

- Enable switches take effect immediately and are saved in `BedrockData\themes.json`.
- Editing CSS or local assets reloads enabled themes automatically. Adding and removing files updates the page without restarting Discord.
- Relative `@import` and `url(...)` paths resolve within the themes folder. Keep imported stylesheets and assets in subfolders so they do not appear as separate themes.
- A leading CSS comment can provide `@name`, `@description`, `@author`, `@version`, and `@website`, one per line. Metadata is optional; otherwise the filename supplies the display name. `@website` accepts an HTTP or HTTPS URL and adds a **Website** link that opens in your browser.

Themes are CSS files, so no plugin manifest or JavaScript is required. Window transparency remains a separate feature; CSS alone cannot enable it.

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
node --test Runtime/tests/*.test.cjs
.\Launcher\tests\smoke.ps1
npm install --prefix Runtime/tests/obj electron@42.7.1 react@18.3.1 react-dom@18.3.1
node Runtime/tests/obj/node_modules/electron/install.js
.\Runtime\tests\electron-smoke.ps1
.\Runtime\tests\electron-smoke.ps1 -ThroughInspector
```

The Electron fixture checks the real sandboxed preload/context bridge, preserved existing preload, settings layout injection, rendered React switches, plugin cleanup and re-enable, relative imports, cross-process settings/events, Markdown, and origin restriction. Dependencies are test-only; the runtime uses Discord's Electron and React. Tests use isolated temporary data and do not launch or alter Discord.
