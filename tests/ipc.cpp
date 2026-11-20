#include "ipc.h"

#include <cstdio>

static bool check(bool ok, const char *label)
{
    if (!ok) std::fprintf(stderr, "%s\n", label);
    return ok;
}

int main()
{
    QByteArray message, pending;
    const QStringList paths{"/tmp/a.geojson", "/tmp/one\ntwo.shp", "/tmp/one\ntwo.dbf"};
    if (!check(makeIpcMessage(paths, message), "encodes a batch")) return 1;
    for (qsizetype i = 0; i < message.size() - 1; ++i) {
        const auto partial = takeIpcMessage(pending, message.sliced(i, 1));
        if (!check(!partial.complete && partial.paths.isEmpty(), "partial reads do not publish any paths")) return 1;
    }
    const auto full = takeIpcMessage(pending, message.last(1));
    if (!check(full.complete && full.error.isEmpty() && full.paths == paths, "accepts one complete batch with odd filenames")) return 1;

    pending.clear();
    if (!check(makeIpcMessage({}, message), "encodes a request to raise the window")) return 1;
    const auto raise = takeIpcMessage(pending, message);
    if (!check(raise.complete && raise.error.isEmpty() && raise.paths.isEmpty(), "accepts a request to raise the window")) return 1;

    pending.clear();
    const auto partial = takeIpcMessage(pending, QByteArray(IpcMaxPendingBytes, 'x'));
    if (!check(!partial.complete, "keeps a bounded incomplete request")) return 1;
    const auto oversized = takeIpcMessage(pending, QByteArray(1, '\0'));
    if (!check(oversized.complete && !oversized.error.isEmpty() && oversized.paths.isEmpty(), "rejects the entire oversized request")) return 1;
    const QString tooLong = "/tmp/" + QString(IpcMaxPendingBytes, QLatin1Char('x'));
    if (!check(!makeIpcMessage({"/tmp/a.geojson", tooLong}, message) && message.isEmpty(), "sender does not truncate an oversized request")) return 1;

    for (const QByteArray &line : {"https://example.invalid/a\n", "file:relative\n", "not-a-url\n", "file:///tmp/a", "file:///tmp/a%00b\n"}) {
        pending.clear();
        const auto invalid = takeIpcMessage(pending, "file:///tmp/valid\n" + line + '\0');
        if (!check(invalid.complete && !invalid.error.isEmpty() && invalid.paths.isEmpty(), "malformed lines reject the batch")) return 1;
    }

    pending.clear();
    makeIpcMessage(paths, message);
    const auto trailing = takeIpcMessage(pending, message + "trailing");
    if (!check(trailing.complete && !trailing.error.isEmpty() && trailing.paths.isEmpty(), "rejects bytes after the terminator")) return 1;

    return 0;
}
