#include "trusted_core.h"
#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <cstdio>

int main()
{
    QTemporaryDir temp;
    if (!temp.isValid()) return 1;
    const QString core = temp.filePath("core");
    QDir().mkpath(core + "/vendor");
    const auto write = [](const QString &path) {
        QFile f(path);
        return f.open(QIODevice::WriteOnly) && f.write("code") == 4;
    };
    const auto check = [](bool ok, const char *label) {
        if (!ok) std::fprintf(stderr, "%s\n", label);
        return ok;
    };
    if (!check(!trustedCore(core), "a core needs index.html")) return 1;
    if (!write(core + "/index.html") || !write(core + "/vendor/app.js")) return 1;
    if (!check(trustedCore(core), "owner-controlled core is trusted")) return 1;
#ifdef Q_OS_LINUX
    const auto privateFile = QFileDevice::ReadOwner | QFileDevice::WriteOwner;
    const auto privateDir = privateFile | QFileDevice::ExeOwner;
    QFile::setPermissions(core + "/vendor/app.js", privateFile | QFileDevice::WriteGroup);
    if (!check(!trustedCore(core), "group-writable scripts are refused even in a private directory")) return 1;
    QFile::setPermissions(core + "/vendor/app.js", privateFile);
    QFile::setPermissions(core + "/vendor", privateDir | QFileDevice::WriteOther);
    if (!check(!trustedCore(core), "other-writable nested directories are refused")) return 1;
    QFile::setPermissions(core + "/vendor", privateDir);
    if (!write(core + "/.hidden.js")) return 1;
    QFile::setPermissions(core + "/.hidden.js", privateFile | QFileDevice::WriteOther);
    if (!check(!trustedCore(core), "hidden served files are checked too")) return 1;
    QFile::remove(core + "/.hidden.js");
    QFile::setPermissions(core, privateDir | QFileDevice::WriteGroup);
    if (!check(!trustedCore(core), "group-writable core directory is refused")) return 1;
    QFile::setPermissions(core, privateDir);
    if (!QFile::link(core, core + "/vendor/loop")) return 1;
    if (!check(trustedCore(core), "internal symlink cycles terminate")) return 1;
    const QString outside = temp.filePath("outside.js");
    if (!write(outside) || !QFile::link(outside, core + "/outside.js")) return 1;
    QFile::setPermissions(outside, privateFile | QFileDevice::WriteOther);
    if (!check(trustedCore(core), "unserved symlinks outside the core are ignored")) return 1;
#endif
    return 0;
}
