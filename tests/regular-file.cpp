#include "regular_file.h"

#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <csignal>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <string>

static int fail(const char *label)
{
    std::fprintf(stderr, "%s\n", label);
    return 1;
}

static void onAlarm(int)
{
    std::fprintf(stderr, "openRegularFile blocked\n");
    std::_Exit(1);
}

static bool rejectedQuickly(const char *path)
{
    const auto started = std::chrono::steady_clock::now();
    RegularFile opened{};
    const bool ok = openRegularFile(path, &opened);
    const auto elapsed = std::chrono::steady_clock::now() - started;
    if (ok) {
        ::close(opened.fd);
        return false;
    }
    return elapsed < std::chrono::milliseconds(200);
}

int main()
{
    std::signal(SIGALRM, onAlarm);
    alarm(5);

    char dir[] = "/tmp/omamap-reg-XXXXXX";
    if (!mkdtemp(dir)) return fail("mkdtemp");
    const std::string root(dir);
    const std::string file = root + "/data.bin";
    const std::string link = root + "/link.bin";
    const std::string fifo = root + "/queue";
    const std::string fifoLink = root + "/queue-link";
    const std::string replaced = root + "/replaced.bin";

    {
        const int fd = ::open(file.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
        if (fd < 0 || ::write(fd, "hello", 5) != 5) return fail("write sample");
        ::close(fd);
    }
    RegularFile opened{};
    {
        const int empty = ::open((root + "/empty.bin").c_str(), O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
        if (empty < 0) return fail("create empty");
        ::close(empty);
    }
    if (!openRegularFile((root + "/empty.bin").c_str(), &opened) || opened.size != 0) return fail("empty file opens");
    ::close(opened.fd);
    if (!openRegularFile(file.c_str(), &opened) || opened.size != 5) return fail("regular file opens");
    char buf[8] = {};
    if (::read(opened.fd, buf, sizeof buf) != 5 || std::memcmp(buf, "hello", 5) != 0) return fail("regular file reads");
    ::close(opened.fd);

    if (openRegularFile(root.c_str(), &opened)) return fail("directory rejected");
    if (openRegularFile((root + "/missing").c_str(), &opened)) return fail("missing path rejected");
    if (openRegularFile("/dev/null", &opened)) return fail("device rejected");

    if (mkfifo(fifo.c_str(), 0600) != 0) return fail("mkfifo");
    // A blocking open of this FIFO does not return. The helper must.
    const pid_t child = fork();
    if (child < 0) return fail("fork");
    if (child == 0) {
        const int fd = ::open(fifo.c_str(), O_RDONLY);
        std::_Exit(fd < 0 ? 1 : 0);
    }
    usleep(200 * 1000);
    int status = 0;
    const pid_t done = waitpid(child, &status, WNOHANG);
    if (done != 0) return fail("blocking open returned");
    kill(child, SIGKILL);
    waitpid(child, &status, 0);
    if (!rejectedQuickly(fifo.c_str())) return fail("fifo rejected without blocking");

    if (symlink(file.c_str(), link.c_str()) != 0) return fail("symlink");
    if (!openRegularFile(link.c_str(), &opened) || opened.size != 5) return fail("symlink to a regular file opens");
    ::close(opened.fd);
    if (symlink(fifo.c_str(), fifoLink.c_str()) != 0) return fail("fifo symlink");
    if (!rejectedQuickly(fifoLink.c_str())) return fail("symlink to a fifo rejected without blocking");

    {
        const int fd = ::open(replaced.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
        if (fd < 0 || ::write(fd, "kept", 4) != 4) return fail("write replaced");
        ::close(fd);
    }
    if (!openRegularFile(replaced.c_str(), &opened) || opened.size != 4) return fail("open before swap");
    if (unlink(replaced.c_str()) != 0 || mkfifo(replaced.c_str(), 0600) != 0) return fail("swap path for a fifo");
    char kept[8] = {};
    if (::read(opened.fd, kept, sizeof kept) != 4 || std::memcmp(kept, "kept", 4) != 0) return fail("open descriptor keeps the original inode");
    ::close(opened.fd);

    unlink((root + "/empty.bin").c_str());
    unlink(file.c_str());
    unlink(link.c_str());
    unlink(fifo.c_str());
    unlink(fifoLink.c_str());
    unlink(replaced.c_str());
    rmdir(dir);
    return 0;
}
