#pragma once

#include <QFileSystemWatcher>
#include <QJsonObject>
#include <QTimer>

// Reads the active Omarchy theme (colors.toml) and UI font, and reports
// changes when the user switches theme.
class ThemeWatcher : public QObject
{
    Q_OBJECT
public:
    explicit ThemeWatcher(QObject *parent = nullptr);

    QJsonObject current() const { return m_theme; }
    QString background() const;

signals:
    void changed(const QJsonObject &theme);

private:
    void reload();
    void rewatch();
    static QString themeDir();
    static QString readFont();

    QFileSystemWatcher m_watcher;
    QTimer m_debounce;
    QJsonObject m_theme;
};
