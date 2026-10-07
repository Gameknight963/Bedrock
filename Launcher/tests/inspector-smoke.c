#include "../inspector.h"
#include <stdio.h>
#include <stdlib.h>

int wmain(int argc, wchar_t **argv)
{
    HINTERNET session;
    wchar_t endpoint[512];
    INTERNET_PORT port;
    DWORD pid;
    int result;
    if (argc != 3 && argc != 4) return 2;
    port = (INTERNET_PORT)wcstoul(argv[1], NULL, 10);
    pid = wcstoul(argv[2], NULL, 10);
    session = WinHttpOpen(L"BedrockInspectorSmoke", WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return 2;
    WinHttpSetTimeouts(session, 500, 500, 500, 500);
    result = inspector_endpoint(session, port, endpoint, 512) &&
        (argc == 4 ? inspector_bootstrap(session, port, endpoint, pid, argv[3]) : inspector_test(session, port, endpoint, pid));
    WinHttpCloseHandle(session);
    return result ? 0 : 1;
}
