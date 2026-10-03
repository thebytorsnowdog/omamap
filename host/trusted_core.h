#pragma once
#include <QString>

// Reject web code that another local user can modify. Paths outside the core
// reached by symlinks are not served by SchemeHandler and are not traversed.
bool trustedCore(const QString &dir);
