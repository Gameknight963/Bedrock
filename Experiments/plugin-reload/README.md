# Plugin reloading

This experiment investigates replacing JavaScript plugins without restarting Discord. It uses a separate Electron fixture and temporary plugin files. It does not change Bedrock's runtime or launch Discord.

## Findings

Tested with Electron 42.7.1 / Node 24.18.0. The internal-cache test also passed on standalone Node 25.9.0.

- Both Node and Chromium keep previously imported modules when their files change.
- Changing only the entry module's query string does not reload its imported helper modules.
- Deleting Node's internal `loadCache` entries, plus the CommonJS entries used by `require(esm)`, reloads the entry and its helper. Thirty cycles passed.
- Access to that internal loader requires exposing Node internals in this test. Ordinary Electron application code received `MODULE_NOT_FOUND`. This test does not establish how to access it inside Discord, and it does not solve Chromium's cache.

## Working approach

`compiler.cjs` uses esbuild to combine an entry point and its local imports into an in-memory function. Evaluating that function creates a fresh module instance. Bedrock could retain that instance across enable/disable, then discard it after unloading and compile a replacement after an update.

The generated code executes in the existing main or renderer environment. It can use the renderer's DOM and globals, or Node and Electron imports in main. No worker, page reload, revision folder, or cache-busting query is used for this approach. esbuild does use a separate compiler service process during compilation.

Thirty replacements passed in each process, checking:

- Updated entry and helper code, fresh mutable module state, and live bindings.
- A circular import whose exported function is called after initialization.
- Literal relative dynamic imports.
- Original `import.meta.url` values, including URL-relative file access in main.
- Main Node/Electron imports and renderer DOM access.
- Explicit start, stop and unload callbacks, with removal of the fixture's global side effects.

## Limits

- This introduces an esbuild dependency. Compilation could happen locally or during package publication; that is a packaging decision rather than something this experiment implements.
- Top-level `await` is rejected by this output format. Async lifecycle methods and the tested dynamic imports work. Renderer plugins that currently use top-level `await` would need a different compilation strategy or an API restriction.
- Computed dynamic imports are not tested and may still reach the environment's normal module loader. Production code must handle or reject these rather than claim complete ownership of every import.
- The renderer URL mapping is specific to this fixture. Production must preserve each file's complete package URL, including subdirectories.
- Bundled execution is not identical to native ESM in every detail. This test covers one safe circular dependency, not all cycle and initialization semantics.
- Dropping the module instance does not clean up arbitrary timers, callbacks, native resources or references held elsewhere. Plugins remain responsible for their lifecycle cleanup. Memory reclamation was not measured.
- Native addons should continue to use Bedrock's managed addon loader. Their unloading requirements are unchanged.

## Running

Install the experiment's pinned dependency with `npm install`, then run `./run.ps1`. It uses Bedrock's existing Electron test fixture. Results are written to `runs/result.json`; output logs are also under `runs`.

Run `node --expose-internals node-internals.cjs` for the separate internal-cache test. Its successful results do not establish a supported public cache API.

## Direction

The compilation approach is a working candidate shared by main and renderer. It avoids manipulating two different module caches, but it changes loading semantics and adds a dependency. It should not replace the production loader until those tradeoffs are accepted and the remaining import cases are covered.
