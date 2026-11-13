#include "shapefile_companions.h"

#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <cstdio>
#include <csignal>
#include <sys/stat.h>
#include <unistd.h>

static void onAlarm(int)
{
    std::fprintf(stderr, "expandShapefileCompanions blocked\n");
    std::_Exit(1);
}

static bool writeBytes(const QString &path, const QByteArray &data = QByteArrayLiteral("ok"))
{
    QFile f(path);
    return f.open(QIODevice::WriteOnly) && f.write(data) == data.size();
}

int main()
{
    std::signal(SIGALRM, onAlarm);
    alarm(5);

    QTemporaryDir temp;
    if (!temp.isValid()) return 1;

    auto check = [](bool ok, const char *label) {
        if (!ok) std::fprintf(stderr, "%s\n", label);
        return ok;
    };

    const QDir root(temp.path());
    if (!root.mkdir(QStringLiteral("basic")) || !root.mkdir(QStringLiteral("mixed")) || !root.mkdir(QStringLiteral("hazards")))
        return 1;

    const QString basicShp = temp.filePath(QStringLiteral("basic/parcels.shp"));
    const QString basicDbf = temp.filePath(QStringLiteral("basic/parcels.dbf"));
    const QString basicPrj = temp.filePath(QStringLiteral("basic/parcels.prj"));
    const QString basicCpg = temp.filePath(QStringLiteral("basic/parcels.cpg"));
    const QString basicShx = temp.filePath(QStringLiteral("basic/parcels.shx"));
    const QString otherDbf = temp.filePath(QStringLiteral("basic/roads.dbf"));
    if (!writeBytes(basicShp) || !writeBytes(basicDbf) || !writeBytes(basicPrj)
        || !writeBytes(basicCpg) || !writeBytes(basicShx) || !writeBytes(otherDbf))
        return 1;

    const QStringList fromShpOnly = expandShapefileCompanions({basicShp});
    const QStringList expectedBasic{basicShp, basicDbf, basicPrj, basicCpg};
    if (!check(fromShpOnly == expectedBasic, "discovers same-stem dbf, prj and cpg while ignoring shx and other stems"))
        return 1;

    const QStringList explicitSubset = expandShapefileCompanions({basicShp, basicDbf, basicShp});
    const QStringList expectedExplicit{basicShp, basicPrj, basicCpg, basicDbf};
    if (!check(explicitSubset == expectedExplicit, "deduplicates explicit parts and fills only missing companions"))
        return 1;

    const QString mixedShp = temp.filePath(QStringLiteral("mixed/SITE.BOUNDARY.SHP"));
    const QString mixedDbfUpper = temp.filePath(QStringLiteral("mixed/SITE.BOUNDARY.DBF"));
    const QString mixedDbfLower = temp.filePath(QStringLiteral("mixed/site.boundary.dbf"));
    const QString mixedPrj = temp.filePath(QStringLiteral("mixed/Site.Boundary.prj"));
    if (!writeBytes(mixedShp) || !writeBytes(mixedDbfUpper) || !writeBytes(mixedDbfLower) || !writeBytes(mixedPrj))
        return 1;

    const QStringList fromMixed = expandShapefileCompanions({mixedShp});
    const QStringList expectedMixed{mixedShp, mixedDbfUpper, mixedPrj};
    if (!check(fromMixed == expectedMixed, "matches dotted stems case-insensitively and prefers matching case"))
        return 1;

    const QString hazardShp = temp.filePath(QStringLiteral("hazards/pipes.shp"));
    const QString hazardDbfFifo = temp.filePath(QStringLiteral("hazards/pipes.dbf"));
    const QString hazardPrjDir = temp.filePath(QStringLiteral("hazards/pipes.prj"));
    const QString hazardCpgValid = temp.filePath(QStringLiteral("hazards/PIPES.CPG"));
    const QString fifoShp = temp.filePath(QStringLiteral("hazards/trap.shp"));
    const QString fifoDbf = temp.filePath(QStringLiteral("hazards/trap.dbf"));
    if (!writeBytes(hazardShp) || !writeBytes(hazardCpgValid) || !writeBytes(fifoDbf)) return 1;
    if (::mkfifo(QFile::encodeName(hazardDbfFifo).constData(), 0600) != 0) return 1;
    if (::mkfifo(QFile::encodeName(fifoShp).constData(), 0600) != 0) return 1;
    if (!QDir().mkdir(hazardPrjDir)) return 1;

    const QStringList fromHazards = expandShapefileCompanions({hazardShp, fifoShp});
    const QStringList expectedHazards{hazardShp, hazardCpgValid, fifoShp};
    if (!check(fromHazards == expectedHazards, "ignores FIFO and directory companions without blocking"))
        return 1;

    return 0;
}
