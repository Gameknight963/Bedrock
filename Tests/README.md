# Native tests

`BedrockTests` uses Google Test. It tests the same C fuse parser used by the launcher, with valid and malformed input. These tests do not start Discord or change its files.

Windows shutdown tests start isolated copies of the test executable. They cover graceful quit, missing or unresponsive bootstraps, and leaving processes at other paths alone. Child processes run in a separate helper mode before the test runner starts.

## Run in Visual Studio

- Open `Bedrock.slnx` and build `BedrockTests`.
- Open **Test → Test Explorer**, then choose **Run All**.
- Visual Studio's **Test Adapter for Google Test** component must be installed for Test Explorer. It is included in the Desktop development with C++ workload.

## Run from PowerShell

After building Debug / x64:

```powershell
.\Tests\bin\x64\Debug\BedrockTests.exe
```

Run one group with `--gtest_filter=FuseParsing.*`. Debug and Release support both x64 and Win32.

## What belongs here

- C/C++ unit tests go in this project. The C code remains C; the tests use C++.
- JavaScript unit tests remain in `Runtime/tests` using Node's test runner.
- The existing Node/Electron smoke scripts check the inspector and renderer together. Run those separately when changing the bootstrap or renderer.

Google Test's sources are pinned in `lib/googletest`, so building does not require downloading packages. The fuse parser and its unit tests use no WinAPI, leaving them usable in a future Linux test build.

## Symbol resolution

Windows x64 tests cover exact symbol names, address masking, ambiguous matches, reference identity and PE unwind boundaries. An optional integration test reads an executable from disk into a private test allocation; it never launches or injects into that executable. Set `BEDROCK_SYMBOL_TARGET` to the executable path and `BEDROCK_SYMBOL_REFERENCE` to a directory containing matching stock `electron.exe` and `electron.exe.sym`, then run `BedrockTests.exe`. Without those variables, the integration test is skipped.

## Native JavaScript integration

Build `Native/PluginHost/NativeController.vcxproj` and `Native/PluginHost/tests/JavaScriptFixture.vcxproj` as Release / x64. Run a stock Electron executable with `Native/PluginHost/tests/javascript-fixture.cjs` as its application path. Set `BEDROCK_TEST_CONFIGURATION=Debug` to test Debug builds instead.

The fixture uses a temporary profile and maps a test plugin into its own main, sandboxed renderer and GPU processes. It checks typed results, embedded NULs, BigInts, object identity, released handles, exceptions, async callbacks making sync calls, timeouts, disabling and re-enabling. It does not use Discord's profile or need Electron symbols. JavaScript-only bridge tests run with `node --test Runtime/tests/*.test.cjs`.
