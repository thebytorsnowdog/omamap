// OmaMap host: a Qt WebEngine window around the web core in ../core.
//
//   omamap [FILE...]     open the viewer, loading any given spatial files
//
// A second invocation hands its files to the running window and exits.

#include "scheme.h"
#include "theme.h"
#include "window.h"

#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QFileInfo>
#include <QLocalServer>
#include <QLocalSocket>
#include <QProcess>
#include <QStandardPaths>
#include <QWebEngineProfile>

static QString coreDirectory()
{
    const QString override = qEnvironmentVariable("OMAMAP_CORE_DIR");
    if (!override.isEmpty()) return override;
    // A binary running from its build directory uses this checkout's core;
    // installed binaries look next to themselves (relocatable installs), then
    // in the configured prefix.
    const QString appDir = QCoreApplication::applicationDirPath();
    if (QDir(appDir) == QDir(QStringLiteral(OMAMAP_BUILD_DIR)) && QFileInfo::exists(QStringLiteral(OMAMAP_SOURCE_CORE "/index.html")))
        return QDir(QStringLiteral(OMAMAP_SOURCE_CORE)).canonicalPath();
    for (const QString &candidate : {appDir + QStringLiteral("/../share/omamap/core"),
                                     QStringLiteral(OMAMAP_INSTALLED_CORE),
                                     QStringLiteral(OMAMAP_SOURCE_CORE)}) {
        if (QFileInfo::exists(candidate + QStringLiteral("/index.html"))) return QDir(candidate).canonicalPath();
    }
    return {};
}

// One running window per user. OMAMAP_INSTANCE names a separate channel, so
// tests (or a second profile) never hand files to the user's own window.
static QString socketName()
{
    QString name = QStringLiteral("omamap-%1").arg(qEnvironmentVariable("USER", QStringLiteral("user")));
    const QString instance = qEnvironmentVariable("OMAMAP_INSTANCE");
    if (!instance.isEmpty()) name += QLatin1Char('-') + instance;
    return name;
}

// Returns true if a running OmaMap accepted the files.
static bool forwardToRunningInstance(const QStringList &files)
{
    QLocalSocket socket;
    socket.connectToServer(socketName());
    if (!socket.waitForConnected(300)) return false;
    socket.write((files.join(QLatin1Char('\n')) + QLatin1Char('\n')).toUtf8());
    socket.flush();
    socket.waitForBytesWritten(1000);
    socket.disconnectFromServer();
    return true;
}

static void focusWindow()
{
    // Best effort: raise the existing window. Omarchy 4's Hyprland takes Lua dispatches.
    if (QStandardPaths::findExecutable(QStringLiteral("hyprctl")).isEmpty()) return;
    QProcess hyprctl;
    hyprctl.setProgram(QStringLiteral("hyprctl"));
    hyprctl.setArguments({QStringLiteral("dispatch"), QStringLiteral("hl.dsp.focus({ window = \"class:^(omamap)$\" })")});
    hyprctl.setStandardOutputFile(QProcess::nullDevice());
    hyprctl.setStandardErrorFile(QProcess::nullDevice());
    hyprctl.startDetached();
}

int main(int argc, char *argv[])
{
    QCoreApplication::setOrganizationName(QStringLiteral("omamap"));
    QCoreApplication::setApplicationName(QStringLiteral("omamap"));
    QCoreApplication::setApplicationVersion(QStringLiteral(OMAMAP_VERSION));
    SchemeHandler::registerScheme();

    QApplication app(argc, argv);
    QGuiApplication::setDesktopFileName(QStringLiteral("omamap"));   // Wayland app_id
    QGuiApplication::setApplicationDisplayName(QStringLiteral("OmaMap"));

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("View spatial datasets over background maps."));
    parser.addHelpOption();
    parser.addVersionOption();
    QCommandLineOption newInstance(QStringLiteral("new-window"), QStringLiteral("Open a separate window instead of reusing a running one."));
    parser.addOption(newInstance);
    parser.addPositionalArgument(QStringLiteral("files"), QStringLiteral("GeoJSON, KML, GPX, CSV or shapefile (.zip, or .shp with its .dbf/.prj) files."), QStringLiteral("[files...]"));
    parser.process(app);

    QStringList files;
    for (const QString &arg : parser.positionalArguments()) {
        // Accept file:// URLs from file managers as well as paths.
        const QUrl url(arg);
        const QString path = url.isLocalFile() ? url.toLocalFile() : arg;
        files << QFileInfo(path).absoluteFilePath();
    }

    if (!parser.isSet(newInstance) && forwardToRunningInstance(files)) {
        focusWindow();
        return 0;
    }

    const QString core = coreDirectory();
    if (core.isEmpty()) {
        qCritical("omamap: web core not found. Set OMAMAP_CORE_DIR or reinstall.");
        return 1;
    }

    // Persistent profile: remembers the map view and keeps a disk cache of
    // basemap tiles so revisited areas load without the network.
    auto *profile = new QWebEngineProfile(QStringLiteral("omamap"), &app);
    profile->setHttpCacheType(QWebEngineProfile::DiskHttpCache);
    profile->setHttpCacheMaximumSize(512 * 1024 * 1024);
    profile->setPersistentCookiesPolicy(QWebEngineProfile::NoPersistentCookies);
    profile->setSpellCheckEnabled(false);
    auto *scheme = new SchemeHandler(core, &app);
    profile->installUrlSchemeHandler(SchemeHandler::Scheme, scheme);
    profile->setUrlRequestInterceptor(new RequestFilter(&app));

    ThemeWatcher theme;
    Window window(profile, scheme, &theme);

    QLocalServer server;
    if (!parser.isSet(newInstance)) {
        QLocalServer::removeServer(socketName());   // clear a stale socket from a crash
        server.setSocketOptions(QLocalServer::UserAccessOption);
        server.listen(socketName());
        QObject::connect(&server, &QLocalServer::newConnection, &window, [&server, &window] {
            while (QLocalSocket *client = server.nextPendingConnection()) {
                QObject::connect(client, &QLocalSocket::disconnected, client, &QObject::deleteLater);
                QObject::connect(client, &QLocalSocket::readyRead, &window, [client, &window] {
                    // Wait for complete lines; a partial path stays buffered.
                    QStringList paths;
                    while (client->canReadLine()) {
                        const QString line = QString::fromUtf8(client->readLine()).trimmed();
                        if (!line.isEmpty()) paths << line;
                    }
                    if (!paths.isEmpty()) window.openFiles(paths);
                    window.raise();
                    window.activateWindow();
                });
            }
        });
    }

    window.openFiles(files);
    window.show();
    return app.exec();
}
