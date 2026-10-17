#include "ipc.h"

#include <QDir>
#include <QIODevice>
#include <QUrl>

IpcTake takeIpcLines(QIODevice *device, int received, qint64 consumed)
{
    IpcTake out;
    out.received = received;
    out.consumed = consumed;
    if (!device) {
        out.abort = true;
        return out;
    }
    while (device->canReadLine()) {
        if (out.consumed >= IpcMaxPendingBytes || out.consumed < 0) {
            out.abort = true;
            return out;
        }
        // canReadLine() means a newline is already buffered. Peeking the cap
        // finds that newline when the line fits, and refuses the line when it
        // does not, without copying the rest of it.
        const QByteArray head = device->peek(IpcMaxPendingBytes + 1);
        const int newline = head.indexOf('\n');
        if (newline < 0 || newline >= IpcMaxPendingBytes) {
            out.abort = true;
            return out;
        }
        const QByteArray line = device->read(newline + 1);
        if (line.size() != newline + 1) {
            out.abort = true;
            return out;
        }
        out.consumed += line.size();
        // Stop once this connection has handed over a megabyte of text, even
        // when that last line is the end of what has arrived so far.
        if (out.consumed > IpcMaxPendingBytes) {
            out.abort = true;
            return out;
        }
        const QByteArray trimmed = line.trimmed();
        if (trimmed.isEmpty() || out.received >= IpcMaxPaths) continue;
        const QUrl url = QUrl::fromEncoded(trimmed, QUrl::StrictMode);
        if (!url.isLocalFile() || !QDir::isAbsolutePath(url.toLocalFile())) continue;
        out.paths << url.toLocalFile();
        out.received++;
    }
    if (device->bytesAvailable() > IpcMaxPendingBytes) out.abort = true;
    return out;
}
