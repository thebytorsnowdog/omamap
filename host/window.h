#pragma once

#include "shapefile_companions.h"

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

signals:
    void filesChosen(const QStringList &paths);

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

    // Validate one selection and queue it, or return an error for the launcher.
    QString openFiles(const QStringList &paths);
    void queueFiles(QList<ImportFile> files);

private:
    void pushTheme();
    void flush();
    void selfTest();
    void selfTestWhenReady(int generation, qint64 deadline);
    void saveDownload(QWebEngineDownloadRequest *download);

    SchemeHandler *m_scheme;
    ThemeWatcher *m_theme;
    QList<QList<ImportFile>> m_pending;
    bool m_ready = false;
    bool m_recovered = false;
    int m_selfTestGeneration = 0;
    QList<qint64> m_crashes;
};
