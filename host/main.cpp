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
#include <QRegularExpression>
#include <QStandardPaths>
#include <QUrl>
#include <QWebEngineProfile>

#ifdef Q_OS_LINUX
#include <sys/socket.h>
#include <unistd.h>
#endif

// The core is code the app runs, so it must not be a folder another local
// user can change: refuse one that is writable by group or others, or owned
// by someone other than this user or root.
static bool trustedCore(const QString &dir)
{
    const QFileInfo info(dir);
    if (!info.isDir() || !QFileInfo::exists(dir + QStringLiteral("/index.html"))) return false;
#ifdef Q_OS_LINUX
    const uint owner = info.ownerId();
    if (owner != 0 && owner != uint(geteuid())) {
        qWarning("omamap: ignoring %s: owned by another user", qPrintable(dir));
        return false;
    }
    if (info.permission(QFileDevice::WriteGroup) || info.permission(QFileDevice::WriteOther)) {
        qWarning("omamap: ignoring %s: writable by other users", qPrintable(dir));
        return false;
    }
#endif
    return true;
}

static QString coreDirectory()
{
    // An explicit override is the developer's choice (see SECURITY.md).
    const QString override = qEnvironmentVariable("OMAMAP_CORE_DIR");
    if (!override.isEmpty()) return override;
    const QString appDir = QCoreApplication::applicationDirPath();
#ifdef OMAMAP_SOURCE_CORE
    // Development builds: a binary running from its build directory uses
    // this checkout's core.
    if (QDir(appDir) == QDir(QStringLiteral(OMAMAP_BUILD_DIR))) {
        const QString source = QDir(QStringLiteral(OMAMAP_SOURCE_CORE)).canonicalPath();
        if (!source.isEmpty() && trustedCore(source)) return source;
    }
#endif
    // Installed binaries look next to themselves (relocatable installs), then
    // in the configured prefix. Never in the source tree they were built from.
    for (const QString &candidate : {appDir + QStringLiteral("/../share/omamap/core"),
                                     QStringLiteral(OMAMAP_INSTALLED_CORE)}) {
        const QString dir = QDir(candidate).canonicalPath();
        if (!dir.isEmpty() && trustedCore(dir)) return dir;
    }
    return {};
}

// One running window per user. The socket lives in the user's private
// runtime directory ($XDG_RUNTIME_DIR, mode 0700), not in /tmp where another
// local user could create it first and receive the paths of files this user
// opens. OMAMAP_INSTANCE names a separate channel, so tests (or a second
// profile) never hand files to the user's own window. Empty if there is no
// usable runtime directory: every launch then opens its own window.
static QString socketPath()
{
    const QString dir = QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
    if (dir.isEmpty()) return {};
    QString name = QStringLiteral("omamap");
    const QString instance = qEnvironmentVariable("OMAMAP_INSTANCE");
    if (!instance.isEmpty()) {
        static const QRegularExpression unsafe(QStringLiteral("[^A-Za-z0-9._-]"));
        name += QLatin1Char('-') + QString(instance).replace(unsafe, QStringLiteral("_")).left(64);
    }
    return dir + QLatin1Char('/') + name + QStringLiteral(".sock");
}

// Messages are one file:// URL per line. Percent-encoding keeps a file name
// containing a newline (legal on Linux) from turning into two paths.
static constexpr qint64 MaxPendingBytes = 1024 * 1024;   // a line longer than this is not a path
static constexpr int MaxPathsPerConnection = 1000;

// Returns true if a running OmaMap accepted the files.
static bool forwardToRunningInstance(const QString &path, const QStringList &files)
{
    if (path.isEmpty()) return false;
    QLocalSocket socket;
    socket.connectToServer(path);
    if (!socket.waitForConnected(300)) return false;
    QByteArray message;
    for (const QString &file : files) message += QUrl::fromLocalFile(file).toEncoded() + '\n';
    if (message.isEmpty()) message = "\n";   // just raise the window
    socket.write(message);
    socket.flush();
    socket.waitForBytesWritten(1000);
    socket.disconnectFromServer();
    return true;
}

// True if the connecting process runs as this user. The socket's directory
// and mode already ensure that; this is a second check.
static bool sameUser(QLocalSocket *client)
{
#ifdef Q_OS_LINUX
    struct ucred cred {};
    socklen_t length = sizeof cred;
    if (getsockopt(int(client->socketDescriptor()), SOL_SOCKET, SO_PEERCRED, &cred, &length) != 0) return false;
    return cred.uid == getuid();
#else
    Q_UNUSED(client);
    return true;
#endif
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

    const QString socket = socketPath();
    if (!parser.isSet(newInstance) && forwardToRunningInstance(socket, files)) {
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
    profile->setPersistentPermissionsPolicy(QWebEngineProfile::PersistentPermissionsPolicy::AskEveryTime);
    auto *scheme = new SchemeHandler(core, &app);
    profile->installUrlSchemeHandler(SchemeHandler::Scheme, scheme);
    profile->setUrlRequestInterceptor(new RequestFilter(&app));

    ThemeWatcher theme;
    Window window(profile, scheme, &theme);

    QLocalServer server;
    if (!parser.isSet(newInstance) && !socket.isEmpty()) {
        QLocalServer::removeServer(socket);   // clear a stale socket from a crash
        server.setSocketOptions(QLocalServer::UserAccessOption);
        if (!server.listen(socket)) qWarning("omamap: cannot listen on %s: %s", qPrintable(socket), qPrintable(server.errorString()));
        QObject::connect(&server, &QLocalServer::newConnection, &window, [&server, &window] {
            while (QLocalSocket *client = server.nextPendingConnection()) {
                QObject::connect(client, &QLocalSocket::disconnected, client, &QObject::deleteLater);
                if (!sameUser(client)) { client->abort(); continue; }
                QObject::connect(client, &QLocalSocket::readyRead, &window, [client, &window] {
                    // Wait for complete lines; a partial line stays buffered, up to a limit.
                    QStringList paths;
                    int received = client->property("paths").toInt();
                    while (client->canReadLine()) {
                        const QByteArray line = client->readLine().trimmed();
                        if (line.isEmpty() || received >= MaxPathsPerConnection) continue;
                        const QUrl url = QUrl::fromEncoded(line, QUrl::StrictMode);
                        if (!url.isLocalFile() || !QDir::isAbsolutePath(url.toLocalFile())) continue;
                        paths << url.toLocalFile();
                        received++;
                    }
                    client->setProperty("paths", received);
                    if (client->bytesAvailable() > MaxPendingBytes) { client->abort(); return; }
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
