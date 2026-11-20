#include "ipc.h"

#include <QDir>
#include <QUrl>

bool makeIpcMessage(const QStringList &paths, QByteArray &message)
{
    message.clear();
    for (const QString &path : paths) {
        const QByteArray encoded = QUrl::fromLocalFile(path).toEncoded();
        if (encoded.size() > IpcMaxPendingBytes - message.size() - 2) {
            message.clear();
            return false;
        }
        message += encoded;
        message += '\n';
    }
    message += '\0';
    return true;
}

IpcTake takeIpcMessage(QByteArray &pending, const QByteArray &incoming)
{
    if (incoming.size() > IpcMaxPendingBytes - pending.size())
        return {{}, QStringLiteral("The launch request exceeds 1 MiB."), true};
    pending += incoming;
    const qsizetype end = incoming.indexOf('\0');
    if (end == -1) return {};
    if (end != incoming.size() - 1)
        return {{}, QStringLiteral("Invalid launch request."), true};

    IpcTake out;
    out.complete = true;
    const QByteArrayView frame(pending.constData(), pending.size() - 1);
    for (qsizetype start = 0; start < frame.size();) {
        const qsizetype newline = frame.indexOf('\n', start);
        if (newline < 0) return {{}, QStringLiteral("Incomplete file path in launch request."), true};
        const QByteArray line = frame.sliced(start, newline - start).toByteArray();
        const QUrl url = QUrl::fromEncoded(line, QUrl::StrictMode);
        const QString path = url.toLocalFile();
        if (!url.isLocalFile() || !QDir::isAbsolutePath(path) || path.contains(QChar(u'\0')))
            return {{}, QStringLiteral("Invalid file path in launch request."), true};
        out.paths << path;
        start = newline + 1;
    }
    return out;
}
