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
    const QFileInfo info(path);
    if (!info.isFile()) return;
    // Loose shapefile parts are opened together; remember only the .shp.
    const QString ext = info.suffix().toLower();
    if (ext == QLatin1String("dbf") || ext == QLatin1String("prj") || ext == QLatin1String("cpg") || ext == QLatin1String("shx")) return;

    QJsonArray entries;
    QFile in(filePath());
    if (in.open(QIODevice::ReadOnly)) entries = QJsonDocument::fromJson(in.readAll()).object().value("recent").toArray();

    const QString absolute = info.absoluteFilePath();
    QJsonArray kept;
    kept.append(QJsonObject{
        {"path", absolute},
        {"name", info.fileName()},
        {"kind", ext == QLatin1String("omamap") ? "profile" : "data"},
        {"time", QDateTime::currentDateTimeUtc().toString(Qt::ISODate)},
    });
    for (const QJsonValue &v : std::as_const(entries)) {
        const QString p = v.toObject().value("path").toString();
        if (p.isEmpty() || p == absolute || !QFileInfo::exists(p)) continue;
        if (kept.size() >= MaxEntries) break;
        kept.append(v);
    }

    QDir().mkpath(QFileInfo(filePath()).absolutePath());
    QSaveFile out(filePath());
    if (!out.open(QIODevice::WriteOnly)) return;
    out.write(QJsonDocument(QJsonObject{{"version", 1}, {"recent", kept}}).toJson(QJsonDocument::Indented));
    out.commit();
}

}
