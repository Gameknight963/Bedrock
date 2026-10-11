# Third-party notices

Bedrock's own code is licensed under the [MIT license](LICENSE). The dependencies below retain their own licenses. Include this file when distributing Bedrock binaries.

| Dependency | License | Used by |
| --- | --- | --- |
| .NET browser WASM runtime | MIT and included dependency notices | Shared renderer runtime for C# plugins |
| jsmn | MIT | Launcher and native plugin IPC JSON parsing |
| Google Test v1.18.0 | BSD-3-Clause | Native tests only; not linked into the launcher |
| Node.js v24.0.0 Node-API headers | MIT | SDK headers and native test fixtures |
| SkiaSharp 4.153.1 | MIT | Backdrop blur experiment only; restored through NuGet |
| Skia | BSD-3-Clause | SkiaSharp experiment |
| Simple Manual Map Injector | MIT | Native plugin controller |
| MinHook v1.3.4 | BSD-2-Clause | Native symbol decoder and SDK dependency |

The backdrop blur experiment uses [SkiaSharp](https://github.com/mono/SkiaSharp/blob/main/LICENSE.txt) and its native [Skia](https://github.com/google/skia/blob/main/LICENSE) dependency. SkiaSharp and its native library are not included in Bedrock's launcher or plugins. Their licenses and additional native dependency notices must accompany any separately distributed experiment binaries.

Separately distributed plugins maintain their dependency notices in the [plugin collection](https://github.com/bedrock-client/bedrock-plugins/blob/main/THIRD_PARTY_NOTICES.md).

## Simple Manual Map Injector

- Source: [TheCruZ/Simple-Manual-Map-Injector](https://github.com/TheCruZ/Simple-Manual-Map-Injector/tree/c28a45e6ceee9acb1cf25cfeee9bdd707c6a78ea)
- Vendored files: `lib/manual-map`
- Commit: `c28a45e6ceee9acb1cf25cfeee9bdd707c6a78ea`
- License: [lib/manual-map/LICENSE](lib/manual-map/LICENSE). Copied into distributed plugins as `manual-map-LICENSE.txt`.
- Local integration changes are described in [lib/manual-map/README.md](lib/manual-map/README.md).

## MinHook v1.3.4

- Source: [TsudaKageyu/minhook](https://github.com/TsudaKageyu/minhook/tree/c3fcafdc10146beb5919319d0683e44e3c30d537)
- Vendored files: `lib/minhook`
- Commit: `c3fcafdc10146beb5919319d0683e44e3c30d537`
- License and included disassembler notices: [lib/minhook/LICENSE.txt](lib/minhook/LICENSE.txt). This file must accompany the native host, which uses MinHook?s HDE64 instruction decoder.

## jsmn

- Source: [zserge/jsmn](https://github.com/zserge/jsmn/tree/25647e692c7906b96ffd2b05ca54c097948e879c)
- Vendored files: `lib/jsmn`
- Commit: `25647e692c7906b96ffd2b05ca54c097948e879c`

```text
Copyright (c) 2010 Serge A. Zaitsev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Google Test v1.18.0

- Source: [google/googletest](https://github.com/google/googletest/tree/063de7e9578f82b369302001269680b4b1553359)
- Vendored files: `lib/googletest`
- Commit: `063de7e9578f82b369302001269680b4b1553359`

```text
Copyright 2008, Google Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
    * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Node-API headers

Source: [Node.js v24.0.0](https://github.com/nodejs/node/tree/v24.0.0/src). Vendored headers: `lib/node-api`.

```text
Node.js is licensed for use as follows:

"""
Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""

This license applies to parts of Node.js originating from the
https://github.com/joyent/node repository:

"""
Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""

The Node.js license applies to all parts of Node.js that are not externally
maintained libraries.
```

The managed runtime is built from the .NET SDK browser runtime pack. Distributions include its LICENSE.TXT and THIRD-PARTY-NOTICES.TXT under Runtime/dotnet/licenses.
