#pragma once

#include <QtGlobal>
#include <QStringList>

class QIODevice;

// One local client may hand the running window this many paths, and this
// many bytes of text. A longer line is not a file path: it is rejected
// before the host copies it.
inline constexpr qint64 IpcMaxPendingBytes = 1024 * 1024;
inline constexpr int IpcMaxPaths = 1000;

struct IpcTake {
    QStringList paths;
    int received = 0;
    qint64 consumed = 0;
    bool abort = false;
};

// Read the complete lines already buffered on device. received and consumed
// are what this connection has accepted so far. Over-long lines set abort
// and leave the unread bytes in the device.
IpcTake takeIpcLines(QIODevice *device, int received, qint64 consumed);
