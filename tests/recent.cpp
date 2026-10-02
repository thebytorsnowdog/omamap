// Recent::addMany: newest first, one entry per file, private, parts skipped.
#include "recent.h"
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <cstdio>

int main()
{
    QTemporaryDir dir;
    if (!dir.isValid()) return 1;
    qputenv("XDG_STATE_HOME", dir.filePath("state").toUtf8());
    auto touch = [&](const QString &name) { QFile f(dir.filePath(name)); f.open(QIODevice::WriteOnly); f.write("x"); return dir.filePath(name); };
    auto names = [] {
        QFile f(Recent::filePath()); if (!f.open(QIODevice::ReadOnly)) return QStringList();
        QStringList out;
        for (const auto &v : QJsonDocument::fromJson(f.readAll()).object().value("recent").toArray()) out << v.toObject().value("name").toString();
        return out;
    };
    auto check = [](bool ok, const char *label) { if (!ok) std::fprintf(stderr, "%s\n", label); return ok; };
    const QString a = touch("a.geojson"), b = touch("roads.shp"), dbf = touch("roads.dbf"), c = touch("work.omamap");
    Recent::add(a);
    Recent::addMany({b, dbf, c, dir.filePath("missing.csv"), b});
    const QStringList got = names();
    if (!check(got == QStringList({"roads.shp", "work.omamap", "a.geojson"}), qPrintable("order and filtering: " + got.join(",")))) return 1;
    if (!check((QFile::permissions(Recent::filePath()) & (QFileDevice::ReadGroup | QFileDevice::ReadOther)) == 0, "list is private")) return 1;
    QStringList many;
    for (int i = 0; i < 40; i++) many << touch(QStringLiteral("f%1.csv").arg(i));
    Recent::addMany(many);
    const QStringList capped = names();
    if (!check(capped.size() == 15 && capped.first() == "f39.csv", "capped at 15, newest first")) return 1;
    return 0;
}
