#include "recent.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>

namespace Recent {

static constexpr int MaxEntries = 15;

QString filePath()
{
    QString state = qEnvironmentVariable("XDG_STATE_HOME");
    if (state.isEmpty()) state = QDir::homePath() + QStringLiteral("/.local/state");
    return state + QStringLiteral("/omamap/recent.json");
}

void add(const QString &path)
{
    addMany({path});
}

void addMany(const QStringList &paths)
{
    // Newest first: walk the batch backwards so its last file leads.
    QJsonArray kept;
    QStringList seen;
    const QString now = QDateTime::currentDateTimeUtc().toString(Qt::ISODate);
    for (qsizetype i = paths.size() - 1; i >= 0 && kept.size() < MaxEntries; i--) {
        const QFileInfo info(paths.at(i));
        if (!info.isFile()) continue;
        // Loose shapefile parts are opened together; remember only the .shp.
        const QString ext = info.suffix().toLower();
        if (ext == QLatin1String("dbf") || ext == QLatin1String("prj") || ext == QLatin1String("cpg") || ext == QLatin1String("shx")) continue;
        const QString absolute = info.absoluteFilePath();
        if (seen.contains(absolute)) continue;
        seen << absolute;
        kept.append(QJsonObject{
            {"path", absolute},
            {"name", info.fileName()},
            {"kind", ext == QLatin1String("omamap") ? "profile" : "data"},
            {"time", now},
        });
    }
    if (kept.isEmpty()) return;

    QJsonArray entries;
    QFile in(filePath());
    if (in.open(QIODevice::ReadOnly)) entries = QJsonDocument::fromJson(in.read(1024 * 1024)).object().value("recent").toArray();
    for (const QJsonValue &v : std::as_const(entries)) {
        if (kept.size() >= MaxEntries) break;
        // Carry earlier entries forward field by field, so whatever else the
        // file held is not repeated.
        const QJsonObject e = v.toObject();
        const QString p = e.value("path").toString();
        if (p.isEmpty() || !QDir::isAbsolutePath(p) || seen.contains(p) || !QFileInfo::exists(p)) continue;
        seen << p;
        kept.append(QJsonObject{
            {"path", p},
            {"name", QFileInfo(p).fileName()},
            {"kind", e.value("kind").toString() == QLatin1String("profile") ? "profile" : "data"},
            {"time", e.value("time").toString().left(40)},
        });
    }

    // The list names files the user opened: keep it private to them.
    const QString dir = QFileInfo(filePath()).absolutePath();
    QDir().mkpath(dir);
    QFile::setPermissions(dir, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
    QSaveFile out(filePath());
    if (!out.open(QIODevice::WriteOnly)) return;
    out.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    out.write(QJsonDocument(QJsonObject{{"version", 1}, {"recent", kept}}).toJson(QJsonDocument::Indented));
    out.commit();
}

}
