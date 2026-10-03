#include "trusted_core.h"

#include <QDir>
#include <QFileInfo>
#include <QSet>

#ifdef Q_OS_LINUX
#include <unistd.h>
#endif

static bool trustedEntry(const QFileInfo &info)
{
#ifdef Q_OS_LINUX
    const uint owner = info.ownerId();
    if (owner != 0 && owner != uint(geteuid())) {
        qWarning("omamap: ignoring %s: owned by another user", qPrintable(info.filePath()));
        return false;
    }
    if (info.permission(QFileDevice::WriteGroup) || info.permission(QFileDevice::WriteOther)) {
        qWarning("omamap: ignoring %s: writable by other users", qPrintable(info.filePath()));
        return false;
    }
#else
    Q_UNUSED(info);
#endif
    return true;
}

bool trustedCore(const QString &dir)
{
    const QFileInfo root(dir);
    if (!root.isDir() || !QFileInfo(dir + QStringLiteral("/index.html")).isFile()) return false;
    if (!trustedEntry(root)) return false;
    const QString canonicalRoot = root.canonicalFilePath();
    QStringList pending{canonicalRoot};
    QSet<QString> visited;
    while (!pending.isEmpty()) {
        const QString current = pending.takeLast();
        if (visited.contains(current)) continue;
        visited.insert(current);
        for (const QFileInfo &entry : QDir(current).entryInfoList(QDir::AllEntries | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot)) {
            const QString path = entry.canonicalFilePath();
            // Match SchemeHandler's confinement: escaped and broken symlinks
            // cannot be served. Follow internal directory links once only.
            if (path.isEmpty() || !path.startsWith(canonicalRoot + QLatin1Char('/'))) continue;
            const QFileInfo target(path);
            if (!trustedEntry(target)) return false;
            if (target.isDir()) pending << path;
        }
    }
    return true;
}
