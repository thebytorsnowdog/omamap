#include "scheme.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QMimeDatabase>
#include <QRegularExpression>
#include <QUrl>
#include <QWebEngineUrlRequestInfo>
#include <QWebEngineUrlRequestJob>
#include <QWebEngineUrlScheme>

SchemeHandler::SchemeHandler(const QString &coreDir, QObject *parent)
    : QWebEngineUrlSchemeHandler(parent)
    , m_coreDir(QFileInfo(coreDir).canonicalFilePath())
{
}

void SchemeHandler::registerScheme()
{
    QWebEngineUrlScheme scheme(Scheme);
    scheme.setSyntax(QWebEngineUrlScheme::Syntax::Host);
    // Secure: clipboard and other secure-context APIs work.
    // CorsEnabled + FetchApiAllowed: same-origin fetch() (opened files) and
    // the parse worker work.
    scheme.setFlags(QWebEngineUrlScheme::SecureScheme | QWebEngineUrlScheme::CorsEnabled
                    | QWebEngineUrlScheme::FetchApiAllowed);
    QWebEngineUrlScheme::registerScheme(scheme);
}

QString SchemeHandler::shareFile(const QString &absolutePath)
{
    const QString token = QString::number(m_nextToken++);
    m_files.insert(token, absolutePath);
    const QString name = QString::fromUtf8(QUrl::toPercentEncoding(QFileInfo(absolutePath).fileName()));
    return QStringLiteral("%1://%2/file/%3/%4").arg(Scheme, Host, token, name);
}

static QByteArray mimeFor(const QString &path)
{
    static const QHash<QString, QByteArray> known = {
        {"html", "text/html"}, {"js", "text/javascript"}, {"css", "text/css"},
        {"svg", "image/svg+xml"}, {"png", "image/png"}, {"json", "application/json"},
    };
    const QString ext = QFileInfo(path).suffix().toLower();
    if (known.contains(ext)) return known.value(ext);
    return "application/octet-stream";
}

void SchemeHandler::requestStarted(QWebEngineUrlRequestJob *job)
{
    const QUrl url = job->requestUrl();
    if (qEnvironmentVariableIsSet("OMAMAP_DEBUG"))
        qWarning().noquote() << "[scheme]" << job->requestMethod() << url.toString() << "initiator" << job->initiator().toString();
    if (url.host() != QLatin1String(Host) || job->requestMethod() != "GET") {
        job->fail(QWebEngineUrlRequestJob::RequestDenied);
        return;
    }
    const QString path = url.path(QUrl::FullyDecoded);

    // Opened files: omamap://app/file/<token>/<name>
    static const QRegularExpression fileRoute(QStringLiteral("^/file/(\\d+)/"));
    const auto match = fileRoute.match(path);
    if (match.hasMatch()) {
        const QString target = m_files.value(match.captured(1));
        auto *file = new QFile(target, job);
        if (target.isEmpty() || !file->open(QIODevice::ReadOnly)) {
            job->fail(QWebEngineUrlRequestJob::UrlNotFound);
            return;
        }
        job->reply("application/octet-stream", file);
        return;
    }

    // Web core files, confined to the core directory.
    QString rel = path == QLatin1String("/") ? QStringLiteral("index.html") : path.mid(1);
    const QString full = QFileInfo(QDir(m_coreDir).filePath(rel)).canonicalFilePath();
    if (full.isEmpty() || !full.startsWith(m_coreDir + QLatin1Char('/')) || !QFileInfo(full).isFile()) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }
    auto *file = new QFile(full, job);
    if (!file->open(QIODevice::ReadOnly)) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }
    job->reply(mimeFor(full), file);
}

void RequestFilter::interceptRequest(QWebEngineUrlRequestInfo &info)
{
    const QUrl url = info.requestUrl();
    const QString scheme = url.scheme();
    if (scheme == QLatin1String(SchemeHandler::Scheme) || scheme == QLatin1String("data") || scheme == QLatin1String("blob"))
        return;
    if (scheme != QLatin1String("https")) {
        info.block(true);
        return;
    }
    // Keep in step with core/basemaps.js and the CSP in core/index.html.
    static const QRegularExpression allowed(QStringLiteral(
        "^(tile\\.openstreetmap\\.org|server\\.arcgisonline\\.com|[a-c]\\.tile\\.opentopomap\\.org)$"));
    const QString host = url.host();
    if (!allowed.match(host).hasMatch() || info.resourceType() != QWebEngineUrlRequestInfo::ResourceTypeImage) {
        info.block(true);
        return;
    }
    if (host == QLatin1String("tile.openstreetmap.org") || host.endsWith(QLatin1String(".tile.opentopomap.org")))
        info.setHttpHeader("User-Agent", "OmaMap/" OMAMAP_VERSION " (+https://github.com/thebytorsnowdog/omamap)");
}
