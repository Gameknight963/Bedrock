import { dotnet } from './_framework/dotnet.js';

function check(condition, message) {
    if (!condition) throw new Error(message);
}

let stage = 'runtime startup';
try {
    const start = performance.now();
    let runtimeCreations = 0;
    const runtime = await dotnet.withDiagnosticTracing(false).create();
    runtimeCreations++;
    stage = 'host exports';
    const host = (await runtime.getAssemblyExports('Host')).Host;
    stage = 'host assembly enumeration';
    const before = host.LoadedAssemblies();
    check(!before.includes('IndependentPlugin') && !before.includes('SecondPlugin'), 'A plugin was already loaded with the host.');
    stage = 'host GC statistics';
    const baselineManagedBytes = host.ManagedBytes();
    const baselineWasmLinearMemoryBytes = runtime.Module?.HEAPU8?.buffer.byteLength ?? null;
    runtime.setModuleImports('bedrock-test', {
        add: (left, right) => left + right,
        addAsync: async (left, right) => left + right,
        writeText: text => { document.querySelector('#output').textContent = text; }
    });
    const load = async name => {
        const response = await fetch(`./plugins/${name}.dll`);
        check(response.ok, 'Could not fetch the independent plugin.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        stage = 'loading ' + name;
        check(host.LoadPlugin(bytes) === name, 'Assembly.Load returned the wrong assembly.');
        stage = 'exports for ' + name;
        return (await runtime.getAssemblyExports(name)).ExamplePlugin;
    };
    const first = await load('IndependentPlugin');
    stage = 'synchronous interop';
    check(first.RoundTrip(40) === 42, 'JS -> C# -> JS -> C# -> JS failed.');
    stage = 'asynchronous interop';
    check(await first.AsyncRoundTrip(40) === 42, 'Async interop failed.');
    stage = 'DOM interop';
    first.UpdatePage('C# updated this page');
    check(document.querySelector('#output').textContent === 'C# updated this page', 'C# could not update the DOM through its JS import.');
    stage = 'JSObject interop';
    const object = { answer: 42 };
    check(first.Echo(object) === object && object.seenByCSharp === true, 'JSObject did not preserve object identity or property access.');
    check(first.Increment() === 1, 'First plugin did not have its own static state.');
    const second = await load('SecondPlugin');
    check(second.RoundTrip(40) === 42, 'Second plugin could not use the existing runtime and imports.');
    check(second.Increment() === 1 && first.Increment() === 2, 'Separate assemblies did not retain separate static state.');
    check(runtimeCreations === 1, 'More than one runtime was created.');
    globalThis.fixtureResult = {
        passed: true,
        runtimeCreations,
        before,
        after: host.LoadedAssemblies(),
        baselineManagedBytes,
        baselineWasmLinearMemoryBytes,
        loadedManagedBytes: host.ManagedBytes(),
        wasmLinearMemoryBytes: runtime.Module?.HEAPU8?.buffer.byteLength ?? null,
        elapsedMs: Math.round(performance.now() - start),
        checks: ['dynamic default-context assembly loading', 'JSImport', 'JSExport', 'async interop', 'DOM update', 'JSObject identity', 'two plugins sharing one runtime', 'independent static state']
    };
} catch (error) {
    globalThis.fixtureResult = { passed: false, stage, error: String(error.stack || error) };
}
