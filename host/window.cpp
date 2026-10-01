#include "window.h"

#include "recent.h"
#include "scheme.h"
#include "theme.h"

#include <QApplication>
#include <QColor>
#include <QTimer>
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
#include <QWebEngineDownloadRequest>
#include <QWebEngineNewWindowRequest>
#include <QWebEngineProfile>
#include <QWebEngineSettings>

static bool isWebLink(const QUrl &url)
{
    return url.scheme() == QLatin1String("https") || url.scheme() == QLatin1String("http");
}

Page::Page(QWebEngineProfile *profile, QObject *parent)
    : QWebEnginePage(profile, parent)
{
    // target=_blank links (attribute values, attribution) go to the default browser.
    connect(this, &QWebEnginePage::newWindowRequested, this, [](QWebEngineNewWindowRequest &request) {
        if (isWebLink(request.requestedUrl())) QDesktopServices::openUrl(request.requestedUrl());
    });
}

bool Page::acceptNavigationRequest(const QUrl &url, NavigationType type, bool isMainFrame)
{
    if (url.scheme() == QLatin1String(SchemeHandler::Scheme)) return true;
    if (isMainFrame && type == NavigationTypeLinkClicked && isWebLink(url)) QDesktopServices::openUrl(url);
    // Anything else (a file dropped outside the drop handler, stray links) stays out.
    return false;
}

// The page's file picker: the default Qt dialog, with chosen files remembered
// for the recent list.
QStringList Page::chooseFiles(FileSelectionMode mode, const QStringList &oldFiles, const QStringList &acceptedMimeTypes)
{
    const QStringList chosen = QWebEnginePage::chooseFiles(mode, oldFiles, acceptedMimeTypes);
    for (const QString &path : chosen) Recent::add(path);
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
    auto *s = page->settings();
    s->setAttribute(QWebEngineSettings::JavascriptCanAccessClipboard, true);
    s->setAttribute(QWebEngineSettings::JavascriptCanPaste, false);
    s->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, false);
    s->setAttribute(QWebEngineSettings::PluginsEnabled, false);
    s->setAttribute(QWebEngineSettings::PdfViewerEnabled, false);
    s->setAttribute(QWebEngineSettings::FocusOnNavigationEnabled, true);
    setPage(page);
    setContextMenuPolicy(Qt::NoContextMenu);
    setWindowTitle(QStringLiteral("OmaMap"));
    resize(1440, 900);

    connect(page, &QWebEnginePage::loadFinished, this, [this](bool ok) {
        if (!ok) return;
        m_ready = true;
        this->page()->runJavaScript(QStringLiteral("window.OmaMap && window.OmaMap.setHost({ version: \"" OMAMAP_VERSION "\" });"));
        pushTheme();
        flush();
        if (qEnvironmentVariableIsSet("OMAMAP_SELFTEST")) {
            const QString script = qEnvironmentVariable("OMAMAP_SELFTEST_JS");
            if (!script.isEmpty()) QTimer::singleShot(2500, this, [this, script] { this->page()->runJavaScript(script); });
            QTimer::singleShot(qEnvironmentVariableIntValue("OMAMAP_SELFTEST_DELAY") ?: 4000, this, &Window::selfTest);
        }
    });
    connect(profile, &QWebEngineProfile::downloadRequested, this, &Window::saveDownload);
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
    if (download->page() != page() || download->url().scheme() != QLatin1String("blob")) {
        download->cancel();
        return;
    }
    QSettings settings;
    QString dir = settings.value(QStringLiteral("profiles/lastDir")).toString();
    if (dir.isEmpty() || !QFileInfo(dir).isDir()) dir = QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation);
    if (dir.isEmpty() || !QFileInfo(dir).isDir()) dir = QDir::homePath();

    QString target = qEnvironmentVariable("OMAMAP_SAVE_PATH");   // tests: no dialog
    if (target.isEmpty()) {
        target = QFileDialog::getSaveFileName(this, QStringLiteral("Save OmaMap profile"),
            QDir(dir).filePath(download->suggestedFileName()), QStringLiteral("OmaMap profile (*.omamap)"));
    }
    if (target.isEmpty()) { download->cancel(); return; }
    if (!target.endsWith(QLatin1String(".omamap"), Qt::CaseInsensitive)) target += QLatin1String(".omamap");
    const QFileInfo info(target);
    settings.setValue(QStringLiteral("profiles/lastDir"), info.absolutePath());
    // The dialog has already confirmed replacing an existing file.
    if (info.exists()) QFile::remove(info.absoluteFilePath());

    download->setDownloadDirectory(info.absolutePath());
    download->setDownloadFileName(info.fileName());
    const QString path = info.absoluteFilePath();
    connect(download, &QWebEngineDownloadRequest::isFinishedChanged, this, [this, download, path] {
        if (!download->isFinished()) return;
        if (download->state() == QWebEngineDownloadRequest::DownloadCompleted) {
            Recent::add(path);
            const QString arg = QString::fromUtf8(QJsonDocument(QJsonArray{path}).toJson(QJsonDocument::Compact));
            page()->runJavaScript(QStringLiteral("window.OmaMap && window.OmaMap.profileSaved(%1[0]);").arg(arg));
        } else {
            page()->runJavaScript(QStringLiteral("toast('Could not save the profile', 'The file could not be written.', 'err');"));
        }
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
    for (const QString &path : std::as_const(m_pending)) {
        const QFileInfo info(path);
        if (!info.isFile() || !info.isReadable()) continue;
        Recent::add(info.absoluteFilePath());
        list.append(QJsonObject{
            {"url", m_scheme->shareFile(info.absoluteFilePath())},
            {"name", info.fileName()},
            {"size", static_cast<double>(info.size())},
        });
    }
    m_pending.clear();
    if (list.isEmpty()) return;
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
        " errors: Array.from(document.querySelectorAll('.toast.err')).map(function (t) { return t.textContent; })})");
    page()->runJavaScript(js, [this](const QVariant &result) {
        printf("%s\n", result.toString().toUtf8().constData());
        fflush(stdout);
        const QString shot = qEnvironmentVariable("OMAMAP_SELFTEST_SHOT");
        if (!shot.isEmpty()) grab().save(shot);
        QApplication::quit();
    });
}
