#include <windows.h>
#include <gtest/gtest.h>
#include <string>
#include "shutdown.h"

bool run_shutdown_child()
{
    const std::wstring command = GetCommandLineW();
    const auto marker = command.find(L"--bedrock-ready=");
    if (marker == std::wstring::npos) return false;
    HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, command.substr(marker + 16).c_str());
    if (!ready) ExitProcess(90);
    const bool pipeEnabled = command.find(L"--bedrock-pipe") != std::wstring::npos;
    const bool ignore = command.find(L"--bedrock-ignore") != std::wstring::npos;
    HANDLE pipe = INVALID_HANDLE_VALUE;
    if (pipeEnabled) {
        const auto name = L"\\\\.\\pipe\\Bedrock-" + std::to_wstring(GetCurrentProcessId());
        pipe = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_INBOUND, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 128, 128, 0, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) ExitProcess(91);
    }
    SetEvent(ready);
    CloseHandle(ready);
    if (!pipeEnabled) Sleep(INFINITE);
    if (!ConnectNamedPipe(pipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) ExitProcess(92);
    char commandBytes[5];
    DWORD length = 0;
    if (!ReadFile(pipe, commandBytes, sizeof(commandBytes), &length, nullptr) || length != 5 ||
        std::string(commandBytes, length) != "quit\n") ExitProcess(93);
    CloseHandle(pipe);
    if (ignore) Sleep(INFINITE);
    ExitProcess(42);
}

class ShutdownTest : public testing::Test {
protected:
    std::wstring executable;
    PROCESS_INFORMATION child{};
    HANDLE ready = nullptr;

    void SetUp() override {
        wchar_t temp[MAX_PATH], source[32768];
        ASSERT_GT(GetTempPathW(MAX_PATH, temp), 0u);
        ASSERT_GT(GetModuleFileNameW(nullptr, source, 32768), 0u);
        executable = std::wstring(temp) + L"Bedrock-shutdown-test-" + std::to_wstring(GetCurrentProcessId()) +
            L"-" + std::to_wstring(GetTickCount64()) + L".exe";
        ASSERT_TRUE(CopyFileW(source, executable.c_str(), TRUE));
    }

    void Spawn(const wchar_t *mode) {
        const auto eventName = L"Local\\Bedrock-shutdown-test-" + std::to_wstring(GetCurrentProcessId()) +
            L"-" + std::to_wstring(GetTickCount64());
        ready = CreateEventW(nullptr, TRUE, FALSE, eventName.c_str());
        ASSERT_NE(ready, nullptr);
        auto command = L"\"" + executable + L"\" " + mode + L" --bedrock-ready=" + eventName;
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        ASSERT_TRUE(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
            CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child));
        ASSERT_EQ(WaitForSingleObject(ready, 5000), WAIT_OBJECT_0);
    }

    void TearDown() override {
        if (child.hProcess) {
            if (WaitForSingleObject(child.hProcess, 0) == WAIT_TIMEOUT) TerminateProcess(child.hProcess, 99);
            WaitForSingleObject(child.hProcess, 3000);
            CloseHandle(child.hProcess);
            CloseHandle(child.hThread);
        }
        if (ready) CloseHandle(ready);
        if (!executable.empty()) DeleteFileW(executable.c_str());
    }

    DWORD ExitCode() {
        DWORD code = STILL_ACTIVE;
        GetExitCodeProcess(child.hProcess, &code);
        return code;
    }
};

TEST_F(ShutdownTest, NoMatchingProcess)
{
    EXPECT_EQ(shutdown_discord(executable.c_str()), 1);
}

TEST_F(ShutdownTest, GracefulQuit)
{
    Spawn(L"--bedrock-pipe");
    ASSERT_NE(child.hProcess, nullptr);
    EXPECT_EQ(shutdown_discord(executable.c_str()), 1);
    EXPECT_EQ(ExitCode(), 42u);
}

TEST_F(ShutdownTest, MissingBootstrapForcesTermination)
{
    Spawn(L"");
    ASSERT_NE(child.hProcess, nullptr);
    EXPECT_EQ(shutdown_discord(executable.c_str()), 1);
    EXPECT_EQ(ExitCode(), 1u);
}

TEST_F(ShutdownTest, SameFilenameInAnotherDirectoryIsUntouched)
{
    Spawn(L"");
    ASSERT_NE(child.hProcess, nullptr);
    const auto slash = executable.find_last_of(L'\\');
    const auto otherPath = executable.substr(0, slash + 1) + L"other\\" + executable.substr(slash + 1);
    EXPECT_EQ(shutdown_discord(otherPath.c_str()), 1);
    EXPECT_EQ(ExitCode(), static_cast<DWORD>(STILL_ACTIVE));
}

TEST_F(ShutdownTest, UnresponsiveBootstrapTimesOut)
{
    Spawn(L"--bedrock-pipe --bedrock-ignore");
    ASSERT_NE(child.hProcess, nullptr);
    const auto start = GetTickCount64();
    EXPECT_EQ(shutdown_discord(executable.c_str()), 1);
    EXPECT_GE(GetTickCount64() - start, 1800u);
    EXPECT_EQ(ExitCode(), 1u);
}
