#pragma once
#include <QString>

// The completed download must be on the same filesystem as the destination.
// Failure leaves the previous destination intact; success replaces it atomically.
bool commitProfile(const QString &staged, const QString &destination);
