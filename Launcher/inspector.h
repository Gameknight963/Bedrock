#ifndef BEDROCK_INSPECTOR_H
#define BEDROCK_INSPECTOR_H

#include <windows.h>
#include <winhttp.h>

int inspector_endpoint(HINTERNET session, INTERNET_PORT port, wchar_t *endpoint, size_t capacity);
int inspector_test(HINTERNET session, INTERNET_PORT port, const wchar_t *endpoint, DWORD expected_pid);
int inspector_bootstrap(HINTERNET session, INTERNET_PORT port, const wchar_t *endpoint, DWORD expected_pid, const wchar_t *bootstrap_path);

#endif
