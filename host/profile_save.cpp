#include "profile_save.h"
#include <QFile>
#include <cstdio>
#include <unistd.h>

bool commitProfile(const QString &staged, const QString &destination)
{
    QFile file(staged);
    if (!file.open(QIODevice::ReadWrite | QIODevice::ExistingOnly)
        || !file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner)
        || !file.flush() || ::fsync(file.handle()) != 0)
        return false;
    file.close();
    // QFile::rename refuses existing destinations. POSIX rename replaces them
    // atomically, including symlinks, without a delete-before-write window.
    return ::rename(QFile::encodeName(staged).constData(),
                    QFile::encodeName(destination).constData()) == 0;
}
