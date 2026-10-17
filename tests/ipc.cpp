// takeIpcLines: bounded local messages, absolute file URLs only.
#include "ipc.h"

#include <QBuffer>
#include <QUrl>
#include <cstdio>

static bool check(bool ok, const char *label)
{
    if (!ok) std::fprintf(stderr, "%s\n", label);
    return ok;
}

int main()
{
    {
        QBuffer buf;
        buf.open(QIODevice::ReadWrite);
        buf.write(QUrl::fromLocalFile("/tmp/a.geojson").toEncoded() + "\n\n");
        buf.seek(0);
        const IpcTake taken = takeIpcLines(&buf, 0, 0);
        if (!check(!taken.abort && taken.paths == QStringList{"/tmp/a.geojson"} && taken.received == 1, "accepts one path and skips a blank line")) return 1;
    }
    {
        QBuffer buf;
        buf.open(QIODevice::ReadWrite);
        buf.write(QByteArray(int(IpcMaxPendingBytes) + 64, 'a'));
        buf.write("\n");
        buf.seek(0);
        const IpcTake taken = takeIpcLines(&buf, 0, 0);
        if (!check(taken.abort && taken.paths.isEmpty(), "rejects an over-long line")) return 1;
        if (!check(buf.bytesAvailable() > IpcMaxPendingBytes, "leaves the over-long line unread")) return 1;
    }
    {
        QBuffer buf;
        buf.open(QIODevice::ReadWrite);
        QByteArray message;
        for (int i = 0; i < IpcMaxPaths + 5; ++i)
            message += QUrl::fromLocalFile(QStringLiteral("/tmp/f%1.geojson").arg(i)).toEncoded() + '\n';
        buf.write(message);
        buf.seek(0);
        const IpcTake taken = takeIpcLines(&buf, 0, 0);
        if (!check(!taken.abort && taken.received == IpcMaxPaths && taken.paths.size() == IpcMaxPaths, "stops accepting paths at the cap")) return 1;
        if (!check(buf.bytesAvailable() == 0, "still drains the extra short lines")) return 1;
    }
    {
        QBuffer buf;
        buf.open(QIODevice::ReadWrite);
        const QString path = QStringLiteral("/tmp/") + QString(20000, QLatin1Char('a')) + QStringLiteral(".geojson");
        const QByteArray line = QUrl::fromLocalFile(path).toEncoded() + '\n';
        QByteArray message;
        int written = 0;
        while (message.size() <= IpcMaxPendingBytes) {
            message += line;
            written++;
        }
        message += line; // one more complete line past the cap
        buf.write(message);
        buf.seek(0);
        const IpcTake taken = takeIpcLines(&buf, 0, 0);
        if (!check(taken.abort && taken.received > 0 && taken.received < written && taken.received <= IpcMaxPaths, "stops once the byte cap is reached")) return 1;
        if (!check(taken.consumed <= IpcMaxPendingBytes + line.size() && buf.bytesAvailable() >= line.size(), "does not read past the capped line")) return 1;
    }
    {
        QBuffer buf;
        buf.open(QIODevice::ReadWrite);
        buf.write("https://example.invalid/a\nfile:relative\nnot-a-url\n");
        buf.seek(0);
        const IpcTake taken = takeIpcLines(&buf, 0, 0);
        if (!check(!taken.abort && taken.paths.isEmpty() && taken.received == 0, "ignores anything that is not an absolute file URL")) return 1;
    }
    return 0;
}
