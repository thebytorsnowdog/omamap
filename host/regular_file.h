#pragma once

#include <stdint.h>
#include <stdbool.h>

// A regular file opened for reading. The caller owns fd and must close it.
struct RegularFile {
    int fd;
    int64_t size;
};

#ifdef __cplusplus
extern "C" {
#endif

// Open path and keep it only when the resulting descriptor is a regular file.
// Symlinks are followed. FIFOs, devices, directories and broken links are
// rejected. The open does not block when the final inode is a FIFO.
// On success, out->size is the size of that inode at open time.
bool openRegularFile(const char *path, struct RegularFile *out);

#ifdef __cplusplus
}
#endif
