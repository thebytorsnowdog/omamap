#pragma once

#include <QList>
#include <QStringList>
#include <dirent.h>
#include <memory>

struct RegularFile;

struct ImportFile {
    QString path;
    qint64 size = 0;
    int shapeGroup = -1;
    // Shapefile parts stay bound to the directory scanned at discovery.
    std::shared_ptr<DIR> directory;
    bool implicit = false;

    bool open(RegularFile *file) const;
};

inline constexpr int MaxImportFiles = 100;
struct ImportBatch {
    QList<ImportFile> files;
    QString error;
};

ImportBatch expandShapefileCompanions(const QStringList &paths);
