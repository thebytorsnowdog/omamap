#include "profile_save.h"
#include <QFile>
#include <QTemporaryDir>
#include <QDir>
#include <cstdio>

int main()
{
    QTemporaryDir dir;
    if (!dir.isValid()) return 1;
    const auto target = dir.filePath("saved.omamap");
    const auto stage = dir.filePath("staged.omamap");
    auto write = [](const QString &path, const QByteArray &value) {
        QFile f(path); return f.open(QIODevice::WriteOnly) && f.write(value) == value.size();
    };
    auto read = [](const QString &path) {
        QFile f(path); if (!f.open(QIODevice::ReadOnly)) return QByteArray(); return f.readAll();
    };
    auto check = [](bool ok, const char *label) { if (!ok) std::fprintf(stderr, "%s\n", label); return ok; };
    if (!write(target, "previous")) return 1;
    if (!check(!commitProfile(stage, target) && read(target) == "previous", "missing download preserves old profile")) return 1;
    if (!write(stage, "replacement")) return 1;
    if (!check(commitProfile(stage, target) && read(target) == "replacement" && !QFile::exists(stage), "atomic replacement succeeds")) return 1;
    if (!check((QFile::permissions(target) & (QFileDevice::ReadGroup | QFileDevice::ReadOther)) == 0, "profile is private")) return 1;
    const auto blocked = dir.filePath("directory.omamap");
    QDir().mkdir(blocked);
    write(stage, "next");
    if (!check(!commitProfile(stage, blocked) && read(stage) == "next" && QDir(blocked).exists(), "failed rename preserves destination and staging")) return 1;
    const auto link = dir.filePath("link.omamap");
    if (!QFile::link(target, link)) return 1;
    if (!check(commitProfile(stage, link) && read(target) == "replacement" && read(link) == "next", "replacing symlink does not overwrite its target")) return 1;
    return 0;
}
