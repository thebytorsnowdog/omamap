#include "shapefile_companions.h"

#include "regular_file.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QSet>
#include <algorithm>
#include <unistd.h>

namespace {

constexpr qint64 MaxCompanionBytes = qint64(100) * 1024 * 1024;

bool isReadableRegular(const QString &path)
{
    RegularFile opened{};
    const QByteArray native = QFile::encodeName(path);
    if (!openRegularFile(native.constData(), &opened)) return false;
    ::close(opened.fd);
    return opened.size >= 0 && opened.size <= MaxCompanionBytes;
}

bool isShapePartSuffix(const QString &ext)
{
    return ext == QLatin1String("shp") || ext == QLatin1String("dbf")
        || ext == QLatin1String("prj") || ext == QLatin1String("cpg");
}

QString partKey(const QString &dirPath, const QString &stemLower, const QString &extLower)
{
    return dirPath + QLatin1Char('\n') + stemLower + QLatin1Char('\n') + extLower;
}

} // namespace

QStringList expandShapefileCompanions(const QStringList &paths)
{
    static const QStringList companionExts{
        QStringLiteral("dbf"),
        QStringLiteral("prj"),
        QStringLiteral("cpg"),
    };

    QSet<QString> seenPaths;
    QSet<QString> seenParts;
    QStringList uniqueInputs;
    uniqueInputs.reserve(paths.size());

    for (const QString &raw : paths) {
        if (raw.isEmpty()) continue;
        const QFileInfo info(raw);
        const QString absPath = info.absoluteFilePath();
        if (seenPaths.contains(absPath)) continue;
        seenPaths.insert(absPath);
        uniqueInputs << absPath;

        const QString extLower = info.suffix().toLower();
        if (isShapePartSuffix(extLower) && isReadableRegular(absPath)) {
            seenParts.insert(partKey(info.absolutePath(), info.completeBaseName().toLower(), extLower));
        }
    }

    QHash<QString, QStringList> dirCache;
    QStringList expanded;
    expanded.reserve(uniqueInputs.size());

    for (const QString &absPath : std::as_const(uniqueInputs)) {
        expanded << absPath;
        const QFileInfo shpInfo(absPath);
        const QString shpSuffix = shpInfo.suffix();
        if (shpSuffix.compare(QLatin1String("shp"), Qt::CaseInsensitive) != 0) continue;

        const QString dirPath = shpInfo.absolutePath();
        const QString stem = shpInfo.completeBaseName();
        const QString stemLower = stem.toLower();
        if (!seenParts.contains(partKey(dirPath, stemLower, QStringLiteral("shp")))) continue;

        auto it = dirCache.find(dirPath);
        if (it == dirCache.end()) {
            it = dirCache.insert(dirPath,
                QDir(dirPath).entryList(QDir::AllEntries | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot, QDir::Name));
        }
        const QStringList &entries = it.value();
        const bool preferUpper = (shpSuffix == shpSuffix.toUpper());

        for (const QString &comp : companionExts) {
            const QString key = partKey(dirPath, stemLower, comp);
            if (seenParts.contains(key)) continue;

            const QString preferredSuffix = preferUpper ? comp.toUpper() : comp;
            QStringList candidates;
            for (const QString &entry : entries) {
                const QFileInfo entryInfo(entry);
                if (entryInfo.suffix().compare(comp, Qt::CaseInsensitive) == 0
                    && entryInfo.completeBaseName().compare(stem, Qt::CaseInsensitive) == 0) {
                    candidates << entry;
                }
            }
            std::sort(candidates.begin(), candidates.end(), [&](const QString &a, const QString &b) {
                const QFileInfo ia(a), ib(b);
                const auto rank = [&](const QFileInfo &fi) {
                    if (fi.completeBaseName() == stem && fi.suffix() == preferredSuffix) return 0;
                    if (fi.completeBaseName() == stem) return 1;
                    return 2;
                };
                const int ra = rank(ia), rb = rank(ib);
                return ra != rb ? ra < rb : a < b;
            });

            const QDir dir(dirPath);
            for (const QString &name : std::as_const(candidates)) {
                const QString candidatePath = QFileInfo(dir.filePath(name)).absoluteFilePath();
                if (seenPaths.contains(candidatePath) || !isReadableRegular(candidatePath)) continue;
                seenPaths.insert(candidatePath);
                seenParts.insert(key);
                expanded << candidatePath;
                break;
            }
        }
    }

    return expanded;
}
