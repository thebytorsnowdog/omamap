#include "scheme.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QIODevice>
#include <QMultiMap>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QUrl>
#include <QWebEngineUrlRequestInfo>
#include <QWebEngineUrlRequestJob>
#include <QWebEngineUrlScheme>

namespace {
// Keep in step with OmaParse.LIMITS.fileBytes and .zipBytes in core/parse.js.
constexpr qint64 OpenedFileBytes = qint64(100) * 1024 * 1024;
constexpr qint64 OpenedZipBytes = qint64(50) * 1024 * 1024;

qint64 openedFileLimit(const QString &path)
{
    const QString ext = QFileInfo(path).suffix().toLower();
    if (ext == QLatin1String("zip") || ext == QLatin1String("kmz")) return OpenedZipBytes;
    return OpenedFileBytes;
}

// The response stops at the size observed when the file was opened. A later
// append cannot make Chromium read more than that, because size() stays put
// and readData will not pass it.
class BoundedFile : public QIODevice
{
public:
    explicit BoundedFile(const QString &path, QObject *parent)
        : QIODevice(parent)
        , m_file(path)
    {
    }

    bool open(QIODevice::OpenMode mode) override
    {
        Q_UNUSED(mode);
        if (isOpen()) return true;
        if (!m_file.open(QIODevice::ReadOnly)) return false;
        m_size = m_file.size();
        return QIODevice::open(QIODevice::ReadOnly);
    }

    void close() override
    {
        m_file.close();
        QIODevice::close();
    }

    qint64 size() const override { return m_size; }

protected:
    qint64 readData(char *data, qint64 maxSize) override
    {
        const qint64 pos = m_file.pos();
        if (pos < 0) return -1;
        if (pos >= m_size) return 0;
        return m_file.read(data, qMin(maxSize, m_size - pos));
    }

    qint64 writeData(const char *, qint64) override { return -1; }

    bool seek(qint64 pos) override
    {
        if (pos < 0 || pos > m_size) return false;
        if (!m_file.seek(pos)) return false;
        return QIODevice::seek(pos);
    }

private:
    QFile m_file;
    qint64 m_size = 0;
};

} // namespace

const QByteArray SchemeHandler::ContentSecurityPolicy =
    "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; "
    "img-src 'self' data: https://tile.openstreetmap.org https://server.arcgisonline.com "
    "https://a.tile.opentopomap.org https://b.tile.opentopomap.org https://c.tile.opentopomap.org; "
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

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
    // Unguessable, so a URL for one opened file says nothing about others.
    quint32 words[4];
    QRandomGenerator::system()->fillRange(words);
    const QString token = QString::fromLatin1(QByteArray(reinterpret_cast<const char *>(words), sizeof words).toHex());
    m_files.insert(token, absolutePath);
    const QString name = QString::fromUtf8(QUrl::toPercentEncoding(QFileInfo(absolutePath).fileName()));
    return QStringLiteral("%1://%2/file/%3/%4").arg(Scheme, Host, token, name);
}

void SchemeHandler::revokeAll()
{
    m_files.clear();
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

    // Opened files: omamap://app/file/<token>/<name>, for the app's own page only.
    static const QRegularExpression fileRoute(QStringLiteral("^/file/([0-9a-f]{32})/"));
    const auto match = fileRoute.match(path);
    if (match.hasMatch()) {
        const QString token = match.captured(1);
        const QString target = m_files.value(token);
        const QUrl from = job->initiator();
        if (from.scheme() != QLatin1String(Scheme) || from.host() != QLatin1String(Host)) {
            job->fail(QWebEngineUrlRequestJob::RequestDenied);
            return;
        }
        // Still a regular file: a FIFO or device swapped in since it was
        // opened would block or never end.
        if (target.isEmpty() || !QFileInfo(target).isFile()) {
            job->fail(QWebEngineUrlRequestJob::UrlNotFound);
            return;
        }
        auto *file = new BoundedFile(target, job);
        if (!file->open(QIODevice::ReadOnly)) {
            job->fail(QWebEngineUrlRequestJob::UrlNotFound);
            return;
        }
        // The page also checks the size it was told at open. This is the
        // check that still applies if the file was replaced since then.
        if (file->size() < 0 || file->size() > openedFileLimit(target)) {
            file->close();
            job->fail(QWebEngineUrlRequestJob::RequestDenied);
            return;
        }
        // Single use: the page reads each opened file once, so a URL that
        // leaked (a log, a crash report, a later page) is worth nothing.
        m_files.remove(token);
        // Data, never a document: if anything navigated here it could not run.
        job->setAdditionalResponseHeaders({
            {"Content-Security-Policy", "sandbox; default-src 'none'"},
            {"X-Content-Type-Options", "nosniff"},
            {"Content-Length", QByteArray::number(file->size())},
        });
        job->reply("application/octet-stream", file);
        return;
    }

    // Web core files, confined to the core directory.
    QString rel = path == QLatin1String("/") ? QStringLiteral("index.html") : path.mid(1);
    const QString full = QFileInfo(QDir(m_coreDir).filePath(rel)).canonicalFilePath();
    if (m_coreDir.isEmpty() || full.isEmpty() || !full.startsWith(m_coreDir + QLatin1Char('/')) || !QFileInfo(full).isFile()) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }
    auto *file = new QFile(full, job);
    if (!file->open(QIODevice::ReadOnly)) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }
    job->setAdditionalResponseHeaders({
        {"Content-Security-Policy", ContentSecurityPolicy},
        {"X-Content-Type-Options", "nosniff"},
        {"Referrer-Policy", "strict-origin-when-cross-origin"},
    });
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
    // One identifiable agent for every basemap. The page's own address is not
    // useful to a tile server, and the default engine string would add a
    // browser version on top of the area the tile request already reveals.
    info.setHttpHeader("User-Agent", "OmaMap/" OMAMAP_VERSION " (+https://github.com/thebytorsnowdog/omamap)");
    info.setHttpHeader("Referer", QByteArray());
}
