#include "regular_file.h"

#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

static bool openRegular(int directoryFd, const char *path, int extraFlags, struct RegularFile *out)
{
    if (!path || !out || path[0] == '\0') return false;
    // O_NONBLOCK so a FIFO swapped in for this path cannot stall the caller.
    // A regular file does not need it, and it is cleared before return.
    const int fd = ::openat(directoryFd, path, O_RDONLY | O_CLOEXEC | O_NONBLOCK | extraFlags);
    if (fd < 0) return false;
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size < 0) {
        ::close(fd);
        return false;
    }
    const int flags = fcntl(fd, F_GETFL);
    if (flags >= 0) fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
    out->fd = fd;
    out->size = static_cast<int64_t>(st.st_size);
    return true;
}

bool openRegularFile(const char *path, struct RegularFile *out)
{
    return openRegular(AT_FDCWD, path, 0, out);
}

bool openRegularFileAt(int directoryFd, const char *name, bool followLinks, struct RegularFile *out)
{
    if (directoryFd < 0 || !name || std::strchr(name, '/')) return false;
    return openRegular(directoryFd, name, followLinks ? 0 : O_NOFOLLOW, out);
}
