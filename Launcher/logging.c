#include <windows.h>
#include <stdio.h>

void launcher_logging_init(void)
{
    FILE *stream;
    AllocConsole();
    _wfreopen_s(&stream, L"CONOUT$", L"w", stdout);
    _wfreopen_s(&stream, L"CONOUT$", L"w", stderr);
    _wfreopen_s(&stream, L"CONIN$", L"r", stdin);
}
