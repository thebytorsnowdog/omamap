#include "regular_file.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

bool openRegularFile(const char *path, struct RegularFile *out)
{
    if (!path || !out || path[0] == '\0') return false;
    // O_NONBLOCK so a FIFO swapped in for this path cannot stall the caller.
    // A regular file does not need it, and it is cleared before return.
    const int fd = ::open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
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
