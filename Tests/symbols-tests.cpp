#include <windows.h>
#include <gtest/gtest.h>
#include <cstring>
#include <string>
#include <vector>
#include <fstream>
#include <filesystem>
#include "../Native/PluginHost/symbols.h"

class SymbolsTest : public testing::Test {
protected:
    std::vector<BYTE> file = std::vector<BYTE>(0x1000);
    BYTE* module = nullptr;
    RUNTIME_FUNCTION functions[2] = {};
    std::string text;
    SymbolReference reference = {};
    BedrockSymbolError error = {};
    const std::vector<BYTE> code = { 0x48, 0x83, 0xec, 0x28, 0x66, 0x0f, 0x6f, 0x25,
        0x04, 0x03, 0x02, 0x01, 0x48, 0x83, 0xc4, 0x28, 0xc3 };

    void SetUp() override {
        module = static_cast<BYTE*>(VirtualAlloc(nullptr, 0x4000, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE));
        ASSERT_NE(module, nullptr);
        for (BYTE* image : { file.data(), module }) {
            auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(image);
            dos->e_magic = IMAGE_DOS_SIGNATURE; dos->e_lfanew = 0x80;
            auto* nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(image + 0x80);
            nt->Signature = IMAGE_NT_SIGNATURE; nt->FileHeader.Machine = IMAGE_FILE_MACHINE_AMD64;
            nt->FileHeader.SizeOfOptionalHeader = sizeof(IMAGE_OPTIONAL_HEADER64); nt->FileHeader.NumberOfSections = 1;
            nt->OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC; nt->OptionalHeader.SizeOfImage = 0x4000;
            auto* section = IMAGE_FIRST_SECTION(nt);
            section->VirtualAddress = 0x1000; section->PointerToRawData = 0x400;
            section->SizeOfRawData = 0x400; section->Misc.VirtualSize = 0x2000; section->Characteristics = IMAGE_SCN_MEM_EXECUTE;
        }
        memcpy(file.data() + 0x400, code.data(), code.size());
        memcpy(module + 0x1000, code.data(), code.size());
        module[0x1008] = 0x08; module[0x1009] = 0x07; module[0x100a] = 0x06; module[0x100b] = 0x05;
        module[0x3000] = 1;
        functions[0] = { 0x1000, 0x1000 + static_cast<DWORD>(code.size()), 0x3000 };
        functions[1] = { 0x2000, 0x2000 + static_cast<DWORD>(code.size()), 0x3000 };
        ASSERT_TRUE(RtlAddFunctionTable(functions, 2, reinterpret_cast<DWORD64>(module)));
        text = "MODULE windows x86_64 fixture fixture.pdb\nFUNC 1000 11 0 Fixture::method()\r\r\n";
        reference.image = file.data(); reference.image_size = file.size();
    }
    void* resolve(const char* name = "Fixture::method()") {
        reference.symbols = text.data(); reference.symbols_size = text.size();
        return symbol_resolve(&reference, module, name, &error);
    }
    void TearDown() override {
        reference.image = nullptr; reference.symbols = nullptr;
        symbol_close(&reference);
        if (module) { RtlDeleteFunctionTable(functions); VirtualFree(module, 0, MEM_RELEASE); }
    }
};

TEST_F(SymbolsTest, MasksAllFourRipDisplacementBytesWithOperandSizePrefix) {
    EXPECT_EQ(resolve(), module + 0x1000);
    EXPECT_EQ(error.code, BEDROCK_SYMBOL_OK);
    EXPECT_STREQ(error.message, "");
    EXPECT_EQ(resolve(), module + 0x1000);
}
TEST_F(SymbolsTest, NamesAreExactAndMissingNamesDifferFromMissingCode) {
    EXPECT_EQ(resolve("Fixture::Method()"), nullptr);
    EXPECT_EQ(error.code, BEDROCK_SYMBOL_NAME_NOT_FOUND);
    module[0x1000] = 0x90;
    EXPECT_EQ(resolve(), nullptr);
    EXPECT_EQ(error.code, BEDROCK_SYMBOL_TARGET_NOT_FOUND);
}
TEST_F(SymbolsTest, DistinctReferenceFunctionsWithOneNameAreAmbiguous) {
    text += "FUNC 2000 11 0 Fixture::method()\n";
    EXPECT_EQ(resolve(), nullptr);
    EXPECT_EQ(error.code, BEDROCK_SYMBOL_NAME_AMBIGUOUS);
}
TEST_F(SymbolsTest, DuplicateReferenceRecordsForTheSameFunctionAreAllowed) {
    text += "FUNC m 1000 11 0 Fixture::method()\n";
    EXPECT_EQ(resolve(), module + 0x1000);
}
TEST_F(SymbolsTest, MultipleTargetMatchesAreAmbiguous) {
    memcpy(module + 0x2000, module + 0x1000, code.size());
    EXPECT_EQ(resolve(), nullptr);
    EXPECT_EQ(error.code, BEDROCK_SYMBOL_TARGET_AMBIGUOUS);
}
TEST_F(SymbolsTest, RejectsIncorrectUnwindSize) {
    functions[0].EndAddress++;
    EXPECT_EQ(resolve(), nullptr);
    EXPECT_EQ(error.code, BEDROCK_SYMBOL_TARGET_INVALID);
}
TEST_F(SymbolsTest, RejectsUnsupportedInstructionsRatherThanGeneratingAnUnsafeMask) {
    file[0x400] = 0xc5;
    EXPECT_EQ(resolve(), nullptr);
    EXPECT_EQ(error.code, BEDROCK_SYMBOL_REFERENCE_INVALID);
}
TEST_F(SymbolsTest, ErrorOutputIsOptionalAndNullNamesAreRejected) {
    reference.symbols = text.data(); reference.symbols_size = text.size();
    EXPECT_EQ(symbol_resolve(&reference, module, "Fixture::method()", nullptr), module + 0x1000);
    EXPECT_EQ(resolve(nullptr), nullptr);
    EXPECT_EQ(error.code, BEDROCK_SYMBOL_INVALID_ARGUMENT);
}

TEST_F(SymbolsTest, HandlesFixedUd2TrapInstructions) {
    file[0x400] = module[0x1000] = 0x0f;
    file[0x401] = module[0x1001] = 0x0b;
    file[0x402] = module[0x1002] = 0x90;
    file[0x403] = module[0x1003] = 0x90;
    EXPECT_EQ(resolve(), module + 0x1000);
}

TEST_F(SymbolsTest, ReferenceSymbolsMustMatchTheExecutablePdbIdentity) {
    auto* nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(file.data() + 0x80);
    nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DEBUG] = { 0x1100, sizeof(IMAGE_DEBUG_DIRECTORY) };
    auto* debug = reinterpret_cast<IMAGE_DEBUG_DIRECTORY*>(file.data() + 0x500);
    debug->Type = IMAGE_DEBUG_TYPE_CODEVIEW; debug->SizeOfData = 24; debug->PointerToRawData = 0x540;
    memcpy(file.data() + 0x540, "RSDS", 4);
    const GUID guid = { 0x12345678, 0xabcd, 0xef01, { 0, 1, 2, 3, 4, 5, 6, 7 } };
    const DWORD age = 1;
    memcpy(file.data() + 0x544, &guid, sizeof(guid)); memcpy(file.data() + 0x554, &age, sizeof(age));
    text = "MODULE windows x86_64 12345678ABCDEF0100010203040506071 fixture.pdb\n";
    reference.symbols = text.data(); reference.symbols_size = text.size();
    EXPECT_TRUE(symbol_reference_valid(&reference));
    text[21] = '9';
    EXPECT_FALSE(symbol_reference_valid(&reference));
}

TEST(SymbolsIntegration, ResolvesSixFunctionsInSuppliedExecutableWithoutExecutingIt) {
    auto environment = [](const wchar_t* name) {
        std::wstring value(32768, L'\0');
        DWORD length = GetEnvironmentVariableW(name, value.data(), static_cast<DWORD>(value.size()));
        if (!length || length >= value.size()) return std::wstring();
        value.resize(length); return value;
    };
    const std::wstring targetPath = environment(L"BEDROCK_SYMBOL_TARGET");
    const std::wstring referencePath = environment(L"BEDROCK_SYMBOL_REFERENCE");
    if (targetPath.empty() || referencePath.empty()) GTEST_SKIP() << "Supply isolated file-analysis inputs to run this integration test.";
    auto read = [](const std::filesystem::path& path) {
        std::ifstream stream(path, std::ios::binary | std::ios::ate);
        if (!stream) return std::vector<BYTE>();
        std::vector<BYTE> bytes(static_cast<size_t>(stream.tellg()));
        stream.seekg(0); stream.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
        return bytes;
    };
    std::vector<BYTE> target = read(targetPath);
    std::vector<BYTE> image = read(std::filesystem::path(referencePath) / "electron.exe");
    std::vector<BYTE> symbols = read(std::filesystem::path(referencePath) / "electron.exe.sym");
    ASSERT_FALSE(target.empty()); ASSERT_FALSE(image.empty()); ASSERT_FALSE(symbols.empty());
    auto* dos = reinterpret_cast<IMAGE_DOS_HEADER*>(target.data());
    ASSERT_EQ(dos->e_magic, IMAGE_DOS_SIGNATURE);
    ASSERT_GE(dos->e_lfanew, 0);
    ASSERT_LT(static_cast<size_t>(dos->e_lfanew) + sizeof(IMAGE_NT_HEADERS64), target.size());
    auto* nt = reinterpret_cast<IMAGE_NT_HEADERS64*>(target.data() + dos->e_lfanew);
    ASSERT_EQ(nt->Signature, static_cast<DWORD>(IMAGE_NT_SIGNATURE));
    BYTE* module = static_cast<BYTE*>(VirtualAlloc(nullptr, nt->OptionalHeader.SizeOfImage, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
    ASSERT_NE(module, nullptr);
    memcpy(module, target.data(), nt->OptionalHeader.SizeOfHeaders);
    auto* sections = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; i++) {
        ASSERT_LE(static_cast<size_t>(sections[i].PointerToRawData) + sections[i].SizeOfRawData, target.size());
        ASSERT_LE(static_cast<size_t>(sections[i].VirtualAddress) + sections[i].SizeOfRawData, nt->OptionalHeader.SizeOfImage);
        memcpy(module + sections[i].VirtualAddress, target.data() + sections[i].PointerToRawData, sections[i].SizeOfRawData);
    }
    IMAGE_DATA_DIRECTORY exception = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXCEPTION];
    auto* functions = reinterpret_cast<PRUNTIME_FUNCTION>(module + exception.VirtualAddress);
    ASSERT_TRUE(RtlAddFunctionTable(functions, exception.Size / sizeof(RUNTIME_FUNCTION), reinterpret_cast<DWORD64>(module)));
    SymbolReference reference = {};
    reference.image = image.data(); reference.image_size = image.size();
    reference.symbols = reinterpret_cast<char*>(symbols.data()); reference.symbols_size = symbols.size();
    EXPECT_TRUE(symbol_reference_valid(&reference));
    const char* names[] = {
        "viz::SkiaRenderer::PrepareCanvasForRPDQ(const struct viz::SkiaRenderer::DrawRPDQParams & const, struct viz::SkiaRenderer::DrawQuadParams *)",
        "SkPaint::setBlendMode(SkBlendMode)",
        "viz::SkiaRenderer::DrawRPDQParams::ClearOutsideBackdropBounds(class SkCanvas *, const struct viz::SkiaRenderer::DrawQuadParams *)",
        "SkBlenders::Arithmetic(float,float,float,float,bool)",
        "SkCanvas::clipPath(SkPath const &,SkClipOp,bool)",
        "SkCanvas::clipRect(SkRect const &,SkClipOp,bool)"
    };
    for (const char* name : names) {
        BedrockSymbolError error = {};
        EXPECT_NE(symbol_resolve(&reference, module, name, &error), nullptr) << error.message;
    }
    reference.image = nullptr; reference.symbols = nullptr; symbol_close(&reference);
    RtlDeleteFunctionTable(functions); VirtualFree(module, 0, MEM_RELEASE);
}
