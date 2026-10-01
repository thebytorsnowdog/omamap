#pragma once

#include <QHash>
#include <QString>
#include <QWebEngineUrlRequestInterceptor>
#include <QWebEngineUrlSchemeHandler>

// Serves the web core at omamap://app/... and, at omamap://app/file/<token>/<name>,
// only the local files the user explicitly opened (command line, file manager).
class SchemeHandler : public QWebEngineUrlSchemeHandler
{
    Q_OBJECT
public:
    static constexpr const char *Scheme = "omamap";
    static constexpr const char *Host = "app";

    explicit SchemeHandler(const QString &coreDir, QObject *parent = nullptr);
    static void registerScheme();   // must run before QApplication exists

    // Returns the URL the page can fetch the file from.
    QString shareFile(const QString &absolutePath);
    QString coreDir() const { return m_coreDir; }

    void requestStarted(QWebEngineUrlRequestJob *job) override;

private:
    QString m_coreDir;
    QHash<QString, QString> m_files;   // token -> absolute path
    quint64 m_nextToken = 1;
};

// Mirrors the page CSP at the network layer: only the app scheme and the
// known basemap tile hosts may be contacted. Identifies OmaMap to the
// OpenStreetMap tile servers, as their usage policy asks.
class RequestFilter : public QWebEngineUrlRequestInterceptor
{
    Q_OBJECT
public:
    using QWebEngineUrlRequestInterceptor::QWebEngineUrlRequestInterceptor;
    void interceptRequest(QWebEngineUrlRequestInfo &info) override;
};
