#pragma once

#include <QStringList>
#include <QWebEnginePage>
#include <QWebEngineView>

class QWebEngineDownloadRequest;
class SchemeHandler;
class ThemeWatcher;

// Keeps the page on the app origin; ordinary web links open in the browser.
class Page : public QWebEnginePage
{
    Q_OBJECT
public:
    explicit Page(QWebEngineProfile *profile, QObject *parent = nullptr);

protected:
    bool acceptNavigationRequest(const QUrl &url, NavigationType type, bool isMainFrame) override;
    QStringList chooseFiles(FileSelectionMode mode, const QStringList &oldFiles, const QStringList &acceptedMimeTypes) override;
    void javaScriptConsoleMessage(JavaScriptConsoleMessageLevel level, const QString &message,
                                  int line, const QString &source) override;
};

class Window : public QWebEngineView
{
    Q_OBJECT
public:
    Window(QWebEngineProfile *profile, SchemeHandler *scheme, ThemeWatcher *theme);

    // Queue files to open; delivered once the page has loaded.
    void openFiles(const QStringList &paths);

private:
    void pushTheme();
    void flush();
    void selfTest();
    void saveDownload(QWebEngineDownloadRequest *download);

    SchemeHandler *m_scheme;
    ThemeWatcher *m_theme;
    QStringList m_pending;
    bool m_ready = false;
    bool m_recovered = false;
    QList<qint64> m_crashes;
};
