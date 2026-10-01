#!/usr/bin/env python3
"""Online supply-chain check; never run as part of the offline app build.

Verify release provenance and report GitHub advisories. Embedded dependencies
whose exact versions are not published by shpjs are checked conservatively at
package level: a result requires investigation rather than assuming safety.
"""
import io
import json
import os
from pathlib import Path
import tarfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
inventory = json.loads((ROOT / "packaging/vendor-dependencies.json").read_text())


def fetch(url):
    headers = {"User-Agent": "OmaMap-vendor-audit", "Accept": "application/json"}
    if url.startswith("https://api.github.com/") and os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        data = response.read(20 * 1024 * 1024 + 1)
        if len(data) > 20 * 1024 * 1024:
            raise ValueError("Upstream response exceeded the download limit")
        return data


def advisories(package):
    # Paginate: an empty first page is meaningful; truncating a full page is not.
    results = []
    for page in range(1, 101):
        query = urllib.parse.urlencode({"ecosystem": "npm", "affects": package, "per_page": 100, "page": page})
        batch = json.loads(fetch("https://api.github.com/advisories?" + query))
        results.extend(batch)
        if len(batch) < 100:
            return results
    raise ValueError("Advisory pagination limit reached")


def main():
    failed = False
    for library in inventory["libraries"]:
        name, version = library["package"], library["version"]
        metadata = json.loads(fetch("https://registry.npmjs.org/" + urllib.parse.quote(name, safe="@/") + "/" + version))
        url = metadata["dist"]["tarball"]
        if not url.startswith("https://registry.npmjs.org/"):
            raise ValueError("Unexpected release archive host")
        with tarfile.open(fileobj=io.BytesIO(fetch(url)), mode="r:gz") as archive:
            for local, member in library["files"].items():
                info = archive.getmember(member)
                if not info.isfile() or info.size > 5 * 1024 * 1024:
                    raise ValueError("Invalid release member")
                if archive.extractfile(info).read() != (ROOT / "core/vendor" / local).read_bytes():
                    print("Release mismatch:", local)
                    failed = True
        found = advisories(name + "@" + version)
        print(name, version, "advisories:", len(found))
        for item in found:
            print(item["ghsa_id"], item["summary"], item["html_url"])
        failed |= bool(found)
    for name in inventory["bundledWithoutExactVersion"]:
        found = advisories(name)
        print(name, "embedded version unspecified; advisories requiring review:", len(found))
        for item in found:
            print(item["ghsa_id"], item["summary"], item["html_url"])
        failed |= bool(found)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
