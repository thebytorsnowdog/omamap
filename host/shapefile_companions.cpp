#include "shapefile_companions.h"

#include "regular_file.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QSet>
#include <algorithm>
#include <fcntl.h>
#include <unistd.h>

namespace {

constexpr qint64 MaxCompanionBytes = qint64(100) * 1024 * 1024;

bool isCompanion(const QString &ext)
{
    return ext == QLatin1String("dbf") || ext == QLatin1String("prj") || ext == QLatin1String("cpg");
}

struct ShapeSet {
    int id = -1;
    bool hasShp = false;
    QSet<QString> explicitParts;
};

struct ShapeDirectory {
    std::shared_ptr<DIR> handle;
    QHash<QString, ShapeSet> sets;
};

std::shared_ptr<DIR> openDirectory(const QString &path)
{
    const int fd = ::open(QFile::encodeName(path).constData(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return {};
    DIR *directory = ::fdopendir(fd);
    if (directory) return {directory, ::closedir};
    ::close(fd);
    return {};
}

bool inspect(ImportFile &entry)
{
    RegularFile opened{};
    if (!entry.open(&opened)) return false;
    ::close(opened.fd);
    entry.size = opened.size;
    return true;
}

ImportBatch tooManyFiles()
{
    return {{}, QStringLiteral("Open at most %1 files at once, including shapefile companions. Select fewer shapefiles or files per launch.")
                    .arg(MaxImportFiles)};
}

} // namespace

bool ImportFile::open(RegularFile *file) const
{
    if (!directory) return openRegularFile(QFile::encodeName(path).constData(), file);
    const QByteArray name = QFile::encodeName(QFileInfo(path).fileName());
    return openRegularFileAt(::dirfd(directory.get()), name.constData(), !implicit, file);
}

ImportBatch expandShapefileCompanions(const QStringList &paths)
{
    QSet<QString> seenPaths;
    QHash<QString, ShapeDirectory> directories;
    int nextGroup = 0;
    ImportBatch batch;
    for (const QString &raw : paths) {
        if (raw.isEmpty()) continue;
        const QFileInfo info(raw);
        const QString path = info.absoluteFilePath();
        if (seenPaths.contains(path)) continue;
        seenPaths.insert(path);

        const QString ext = info.suffix().toLower();
        ImportFile file{path};
        if (ext == QLatin1String("shp") || isCompanion(ext)) {
            const QString parent = info.absolutePath();
            auto dir = directories.find(parent);
            file.directory = dir == directories.end() ? openDirectory(parent) : dir->handle;
            if (!inspect(file)) continue;
            if (dir == directories.end()) dir = directories.insert(parent, {file.directory, {}});
            ShapeSet &set = dir->sets[info.completeBaseName().toLower()];
            if (set.id < 0) set.id = nextGroup++;
            file.shapeGroup = set.id;
            if (ext == QLatin1String("shp")) set.hasShp |= file.size <= MaxCompanionBytes;
            else set.explicitParts.insert(ext);
        } else if (!inspect(file)) continue;
        batch.files.append(file);
        if (batch.files.size() > MaxImportFiles) return tooManyFiles();
    }

    for (auto dir = directories.cbegin(); dir != directories.cend(); ++dir) {
        const auto &sets = dir->sets;
        const auto &directory = dir->handle;
        if (!directory || std::none_of(sets.cbegin(), sets.cend(), [](const ShapeSet &set) { return set.hasShp; })) continue;
        const QDir parent(dir.key());
        while (const auto *entry = ::readdir(directory.get())) {
            const QString name = QFile::decodeName(entry->d_name);
            if (QFile::encodeName(name) != entry->d_name) continue;
            const QFileInfo info(name);
            const QString ext = info.suffix().toLower();
            if (!isCompanion(ext)) continue;
            const auto set = sets.constFind(info.completeBaseName().toLower());
            if (set == sets.cend() || !set->hasShp || set->explicitParts.contains(ext)) continue;

            // Use the pinned directory for both discovery and the eventual read.
            // Keep all matching regular entries so the renderer can reject duplicates.
            ImportFile file{parent.filePath(name), 0, set->id, directory, true};
            if (!inspect(file) || file.size > MaxCompanionBytes) continue;
            batch.files.append(file);
            if (batch.files.size() > MaxImportFiles) return tooManyFiles();
        }
    }

    if (batch.files.isEmpty() && !paths.isEmpty())
        batch.error = QStringLiteral("None of the selected files could be opened.");
    return batch;
}
