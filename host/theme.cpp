#include "theme.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QRegularExpression>
#include <QStandardPaths>

ThemeWatcher::ThemeWatcher(QObject *parent)
    : QObject(parent)
{
    // Theme switches replace the whole directory; coalesce the burst of events.
    m_debounce.setSingleShot(true);
    m_debounce.setInterval(250);
    connect(&m_debounce, &QTimer::timeout, this, [this] {
        const QJsonObject before = m_theme;
        reload();
        rewatch();
        if (m_theme != before) emit changed(m_theme);
    });
    connect(&m_watcher, &QFileSystemWatcher::directoryChanged, &m_debounce, qOverload<>(&QTimer::start));
    connect(&m_watcher, &QFileSystemWatcher::fileChanged, &m_debounce, qOverload<>(&QTimer::start));
    reload();
    rewatch();
}

QString ThemeWatcher::themeDir()
{
    const QString override = qEnvironmentVariable("OMAMAP_THEME_DIR");
    if (!override.isEmpty()) return override;
    QString state = qEnvironmentVariable("XDG_STATE_HOME");
    if (state.isEmpty()) state = QDir::homePath() + QStringLiteral("/.local/state");
    return state + QStringLiteral("/omarchy/current/theme");
}

QString ThemeWatcher::readFont()
{
    if (QStandardPaths::findExecutable(QStringLiteral("omarchy-font-current")).isEmpty()) return {};
    QProcess p;
    p.start(QStringLiteral("omarchy-font-current"), {});
    if (!p.waitForFinished(1500)) { p.kill(); return {}; }
    return QString::fromUtf8(p.readAllStandardOutput()).trimmed().left(80);
}

void ThemeWatcher::reload()
{
    QJsonObject colors;
    QString mode = QStringLiteral("dark");
    QFile file(themeDir() + QStringLiteral("/colors.toml"));
    if (file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        // colors.toml is flat: key = "value" lines and comments.
        static const QRegularExpression line(QStringLiteral("^\\s*([A-Za-z0-9_]+)\\s*=\\s*\"([^\"]*)\"\\s*(#.*)?$"));
        static const QRegularExpression hex(QStringLiteral("^#[0-9A-Fa-f]{6}$"));
        while (!file.atEnd()) {
            const auto m = line.match(QString::fromUtf8(file.readLine()).trimmed());
            if (!m.hasMatch()) continue;
            const QString key = m.captured(1), value = m.captured(2);
            if (key == QLatin1String("mode")) mode = value == QLatin1String("light") ? value : QStringLiteral("dark");
            else if (hex.match(value).hasMatch()) colors.insert(key, value);
        }
    }
    QJsonObject theme{{"mode", mode}, {"colors", colors}};
    const QString font = m_theme.isEmpty() || !m_theme.contains("font") ? readFont() : m_theme.value("font").toString();
    if (!font.isEmpty()) theme.insert("font", font);
    m_theme = theme;
}

void ThemeWatcher::rewatch()
{
    if (!m_watcher.files().isEmpty()) m_watcher.removePaths(m_watcher.files());
    if (!m_watcher.directories().isEmpty()) m_watcher.removePaths(m_watcher.directories());
    const QString dir = themeDir();
    const QString parent = QFileInfo(dir).absolutePath();
    QStringList paths;
    for (const QString &p : {parent, dir, dir + QStringLiteral("/colors.toml")})
        if (QFileInfo::exists(p)) paths << p;
    if (!paths.isEmpty()) m_watcher.addPaths(paths);
}

QString ThemeWatcher::background() const
{
    return m_theme.value("colors").toObject().value("background").toString(QStringLiteral("#1a1b26"));
}
