"use strict";
/* ---------------------------------------------------------------------------
   OmaMap parsing and validation.

   Ported from WIMP 1.1.0's reviewed import paths. Runs in the parse worker
   (parse-worker.js) and, for KML/GPX which need DOMParser, on the main thread.
   Depends on globals provided by the vendored UMD builds: Papa, shp, fflate,
   and (main thread only) toGeoJSON.
--------------------------------------------------------------------------- */
(function (root) {

  const LIMITS = Object.freeze({
    fileBytes: 100 * 1024 * 1024,       // per non-ZIP file
    zipBytes: 50 * 1024 * 1024,         // compressed ZIP
    expandedZipBytes: 250 * 1024 * 1024,
    zipEntries: 500,
    zipRatio: 100,                      // with a 1 MiB small-file allowance
    features: 500000,                   // per dataset
    coordinates: 5000000,               // positions per dataset
    geometryDepth: 8,
    propertiesPerFeature: 500,
    propertyString: 100000,
    propertyBytes: 200 * 1024 * 1024
  });

  const FORBIDDEN_PROPERTY_NAMES = ["__proto__", "prototype", "constructor"];
  const GEOMETRY_TYPES = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
  const SHAPE_PARTS = ["shp", "dbf", "prj", "cpg"];

  function isGeometryType(type) { return typeof type === "string" && GEOMETRY_TYPES.indexOf(type) !== -1; }

  function extOf(name) {
    const m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function safeMessage(err, fallback) {
    let s = err && err.message ? String(err.message) : (fallback || "Error.");
    s = s.replace(/[\x00-\x1f\x7f]/g, " ");
    if (s.length > 500) s = s.slice(0, 500) + "…";
    return s;
  }

  function decodeText(bytes) {
    // Tolerate legacy encodings in text formats rather than failing: invalid
    // UTF-8 sequences become U+FFFD, which is visible in the inspector.
    return new TextDecoder("utf-8").decode(bytes);
  }

  /* ----------------------------- GeoJSON --------------------------------- */

  function normalizeToFeatureCollection(geojson) {
    if (!geojson || typeof geojson !== "object") throw new Error("Data must be a GeoJSON object.");
    if (Array.isArray(geojson)) {
      const all = [];
      geojson.forEach(function (item, index) {
        const part = normalizeToFeatureCollection(item);
        if (!part.features.length) throw new Error("Layer " + index + " contained no features.");
        for (let i = 0; i < part.features.length; i++) all.push(part.features[i]);
      });
      return { type: "FeatureCollection", features: all };
    }
    if (geojson.type === "FeatureCollection") {
      if (!Array.isArray(geojson.features)) throw new Error("FeatureCollection requires a features array.");
      return { type: "FeatureCollection", features: geojson.features.slice() };
    }
    if (geojson.type === "Feature") return { type: "FeatureCollection", features: [geojson] };
    if (isGeometryType(geojson.type)) return { type: "FeatureCollection", features: [{ type: "Feature", geometry: geojson, properties: {} }] };
    throw new Error("Data is not a supported GeoJSON type.");
  }

  function validatePosition(position, counter) {
    if (!Array.isArray(position) || position.length < 2 || position.length > 4) throw new Error("Coordinate positions need two to four numbers.");
    for (let i = 0; i < position.length; i++) {
      if (typeof position[i] !== "number" || !Number.isFinite(position[i])) throw new Error("Coordinates must be finite numbers, not strings or blanks.");
    }
    if (position[0] < -180 || position[0] > 180 || position[1] < -90 || position[1] > 90) {
      throw new Error("Coordinates fall outside WGS84 longitude/latitude bounds. Projected data needs a .prj file (shapefile) or reprojecting to WGS84.");
    }
    counter.count++;
    if (counter.count > LIMITS.coordinates) throw new Error("Dataset exceeds the " + LIMITS.coordinates.toLocaleString() + " coordinate limit.");
  }

  function samePosition(a, b) {
    return a.length === b.length && a.every(function (value, index) { return value === b[index]; });
  }

  function validateGeometry(geometry, counter, depth) {
    depth = depth || 0;
    if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) throw new Error("Every feature requires a non-null geometry.");
    if (depth > LIMITS.geometryDepth) throw new Error("GeometryCollection nesting limit exceeded.");
    const type = geometry.type;
    if (!isGeometryType(type)) throw new Error("Unsupported geometry type: " + String(type));
    if (type === "GeometryCollection") {
      if (!Array.isArray(geometry.geometries) || !geometry.geometries.length) throw new Error("GeometryCollection requires at least one geometry.");
      geometry.geometries.forEach(function (child) { validateGeometry(child, counter, depth + 1); });
      return;
    }
    const c = geometry.coordinates;
    if (!Array.isArray(c)) throw new Error(type + " requires coordinates.");
    if (type === "Point") return validatePosition(c, counter);
    if (type === "MultiPoint") {
      if (!c.length) throw new Error("MultiPoint requires at least one position.");
      return c.forEach(function (p) { validatePosition(p, counter); });
    }
    if (type === "LineString") {
      if (c.length < 2) throw new Error("LineString requires at least two positions.");
      return c.forEach(function (p) { validatePosition(p, counter); });
    }
    if (type === "MultiLineString") {
      if (!c.length) throw new Error("MultiLineString requires at least one line.");
      return c.forEach(function (line) {
        if (!Array.isArray(line) || line.length < 2) throw new Error("Each line requires at least two positions.");
        line.forEach(function (p) { validatePosition(p, counter); });
      });
    }
    function validateRing(ring) {
      if (!Array.isArray(ring) || ring.length < 4) throw new Error("Polygon rings require at least four positions.");
      ring.forEach(function (p) { validatePosition(p, counter); });
      if (!samePosition(ring[0], ring[ring.length - 1])) throw new Error("Polygon rings must be closed.");
    }
    if (type === "Polygon") {
      if (!c.length) throw new Error("Polygon requires at least one ring.");
      return c.forEach(validateRing);
    }
    if (!c.length) throw new Error("MultiPolygon requires at least one polygon.");
    c.forEach(function (polygon) {
      if (!Array.isArray(polygon) || !polygon.length) throw new Error("Each polygon requires at least one ring.");
      polygon.forEach(validateRing);
    });
  }

  function copyJsonValue(value, depth, budget) {
    if (depth > 20) throw new Error("Nested property depth exceeds 20.");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Property numbers must be finite.");
      return value;
    }
    if (typeof value === "string") {
      if (value.length > LIMITS.propertyString) throw new Error("A property value exceeds the 100,000 character limit.");
      budget.bytes += value.length * 2;
      return value;
    }
    if (Array.isArray(value)) return value.map(function (item) { return copyJsonValue(item, depth + 1, budget); });
    if (typeof value === "object") {
      const out = {};
      const keys = Object.keys(value);
      if (keys.length > LIMITS.propertiesPerFeature) throw new Error("An object has too many properties.");
      keys.forEach(function (key) {
        if (FORBIDDEN_PROPERTY_NAMES.indexOf(key) >= 0) throw new Error("Rejected unsafe property name: " + key);
        out[key] = copyJsonValue(value[key], depth + 1, budget);
      });
      return out;
    }
    throw new Error("Properties may contain only JSON values.");
  }

  /* Normalise any GeoJSON input into a validated FeatureCollection copy with
     own-property objects only. Throws on any structural problem. */
  function validateFeatureCollection(input) {
    const fc = normalizeToFeatureCollection(input);
    if (fc.features.length > LIMITS.features) throw new Error("Dataset exceeds the " + LIMITS.features.toLocaleString() + " feature limit.");
    const counter = { count: 0 };
    const budget = { bytes: 0 };
    const features = fc.features.map(function (feature, index) {
      if (!feature || typeof feature !== "object" || feature.type !== "Feature") throw new Error("Feature " + index + " is invalid.");
      validateGeometry(feature.geometry, counter, 0);
      if (feature.properties !== undefined && feature.properties !== null && (typeof feature.properties !== "object" || Array.isArray(feature.properties))) throw new Error("Feature properties must be a JSON object.");
      const output = {
        type: "Feature",
        geometry: copyJsonValue(feature.geometry, 0, budget),
        properties: copyJsonValue(feature.properties == null ? {} : feature.properties, 0, budget)
      };
      if (Object.prototype.hasOwnProperty.call(feature, "id") && feature.id != null) {
        if (!(typeof feature.id === "string" || (typeof feature.id === "number" && Number.isSafeInteger(feature.id)))) throw new Error("Feature IDs must be strings or safe integers.");
        output.id = feature.id;
      }
      return output;
    });
    if (budget.bytes > LIMITS.propertyBytes) throw new Error("Dataset attribute data exceeds the size budget.");
    if (!features.length) throw new Error("Dataset contains no features.");
    return { type: "FeatureCollection", features: features, coordinateCount: counter.count };
  }

  /* ------------------------ British National Grid ------------------------ */
  // OSGB36 / British National Grid (EPSG:27700) to WGS84, using the Ordnance
  // Survey transverse Mercator formulas and a 7-parameter Helmert shift.
  // Accurate to roughly 5 m, which suits viewing and inspection.

  const BNG = { minE: 0, maxE: 700000, minN: 0, maxN: 1300000 };

  function inBng(e, n) { return e >= BNG.minE && e <= BNG.maxE && n >= BNG.minN && n <= BNG.maxN; }

  function bngToWgs84(easting, northing) {
    const a = 6377563.396, b = 6356256.909, F0 = 0.9996012717;
    const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180, N0 = -100000, E0 = 400000;
    const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n;
    let lat = lat0, M = 0;
    do {
      lat = (northing - N0 - M) / (a * F0) + lat;
      const dl = lat - lat0, sl = lat + lat0;
      M = b * F0 * ((1 + n + 1.25 * n2 + 1.25 * n3) * dl
        - (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(dl) * Math.cos(sl)
        + (1.875 * n2 + 1.875 * n3) * Math.sin(2 * dl) * Math.cos(2 * sl)
        - (35 / 24) * n3 * Math.sin(3 * dl) * Math.cos(3 * sl));
    } while (Math.abs(northing - N0 - M) >= 0.00001);
    const sin = Math.sin(lat), cos = Math.cos(lat), tan = Math.tan(lat);
    const nu = a * F0 / Math.sqrt(1 - e2 * sin * sin);
    const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sin * sin, 1.5);
    const eta2 = nu / rho - 1;
    const t2 = tan * tan, t4 = t2 * t2, t6 = t4 * t2, sec = 1 / cos;
    const VII = tan / (2 * rho * nu);
    const VIII = tan / (24 * rho * Math.pow(nu, 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
    const IX = tan / (720 * rho * Math.pow(nu, 5)) * (61 + 90 * t2 + 45 * t4);
    const X = sec / nu;
    const XI = sec / (6 * Math.pow(nu, 3)) * (nu / rho + 2 * t2);
    const XII = sec / (120 * Math.pow(nu, 5)) * (5 + 28 * t2 + 24 * t4);
    const XIIA = sec / (5040 * Math.pow(nu, 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
    const dE = easting - E0;
    const latA = lat - VII * dE * dE + VIII * Math.pow(dE, 4) - IX * Math.pow(dE, 6);
    const lonA = lon0 + X * dE - XI * Math.pow(dE, 3) + XII * Math.pow(dE, 5) - XIIA * Math.pow(dE, 7);

    // OSGB36 geodetic -> cartesian (Airy 1830), Helmert to WGS84, -> geodetic.
    const sA = Math.sin(latA), cA = Math.cos(latA);
    const nuA = a / Math.sqrt(1 - e2 * sA * sA);
    const x1 = nuA * cA * Math.cos(lonA), y1 = nuA * cA * Math.sin(lonA), z1 = (1 - e2) * nuA * sA;
    const tx = 446.448, ty = -125.157, tz = 542.060, s = -20.4894e-6;
    const sec2rad = Math.PI / (180 * 3600);
    const rx = 0.1502 * sec2rad, ry = 0.2470 * sec2rad, rz = 0.8421 * sec2rad;
    const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
    const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
    const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;
    const aW = 6378137, bW = 6356752.3142, e2W = 1 - (bW * bW) / (aW * aW);
    const p = Math.sqrt(x2 * x2 + y2 * y2);
    let phi = Math.atan2(z2, p * (1 - e2W)), prev;
    do {
      prev = phi;
      const nuW = aW / Math.sqrt(1 - e2W * Math.sin(phi) * Math.sin(phi));
      phi = Math.atan2(z2 + e2W * nuW * Math.sin(phi), p);
    } while (Math.abs(phi - prev) > 1e-12);
    const lambda = Math.atan2(y2, x2);
    return [Math.round(lambda * 180 / Math.PI * 1e7) / 1e7, Math.round(phi * 180 / Math.PI * 1e7) / 1e7];
  }

  /* Transform every position in GeoJSON-shaped data from BNG to WGS84.
     Shape problems are left for validateFeatureCollection to report. */
  function reprojectBng(value, depth, counter) {
    if (depth > LIMITS.geometryDepth + 6 || !Array.isArray(value)) return value;
    if (value.length >= 2 && value.length <= 4 && typeof value[0] === "number" && typeof value[1] === "number") {
      if (++counter.count > LIMITS.coordinates) throw new Error("Dataset exceeds the coordinate limit.");
      if (!inBng(value[0], value[1])) throw new Error("A coordinate is outside the British National Grid area.");
      return bngToWgs84(value[0], value[1]).concat(value.slice(2));
    }
    return value.map(function (v) { return reprojectBng(v, depth + 1, counter); });
  }

  // GeoJSON written by older tools (e.g. QGIS) may declare a named CRS.
  function declaresBng(data) {
    const crs = data && data.crs;
    const name = crs && crs.properties && typeof crs.properties.name === "string" ? crs.properties.name : "";
    return /(^|[^0-9])27700$/.test(name.trim());
  }

  function reprojectGeoJsonBng(data) {
    const counter = { count: 0 };
    const geom = function (g) {
      if (!g || typeof g !== "object") return g;
      if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) return Object.assign({}, g, { geometries: g.geometries.map(geom) });
      return Object.assign({}, g, { coordinates: reprojectBng(g.coordinates, 0, counter) });
    };
    if (data.type === "FeatureCollection" && Array.isArray(data.features)) {
      return Object.assign({}, data, { features: data.features.map(function (f) { return f && typeof f === "object" ? Object.assign({}, f, { geometry: geom(f.geometry) }) : f; }) });
    }
    if (data.type === "Feature") return Object.assign({}, data, { geometry: geom(data.geometry) });
    return geom(data);
  }

  function parseJson(text) {
    try { return JSON.parse(text); }
    catch (e) { throw new Error("File is not valid JSON."); }
  }

  function jsonToGeoJSON(text) { return geoJsonFromData(parseJson(text)); }

  function geoJsonFromData(data) {
    if (!data || typeof data !== "object") throw new Error("JSON did not contain an object.");
    if (declaresBng(data)) {
      const fc = validateFeatureCollection(reprojectGeoJsonBng(data));
      fc.notes = ["Converted from British National Grid (EPSG:27700)."];
      return fc;
    }
    return validateFeatureCollection(data);
  }

  /* ------------------------------- CSV ----------------------------------- */

  function exactCoordinate(value, label) {
    const text = String(value == null ? "" : value).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) throw new Error(label + " must be a complete numeric value.");
    const number = Number(text);
    if (!Number.isFinite(number)) throw new Error(label + " must be finite.");
    return number;
  }

  function csvToGeoJSON(text) {
    if (!text || !text.trim()) throw new Error("CSV file is empty.");
    const parsed = root.Papa.parse(text, { header: false, dynamicTyping: false, skipEmptyLines: "greedy" });
    if (parsed.errors && parsed.errors.length) throw new Error("CSV could not be parsed: malformed rows are not accepted.");
    if (parsed.data.length < 2) throw new Error("CSV has no data rows.");
    const fields = parsed.data[0];
    if (!Array.isArray(fields) || !fields.length) throw new Error("CSV headers are invalid.");
    const headerKeys = new Set();
    fields.forEach(function (field, index) {
      const key = String(field).replace(/^﻿/, "").trim();
      if (!key || headerKeys.has(key)) throw new Error("CSV headers must be non-empty and unique.");
      if (FORBIDDEN_PROPERTY_NAMES.indexOf(key) !== -1) throw new Error("Rejected unsafe CSV header: " + key);
      fields[index] = key;
      headerKeys.add(key);
    });
    const rows = parsed.data.slice(1);
    rows.forEach(function (row, index) {
      if (!Array.isArray(row) || row.length !== fields.length) throw new Error("CSV row " + (index + 2) + " has a different number of cells from its header.");
    });
    const normal = fields.map(function (field) { return String(field).toLowerCase().trim().replace(/[\s_-]+/g, ""); });
    const find = function (aliases) { return normal.findIndex(function (f) { return aliases.indexOf(f) >= 0; }); };
    const latIndex = find(["lat", "latitude", "gpsy", "wgs84lat", "wgs84latitude"]);
    const lonIndex = find(["lon", "lng", "long", "longitude", "gpsx", "wgs84lon", "wgs84longitude"]);
    const eIndex = find(["easting", "eastings", "east", "bngeasting", "osgbeasting", "gridx"]);
    const nIndex = find(["northing", "northings", "north", "bngnorthing", "osgbnorthing", "gridy"]);
    const xIndex = find(["x", "xcoord", "xcoordinate"]);
    const yIndex = find(["y", "ycoord", "ycoordinate"]);

    // Work out which coordinate columns to use and in which system.
    let xi, yi, grid;
    if (latIndex >= 0 && lonIndex >= 0) { xi = lonIndex; yi = latIndex; grid = false; }
    else if (eIndex >= 0 && nIndex >= 0) { xi = eIndex; yi = nIndex; grid = true; }
    else if (xIndex >= 0 && yIndex >= 0) {
      xi = xIndex; yi = yIndex;
      // x/y could be either: decide from the values.
      grid = rows.some(function (row) {
        const x = Number(String(row[xi]).trim()), y = Number(String(row[yi]).trim());
        return Number.isFinite(x) && Number.isFinite(y) && (Math.abs(x) > 180 || Math.abs(y) > 90);
      });
    } else {
      throw new Error("CSV needs coordinate columns: latitude/longitude (WGS84) or easting/northing (British National Grid).");
    }

    const features = rows.map(function (row, rowIndex) {
      const where = "Row " + (rowIndex + 2);
      const x = exactCoordinate(row[xi], where + (grid ? " easting" : " longitude"));
      const y = exactCoordinate(row[yi], where + (grid ? " northing" : " latitude"));
      let coordinates;
      if (grid) {
        if (!inBng(x, y)) throw new Error(where + " is outside the British National Grid area (easting 0–700000, northing 0–1300000).");
        coordinates = bngToWgs84(x, y);
      } else {
        if (y < -90 || y > 90 || x < -180 || x > 180) throw new Error(where + " is outside WGS84 bounds.");
        coordinates = [x, y];
      }
      const properties = {};
      fields.forEach(function (field, fieldIndex) { properties[field] = row[fieldIndex]; });
      return { type: "Feature", geometry: { type: "Point", coordinates: coordinates }, properties: properties };
    });
    const fc = validateFeatureCollection({ type: "FeatureCollection", features: features });
    if (grid) fc.notes = ["Converted from British National Grid (EPSG:27700) easting/northing."];
    return fc;
  }

  /* --------------------------- KML / GPX --------------------------------- */
  // Main thread only: needs DOMParser and toGeoJSON.

  function xmlToGeoJSON(text, ext) {
    if (/<!DOCTYPE|<!ENTITY/i.test(String(text))) throw new Error("XML with a DOCTYPE or ENTITY declaration is not accepted.");
    const doc = new root.DOMParser().parseFromString(text, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("File is not valid " + ext.toUpperCase() + " XML.");
    const geojson = ext === "kml" ? root.toGeoJSON.kml(doc) : root.toGeoJSON.gpx(doc);
    // toGeoJSON emits null-geometry features for empty placemarks; skip them
    // rather than rejecting the whole file.
    geojson.features = (geojson.features || []).filter(function (f) { return f && f.geometry; });
    return validateFeatureCollection(geojson);
  }

  /* ------------------------------- ZIP ----------------------------------- */

  let crcTable = null;
  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
      crcTable[index] = value;
    }
    return crcTable;
  }

  /* Validate the archive structure before any decompression: matching
     central/local headers, safe names, and complete non-overlapping entry
     spans. Entries written with a trailing data descriptor (macOS Finder,
     streaming tools) are accepted when the descriptor agrees with the
     central directory. */
  function inspectZipMetadata(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let endOffset = -1;
    function safeName(start, length, flags) {
      if (start + length > bytes.length) throw new Error("ZIP filename is truncated.");
      const encoded = bytes.subarray(start, start + length);
      let name;
      if (flags & 0x0800 || !encoded.some(function (byte) { return byte > 127; })) {
        try { name = new TextDecoder("utf-8", { fatal: true }).decode(encoded); }
        catch (error) { throw new Error("ZIP filenames must use valid UTF-8 or ASCII."); }
      } else {
        // Legacy (CP437 / local code page) names: decode leniently. Names only
        // group shapefile parts, so lossy characters are harmless.
        name = new TextDecoder("utf-8").decode(encoded);
      }
      if (!name || /[\x00-\x1f\x7f\\:]/.test(name) || name.startsWith("/") || /(^|\/)\.{1,2}(\/|$)/.test(name) || name.indexOf("//") >= 0) throw new Error("ZIP contains an unsafe filename.");
      return name.normalize("NFC").toLowerCase();
    }
    function validateExtra(start, length) {
      const end = start + length;
      if (end > bytes.length) throw new Error("ZIP extra field is truncated.");
      for (let position = start; position < end;) {
        if (position + 4 > end) throw new Error("ZIP extra field is truncated.");
        const id = view.getUint16(position, true), size = view.getUint16(position + 2, true);
        if (id === 1) throw new Error("ZIP64 archives are not supported.");
        if (position + 4 + size > end) throw new Error("ZIP extra field is truncated.");
        position += 4 + size;
      }
    }
    if (bytes.length < 22) throw new Error("File is too small to be a ZIP archive.");
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
      if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { endOffset = offset; break; }
    }
    if (endOffset < 0) throw new Error("ZIP end record is missing.");
    const count = view.getUint16(endOffset + 10, true);
    const centralOffset = view.getUint32(endOffset + 16, true);
    const centralSize = view.getUint32(endOffset + 12, true);
    if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
    if (view.getUint16(endOffset + 4, true) || view.getUint16(endOffset + 6, true) || view.getUint16(endOffset + 8, true) !== count) throw new Error("Multi-disk ZIP archives are not supported.");
    if (centralOffset + centralSize !== endOffset) throw new Error("ZIP central directory boundary is invalid.");
    if (!count || count > LIMITS.zipEntries) throw new Error("ZIP entry count is outside the supported limit (" + LIMITS.zipEntries + ").");
    const entries = [], names = new Set();
    let offset = centralOffset;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > endOffset || view.getUint32(offset, true) !== 0x02014b50) throw new Error("ZIP central directory is invalid.");
      const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
      const crc = view.getUint32(offset + 16, true), compressed = view.getUint32(offset + 20, true), expanded = view.getUint32(offset + 24, true);
      const localOffset = view.getUint32(offset + 42, true);
      const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
      if (flags & 1) throw new Error("Encrypted ZIP entries are not supported.");
      if (compressed === 0xffffffff || expanded === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
      if (offset + 46 + nameLength + extraLength + commentLength > endOffset) throw new Error("ZIP central entry is truncated.");
      validateExtra(offset + 46 + nameLength, extraLength);
      const name = safeName(offset + 46, nameLength, flags);
      if (names.has(name)) throw new Error("ZIP contains duplicate filenames.");
      names.add(name);
      const streamed = !!(flags & 0x0008);
      // Allowed flags: UTF-8 names, deflate level bits, data descriptor.
      if ((method !== 0 && method !== 8) || (flags & ~(method === 8 ? 0x080e : 0x0808))) throw new Error("ZIP entry flags or compression method are unsupported.");
      if (streamed && method === 0) throw new Error("Stored ZIP entries with data descriptors are not supported.");
      if (view.getUint16(offset + 34, true)) throw new Error("Multi-disk ZIP archives are not supported.");
      if (view.getUint16(offset + 6, true) > 45) throw new Error("ZIP entry version is unsupported.");
      if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIP local header is invalid.");
      const localFlags = view.getUint16(localOffset + 6, true), localMethod = view.getUint16(localOffset + 8, true);
      const localCrc = view.getUint32(localOffset + 14, true), localCompressed = view.getUint32(localOffset + 18, true), localExpanded = view.getUint32(localOffset + 22, true);
      const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const sizesAgree = (localCrc === crc && localCompressed === compressed && localExpanded === expanded) ||
        (streamed && localCrc === 0 && localCompressed === 0 && localExpanded === 0);
      if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength || !sizesAgree || dataOffset + compressed > centralOffset || view.getUint16(localOffset + 4, true) !== view.getUint16(offset + 6, true)) throw new Error("ZIP central and local entry metadata disagree.");
      validateExtra(localOffset + 30 + localNameLength, localExtraLength);
      for (let j = 0; j < nameLength; j++) if (bytes[offset + 46 + j] !== bytes[localOffset + 30 + j]) throw new Error("ZIP central and local entry names disagree.");
      let descriptorLength = 0;
      if (streamed) {
        const d = dataOffset + compressed;
        const signed = d + 16 <= centralOffset && view.getUint32(d, true) === 0x08074b50;
        const base = signed ? d + 4 : d;
        if (base + 12 > centralOffset) throw new Error("ZIP data descriptor is truncated.");
        if (view.getUint32(base, true) !== crc || view.getUint32(base + 4, true) !== compressed || view.getUint32(base + 8, true) !== expanded) throw new Error("ZIP data descriptor disagrees with the central directory.");
        descriptorLength = signed ? 16 : 12;
      }
      offset += 46 + nameLength + extraLength + commentLength;
      entries.push({ name: name, method: method, compressed: compressed, expanded: expanded, crc: crc, localOffset: localOffset, dataOffset: dataOffset, end: dataOffset + compressed + descriptorLength });
    }
    if (offset !== endOffset) throw new Error("ZIP central directory size or count disagrees.");
    // Every local entry must occupy one complete, non-overlapping span before the directory.
    let nextOffset = 0;
    entries.slice().sort(function (a, b) { return a.localOffset - b.localOffset; }).forEach(function (entry) {
      if (entry.localOffset !== nextOffset) throw new Error("ZIP local entries overlap or leave unlisted data.");
      nextOffset = entry.end;
    });
    if (nextOffset !== centralOffset) throw new Error("ZIP contains unlisted data before its central directory.");
    return entries;
  }

  /* Extract each entry exactly once with bounded inflate pushes, checking
     actual sizes, CRC-32, total expansion and compression ratio. Returns only
     the entries OmaMap can read. */
  function extractZip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.byteLength > LIMITS.zipBytes) throw new Error("ZIP exceeds the " + Math.round(LIMITS.zipBytes / 1048576) + " MiB limit.");
    const entries = inspectZipMetadata(bytes);
    const table = getCrcTable();
    const extracted = new Map();
    let expanded = 0;
    entries.forEach(function (entry) {
      const retain = !entry.name.split("/").includes("__macosx") && /\.(shp|dbf|prj|cpg|json|geojson|kml|gpx|csv)$/.test(entry.name);
      const chunks = [];
      let actual = 0, crc = 0xffffffff, finished = false;
      function accept(data, final) {
        actual += data.length;
        expanded += data.length;
        if (expanded > LIMITS.expandedZipBytes) throw new Error("ZIP expands beyond the " + Math.round(LIMITS.expandedZipBytes / 1048576) + " MiB limit.");
        if (expanded > Math.max(1024 * 1024, bytes.length * LIMITS.zipRatio)) throw new Error("ZIP compression ratio exceeds the safety limit.");
        if (actual > entry.expanded) throw new Error("ZIP actual expansion disagrees with its entry size.");
        for (let index = 0; index < data.length; index++) crc = (crc >>> 8) ^ table[(crc ^ data[index]) & 255];
        if (retain) chunks.push(data.slice());
        if (final) finished = true;
      }
      const inflater = entry.method === 8 ? new root.fflate.Inflate(accept) : null;
      const step = 64 * 1024;
      for (let offset = 0; offset < entry.compressed; offset += step) {
        const end = Math.min(entry.compressed, offset + step);
        const chunk = bytes.subarray(entry.dataOffset + offset, entry.dataOffset + end);
        if (inflater) inflater.push(chunk, end === entry.compressed);
        else accept(chunk, end === entry.compressed);
      }
      if (!entry.compressed && entry.method === 0) accept(new Uint8Array(0), true);
      if (!finished || actual !== entry.expanded) throw new Error("ZIP entry is truncated or its actual expansion disagrees.");
      if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error("ZIP entry checksum disagrees with its extracted bytes.");
      if (retain) {
        const output = new Uint8Array(actual);
        let offset = 0;
        chunks.forEach(function (chunk) { output.set(chunk, offset); offset += chunk.length; });
        extracted.set(entry.name, output);
      }
    });
    return extracted;
  }

  function baseName(path) {
    const name = String(path).split("/").pop();
    return name.replace(/\.[^.]+$/, "");
  }

  async function shapefileParts(parts) {
    if (!parts.shp) throw new Error("Shapefile is missing its .shp file.");
    const input = { shp: parts.shp };
    if (parts.dbf) input.dbf = parts.dbf;
    if (parts.prj) input.prj = decodeText(parts.prj);
    if (parts.cpg) input.cpg = decodeText(parts.cpg);
    return root.shp(input);
  }

  /* A ZIP may hold several layers. Each becomes its own dataset so they can be
     shown, hidden and inspected separately. */
  async function zipToDatasets(arrayBuffer, zipName) {
    let entries;
    try { entries = extractZip(arrayBuffer); }
    catch (error) { throw new Error("Could not read ZIP: " + safeMessage(error, "invalid or unsupported archive.")); }
    const layers = [];
    const multiple = Array.from(entries.keys()).filter(function (n) { return /\.(shp|json|geojson|csv)$/.test(n); }).length > 1;
    for (const [filename, bytes] of entries) {
      const label = multiple ? baseName(zipName) + " / " + baseName(filename) : baseName(zipName);
      if (filename.endsWith(".shp")) {
        const stem = filename.slice(0, -4);
        const raw = await shapefileParts({ shp: bytes, dbf: entries.get(stem + ".dbf"), prj: entries.get(stem + ".prj"), cpg: entries.get(stem + ".cpg") });
        layers.push({ name: label, geojson: validateFeatureCollection(raw), warnings: entries.has(stem + ".prj") ? [] : ["No .prj file: coordinates were assumed to be WGS84."] });
      } else if (/\.(geojson|json)$/.test(filename)) {
        layers.push(withNotes(label, jsonToGeoJSON(decodeText(bytes))));
      } else if (filename.endsWith(".csv")) {
        layers.push(withNotes(label, csvToGeoJSON(decodeText(bytes))));
      }
    }
    if (!layers.length) throw new Error("ZIP contains no shapefile, GeoJSON or CSV layers.");
    return layers;
  }

  /* ------------------------------ Profiles -------------------------------- */
  // A profile is a saved workspace: datasets with their data and styles, the
  // map view and the basemap. OmaMap writes .omamap; WIMP's .sdv-profile.json
  // files are read too.

  const PROFILE_VERSION = 1;
  const MAX_PROFILE_DATASETS = 50;

  function isProfile(data) {
    return !!data && typeof data === "object" && !Array.isArray(data) && (data.omamap === "profile" || data.__sdv_profile === true);
  }

  function cleanHex(v) { return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null; }
  function cleanNum(v, lo, hi, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; }
  function cleanText(v, max) { return typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : ""; }

  function cleanStyle(raw) {
    const st = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const out = {
      colour: cleanHex(st.colour),
      fillOpacity: cleanNum(st.fillOpacity, 0, 1, null),
      weight: cleanNum(st.weight, 0.5, 8, null),
      radius: cleanNum(st.radius, 2, 16, null),
      outline: ["auto", "fg", "bg", "none"].indexOf(st.outline) >= 0 ? st.outline : "auto",
      byField: null
    };
    const bf = st.byField;
    if (bf && typeof bf === "object" && typeof bf.field === "string" && bf.field && FORBIDDEN_PROPERTY_NAMES.indexOf(bf.field) < 0) {
      out.byField = { field: bf.field.slice(0, 200), mode: bf.mode === "ranges" ? "ranges" : "categories", reverse: bf.reverse === true };
    }
    return out;
  }

  // WIMP stored Leaflet-style options and a separate style-by-field record.
  function wimpStyle(ds) {
    const st = ds.style && typeof ds.style === "object" ? ds.style : {};
    const sbf = ds.styleByField && typeof ds.styleByField === "object" ? ds.styleByField : null;
    return cleanStyle({
      colour: cleanHex(st.fillColor) || cleanHex(st.color),
      fillOpacity: st.fillOpacity, weight: st.weight, radius: st.radius,
      byField: sbf && sbf.field ? { field: sbf.field, mode: "categories" } : null
    });
  }

  function parseProfile(data) {
    const wimp = data.__sdv_profile === true;
    if (!wimp && data.version !== PROFILE_VERSION) throw new Error("This profile was saved by a newer OmaMap (format " + String(data.version).slice(0, 10) + ").");
    if (!Array.isArray(data.datasets)) throw new Error("Profile has no dataset list.");
    if (data.datasets.length > MAX_PROFILE_DATASETS) throw new Error("Profile has more than " + MAX_PROFILE_DATASETS + " datasets.");
    const skipped = [];
    const datasets = [];
    data.datasets.forEach(function (ds, i) {
      if (!ds || typeof ds !== "object") throw new Error("Profile dataset " + (i + 1) + " is invalid.");
      const name = cleanText(ds.name, 200) || "Dataset " + (i + 1);
      // WIMP saved server-rendered map services without data; nothing to restore.
      if (wimp && ds.kind && ds.kind !== "vector") { skipped.push(name); return; }
      let geojson;
      try { geojson = validateFeatureCollection(ds.geojson); }
      catch (e) { throw new Error("Profile dataset “" + name + "”: " + safeMessage(e)); }
      datasets.push({ name: name, geojson: geojson, visible: ds.visible !== false, style: wimp ? wimpStyle(ds) : cleanStyle(ds.style), warnings: [] });
    });
    let view = null;
    const v = wimp ? (data.map && Array.isArray(data.map.center) ? { lat: data.map.center[0], lng: data.map.center[1], zoom: data.map.zoom } : null) : data.view;
    if (v && Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lng)) && Number.isFinite(Number(v.zoom))) {
      view = { lat: cleanNum(v.lat, -85, 85, 0), lng: cleanNum(v.lng, -180, 180, 0), zoom: cleanNum(v.zoom, 2, 22, 6) };
    }
    const basemapRaw = wimp ? (data.map && data.map.basemap) : data.basemap;
    const basemap = typeof basemapRaw === "string" && /^[a-z]{1,20}$/.test(basemapRaw) ? basemapRaw : null;
    return {
      kind: "profile",
      name: cleanText(data.name, 200),
      savedAt: cleanText(data.savedAt, 40),
      view: view,
      basemap: basemap,
      datasets: datasets,
      notes: skipped.length ? ["Not restored (map services have no saved data): " + skipped.join(", ")] : []
    };
  }

  /* ----------------------------- Dispatch -------------------------------- */

  // Conversion notes travel with the dataset and show in the dataset list.
  function withNotes(name, fc) {
    const notes = fc.notes || [];
    delete fc.notes;
    return { name: name, geojson: fc, warnings: notes };
  }

  /* Parse one file's bytes into a list of { name, geojson, warnings } datasets.
     KML/GPX are routed to xmlToGeoJSON by the caller on the main thread. */
  async function parseBytes(name, buffer) {
    const ext = extOf(name);
    const display = baseName(name) || "Untitled";
    if (ext === "zip") return zipToDatasets(buffer, name);
    if (buffer.byteLength > LIMITS.fileBytes) throw new Error("File is too large (limit " + Math.round(LIMITS.fileBytes / 1048576) + " MiB).");
    const text = decodeText(new Uint8Array(buffer));
    if (ext === "csv" || ext === "tsv" || ext === "txt") return [withNotes(display, csvToGeoJSON(text))];
    if (ext === "omamap" || ext === "json" || ext === "geojson") {
      const data = parseJson(text);
      if (isProfile(data)) return parseProfile(data);
      if (ext === "omamap") throw new Error("This is not an OmaMap profile.");
      return [withNotes(display, geoJsonFromData(data))];
    }
    if (ext === "kml" || ext === "gpx") return [{ name: display, geojson: xmlToGeoJSON(text, ext) }];
    // Unknown extension: try JSON, then CSV.
    try { return [withNotes(display, jsonToGeoJSON(text))]; }
    catch (e) { return [withNotes(display, csvToGeoJSON(text))]; }
  }

  async function parseShapefileSet(name, parts) {
    for (const key of Object.keys(parts)) {
      if (SHAPE_PARTS.indexOf(key) < 0) throw new Error("Unexpected shapefile part: " + key);
      if (parts[key].byteLength > LIMITS.fileBytes) throw new Error("Shapefile part ." + key + " is too large.");
    }
    const raw = await shapefileParts({
      shp: parts.shp && new Uint8Array(parts.shp), dbf: parts.dbf && new Uint8Array(parts.dbf),
      prj: parts.prj && new Uint8Array(parts.prj), cpg: parts.cpg && new Uint8Array(parts.cpg)
    });
    return [{ name: name, geojson: validateFeatureCollection(raw), warnings: parts.prj ? [] : ["No .prj file: coordinates were assumed to be WGS84."] }];
  }

  const api = {
    LIMITS: LIMITS,
    SHAPE_PARTS: SHAPE_PARTS,
    extOf: extOf,
    baseName: baseName,
    safeMessage: safeMessage,
    validateFeatureCollection: validateFeatureCollection,
    jsonToGeoJSON: jsonToGeoJSON,
    csvToGeoJSON: csvToGeoJSON,
    xmlToGeoJSON: xmlToGeoJSON,
    inspectZipMetadata: inspectZipMetadata,
    bngToWgs84: bngToWgs84,
    PROFILE_VERSION: PROFILE_VERSION,
    extractZip: extractZip,
    parseBytes: parseBytes,
    parseShapefileSet: parseShapefileSet
  };
  root.OmaParse = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
