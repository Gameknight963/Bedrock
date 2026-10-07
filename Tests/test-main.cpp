#include <gtest/gtest.h>

bool run_shutdown_child();

int main(int argc, char **argv)
{
    run_shutdown_child();
    testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
