#pragma once

#include <QString>

// Recently opened files and saved profiles, newest first, in
// $XDG_STATE_HOME/omamap/recent.json. The Omarchy bar widget reads this file:
//   {"version":1,"recent":[{"path":"…","name":"…","kind":"profile|data","time":"ISO-8601"}]}
namespace Recent {
QString filePath();
void add(const QString &path);
}
