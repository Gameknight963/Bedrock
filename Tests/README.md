# Native tests

`BedrockTests` uses Google Test. It tests the same C fuse parser used by the launcher, with valid and malformed input. These tests do not start Discord or change its files.

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
