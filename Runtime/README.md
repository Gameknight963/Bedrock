> WARNING: STALE

# Bedrock plugin API v1

Build and run the Launcher project after quitting Discord. Its build copies the runtime next to the executable. No browser debugger, separate Node installation, or JavaScript build step is needed to use Bedrock. The launcher installs `bootstrap.cjs` before Discord's application entry point, then closes the inspector port. The bootstrap supplies the plugin loader and renderer preload for the rest of the session.

In Discord's User Settings, **Bedrock → Plugins** provides search, enable switches, and a detail page with **Details** and **Settings** tabs. **Open plugins folder** opens your installed packages; **Refresh** discovers new ones and unloads removed or invalid packages.

Remove a plugin using the **Remove** button on its card or the **Remove** button on its details page. Removal disables the plugin, calls its unload callbacks, and deletes its installed folder. Saved settings are kept unless you check **Also delete saved settings** in the confirmation dialog. Shift-click **Remove** to skip confirmation and keep settings. If cleanup needs a restart or Windows keeps files locked, Bedrock queues the remaining operation for the next launch and the page asks you to restart.

The **Browse** tab lists the official plugin collection. Open **Details** to read a plugin's README, or choose **Install** on its card. Installed plugins show an **Installed** badge; newer published versions show **Update available** and an **Update** button. Updates preserve settings and enable state. A restart is needed if the plugin cannot finish unloading or its files remain locked.

**Check for updates** refreshes the online catalog. Browsing downloads only the catalog; plugin packages download when you install or update them. Bedrock checks each package against its published SHA-256 checksum and validates it before installation. The catalog is cached for one hour, and the last saved catalog remains available when GitHub cannot be reached.

Plugin details include **License** and **Notices** tabs when the package provides those documents. Full text is selectable. Installed packages use `LICENSE` (or `LICENSE.md` / `LICENSE.txt`), with notices from `NOTICE`, `NOTICE.md`, and `THIRD_PARTY_NOTICES.md`. Collection catalogs can include the same documents so they are available before installation.

## Locations

`BedrockData` lives beside `BedrockLauncher.exe`, independently of the working directory. Each build has its own data folder. Plugins are distributed separately from the launcher; builds do not overwrite installed plugins or their data. Keep `BedrockData` when updating or moving Bedrock, and use a writable installation folder.

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
    "manifestVersion": 3,
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

Required: `manifestVersion`, `id`, `name`, `version`, `entrypoints`. IDs use lowercase letters, digits, dots, underscores or hyphens and must be unique. `description`, `readme`, and `icon` are optional. Main, renderer and GPU entry points are independently optional, but at least one is required. `.js` and `.mjs` entry points are supported. Prefer `main.js` and `renderer.js`, or `main/index.js` and `renderer/index.js`.

Each JavaScript entry point must be an object declaring `runtime`, `path` and `requiresApi`. The current JavaScript API version is `1.8.0`. JavaScript entry points run in main or renderer environments.

`requiresApi` is a semantic version, not a version range. Bedrock accepts requirements with the same major version that are no newer than its API, comparing minor and patch versions in order. For example, API `1.3.2` accepts `1.2.0` and `1.3.2`, but rejects `1.3.3` and `2.0.0`. Prerelease versions follow semantic-version precedence; build metadata does not affect compatibility. Requirements are checked before executing any plugin code.

`manifestVersion: 3` identifies this package format. The old string entry points and top-level `apiVersion` are no longer accepted.

## Native entry points

```json
"gpu": { "runtime": "native", "path": "native/win32-x64/plugin.dll" }
```

Native entry points support main, GPU and Discord renderer processes on Windows x64. They declare `runtime` and `path`; the native API requirement belongs in the DLL descriptor rather than `requiresApi`. Bedrock supplies lifecycle, logging and settings without requiring a JavaScript entry point. The C interface and ownership rules are described in [the native API guide](../include/README.md).

## Lifecycle and context

Each JavaScript entry point exports `start(ctx)` and optionally `stop()`. Use ES module syntax; no `package.json` is required. Main entry modules are loaded synchronously so they can register window hooks before Discord creates a window; top-level `await` is unsupported there. `start()` itself may be async.

Bedrock converts individual JavaScript files when loading them. Main modules use CommonJS, and renderer modules use SystemJS. Relative imports, dynamic imports and `import.meta.url` remain available. Replacing a package clears its JavaScript module cache after `unload()` succeeds, including helper modules. Disabling alone keeps the module for re-enabling. Converted modules are not identical to native ES modules in every edge case; circular imports that read values before initialization can behave differently.

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

### Removing and replacing

Export an optional `unload(ctx)` to release resources kept across activations. Bedrock calls it after stopping the plugin when removing or replacing its package, including when the plugin is already disabled. The activation context has stopped by this point.

- `unload(ctx)` can be synchronous or async, with a ten-second limit.
- Return nothing. Call `ctx.requireRestart(reason)` if final cleanup requires exiting Discord.
- The unload context provides `id`, `manifest`, `log` and `requireRestart`; activation resources and settings are unavailable. It requires JavaScript API `1.3.0`.
- Restart requests remain visible after removal or replacement and clear when Discord restarts.
- A restart request, exception, or timeout queues the file operation for the next launch. Bedrock owns deleting and replacing package files; plugins only release their resources.

### Loading native addons

Main plugins can use `Bedrock.require(request, import.meta.url)` to load modules relative to their entry point. For `.node` files, Bedrock tracks each acquisition. Use API requirement `1.2.0` for `Bedrock.unloadAddon()`; `Bedrock.require()` and `unload()` are available from `1.1.0`.

```js
let addon;

export function start(ctx) {
    addon ||= Bedrock.require('./native/addon.node', import.meta.url);
}

export function stop() {
    // Stop the feature here; keep the addon available for re-enabling.
}

export function unload() {
    if (!addon) return;
    Bedrock.unloadAddon(addon);
    addon = undefined;
}
```

- Balance each `.node` acquisition with one `Bedrock.unloadAddon(exports)` call. Cached acquisitions share the exports object; only the final release unloads the DLL.
- Before the final release, Bedrock calls the addon's optional synchronous `dispose()` export. The addon must remove native callbacks, finalizers and shutdown hooks, and release its resources before returning. A disposal error leaves it loaded.
- Do not mix ordinary `require()` with managed loading of the same addon, or use its exports after releasing them. Bedrock rejects addons already present in Node's ordinary cache, but cannot track later ordinary callers.
- JavaScript modules and built-ins use normal Node loading. Addons loaded indirectly by those modules are not tracked. Node retains internal addon bookkeeping until process exit, so unloading is not a way to reclaim every allocation made by Node.

If an addon cannot remove its registered callbacks safely, leave it loaded and call `ctx.requireRestart(reason)` from `unload(ctx)` instead.

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

### Custom settings editors

JavaScript API **1.10.0** lets a renderer export a `Settings` React component. It appears below the ordinary controls in the plugin's Settings tab, including when the plugin is disabled.

```js
export function Settings({ ctx }) {
    const { count } = settings.use(['count']);
    return ctx.react.createElement('button', {
        onClick: () => settings.set('count', count + 1)
    }, `Count: ${count}`);
}
```

- `ctx` belongs to this editor. It provides `id`, `manifest`, `react`, `log`, `settings`, `styles`, `webpack`, `events`, `requireRestart` and `signal`. TypeScript types are `RendererSettingsProps` and `RendererSettingsContext`.
- Closing the tab aborts its signal and disposes its owned styles, event subscriptions and pending module waits. Use React effects to manage other UI resources.
- Opening settings imports the renderer module, but does not call `start()` or register its source patches. Keep activation work in `start()` rather than at module scope.
- Defined settings remain readable and editable while disabled. Their `onChange` callbacks run while the renderer activation is running; `settings.use()` and subscriptions still receive edits while disabled.
- Use `ctx.settings` for editor data that does not have an ordinary control, such as a list of replacement rules. Validate that data in the plugin.

An error in the editor is shown in its settings panel. Other settings remain usable.

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

`ctx.styles.add(css)` adds an owned style element and returns its disposer. Relative ES imports and `fetch(new URL('./style.css', import.meta.url))` work through Bedrock's package protocol.

Discord modules are available through `ctx.webpack`:

- `find(predicate)` searches loaded module exports.
- `waitFor(predicate)` waits for a matching module to execute. It rejects if the plugin stops first.
- `loadChunks({ find, match? })` requests a lazy-loaded feature, then executes its entry module. Use `find()` afterward to locate its exports. Available in JavaScript API **1.9.0**.

For `loadChunks`, `find` is a distinctive source fragment or an array of fragments that must all occur in one registered module factory. Bedrock follows the first recognized chunk-loading instruction in that factory. For example:

```js
await ctx.webpack.loadChunks({ find: 'distinctive source text' });
const feature = ctx.webpack.find(value => typeof value?.someMethod === 'function');
```

An optional `match` regular expression selects a different loading instruction. Capture the comma-separated Webpack chunk calls, such as `r.e("123"),r.e("456")`, in group 1, and the quoted or numeric entry module ID in group 2. Group 1 can be empty when the entry module is already registered.

An ambiguous factory match, missing instruction, chunk-loading failure or failed entry module rejects the promise. Stopping the plugin cancels its wait and prevents later entry-module execution; downloaded chunks remain registered with Discord.

Module exports and the settings adapter depend on Discord internals and can require updates after Discord changes.

For manual debugging, the renderer exposes `Bedrock.plugins.list()`, `await Bedrock.plugins.setEnabled(id, enabled)`, and `await Bedrock.plugins.rescan()`.

#### Context menus

JavaScript API **1.4.0** adds menu and message hooks. Renderer types are provided in [renderer.d.ts](../include/bedrock/renderer.d.ts), with a [TypeScript example](../Examples/renderer-apis.ts). Compile TypeScript to JavaScript for the package's entry point.

```js
export function start(ctx) {
    ctx.contextMenus.patch('user-context', (children, props) => {
        children.push(ctx.contextMenus.item({
            id: 'example-copy-user-id',
            label: 'Copy User ID',
            action: () => navigator.clipboard.writeText(props.user.id)
        }));
    });
}
```

- `patch(navId, callback)` receives a mutable array of React children and the menu component's props. Menu IDs and props come from Discord; the user menu above supplies `props.user`.
- `item({id, label, action, disabled?})` creates an ordinary command using Discord's menu item component. Call it inside a menu callback, after Bedrock has observed the component.
- API **1.5.1** allows submenu parents with `children` instead of an action. `leadingAccessory` and `trailingIndicator` pass Discord's icon descriptors through to the item.
- Callbacks run synchronously in registration order. A failed callback is logged and its changes are discarded. Existing sliders, submenus and other controls stay in the menu tree, including when Native Menus reads that tree.
- Registration returns a disposer and is removed when the renderer context stops. Already open menus close through Discord's usual behavior; removing a hook affects subsequent renders.

#### Sending and editing messages

```js
export function start(ctx) {
    ctx.messages.beforeSend(async event => {
        event.message.content = await transform(event.message.content);
        if (!event.message.content.trim()) event.cancel();
    });
    ctx.messages.beforeEdit(event => {
        event.message.content = event.message.content.replaceAll(':wave:', '\u{1F44B}');
    });
}
```

- Both events supply `channelId`, `message.content`, `signal` and `cancel()`. Edits also supply `messageId`.
- API **1.6.0** adds `options.stickerIds` to send events. Replace the array or edit it to change the selected stickers; set it to `[]` to send without stickers. Edit events do not have `options`.
- Bedrock awaits callbacks in registration order and sends the final content after they finish. Other message fields and action arguments are preserved.
- Each callback gets its own copy of the sticker array. Successful changes pass to subsequent callbacks and Discord without changing the caller's options.
- `cancel()` prevents the action and rejects it with `BedrockMessageCancelledError`. A thrown error also prevents the action and is logged with the plugin ID. Avoid waiting indefinitely in a hook, since the action waits with it.
- Registration returns a disposer. If a hook is removed while awaiting work, its late changes and cancellation are ignored. Respect `event.signal` to cancel your own outstanding work when the context stops.

These adapters observe Discord's send/edit and context-menu action exports as modules execute. They depend on those internal action shapes. Functions captured before Bedrock observes their exports, and frozen nonwritable data properties, cannot be intercepted this way.

#### Message accessories and chat buttons

API **1.7.0** adds buttons to the message hover toolbar:

```js
ctx.messages.addButton('translate', ({ message, channel, signal }) => {
    if (!message.content) return null;
    return {
        label: 'Translate',
        icon: TranslateIcon,
        onClick: () => translateMessage(message, signal)
    };
});
```

The factory receives the message, available channel and activation signal. Return `null` to hide the button. Definitions contain `label`, an icon component, `onClick` and an optional `disabled` flag. Bedrock uses Discord's toolbar button component and reports click errors through the plugin logger. Factories can use React hooks.

Registration returns a disposer. Removing a registration updates open toolbars, and stale buttons cannot start new actions. Async handlers should respect `signal` to cancel their outstanding work. An optional `{order}` argument controls ordering among plugin buttons.

API **1.8.0** adds an optional `onContextMenu(event)` handler for right-click actions. It supports async callbacks and uses the same error reporting and activation checks as `onClick`. Call `event.preventDefault()` to suppress the normal context menu; call `event.stopPropagation()` if the message should not also handle the event.

API **1.5.0** adds React components to the message accessories area and the chat input's button row:

```js
export function start(ctx) {
    ctx.messages.addAccessory('message-id', props =>
        ctx.react.createElement('small', null, props.message.id));

    ctx.chatBar.addButton('channel-info', props => ctx.chatBar.button({
        label: 'Show channel ID',
        icon: ctx.react.createElement('svg', { viewBox: '0 0 24 24', fill: 'currentColor' },
            ctx.react.createElement('path', { d: 'M10 3h4v2h-4zm0 6h4v12h-4z' })),
        disabled: props.disabled,
        onClick: () => { ctx.notifications.show({ title: 'Channel ID', body: props.channel.id }); }
    }));
}
```

- `messages.addAccessory(id, Component, {order?})` receives Discord's accessory props, including `message`, and the plugin's `signal`.
- `chatBar.addButton(id, Component, {order?})` receives composer props, including `channel`, `disabled`, `isEmpty` and the plugin's `signal`. `chatBar.button({label, icon, onClick, disabled?, pressed?})` supplies a compact button with a tooltip and accessible label. Components can return their own elements instead.
- IDs are unique within each plugin and component category. Lower `order` values appear first; the default is zero. Equal values retain registration order.
- Both methods return disposers. Existing slots update when registrations change, without requiring you to scroll away or reopen the channel. A component's rendering error is logged and isolated from other components.
- `ctx.react` is Discord's React instance. Read it inside your component, where React is available. Components can use its normal hooks; effect cleanup runs when they unmount. Creating another React instance can cause hook errors.

Bedrock owns the source hooks that provide these slots. Removing a registration does not require a restart. The integration depends on Discord's rendering code; `Bedrock.debug.status().rendererUi` reports its patch states and registration counts.

#### Local slash commands

API **1.5.0** commands appear with Discord's built-in slash commands and execute locally:

```js
export function start(ctx) {
    ctx.commands.register({
        name: 'example',
        description: 'Show a local notification',
        options: [{ name: 'text', description: 'Notification text', type: 'string', required: true }],
        async execute(values, context) {
            ctx.notifications.show({ title: 'Example', body: values.text });
        }
    });
}
```

- `commands.register(definition)` returns a disposer. Names use lowercase letters, digits, underscores or hyphens, up to 32 characters. Duplicate names are rejected, including names already used by Discord.
- Options declare `name`, `description`, `type`, optional `required`, and optional `choices: [{name, value}]`. Required options precede optional options. Types are `string`, `integer`, `number`, `boolean`, `user`, `channel`, `role`, `mentionable` and `attachment`. String and numeric options support choices.
- `execute(values, context)` receives values by option name, rather than an array. Strings, numbers and booleans are validated; user/channel/role/mentionable/attachment values are passed through from Discord. The context includes Discord's command context, `channelId` and the plugin's `signal`.
- Async callbacks are awaited. Failures are logged under the plugin's ID and shown in a local notification. Return values are ignored.
- Disabling removes the commands. A stale picker entry cannot execute a stopped plugin. Use `context.signal` to cancel work already in progress.

To send a message explicitly, call `await ctx.messages.send(channelId, {content: 'Hello'})`. This uses Discord's loaded message actions and runs registered `beforeSend` hooks. It rejects if those actions are unavailable or the caller's context has stopped.

#### Notifications

API **1.5.0** provides notifications inside the Discord window:

```js
const notice = ctx.notifications.show({
    title: 'Finished',
    body: 'The export is ready.',
    type: 'success',
    timeout: 5000,
    actions: [{ label: 'Open', onClick: () => openExport() }]
});
notice.close();
```

`title` is required. `body` is plain text; `type` is `info`, `success` or `error`. `timeout` is in milliseconds and defaults to five seconds; zero keeps the notification until dismissed. Optional `onClick` makes the title clickable. Action callbacks can be asynchronous, and errors are logged. All notifications have a dismiss button and are closed when their plugin context stops.

#### Source patches

Export `patches` from a JavaScript renderer entry point when an ordinary wrapper cannot reach the code you need to change. Source patches require API **1.4.0**.

```js
export const patches = [{
    id: 'example-label',
    find: 'a distinctive string in the target module',
    replacement: {
        match: /label:"Original label"/,
        replace: 'label:$self.label()'
    }
}];

export function label() { return 'Replacement label'; }
export function start(ctx) {}
```

The strings above illustrate the format; a real patch must match the current Discord source.

- `find` is a literal substring used to select a Webpack module factory. By default, a patch attempts the first matching factory. Set `all: true` to attempt every matching factory.
- `replacement` is one `{match, replace}` object or an array applied in order. Matches accept strings or regular expressions; replacements follow JavaScript's `String.replace` rules, including capture groups and replacement callbacks.
- `$self` in the resulting source refers to the plugin's exported namespace. Export any helpers referenced by a patch.
- Bedrock compiles each patch before accepting it. If a replacement misses or produces invalid code, that patch is discarded while earlier successful patches remain. Errors identify the plugin, patch and module.
- The plugin details page lists waiting, applied, failed and restart-required patches under **Source patches**. `Bedrock.plugins.list()` also exposes these diagnostics. Waiting can be normal for modules Discord loads on demand.

At startup, Bedrock imports enabled JavaScript renderer plugins and registers their patches before releasing queued Webpack startup callbacks. Settings are bound and the synchronous portion of `start(ctx)` runs first. Do not wait for Discord modules at module scope; use `ctx.webpack.waitFor()` inside `start()`. Startup continues after ten seconds if preparation stalls. A patch registered after its target factory has executed requires a restart.

An applied source patch cannot be undone by removing its rule: Discord has already created functions and objects from the changed code. Disabling such a plugin shows **Restart to disable** and keeps its renderer context, helpers and hooks running until restart. Removal and replacement are also deferred; `stop()` and `unload()` are not called on that retained renderer context. A patch that has not applied can be disabled normally. This exception concerns the renderer entry point; a separate main entry point follows its normal lifecycle.

Launch with `--devtools` to open renderer DevTools without editing Discord's settings or reopening the Node inspector. `Bedrock.debug.status()` reports settings hook counts, discovered React/layout types, and observed/cached module counts.

### Main APIs

```js
export function start(ctx) {
    ctx.windows.beforeCreate(options => { options.transparent = true; });
    ctx.windows.onCreated(window => ctx.log.info('Window', window.id));
}
```

`ctx.windows.beforeCreate(callback)` supplies mutable Electron BrowserWindow options before construction. `onCreated(callback)` receives newly created windows. Both return owned disposers. `all()` returns currently tracked windows. Window construction changes are applied to future windows. Enabling these hooks while windows exist, or removing an applied hook, displays a restart notice. Existing-window WinAPI changes, native titlebar handling, and a transparency plugin remain separate follow-up work. CSS comes from user plugins.

Main plugins run inside Discord's Node process and can import Node built-ins or use `Bedrock.require(request, import.meta.url)` to load a compatible `.node` addon. Plugins are trusted code, not sandboxed packages; there is no host-imposed catalogue or compilation requirement. Addons must match Electron's architecture and ABI.

## Verification

```powershell
npm ci --prefix Runtime
npm run build --prefix Runtime
node --test Runtime/tests/*.test.cjs
.\Launcher\tests\smoke.ps1
npm install --prefix Runtime/tests/obj electron@42.7.1 react@18.3.1 react-dom@18.3.1
node Runtime/tests/obj/node_modules/electron/install.js
.\Runtime\tests\electron-smoke.ps1
.\Runtime\tests\electron-smoke.ps1 -ThroughInspector
.\Runtime\tests\addons-smoke.ps1
& .\Runtime\tests\obj\node_modules\electron\dist\electron.exe .\Runtime\tests\renderer-apis-smoke.cjs
& .\Runtime\tests\obj\node_modules\electron\dist\electron.exe .\Runtime\tests\renderer-ui-smoke.cjs
```

The Electron fixture checks the real sandboxed preload/context bridge, preserved existing preload, settings layout injection, rendered React switches, plugin cleanup and re-enable, live package updates and reinstalls, relative imports, cross-process settings/events, Markdown, and origin restriction. The isolated Electron and React dependencies are test-only. Tests use temporary data and do not launch or alter Discord.

The renderer API fixture checks early source patches with bound settings, async send/edit hooks, cancellation, React menu additions readable by Native Menus, and deferred removal of applied source patches.

The renderer UI fixture checks stateful accessories, registration changes, rendering errors, composer buttons, local command execution and explicit sending, notification actions and expiry, and cleanup when disabling and re-enabling.

## Initialization status

Use `ctx.reportStatus("Preparing resources")` during startup to describe the current task. The Plugins page shows this message while the plugin initializes. Longer tasks also appear in a compact panel when you are outside the Plugins page. Startup errors can be selected or copied from the plugin?s detail page; Retry disables and enables the plugin again.

## C# plugins

Main entry points use `runtime: "dotnet"` for desktop .NET; renderer entry points use `runtime: "dotnet-wasm"` for browser WebAssembly. Both declare a managed DLL path. The assembly declares its entry type and API requirement through an assembly-level `BedrockPlugin` attribute. See [the managed API](../Managed/README.md) and [the C# example](../Examples/dotnet/ExamplePlugin.cs).

The Electron smoke fixture also exercises Window Customization and Selectable Settings from the separate plugin collection. Build that collection first. It defaults to a sibling `bedrock-plugins` checkout; set `BEDROCK_PLUGINS_ROOT` to use another location.
