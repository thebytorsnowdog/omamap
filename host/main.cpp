// OmaMap host: a Qt WebEngine window around the web core in ../core.
//
//   omamap [FILE...]     open the viewer, loading any given spatial files
//
// A second invocation hands its files to the running window and exits.

#include "ipc.h"
#include "scheme.h"
#include "theme.h"
#include "trusted_core.h"
#include "window.h"

#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QLocalServer>
#include <QLocalSocket>
#include <QProcess>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>
#include <QWebEngineProfile>
#include <memory>
#include <optional>

#ifdef Q_OS_LINUX
#include <sys/socket.h>
#include <unistd.h>
#endif

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
    // Older instances process paths as they arrive and cannot acknowledge a
    // batch. Keep their socket separate so an upgraded launcher can open it
    // with the matching host and renderer.
    return dir + QLatin1Char('/') + name + QStringLiteral(".v2.sock");
}

// No value means there is no connection. Once connected, report any failure
// to the caller so a handoff is never retried as a separate import.
static std::optional<QString> forwardToRunningInstance(const QString &path, const QStringList &files)
{
    if (path.isEmpty()) return std::nullopt;
    QLocalSocket socket;
    socket.connectToServer(path);
    if (!socket.waitForConnected(300)) return std::nullopt;
    QByteArray message;
    if (!makeIpcMessage(files, message))
        return QStringLiteral("The launch request exceeds 1 MiB. Select fewer files per launch.");
    if (socket.write(message) != message.size())
        return QStringLiteral("Could not send files to the running window.");
    socket.flush();

    QElapsedTimer timer;
    timer.start();
    while (!socket.canReadLine()) {
        const qint64 remaining = 5000 - timer.elapsed();
        if (remaining <= 0 || !socket.waitForReadyRead(static_cast<int>(remaining))) break;
    }
    if (!socket.canReadLine()) return QStringLiteral("The running window did not acknowledge the launch request.");
    const QByteArray reply = socket.readLine();
    if (reply == "OK\n") return QString{};
    if (reply.startsWith("ERROR ")) return QString::fromUtf8(reply.mid(6).trimmed());
    return QStringLiteral("The running window sent an invalid launch response.");
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
    if (!parser.isSet(newInstance)) {
        const auto result = forwardToRunningInstance(socket, files);
        if (result) {
            if (result->isEmpty()) {
                focusWindow();
                return 0;
            }
            qCritical("omamap: %s", qPrintable(*result));
            return 1;
        }
    }

    auto initialBatch = expandShapefileCompanions(files);
    if (!initialBatch.error.isEmpty()) {
        qCritical("omamap: %s", qPrintable(initialBatch.error));
        return 1;
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
    window.queueFiles(std::move(initialBatch.files));

    QLocalServer server;
    if (!parser.isSet(newInstance) && !socket.isEmpty()) {
        QLocalServer::removeServer(socket);   // clear a stale socket from a crash
        server.setSocketOptions(QLocalServer::UserAccessOption);
        if (!server.listen(socket)) qWarning("omamap: cannot listen on %s: %s", qPrintable(socket), qPrintable(server.errorString()));
        QObject::connect(&server, &QLocalServer::newConnection, &window, [&server, &window] {
            while (QLocalSocket *client = server.nextPendingConnection()) {
                QObject::connect(client, &QLocalSocket::disconnected, client, &QObject::deleteLater);
                if (!sameUser(client)) { client->abort(); continue; }
                client->setReadBufferSize(IpcMaxPendingBytes + 1);
                QTimer::singleShot(10000, client, [client] { client->abort(); });
                const auto pending = std::make_shared<QByteArray>();
                const auto receive = [client, &window, pending] {
                    if (client->state() != QLocalSocket::ConnectedState) return;
                    const IpcTake taken = takeIpcMessage(*pending, client->readAll());
                    if (!taken.complete) return;
                    const QString error = taken.error.isEmpty() ? window.openFiles(taken.paths) : taken.error;
                    if (error.isEmpty()) {
                        window.raise();
                        window.activateWindow();
                        client->write("OK\n");
                    } else {
                        client->write("ERROR " + error.toUtf8() + '\n');
                    }
                    client->disconnectFromServer();
                };
                QObject::connect(client, &QLocalSocket::readyRead, &window, receive);
                // A client can send its message before newConnection runs.
                if (client->bytesAvailable()) receive();
            }
        });
    }

    window.show();
    return app.exec();
}
