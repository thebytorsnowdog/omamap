#pragma once

#include <QByteArray>
#include <QStringList>

// Transport bound. The import limit is applied after companion discovery.
inline constexpr qsizetype IpcMaxPendingBytes = 1024 * 1024;

struct IpcTake {
    QStringList paths;
    QString error;
    bool complete = false;
};

// Percent-encoded file URLs, one per line, with a NUL terminator for the
// batch. A client waits for one result line before exiting.
bool makeIpcMessage(const QStringList &paths, QByteArray &message);
IpcTake takeIpcMessage(QByteArray &pending, const QByteArray &incoming);
