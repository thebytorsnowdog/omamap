#include "shapefile_companions.h"
#include "regular_file.h"

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

static QStringList sortedPaths(const ImportBatch &batch)
{
    QStringList paths;
    for (const auto &file : batch.files) paths << file.path;
    paths.sort();
    return paths;
}

static bool matches(const ImportBatch &batch, QStringList expected)
{
    expected.sort();
    return batch.error.isEmpty() && sortedPaths(batch) == expected;
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

    const auto fromShpOnly = expandShapefileCompanions({basicShp});
    if (!check(matches(fromShpOnly, {basicShp, basicDbf, basicPrj, basicCpg}), "discovers same-stem dbf, prj and cpg while ignoring shx and other stems"))
        return 1;
    for (const auto &file : fromShpOnly.files) {
        if (!check(file.shapeGroup == fromShpOnly.files.first().shapeGroup, "directory companions share the selected group")) return 1;
    }

    const auto explicitSubset = expandShapefileCompanions({basicShp, basicDbf, basicShp});
    if (!check(matches(explicitSubset, {basicShp, basicDbf, basicPrj, basicCpg}), "deduplicates explicit paths and fills only missing companions"))
        return 1;

    const QString mixedShp = temp.filePath(QStringLiteral("mixed/SITE.BOUNDARY.SHP"));
    const QString mixedDbfUpper = temp.filePath(QStringLiteral("mixed/SITE.BOUNDARY.DBF"));
    const QString mixedDbfLower = temp.filePath(QStringLiteral("mixed/site.boundary.dbf"));
    const QString mixedPrj = temp.filePath(QStringLiteral("mixed/Site.Boundary.prj"));
    if (!writeBytes(mixedShp) || !writeBytes(mixedDbfUpper) || !writeBytes(mixedDbfLower) || !writeBytes(mixedPrj))
        return 1;

    const auto fromMixed = expandShapefileCompanions({mixedShp});
    if (!check(matches(fromMixed, {mixedShp, mixedDbfUpper, mixedDbfLower, mixedPrj}), "surfaces case-insensitive duplicates so the renderer can reject ambiguity"))
        return 1;
    if (!check(matches(expandShapefileCompanions({mixedShp, mixedDbfLower}), {mixedShp, mixedDbfLower, mixedPrj}), "uses an explicitly chosen case variant"))
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

    const auto fromHazards = expandShapefileCompanions({hazardShp, fifoShp});
    if (!check(matches(fromHazards, {hazardShp, hazardCpgValid}), "ignores FIFO and directory companions without blocking"))
        return 1;

    const QString otherShp = temp.filePath(QStringLiteral("hazards/parcels.shp"));
    const QString otherPrj = temp.filePath(QStringLiteral("hazards/parcels.prj"));
    const QString linkDbf = temp.filePath(QStringLiteral("hazards/parcels.dbf"));
    if (!writeBytes(otherShp) || !writeBytes(otherPrj, "selected") || !QFile::link(basicDbf, linkDbf)) return 1;
    const auto acrossDirs = expandShapefileCompanions({basicShp, otherShp});
    if (!check(matches(acrossDirs, {basicShp, basicDbf, basicPrj, basicCpg, otherShp, otherPrj}), "skips an implicit symlink while discovering regular companions"))
        return 1;
    const int firstGroup = acrossDirs.files[0].shapeGroup;
    const int secondGroup = acrossDirs.files[1].shapeGroup;
    if (!check(firstGroup != secondGroup, "identical stems in different directories receive separate groups")) return 1;
    for (const auto &file : acrossDirs.files) {
        const bool selectedDir = file.path.startsWith(temp.filePath("hazards/"));
        if (!check(file.shapeGroup == (selectedDir ? secondGroup : firstGroup), "parts use their own directory's group")) return 1;
    }
    const auto explicitLink = expandShapefileCompanions({otherShp, linkDbf});
    RegularFile opened{};
    if (!check(matches(explicitLink, {otherShp, linkDbf, otherPrj}) && explicitLink.files[1].open(&opened), "an explicitly selected symlink remains readable"))
        return 1;
    ::close(opened.fd);

    const QString renamed = temp.filePath("moved");
    if (!QDir().rename(temp.filePath("hazards"), renamed) || !root.mkdir("hazards") || !writeBytes(otherPrj, "replacement")) return 1;
    for (const auto &file : acrossDirs.files) {
        if (file.path != otherPrj) continue;
        if (!check(file.open(&opened), "opens the companion in the original parent")) return 1;
        char bytes[16]{};
        const auto size = ::read(opened.fd, bytes, sizeof bytes);
        ::close(opened.fd);
        if (!check(size == 8 && QByteArray(bytes, size) == "selected", "a replaced parent does not change the source")) return 1;
        const QString original = renamed + "/parcels.prj";
        if (!QFile::remove(original) || !QFile::link(otherPrj, original)) return 1;
        if (!check(!file.open(&opened), "opening a previously discovered companion still refuses links")) return 1;
    }

    QStringList boundary{basicShp};
    for (int i = 0; i < MaxImportFiles - 3; ++i) {
        QString single = temp.filePath(QStringLiteral("file-%1.csv").arg(i));
        if (!writeBytes(single)) return 1;
        boundary.append(single);
    }
    auto overflow = expandShapefileCompanions(boundary);
    if (!check(!overflow.error.isEmpty() && overflow.files.isEmpty(), "rejects the entire batch when expansion exceeds the limit")) return 1;
    boundary.removeLast();
    const auto atLimit = expandShapefileCompanions(boundary);
    if (!check(atLimit.error.isEmpty() && atLimit.files.size() == MaxImportFiles, "accepts a complete batch at the expanded limit")) return 1;

    return 0;
}
