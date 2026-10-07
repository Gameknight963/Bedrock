#include <gtest/gtest.h>
#include "fuse.h"
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

namespace {
constexpr size_t SentinelSize = sizeof(FUSE_SENTINEL) - 1;

std::vector<uint8_t> MakeWire(const std::string &states = "001000011", uint8_t version = 1)
{
    std::vector<uint8_t> bytes(FUSE_SENTINEL, FUSE_SENTINEL + SentinelSize);
    bytes.push_back(version);
    bytes.push_back(static_cast<uint8_t>(states.size()));
    bytes.insert(bytes.end(), states.begin(), states.end());
    return bytes;
}

class InspectorState : public testing::TestWithParam<char> {};

TEST_P(InspectorState, ReadsWireWithoutChangingInput)
{
    std::string states = "001000011";
    states[FUSE_INSPECTOR_INDEX] = GetParam();
    auto bytes = MakeWire(states);
    bytes.insert(bytes.begin(), 17, 0xff);
    const auto original = bytes;
    FuseLocation fuse{};
    size_t offset = 0;
    ASSERT_EQ(FUSE_OK, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
    EXPECT_EQ(17 + SentinelSize + 2, offset);
    EXPECT_EQ(1, fuse.version);
    EXPECT_EQ(states.size(), fuse.count);
    EXPECT_EQ(states, std::string(fuse.wire, fuse.wire + fuse.count));
    EXPECT_EQ(original, bytes);
}

INSTANTIATE_TEST_SUITE_P(EnabledAndDisabled, InspectorState, testing::Values('0', '1'));

TEST(FuseParsing, MissingAndPartialSentinelsAreRejected)
{
    FuseLocation fuse{};
    size_t offset = 0;
    EXPECT_EQ(FUSE_NOT_FOUND, fuse_find_wire(nullptr, 0, &fuse, &offset));
    const std::string partial(FUSE_SENTINEL, SentinelSize - 1);
    EXPECT_EQ(FUSE_NOT_FOUND, fuse_find_wire(reinterpret_cast<const uint8_t *>(partial.data()), partial.size(), &fuse, &offset));
}

TEST(FuseParsing, DuplicateSentinelsAreRejected)
{
    auto bytes = MakeWire();
    const auto second = MakeWire();
    bytes.insert(bytes.end(), second.begin(), second.end());
    FuseLocation fuse{};
    size_t offset = 0;
    EXPECT_EQ(FUSE_AMBIGUOUS, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
}

TEST(FuseParsing, EveryTruncationAfterSentinelIsRejected)
{
    const auto bytes = MakeWire();
    for (size_t length = SentinelSize; length < bytes.size(); ++length) {
        SCOPED_TRACE(length);
        FuseLocation fuse{};
        size_t offset = 0;
        EXPECT_EQ(FUSE_TRUNCATED, fuse_find_wire(bytes.data(), length, &fuse, &offset));
    }
}

TEST(FuseParsing, UnknownVersionAndMissingInspectorSettingAreRejected)
{
    for (const auto &bytes : {MakeWire("001000011", 2), MakeWire("001")}) {
        FuseLocation fuse{};
        size_t offset = 0;
        EXPECT_EQ(FUSE_UNSUPPORTED, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
    }
}

TEST(FuseParsing, InvalidStateAndRemovedInspectorAreRejected)
{
    auto bytes = MakeWire("001x00011");
    FuseLocation fuse{};
    size_t offset = 0;
    EXPECT_EQ(FUSE_INVALID_STATE, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
    bytes = MakeWire("001r00011");
    EXPECT_EQ(FUSE_INSPECTOR_REMOVED, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
}

TEST(FuseParsing, RemovedUnrelatedSettingsAreAllowed)
{
    const auto bytes = MakeWire("r010r0011");
    FuseLocation fuse{};
    size_t offset = 0;
    EXPECT_EQ(FUSE_OK, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
}

TEST(FuseParsing, MaximumWireFitsAndOversizedDeclarationIsRejected)
{
    auto bytes = MakeWire(std::string(255, '1'));
    FuseLocation fuse{};
    size_t offset = 0;
    ASSERT_EQ(FUSE_OK, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
    EXPECT_EQ(255, fuse.count);
    EXPECT_TRUE(std::all_of(std::begin(fuse.wire), std::end(fuse.wire), [](uint8_t state) { return state == '1'; }));
    bytes.pop_back();
    EXPECT_EQ(FUSE_TRUNCATED, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
}

TEST(FuseParsing, FailureLeavesOutputUntouched)
{
    const auto bytes = MakeWire("001x00011");
    FuseLocation fuse;
    std::memset(&fuse, 0xa5, sizeof(fuse));
    FuseLocation original;
    std::memcpy(&original, &fuse, sizeof(fuse));
    size_t offset = 123;
    EXPECT_EQ(FUSE_INVALID_STATE, fuse_find_wire(bytes.data(), bytes.size(), &fuse, &offset));
    EXPECT_EQ(0, std::memcmp(&original, &fuse, sizeof(fuse)));
    EXPECT_EQ(size_t{123}, offset);
}
}
