# Chromium module-cache investigation

This experiment uses a hidden Electron fixture, not Discord. It changes a helper module's response from version 1 to version 2, then tries clearing caches before importing the same entry URL again.

Run `./run.ps1` using Bedrock's existing Electron test installation. The report and logs are under `runs`.

## Results

Tested on Electron 42.7.1, Chromium 148.0.7778.280, in a sandboxed renderer with context isolation enabled.

These operations all returned the previously loaded module, without another module request:

- Responses with `Cache-Control: no-store`.
- Electron `session.clearCache()`.
- Electron `session.clearCodeCaches()` for both module URLs.
- Electron `webFrame.clearCache()`.
- DevTools `Network.clearBrowserCache`.
- DevTools `Network.setCacheDisabled`.

Those caches are separate from the already instantiated module graph. Clearing downloaded files or compiled code does not make the current page forget a loaded module.

## Chromium implementation

In this Chromium build, [`blink::ModuleMap`](https://github.com/chromium/chromium/blob/148.0.7778.280/third_party/blink/renderer/core/script/module_map.h#L45-L58) stores modules by URL and type in a private map. Its interface supports fetching, looking up and adding modules, with no public removal method.

[`Modulator::ClearModulator()`](https://github.com/chromium/chromium/blob/148.0.7778.280/third_party/blink/renderer/core/script/modulator.cc#L58-L62) removes the context's entire Modulator object from its per-context data. A subsequent `Modulator::From()` can create a new one. This is a native internal function, not a JavaScript or Electron API. It is a candidate for further native research, not a tested live-reset solution.

The Modulator also owns module-record resolution state. The resolver's [`GetModuleScriptFromModuleRecord()`](https://github.com/chromium/chromium/blob/148.0.7778.280/third_party/blink/renderer/core/script/module_record_resolver_impl.cc#L42-L51) requires registered module records to remain present. Clearing all that state while existing modules remain alive needs investigation; finding a function named Clear is insufficient to establish that it is safe.

## Context replacement

A new Electron isolated world imports fresh entry and helper code at the same URLs. It shares the document's DOM but has different JavaScript globals. It does not invalidate the main world's modules, and it would change how plugins access Discord's JavaScript objects. Reusing the same isolated world still returns its cached module.

A new document also imports the updated modules, but resets the page's globals. This is the ordinary page-reload route, rather than targeted invalidation. It does not require restarting the Electron application.

## Conclusion

No public targeted invalidation mechanism was found. The tested cache-clearing APIs do not work for this purpose. Native modification of Blink's module state remains a possible research direction; this experiment neither implements nor establishes the safety of that approach. Production files are unchanged.
