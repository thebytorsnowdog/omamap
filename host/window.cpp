#include "window.h"

#include "recent.h"
#include "profile_save.h"
#include "scheme.h"
#include "theme.h"

#include <QApplication>
#include <QColor>
#include <QDateTime>
#include <QTimer>
#include <QTemporaryDir>
#include <memory>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QSettings>
#include <QStandardPaths>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMessageBox>
#include <QWebEngineDownloadRequest>
#include <QWebEngineFileSystemAccessRequest>
#include <QWebEngineFullScreenRequest>
#include <QWebEngineNewWindowRequest>
#include <QWebEnginePermission>
#include <QWebEngineRegisterProtocolHandlerRequest>
#include <QWebEngineProfile>
#include <QWebEngineSettings>

// Only plain web pages are handed to the browser: no other scheme (file:,
// custom handlers, the app's own omamap:) and no embedded credentials.
static bool isWebLink(const QUrl &url)
{
    return url.isValid() && (url.scheme() == QLatin1String("https") || url.scheme() == QLatin1String("http"))
        && !url.host().isEmpty() && url.userInfo().isEmpty();
}

static void openExternally(const QUrl &url)
{
    if (qEnvironmentVariableIsSet("OMAMAP_DEBUG")) qWarning().noquote() << "[open-external]" << url.toString();
    QDesktopServices::openUrl(url);
}

Page::Page(QWebEngineProfile *profile, QObject *parent)
    : QWebEnginePage(profile, parent)
{
    // target=_blank links the user clicks (attribute values) go to the default
    // browser. Script-opened windows are refused (JavascriptCanOpenWindows is off).
    connect(this, &QWebEnginePage::newWindowRequested, this, [](QWebEngineNewWindowRequest &request) {
        if (request.isUserInitiated() && isWebLink(request.requestedUrl())) openExternally(request.requestedUrl());
    });
    // The app needs no device, location, notification, clipboard-read or
    // similar permission: refuse every request, and never remember one.
    connect(this, &QWebEnginePage::permissionRequested, this, [](QWebEnginePermission permission) {
        if (qEnvironmentVariableIsSet("OMAMAP_DEBUG")) qWarning() << "[permission denied]" << permission.permissionType();
        permission.deny();
    });
    connect(this, &QWebEnginePage::fileSystemAccessRequested, this, [](QWebEngineFileSystemAccessRequest request) { request.reject(); });
    connect(this, &QWebEnginePage::registerProtocolHandlerRequested, this, [](QWebEngineRegisterProtocolHandlerRequest request) { request.reject(); });
    connect(this, &QWebEnginePage::fullScreenRequested, this, [](QWebEngineFullScreenRequest request) { request.reject(); });
}

bool Page::acceptNavigationRequest(const QUrl &url, NavigationType type, bool isMainFrame)
{
    // The window only ever shows the app itself.
    if (isMainFrame && url.scheme() == QLatin1String(SchemeHandler::Scheme) && url.host() == QLatin1String(SchemeHandler::Host)
        && (url.path() == QLatin1String("/index.html") || url.path() == QLatin1String("/")))
        return true;
    if (isMainFrame && type == NavigationTypeLinkClicked && isWebLink(url)) openExternally(url);
    // Anything else (a file dropped outside the drop handler, stray links,
    // frames) stays out.
    return false;
}

// The page's file picker: the default Qt dialog, with chosen files remembered
// for the recent list.
QStringList Page::chooseFiles(FileSelectionMode mode, const QStringList &oldFiles, const QStringList &acceptedMimeTypes)
{
    const QStringList chosen = QWebEnginePage::chooseFiles(mode, oldFiles, acceptedMimeTypes);
    Recent::addMany(chosen);
    return chosen;
}

void Page::javaScriptConsoleMessage(JavaScriptConsoleMessageLevel level, const QString &message,
                                    int line, const QString &source)
{
    if (qEnvironmentVariableIsSet("OMAMAP_DEBUG") || level == ErrorMessageLevel)
        qWarning().noquote() << QStringLiteral("[page] %1:%2 %3").arg(source).arg(line).arg(message);
}

Window::Window(QWebEngineProfile *profile, SchemeHandler *scheme, ThemeWatcher *theme)
    : m_scheme(scheme)
    , m_theme(theme)
{
    auto *page = new Page(profile, this);
    page->setBackgroundColor(QColor(theme->background()));   // no white flash on open
    // Lock the engine down to what the app uses. Defaults that matter are set
    // explicitly so a Qt default change cannot loosen them.
    auto *s = page->settings();
    s->setAttribute(QWebEngineSettings::JavascriptCanAccessClipboard, true);   // Copy attributes (write)
    s->setAttribute(QWebEngineSettings::JavascriptCanPaste, false);
    s->setAttribute(QWebEngineSettings::JavascriptCanOpenWindows, false);
    s->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, false);
    s->setAttribute(QWebEngineSettings::LocalContentCanAccessFileUrls, false);
    s->setAttribute(QWebEngineSettings::AllowRunningInsecureContent, false);
    s->setAttribute(QWebEngineSettings::AllowGeolocationOnInsecureOrigins, false);
    s->setAttribute(QWebEngineSettings::AllowWindowActivationFromJavaScript, false);
    s->setAttribute(QWebEngineSettings::HyperlinkAuditingEnabled, false);
    s->setAttribute(QWebEngineSettings::DnsPrefetchEnabled, false);
    s->setAttribute(QWebEngineSettings::NavigateOnDropEnabled, false);
    s->setAttribute(QWebEngineSettings::ScreenCaptureEnabled, false);
    s->setAttribute(QWebEngineSettings::FullScreenSupportEnabled, false);
    s->setAttribute(QWebEngineSettings::WebRTCPublicInterfacesOnly, true);
    s->setAttribute(QWebEngineSettings::PluginsEnabled, false);
    s->setAttribute(QWebEngineSettings::PdfViewerEnabled, false);
    s->setAttribute(QWebEngineSettings::ErrorPageEnabled, false);
    s->setAttribute(QWebEngineSettings::FocusOnNavigationEnabled, true);
    // Links to unknown schemes (steam:, mailto:, custom handlers) never reach the desktop.
    s->setUnknownUrlSchemePolicy(QWebEngineSettings::DisallowUnknownUrlSchemes);
    setPage(page);
    setContextMenuPolicy(Qt::NoContextMenu);
    setWindowTitle(QStringLiteral("OmaMap"));
    resize(1440, 900);

    connect(page, &QWebEnginePage::loadFinished, this, [this](bool ok) {
        if (!ok) return;
        m_ready = true;
        if (m_recovered) {
            m_recovered = false;
            this->page()->runJavaScript(QStringLiteral("setTimeout(function () { toast('OmaMap recovered', 'The map stopped unexpectedly (often from running out of memory) and was restarted. Reopen your files or profile.', 'warn'); }, 300);"));
        }
        this->page()->runJavaScript(QStringLiteral("window.OmaMap && window.OmaMap.setHost({ version: \"" OMAMAP_VERSION "\" });"));
        pushTheme();
        flush();
        if (qEnvironmentVariableIsSet("OMAMAP_SELFTEST")) {
            fprintf(stderr, "OMAMAP_SELFTEST_READY\n");
            fflush(stderr);
            const QString script = qEnvironmentVariable("OMAMAP_SELFTEST_JS");
            if (!script.isEmpty()) QTimer::singleShot(2500, this, [this, script] { this->page()->runJavaScript(script); });
            QTimer::singleShot(qEnvironmentVariableIntValue("OMAMAP_SELFTEST_DELAY") ?: 4000, this, &Window::selfTest);
        }
    });
    connect(profile, &QWebEngineProfile::downloadRequested, this, &Window::saveDownload);

    // If the page's process dies (most often out of memory on a huge file),
    // reload instead of leaving a blank window. Give up after three crashes in
    // a minute so a crash loop cannot spin forever.
    connect(page, &QWebEnginePage::renderProcessTerminated, this, [this](QWebEnginePage::RenderProcessTerminationStatus status, int) {
        if (status == QWebEnginePage::NormalTerminationStatus) return;
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        m_crashes.append(now);
        while (!m_crashes.isEmpty() && now - m_crashes.first() > 60000) m_crashes.removeFirst();
        if (m_crashes.size() > 3) {
            qCritical("omamap: the page keeps crashing; not reloading.");
            return;
        }
        m_ready = false;
        m_recovered = true;
        m_scheme->revokeAll();   // URLs handed to the dead page must not outlive it
        QTimer::singleShot(500, this, [this] { load(QUrl(QStringLiteral("%1://%2/index.html").arg(SchemeHandler::Scheme, SchemeHandler::Host))); });
    });
    connect(theme, &ThemeWatcher::changed, this, [this, page] {
        page->setBackgroundColor(QColor(m_theme->background()));
        pushTheme();
    });
    load(QUrl(QStringLiteral("%1://%2/index.html").arg(SchemeHandler::Scheme, SchemeHandler::Host)));
}

void Window::pushTheme()
{
    if (!m_ready) return;
    const QString json = QString::fromUtf8(QJsonDocument(m_theme->current()).toJson(QJsonDocument::Compact));
    page()->runJavaScript(QStringLiteral("window.OmaMap && window.OmaMap.applyTheme(%1);").arg(json));
}

// The page saves profiles as blob downloads; ask where to put them. Nothing
// else may download.
void Window::saveDownload(QWebEngineDownloadRequest *download)
{
    if (qEnvironmentVariableIsSet("OMAMAP_DEBUG"))
        qWarning().noquote() << "[download]" << download->url().toString() << "page match" << (download->page() == page()) << download->suggestedFileName();
    if (download->page() != page() || download->isSavePageDownload() || download->url().scheme() != QLatin1String("blob")
        || !download->url().path().startsWith(QStringLiteral("omamap://app/"))) {
        download->cancel();
        return;
    }
    QSettings settings;
    QString dir = settings.value(QStringLiteral("profiles/lastDir")).toString();
    if (dir.isEmpty() || !QFileInfo(dir).isDir()) dir = QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation);
    if (dir.isEmpty() || !QFileInfo(dir).isDir()) dir = QDir::homePath();

    QString target = qEnvironmentVariable("OMAMAP_SAVE_PATH");   // tests: no dialog
    const bool dialog = target.isEmpty();
    if (dialog) {
        target = QFileDialog::getSaveFileName(this, QStringLiteral("Save OmaMap profile"),
            QDir(dir).filePath(download->suggestedFileName()), QStringLiteral("OmaMap profile (*.omamap)"));
    }
    if (target.isEmpty()) { download->cancel(); return; }
    if (!target.endsWith(QLatin1String(".omamap"), Qt::CaseInsensitive)) {
        target += QLatin1String(".omamap");
        // The dialog confirmed replacing the name as typed, not this one.
        if (dialog && QFileInfo::exists(target)
            && QMessageBox::question(this, QStringLiteral("Replace profile?"),
                   QStringLiteral("%1 already exists. Replace it?").arg(QFileInfo(target).fileName()),
                   QMessageBox::Yes | QMessageBox::Cancel, QMessageBox::Cancel) != QMessageBox::Yes) {
            download->cancel();
            return;
        }
    }
    const QFileInfo info(target);
    settings.setValue(QStringLiteral("profiles/lastDir"), info.absolutePath());
    // Stage in a private directory on the destination filesystem. Keep the
    // old profile until the complete replacement is durable and ready.
    const auto staging = std::make_shared<QTemporaryDir>(info.absolutePath() + QStringLiteral("/.omamap-save-XXXXXX"));
    if (!staging->isValid()) {
        download->cancel();
        page()->runJavaScript(QStringLiteral("toast('Could not save the profile', 'The destination cannot be written. Your previous profile is unchanged.', 'err');"));
        return;
    }
    download->setDownloadDirectory(staging->path());
    download->setDownloadFileName(QStringLiteral("profile.omamap"));
    const QString path = info.absoluteFilePath();
    connect(download, &QWebEngineDownloadRequest::isFinishedChanged, this, [this, download, path, staging] {
        if (!download->isFinished()) return;
        if (download->state() == QWebEngineDownloadRequest::DownloadCompleted
            && commitProfile(staging->filePath(QStringLiteral("profile.omamap")), path)) {
            Recent::add(path);
            const QString arg = QString::fromUtf8(QJsonDocument(QJsonArray{path}).toJson(QJsonDocument::Compact));
            page()->runJavaScript(QStringLiteral("window.OmaMap && window.OmaMap.profileSaved(%1[0]);").arg(arg));
        } else {
            page()->runJavaScript(QStringLiteral("toast('Could not save the profile', 'The file could not be written. Your previous profile is unchanged.', 'err');"));
        }
        staging->remove();
    });
    download->accept();
}

void Window::openFiles(const QStringList &paths)
{
    m_pending << paths;
    flush();
}

void Window::flush()
{
    if (!m_ready || m_pending.isEmpty()) return;
    QJsonArray list;
    QStringList opened;
    for (const QString &path : std::as_const(m_pending)) {
        const QFileInfo info(path);
        if (!info.isFile() || !info.isReadable()) continue;
        opened << info.absoluteFilePath();
        list.append(QJsonObject{
            {"url", m_scheme->shareFile(info.absoluteFilePath())},
            {"name", info.fileName()},
            {"size", static_cast<double>(info.size())},
        });
    }
    m_pending.clear();
    if (list.isEmpty()) return;
    Recent::addMany(opened);   // one rewrite of the list per batch, not per file
    const QString json = QString::fromUtf8(QJsonDocument(list).toJson(QJsonDocument::Compact));
    page()->runJavaScript(QStringLiteral("window.OmaMap && window.OmaMap.openUrls(%1);").arg(json));
}

// OMAMAP_SELFTEST=1: report page state as JSON on stdout, optionally save a
// screenshot to OMAMAP_SELFTEST_SHOT, then quit. Used by tests/host-smoke.sh.
void Window::selfTest()
{
    const QString js = QStringLiteral(
        "JSON.stringify({worker: !!Parser.worker && !Parser.failed, mode: STATE.mode, basemap: STATE.basemapId,"
        " bg: getComputedStyle(document.body).backgroundColor, font: getComputedStyle(document.body).fontFamily,"
        " datasets: STATE.datasets.map(function (d) { return d.name + ':' + d.featureCount; }),"
        " errors: Array.from(document.querySelectorAll('.toast.err')).map(function (t) { return t.textContent; }),"
        " notices: Array.from(document.querySelectorAll('.toast')).map(function (t) { return t.firstChild.textContent; })})");
    page()->runJavaScript(js, [this](const QVariant &result) {
        printf("%s\n", result.toString().toUtf8().constData());
        fflush(stdout);
        const QString shot = qEnvironmentVariable("OMAMAP_SELFTEST_SHOT");
        if (!shot.isEmpty()) grab().save(shot);
        QApplication::quit();
    });
}
