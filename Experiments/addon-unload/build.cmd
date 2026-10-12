@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /LD /O2 /MT /I..\..\Bedrock\lib\node-api probe.c /link /out:probe.node
if errorlevel 1 exit /b 1
cl /nologo /LD /O2 /MT /DFIXTURE_VERSION=1 /I..\..\Bedrock\lib\node-api fixture.c /link /out:fixture-v1.node
if errorlevel 1 exit /b 1
cl /nologo /LD /O2 /MT /DFIXTURE_VERSION=2 /I..\..\Bedrock\lib\node-api fixture.c /link /out:fixture-v2.node
if errorlevel 1 exit /b 1
cl /nologo /LD /O2 /MT /DFIXTURE_VERSION=1 /DUNSAFE_CLEANUP /I..\..\Bedrock\lib\node-api fixture.c /link /out:fixture-unsafe-cleanup.node
if errorlevel 1 exit /b 1
cl /nologo /LD /O2 /MT /DFIXTURE_VERSION=1 /DUNSAFE_FINALIZER /I..\..\Bedrock\lib\node-api fixture.c /link /out:fixture-unsafe-finalizer.node
