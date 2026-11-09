"use strict";
/* ---------------------------------------------------------------------------
   OmaMap parsing and validation.

   Ported from WIMP 1.1.0's reviewed import paths. Runs in the parse worker
   (parse-worker.js). KML and GPX are scanned here too: Chromium workers have
   no DOMParser, and DOMParser.parseFromString cannot yield. Depends on
   globals provided by the vendored UMD builds: Papa, shp and fflate.
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
    fieldsPerDataset: 1000,             // distinct attribute names
    cells: 10000000,                    // attribute values built from one CSV or DBF
    propertyString: 100000,
    propertyBytes: 200 * 1024 * 1024,
    workspaceBytes: 512 * 1024 * 1024,  // estimated data + rendering structures, not an OS memory guarantee
    workspaceFeatures: 1000000,
    workspaceCoordinates: 10000000,
    layersPerFile: 50,                  // datasets from one ZIP or profile
    featuresPerFile: 1000000,           // all layers of one ZIP together
    arrayNesting: 4,                    // GeoJSON given as nested arrays of layers
    xmlDepth: 64,                       // elements open at once in one KML or GPX file
    xmlElements: 6000000,               // tags in one KML or GPX file
    xmlAttributes: 64,                  // attributes on one tag
    xmlNames: 4096                      // distinct tag names in one KML or GPX file
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

  function normalizeToFeatureCollection(geojson, depth) {
    depth = depth || 0;
    if (!geojson || typeof geojson !== "object") throw new Error("Data must be a GeoJSON object.");
    if (Array.isArray(geojson)) {
      // Bounded, so deeply nested arrays fail cleanly instead of exhausting the stack.
      if (depth >= LIMITS.arrayNesting) throw new Error("GeoJSON layer arrays are nested too deeply.");
      const all = [];
      geojson.forEach(function (item, index) {
        const part = normalizeToFeatureCollection(item, depth + 1);
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

  // Shapefile date fields arrive as Date objects; keep them as plain text. An
  // empty DBF date ("00000000") decodes to 1899-11-30, so that means no date.
  function dateText(d) {
    if (isNaN(d.getTime())) return null;
    if (d.getFullYear() === 1899 && d.getMonth() === 10 && d.getDate() === 30) return null;
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  /* Check a property value in place: JSON types only, finite numbers, bounded
     strings and nesting, and no prototype-pollution key anywhere. Returns the
     value to store (only Dates are replaced). Not copying keeps peak memory
     close to the parsed size, which matters for large files. */
  function budgetExceeded(budget) {
    return new Error("Dataset attribute data exceeds the " + Math.round(LIMITS.propertyBytes / 1048576) + " MiB attribute budget" +
      (budget.features ? " after " + budget.features.toLocaleString() + " features" : "") +
      ". Remove unused columns or split the file.");
  }

  function checkJsonValue(value, depth, budget) {
    budget.bytes += 16;
    if (budget.bytes > LIMITS.propertyBytes) throw budgetExceeded(budget);
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
    if (value instanceof Date) return dateText(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = checkJsonValue(value[i], depth + 1, budget);
      return value;
    }
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const keys = Object.keys(value);
      if (keys.length > LIMITS.propertiesPerFeature) throw new Error("An object has too many properties.");
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        // A feature's top-level attribute names repeat on every feature and
        // share one string, so they are charged once per dataset (see
        // validateFeatureCollection); each feature pays only for the slot.
        budget.bytes += depth === 0 ? 8 : key.length * 2 + 16;
        if (FORBIDDEN_PROPERTY_NAMES.indexOf(key) >= 0) throw new Error("Rejected unsafe property name: " + key);
        if (key.length > LIMITS.propertyString) throw new Error("A property name is too long.");
        const v = value[key];
        const checked = checkJsonValue(v, depth + 1, budget);
        if (checked !== v) value[key] = checked;
      }
      return value;
    }
    throw new Error("Properties may contain only JSON values.");
  }

  // The validated geometry, reduced to its GeoJSON members. Coordinate arrays
  // are reused, not copied.
  function cleanGeometry(g) {
    if (g.type === "GeometryCollection") return { type: g.type, geometries: g.geometries.map(cleanGeometry) };
    return { type: g.type, coordinates: g.coordinates };
  }

  /* Normalise any GeoJSON input into a validated FeatureCollection. Features
     are rebuilt with only type, geometry, properties and id; property objects
     are checked in place. Throws on any structural problem. */
  function validateFeatureCollection(input) {
    const fc = normalizeToFeatureCollection(input);
    if (fc.features.length > LIMITS.features) throw new Error("Dataset exceeds the " + LIMITS.features.toLocaleString() + " feature limit.");
    const counter = { count: 0 };
    const budget = { bytes: 0, features: 0 };
    // Every distinct attribute name becomes a table column and a "colour by"
    // choice, so a dataset may not invent an unbounded number of them.
    const fields = new Set();
    const features = new Array(fc.features.length);
    for (let index = 0; index < fc.features.length; index++) {
      const feature = fc.features[index];
      if (!feature || typeof feature !== "object" || feature.type !== "Feature") throw new Error("Feature " + index + " is invalid.");
      validateGeometry(feature.geometry, counter, 0);
      const props = feature.properties;
      if (props !== undefined && props !== null && (typeof props !== "object" || Array.isArray(props))) throw new Error("Feature properties must be a JSON object.");
      if (props) {
        // Own names only, matching checkJsonValue. Inherited enumerable
        // names are not attributes of this feature.
        const names = Object.keys(props);
        for (let n = 0; n < names.length; n++) {
          const key = names[n];
          if (!fields.has(key)) {
            fields.add(key);
            budget.bytes += key.length * 2 + 16;
            if (fields.size > LIMITS.fieldsPerDataset) throw new Error("Dataset has more than " + LIMITS.fieldsPerDataset.toLocaleString() + " different attribute names.");
          }
        }
      }
      const output = {
        type: "Feature",
        geometry: cleanGeometry(feature.geometry),
        properties: props == null ? {} : checkJsonValue(props, 0, budget)
      };
      if (Object.prototype.hasOwnProperty.call(feature, "id") && feature.id != null) {
        if (!(typeof feature.id === "string" || (typeof feature.id === "number" && Number.isSafeInteger(feature.id)))) throw new Error("Feature IDs must be strings or safe integers.");
        if (typeof feature.id === "string" && feature.id.length > 1000) throw new Error("A feature ID exceeds the 1,000 character limit.");
        output.id = feature.id;
      }
      features[index] = output;
      budget.features = index + 1;
    }
    if (budget.bytes > LIMITS.propertyBytes) throw budgetExceeded(budget);
    if (!features.length) throw new Error("Dataset contains no features.");
    return { type: "FeatureCollection", features: features, coordinateCount: counter.count, fields: Array.from(fields),
      estimatedBytes: features.length * 256 + counter.count * 64 + budget.bytes };
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
    const geom = function (g, depth) {
      if (!g || typeof g !== "object") return g;
      if (depth > LIMITS.geometryDepth) throw new Error("GeometryCollection nesting limit exceeded.");
      if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) return Object.assign({}, g, {
        geometries: g.geometries.map(function (child) { return geom(child, depth + 1); })
      });
      return Object.assign({}, g, { coordinates: reprojectBng(g.coordinates, 0, counter) });
    };
    if (data.type === "FeatureCollection" && Array.isArray(data.features)) {
      return Object.assign({}, data, { features: data.features.map(function (f) { return f && typeof f === "object" ? Object.assign({}, f, { geometry: geom(f.geometry, 0) }) : f; }) });
    }
    if (data.type === "Feature") return Object.assign({}, data, { geometry: geom(data.geometry, 0) });
    return geom(data, 0);
  }

  function parseJson(text) {
    // decodeText drops a UTF-8 BOM. A caller that already has a string may
    // still carry U+FEFF, which JSON.parse rejects.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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

  // Same set as JavaScript \s. A RegExp test on every character of a large
  // CSV dominates the preflight that exists to reject wide files early.
  function isCsvSpace(ch) {
    const c = ch.charCodeAt(0);
    return c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x20
      || c === 0xa0 || c === 0x1680 || c === 0xfeff
      || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  }

  function exactCoordinate(value, label) {
    const text = String(value == null ? "" : value).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) throw new Error(label + " must be a complete numeric value.");
    const number = Number(text);
    if (!Number.isFinite(number)) throw new Error(label + " must be finite.");
    return number;
  }

  function csvToGeoJSON(text) {
    if (!text || !text.trim()) throw new Error("CSV file is empty.");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    // Detect the delimiter on a bounded sample, then scan without building
    // arrays. Papa's chunk callbacks run AFTER a record has been allocated;
    // a single comma-heavy record otherwise bypasses the memory safeguards.
    const sample = root.Papa.parse(text.slice(0, 65536), { preview: 10, skipEmptyLines: "greedy" });
    const delimiter = sample.meta.delimiter;
    let quoted = false, atStart = true, width = 1, length = 0, rowCount = 0, cells = 0, nonempty = false;
    function record() {
      if (nonempty) {
        if (rowCount++ > 0) cells += width;
        if (rowCount > LIMITS.features + 1) throw new Error("CSV has more than " + LIMITS.features.toLocaleString() + " rows (the feature limit).");
        if (cells > LIMITS.cells) throw new Error("CSV has more than " + LIMITS.cells.toLocaleString() + " cells (rows × columns).");
      }
      width = 1; length = 0; atStart = true; nonempty = false;
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { i++; length++; }
          else quoted = false;
        } else length++;
        if (!isCsvSpace(ch) && ch !== '"') nonempty = true;
      } else if (ch === delimiter) {
        if (++width > LIMITS.propertiesPerFeature) throw new Error("CSV has more than " + LIMITS.propertiesPerFeature + " columns.");
        length = 0; atStart = true;
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        record();
      } else if (ch === '"' && atStart) {
        quoted = true; atStart = false;
      } else {
        atStart = false; length++;
        if (!isCsvSpace(ch)) nonempty = true;
      }
      if (length > LIMITS.propertyString) throw new Error("A CSV value exceeds the 100,000 character limit.");
    }
    record();
    // Parse in chunks and stop one row past the feature limit. Parsing (or
    // even line-splitting) all of a huge CSV first would exhaust memory before
    // the limit could be checked.
    const parsed = { data: [], errors: 0, tooMany: false };
    root.Papa.parse(text, {
      delimiter: delimiter, header: false, dynamicTyping: false, skipEmptyLines: "greedy", chunkSize: 1024 * 1024,
      chunk: function (result, parser) {
        parsed.errors += result.errors.length;
        for (let i = 0; i < result.data.length; i++) parsed.data.push(result.data[i]);
        if (parsed.data.length > LIMITS.features + 1) { parsed.tooMany = true; parser.abort(); }
      }
    });
    if (parsed.tooMany) throw new Error("CSV has more than " + LIMITS.features.toLocaleString() + " rows (the feature limit).");
    if (parsed.errors) throw new Error("CSV could not be parsed: malformed rows are not accepted.");
    if (parsed.data.length < 2) throw new Error("CSV has no data rows.");
    const fields = parsed.data[0];
    if (!Array.isArray(fields) || !fields.length) throw new Error("CSV headers are invalid.");
    if (fields.length > LIMITS.propertiesPerFeature) throw new Error("CSV has more than " + LIMITS.propertiesPerFeature + " columns.");
    if ((parsed.data.length - 1) * fields.length > LIMITS.cells) throw new Error("CSV has more than " + LIMITS.cells.toLocaleString() + " cells (rows × columns).");
    const headerKeys = new Set();
    fields.forEach(function (field, index) {
      const key = String(field).replace(/^\uFEFF/, "").trim();
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
  // Scanned in slices. DOMParser.parseFromString cannot yield, and a worker
  // has no DOMParser, so one large track froze the window for the whole parse.
  // Entity references are decoded once and never substituted from a DTD.

  const XML_SLICE = 64 * 1024;
  const XML_NAME_LENGTH = 200;
  const KML_TEXT = { name: 1, address: 1, visibility: 1, open: 1, phoneNumber: 1, description: 1 };
  const GPX_TEXT = { name: 1, cmt: 1, desc: 1, type: 1, time: 1, keywords: 1, sym: 1 };
  const XML_TEXT = {
    name: 1, address: 1, visibility: 1, open: 1, phoneNumber: 1, description: 1,
    cmt: 1, desc: 1, type: 1, time: 1, keywords: 1, sym: 1, ele: 1, styleUrl: 1,
    color: 1, width: 1, fill: 1, outline: 1, begin: 1, end: 1, when: 1, value: 1
  };

  function countMatches(text, pattern) {
    let n = 0;
    pattern.lastIndex = 0;
    while (pattern.exec(text)) n++;
    return n;
  }

  function isXmlSpace(code) {
    return code === 32 || code === 9 || code === 10 || code === 13;
  }

  function isXmlNameChar(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
      code === 95 || code === 58 || code === 45 || code === 46 || code > 127;
  }

  function hashXmlId(id) {
    if (!id) return "#";
    return id.charAt(0) === "#" ? id : "#" + id;
  }

  /* KML colours are aabbggrr. Stroke and fill keep those names; other roles
     become role-color, matching the properties already shown in the table. */
  function kmlColour(raw, role) {
    const out = {};
    if (!raw) return out;
    let hex = String(raw).trim();
    const key = role === "stroke" || role === "fill" ? role : role + "-color";
    if (hex.charAt(0) === "#") hex = hex.slice(1);
    if (hex.length === 6 || hex.length === 3) out[key] = "#" + hex;
    else if (hex.length === 8) {
      const opacity = parseInt(hex.slice(0, 2), 16);
      if (Number.isFinite(opacity)) out[role + "-opacity"] = opacity / 255;
      out[key] = "#" + hex.slice(6, 8) + hex.slice(4, 6) + hex.slice(2, 4);
    }
    return out;
  }

  function closeXmlRing(ring) {
    if (ring.length < 4) return null;
    const first = ring[0], last = ring[ring.length - 1];
    let same = first.length === last.length;
    for (let i = 0; same && i < first.length; i++) if (first[i] !== last[i]) same = false;
    if (!same) ring.push(first.slice());
    return ring.length >= 4 ? ring : null;
  }

  /* Cheap checks that need no geometry, so they also run in the worker for
     KML and GPX found inside a ZIP. Returns the number of feature elements. */
  function precheckXml(text, ext) {
    if (/<!DOCTYPE|<!ENTITY/i.test(String(text))) throw new Error("XML with a DOCTYPE or ENTITY declaration is not accepted.");
    // Count features before the scan. A 100 MiB KML of placemarks used to
    // reach the DOM and freeze the window for about a minute.
    const items = ext === "kml" ? countMatches(text, /<(?:\w+:)?Placemark[\s>]/g) : countMatches(text, /<(?:\w+:)?(?:wpt|trk|rte)[\s>]/g);
    if (items > LIMITS.features) throw new Error("File has more than " + LIMITS.features.toLocaleString() + (ext === "kml" ? " placemarks." : " waypoints, tracks and routes."));
    return items;
  }

  /* One pass over the XML text. Yields often enough that a slice stays short
     even when one element holds millions of coordinates. Custom entities are
     refused; the five predefined entities and numeric character references
     are decoded a single time. */
  function* buildXmlFeatures(text, ext) {
    const src = String(text);
    const end = src.length;
    const invalid = function () { return new Error("File is not valid " + ext.toUpperCase() + " XML."); };
    const names = [];
    const namePool = new Map();
    const textStack = [];
    const geomStack = [];
    const pmStack = [];
    const styleStack = [];
    const pending = [];
    const trks = [], rtes = [], wpts = [];
    const styles = {};
    const styleMaps = [];
    const counter = { count: 0 };
    let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
    let elements = 0;
    let nextYield = i + XML_SLICE;
    let rooted = false;
    let coordMode = null;
    let pm = null;
    let styleFrame = null;
    let paint = null;
    let dataEl = null;
    let gpxCur = null;
    let pt = null;

    function intern(name) {
      const hit = namePool.get(name);
      if (hit) return hit;
      if (namePool.size >= LIMITS.xmlNames) throw new Error("File has too many distinct XML names.");
      namePool.set(name, name);
      return name;
    }

    function localOf(name) {
      const colon = name.lastIndexOf(":");
      return colon >= 0 ? name.slice(colon + 1) : name;
    }

    function addCoord(n) {
      counter.count += n;
      if (counter.count > LIMITS.coordinates) throw new Error("Dataset exceeds the " + LIMITS.coordinates.toLocaleString() + " coordinate limit.");
    }

    function freshGeomBucket() {
      return { points: [], lines: [], polys: [], tracks: [], trackTimes: [] };
    }

    function bucket() {
      if (!pm) return null;
      if (pm.multiDepth > 0) return pm.multiFrozen ? null : pm.multi;
      return pm.multi ? null : pm;
    }

    function readNumber(at) {
      let c = src.charCodeAt(at);
      if (c !== 45 && c !== 43 && c !== 46 && (c < 48 || c > 57)) return null;
      const start = at;
      let sign = 1;
      if (c === 45) { sign = -1; at++; }
      else if (c === 43) at++;
      let intPart = 0, digits = 0, frac = 0, scale = 1, fracDigits = 0;
      while (at < end) {
        c = src.charCodeAt(at);
        if (c < 48 || c > 57) break;
        if (digits < 15) intPart = intPart * 10 + (c - 48);
        digits++;
        at++;
      }
      if (at < end && src.charCodeAt(at) === 46) {
        at++;
        while (at < end) {
          c = src.charCodeAt(at);
          if (c < 48 || c > 57) break;
          if (fracDigits < 15) { frac = frac * 10 + (c - 48); scale *= 10; }
          fracDigits++;
          at++;
        }
      }
      if (!digits && !fracDigits) return null;
      if (at < end && (src.charCodeAt(at) === 101 || src.charCodeAt(at) === 69)) {
        let j = at + 1;
        if (j < end && (src.charCodeAt(j) === 43 || src.charCodeAt(j) === 45)) j++;
        const expAt = j;
        while (j < end && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) j++;
        if (j === expAt) return null;
        const n = Number(src.slice(start, j));
        return Number.isFinite(n) ? { n: n, i: j } : null;
      }
      return { n: sign * (intPart + (scale > 1 ? frac / scale : 0)), i: at };
    }

    function readEntity(at) {
      if (src.charCodeAt(at) !== 38) return null;
      const semi = src.indexOf(";", at + 1);
      if (semi < 0 || semi >= end || semi - at > 32) return null;
      const body = src.slice(at + 1, semi);
      let value;
      if (body === "lt") value = "<";
      else if (body === "gt") value = ">";
      else if (body === "amp") value = "&";
      else if (body === "quot") value = "\"";
      else if (body === "apos") value = "'";
      else if (body.charAt(0) === "#") {
        const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
        const cp = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
        value = String.fromCodePoint(cp);
      } else throw new Error("XML entity references are not accepted.");
      return { value: value, i: semi + 1 };
    }

    function appendChunk(item, chunk) {
      if (!chunk) return;
      if (item.n + chunk.length > LIMITS.propertyString) throw new Error("A property value exceeds the 100,000 character limit.");
      item.parts.push(chunk);
      item.n += chunk.length;
    }

    function appendRange(item, from, to) {
      const amp = src.indexOf("&", from);
      if (amp < 0 || amp >= to) { appendChunk(item, src.slice(from, to)); return; }
      let at = from;
      while (at < to) {
        const next = src.indexOf("&", at);
        if (next < 0 || next >= to) { appendChunk(item, src.slice(at, to)); break; }
        if (next > at) appendChunk(item, src.slice(at, next));
        const entity = readEntity(next);
        if (!entity || entity.i > to) throw invalid();
        appendChunk(item, entity.value);
        at = entity.i;
      }
    }

    function joinText(item) {
      const value = item.parts.length === 1 ? item.parts[0] : item.parts.join("");
      return value.normalize("NFC");
    }

    function* skipTo(marker, from) {
      let pos = from;
      while (pos < end) {
        if (pos >= nextYield) { nextYield = pos + XML_SLICE; yield; }
        const found = src.indexOf(marker, pos);
        if (found < 0) throw invalid();
        if (found - pos > XML_SLICE) { pos += XML_SLICE; continue; }
        return found + marker.length;
      }
      throw invalid();
    }

    function* readAttrs(from, needed) {
      const found = {};
      let at = from, count = 0;
      while (at < end) {
        if (at >= nextYield) { nextYield = at + XML_SLICE; yield; }
        let c = src.charCodeAt(at);
        if (c === 62) return { i: at + 1, empty: false, found: found };
        if (c === 47 && src.charCodeAt(at + 1) === 62) return { i: at + 2, empty: true, found: found };
        if (!isXmlSpace(c)) throw invalid();
        while (at < end && isXmlSpace(src.charCodeAt(at))) at++;
        c = src.charCodeAt(at);
        if (c === 62 || c === 47) continue;
        const nameAt = at;
        while (at < end && isXmlNameChar(src.charCodeAt(at))) at++;
        if (at === nameAt || at - nameAt > XML_NAME_LENGTH) throw invalid();
        const attr = src.slice(nameAt, at);
        while (at < end && isXmlSpace(src.charCodeAt(at))) at++;
        if (src.charCodeAt(at) !== 61) throw invalid();
        at++;
        while (at < end && isXmlSpace(src.charCodeAt(at))) at++;
        const quote = src.charCodeAt(at);
        if (quote !== 34 && quote !== 39) throw invalid();
        at++;
        const valueAt = at;
        while (at < end && src.charCodeAt(at) !== quote) {
          if (src.charCodeAt(at) === 38) {
            const entity = readEntity(at);
            if (!entity) throw invalid();
            at = entity.i;
            continue;
          }
          if (src.charCodeAt(at) === 60 || src.charCodeAt(at) === 0) throw invalid();
          at++;
          if (at >= nextYield) { nextYield = at + XML_SLICE; yield; }
        }
        if (at >= end) throw invalid();
        if (++count > LIMITS.xmlAttributes) throw new Error("An XML element has too many attributes.");
        if (needed && needed.indexOf(attr) >= 0) {
          const rawLength = at - valueAt;
          if (rawLength > LIMITS.propertyString) throw new Error("A property value exceeds the 100,000 character limit.");
          const item = { parts: [], n: 0 };
          appendRange(item, valueAt, at);
          found[attr] = joinText(item);
        }
        at++;
      }
      throw invalid();
    }

    function readName(from) {
      const nameAt = from;
      let at = from;
      while (at < end && isXmlNameChar(src.charCodeAt(at))) at++;
      if (at === nameAt || at - nameAt > XML_NAME_LENGTH) throw invalid();
      return { name: intern(src.slice(nameAt, at)), i: at };
    }

    function gpxPoint(attrs) {
      const lat = Number(attrs.lat), lon = Number(attrs.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { coord: [lon, lat], time: null };
    }

    function gpxProps(kind, raw) {
      const props = kind ? { _gpxType: kind } : {};
      const fields = ["name", "cmt", "desc", "type", "time", "keywords", "sym"];
      for (let f = 0; f < fields.length; f++) if (raw[fields[f]]) props[fields[f]] = raw[fields[f]];
      return props;
    }

    function openMulti() {
      if (!pm.multiFrozen) pm.multi = freshGeomBucket();
      pm.multiDepth++;
    }

    function finishPaint() {
      if (!paint) return;
      const role = paint.kind === "line" ? "stroke" : "fill";
      const bag = kmlColour(paint.color, role);
      if (paint.kind === "line" && paint.width !== "") {
        const width = Number(paint.width);
        if (Number.isFinite(width) && width !== 0) bag["stroke-width"] = width;
      }
      if (paint.kind === "poly") {
        if (paint.fill === "0") bag["fill-opacity"] = 0;
        if (paint.outline === "0") bag["stroke-opacity"] = 0;
      }
      if (styleFrame && styleFrame.kind === "style") Object.assign(styleFrame.bag, bag);
      if (pm && styleFrame && styleFrame.kind === "style" && pm.styleOwns === styleFrame) Object.assign(pm.inline, bag);
      else if (pm && !styleFrame) Object.assign(pm.inline, bag);
      paint = null;
    }

    function dispatchText(local, value) {
      if (paint && (local === "color" || local === "width" || local === "fill" || local === "outline")) {
        paint[local] = value.trim();
        return;
      }
      if (local === "styleUrl") {
        const url = value.trim();
        if (styleFrame && styleFrame.kind === "map" && !styleFrame.url) styleFrame.url = url;
        else if (pm && !pm.styleUrl) pm.styleUrl = url;
        return;
      }
      if (local === "SimpleData" && dataEl) { dataEl.value = value; return; }
      if (local === "value" && dataEl && !dataEl.simple) { dataEl.value = value; return; }
      if (local === "when") {
        const track = geomStack[geomStack.length - 1];
        if (track && track.k === "track") track.whens.push(value);
        else if (pm) pm.time.timestamp = value;
        return;
      }
      if ((local === "begin" || local === "end") && pm) {
        if (!pm.time.timespan) pm.time.timespan = { begin: "", end: "" };
        pm.time.timespan[local] = value;
        return;
      }
      if (local === "ele" && pt) {
        const elevation = Number(value.trim());
        // A zero elevation used to be dropped; keep that so sea level stays a 2D position.
        if (Number.isFinite(elevation) && elevation !== 0) pt.coord.push(elevation);
        return;
      }
      if (ext === "gpx" && local === "time" && pt && !pt.time) pt.time = value;
      // First matching element in the feature, including a time inside the first point.
      if (ext === "gpx" && gpxCur && GPX_TEXT[local] && gpxCur.props[local] == null && value !== "") gpxCur.props[local] = value;
      else if (ext === "kml" && pm && KML_TEXT[local] && !styleFrame && pm.props[local] == null && value !== "") pm.props[local] = value;
    }

    function commitPoint() {
      const frame = geomStack.pop();
      if (!frame || frame.nums.length < 2) return;
      if (frame.nums.length > 4) throw new Error("Coordinate positions need two to four numbers.");
      const target = bucket();
      if (!target) return;
      target.points.push({ type: "Point", coordinates: frame.nums });
      addCoord(1);
    }

    function commitLine() {
      const frame = geomStack.pop();
      if (!frame || frame.positions.length < 2) return;
      const target = bucket();
      if (!target) return;
      target.lines.push({ type: "LineString", coordinates: frame.positions });
    }

    function commitRing() {
      const frame = geomStack.pop();
      const parent = geomStack[geomStack.length - 1];
      if (!frame || !parent || parent.k !== "poly") return;
      const before = frame.positions.length;
      const ring = closeXmlRing(frame.positions);
      if (!ring) return;
      if (ring.length > before) addCoord(ring.length - before);
      parent.rings.push(ring);
    }

    function commitPoly() {
      const frame = geomStack.pop();
      if (!frame || !frame.rings.length) return;
      const target = bucket();
      if (target) target.polys.push({ type: "Polygon", coordinates: frame.rings });
    }

    function commitTrack() {
      const frame = geomStack.pop();
      if (!frame || !frame.positions.length) return;
      const target = bucket();
      if (!target) return;
      if (frame.positions.length > 2) target.tracks.push({ type: "LineString", coordinates: frame.positions });
      else target.points.push({ type: "Point", coordinates: frame.positions[0] });
      if (frame.whens.length) target.trackTimes.push(frame.whens);
    }

    function commitCoord() {
      const frame = geomStack[geomStack.length - 1];
      if (!coordMode || coordMode.k !== "spaced" || !frame || frame.k !== "track") { coordMode = null; return; }
      const nums = coordMode.buf;
      coordMode = null;
      if (nums.length < 2) return;
      if (nums.length > 4) throw new Error("Coordinate positions need two to four numbers.");
      frame.positions.push(nums);
      addCoord(1);
    }

    function finishGpxTrack() {
      const lines = [], times = [];
      for (let s = 0; s < gpxCur.segs.length; s++) {
        const seg = gpxCur.segs[s];
        if (seg.coords.length < 2) continue;
        lines.push(seg.coords);
        if (seg.times.length) times.push(seg.times);
      }
      if (!lines.length) return;
      const props = gpxProps("trk", gpxCur.props);
      if (times.length) props.coordinateProperties = { times: lines.length > 1 ? times : times[0] };
      const geometry = lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
      trks.push({ type: "Feature", properties: props, geometry: geometry });
    }

    function orderedStyle(bag) {
      const out = {};
      const keys = ["fill-opacity", "fill", "stroke-opacity", "stroke", "stroke-width"];
      for (let k = 0; k < keys.length; k++) if (bag[keys[k]] != null) out[keys[k]] = bag[keys[k]];
      const rest = Object.keys(bag);
      for (let k = 0; k < rest.length; k++) if (out[rest[k]] == null) out[rest[k]] = bag[rest[k]];
      return out;
    }

    function materialise(mark) {
      const source = mark.multi || mark;
      const geoms = source.polys.concat(source.lines, source.points, source.tracks);
      if (!geoms.length) return null;
      const properties = {};
      const propOrder = ["name", "address", "visibility", "open", "phoneNumber", "description"];
      for (let k = 0; k < propOrder.length; k++) if (mark.props[propOrder[k]]) properties[propOrder[k]] = mark.props[propOrder[k]];
      if (mark.styleUrl) {
        const key = hashXmlId(mark.styleUrl);
        const mapped = styles[key];
        if (mapped) Object.assign(properties, { styleUrl: key }, orderedStyle(mapped));
        else properties.styleUrl = key;
      }
      Object.assign(properties, orderedStyle(mark.inline), mark.extended, mark.time);
      if (source.trackTimes.length) properties.coordinateProperties = { times: source.trackTimes.length === 1 ? source.trackTimes[0] : source.trackTimes };
      const feature = {
        type: "Feature",
        geometry: geoms.length === 1 ? geoms[0] : { type: "GeometryCollection", geometries: geoms },
        properties: properties
      };
      if (mark.id) feature.id = mark.id;
      return feature;
    }

    function* readTuples(from, stop, into) {
      let at = from;
      while (at < stop) {
        if (at >= nextYield) { nextYield = at + XML_SLICE; yield; }
        let c = src.charCodeAt(at);
        if (isXmlSpace(c)) { at++; continue; }
        const position = [];
        while (at < stop && !isXmlSpace(src.charCodeAt(at))) {
          if (src.charCodeAt(at) === 44) { at++; continue; }
          const num = readNumber(at);
          if (!num || num.i > stop) break;
          position.push(num.n);
          at = num.i;
        }
        if (position.length > 4) throw new Error("Coordinate positions need two to four numbers.");
        if (position.length >= 2) { into.push(position); addCoord(1); }
        if (at < stop && !isXmlSpace(src.charCodeAt(at))) at++;
      }
      return at;
    }

    function* readFlatNumbers(from, stop, into) {
      let at = from;
      while (at < stop) {
        if (at >= nextYield) { nextYield = at + XML_SLICE; yield; }
        const c = src.charCodeAt(at);
        if (isXmlSpace(c) || c === 44) { at++; continue; }
        const num = readNumber(at);
        if (!num || num.i > stop) { at++; continue; }
        if (into.length >= 4) throw new Error("Coordinate positions need two to four numbers.");
        into.push(num.n);
        at = num.i;
      }
      return at;
    }

    /* Self-closing GPX points are the bulk of a large track. The general tag
       parser is correct for them and far too slow; this only accepts an empty
       tag and leaves anything with child elements on the slow path. */
    function scanFastPoint(at) {
      let kind, nameLen;
      if (src.startsWith("<trkpt", at)) { kind = "trkpt"; nameLen = 6; }
      else if (src.startsWith("<rtept", at)) { kind = "rtept"; nameLen = 6; }
      else if (src.startsWith("<wpt", at)) { kind = "wpt"; nameLen = 4; }
      else return null;
      let j = at + nameLen;
      const boundary = src.charCodeAt(j);
      if (!isXmlSpace(boundary) && boundary !== 47) return null;
      let lat = NaN, lon = NaN, attrs = 0;
      while (j < end) {
        while (j < end && isXmlSpace(src.charCodeAt(j))) j++;
        if (src.charCodeAt(j) === 47 && src.charCodeAt(j + 1) === 62) {
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return { i: j + 2, kind: kind, coord: [lon, lat] };
        }
        if (src.charCodeAt(j) === 62 || src.charCodeAt(j) === 60) return null;
        const nameAt = j;
        while (j < end && isXmlNameChar(src.charCodeAt(j))) j++;
        if (j === nameAt || j - nameAt > XML_NAME_LENGTH) return null;
        const attr = src.slice(nameAt, j);
        while (j < end && isXmlSpace(src.charCodeAt(j))) j++;
        if (src.charCodeAt(j) !== 61) return null;
        j++;
        while (j < end && isXmlSpace(src.charCodeAt(j))) j++;
        const quote = src.charCodeAt(j);
        if (quote !== 34 && quote !== 39) return null;
        j++;
        const valueAt = j;
        while (j < end && src.charCodeAt(j) !== quote) {
          if (src.charCodeAt(j) === 38 || src.charCodeAt(j) === 60 || src.charCodeAt(j) === 0) return null;
          j++;
        }
        if (src.charCodeAt(j) !== quote) return null;
        if (++attrs > LIMITS.xmlAttributes) throw new Error("An XML element has too many attributes.");
        if (attr === "lat" || attr === "lon") {
          const n = Number(src.slice(valueAt, j));
          if (attr === "lat") lat = n; else lon = n;
        }
        j++;
      }
      return null;
    }

    function* readTuplesUntil(from, into) {
      let at = from;
      while (at < end && src.charCodeAt(at) !== 60) {
        if (at >= nextYield) { nextYield = at + XML_SLICE; yield; }
        if (isXmlSpace(src.charCodeAt(at))) { at++; continue; }
        const position = [];
        while (at < end && src.charCodeAt(at) !== 60 && !isXmlSpace(src.charCodeAt(at))) {
          if (src.charCodeAt(at) === 44) { at++; continue; }
          const num = readNumber(at);
          if (!num) break;
          position.push(num.n);
          at = num.i;
        }
        if (position.length > 4) throw new Error("Coordinate positions need two to four numbers.");
        if (position.length >= 2) { into.push(position); addCoord(1); }
        if (at < end && src.charCodeAt(at) !== 60 && !isXmlSpace(src.charCodeAt(at))) at++;
      }
      return at;
    }

    function* readFlatUntil(from, into) {
      let at = from;
      while (at < end && src.charCodeAt(at) !== 60) {
        if (at >= nextYield) { nextYield = at + XML_SLICE; yield; }
        const c = src.charCodeAt(at);
        if (isXmlSpace(c) || c === 44) { at++; continue; }
        const num = readNumber(at);
        if (!num) { at++; continue; }
        if (into.length >= 4) throw new Error("Coordinate positions need two to four numbers.");
        into.push(num.n);
        at = num.i;
      }
      return at;
    }

    function* feedUntilTag(from) {
      if (coordMode && (coordMode.k === "point" || coordMode.k === "spaced")) return yield* readFlatUntil(from, coordMode.buf);
      if (coordMode) return yield* readTuplesUntil(from, coordMode.buf);
      let at = from;
      while (at < end && src.charCodeAt(at) !== 60) {
        if (at >= nextYield) { nextYield = at + XML_SLICE; yield; }
        let stop = Math.min(end, at + XML_SLICE);
        const lt = src.indexOf("<", at);
        if (lt >= 0 && lt < stop) stop = lt;
        else if (lt < 0) stop = end;
        const amp = src.lastIndexOf("&", stop - 1);
        const semi = amp >= at ? src.indexOf(";", amp) : -1;
        if (amp >= at && semi >= stop && semi - amp <= 32) stop = amp;
        if (stop === at) stop = Math.min(end, at + 1);
        if (textStack.length) appendRange(textStack[textStack.length - 1], at, stop);
        at = stop;
      }
      return at;
    }

    function startTag(local, attrs) {
      if (ext === "kml") {
        if (local === "Placemark") {
          pmStack.push(pm);
          pm = freshGeomBucket();
          pm.props = {}; pm.inline = {}; pm.extended = {}; pm.time = {};
          pm.id = attrs.id || ""; pm.styleUrl = null; pm.multi = null; pm.multiDepth = 0; pm.multiFrozen = false; pm.styleOwns = null;
          return;
        }
        if (local === "MultiGeometry" || local === "MultiTrack") { if (pm) openMulti(); return; }
        if (local === "Polygon") { if (pm) geomStack.push({ k: "poly", rings: [] }); return; }
        if (local === "LinearRing") { geomStack.push({ k: "ring", positions: [] }); return; }
        if (local === "LineString") { if (pm) geomStack.push({ k: "line", positions: [] }); return; }
        if (local === "Point") { if (pm) geomStack.push({ k: "point", nums: [] }); return; }
        if (local === "Track") { if (pm) geomStack.push({ k: "track", positions: [], whens: [] }); return; }
        if (local === "coordinates") {
          const top = geomStack[geomStack.length - 1];
          if (top && top.k === "point" && !top.sawCoords) { top.sawCoords = true; coordMode = { k: "point", buf: top.nums }; }
          else if (top && (top.k === "line" || top.k === "ring") && !top.sawCoords) { top.sawCoords = true; coordMode = { k: "tuples", buf: top.positions }; }
          return;
        }
        if (local === "coord") { coordMode = { k: "spaced", buf: [] }; return; }
        if (local === "Style") {
          styleStack.push(styleFrame);
          styleFrame = { kind: "style", id: attrs.id || "", bag: {} };
          if (pm && !pm.styleOwns) pm.styleOwns = styleFrame;
          return;
        }
        if (local === "StyleMap") {
          styleStack.push(styleFrame);
          styleFrame = { kind: "map", id: attrs.id || "", url: null };
          return;
        }
        if (local === "LineStyle") { paint = { kind: "line", color: "", width: "", fill: "", outline: "" }; return; }
        if (local === "PolyStyle") { paint = { kind: "poly", color: "", width: "", fill: "", outline: "" }; return; }
        if (local === "Data") { dataEl = { name: attrs.name || "", value: "", simple: false }; return; }
        if (local === "SimpleData") {
          dataEl = { name: attrs.name || "", value: "", simple: true };
          textStack.push({ name: local, parts: [], n: 0 });
          return;
        }
      } else {
        if (local === "trk") { gpxCur = { kind: "trk", props: {}, segs: [], seg: null }; return; }
        if (local === "rte") { gpxCur = { kind: "rte", props: {}, line: [] }; return; }
        if (local === "trkseg" && gpxCur && gpxCur.kind === "trk") { gpxCur.seg = { coords: [], times: [] }; return; }
        if (local === "wpt" || local === "trkpt" || local === "rtept") {
          pt = gpxPoint(attrs);
          if (local === "wpt") gpxCur = { kind: "wpt", props: {}, pt: pt };
          return;
        }
      }
      if (XML_TEXT[local]) textStack.push({ name: local, parts: [], n: 0 });
    }

    function endTag(local) {
      if (textStack.length && textStack[textStack.length - 1].name === local) dispatchText(local, joinText(textStack.pop()));
      if (ext === "kml") {
        if (local === "Placemark") { pending.push(pm); pm = pmStack.pop() || null; return; }
        if (local === "MultiGeometry" || local === "MultiTrack") {
          if (pm && pm.multiDepth) { pm.multiDepth--; if (pm.multiDepth === 0) pm.multiFrozen = true; }
          return;
        }
        if (local === "coordinates") { coordMode = null; return; }
        if (local === "coord") { commitCoord(); return; }
        if (local === "Point") { commitPoint(); return; }
        if (local === "LineString") { commitLine(); return; }
        if (local === "LinearRing") { commitRing(); return; }
        if (local === "Polygon") { commitPoly(); return; }
        if (local === "Track") { commitTrack(); return; }
        if (local === "LineStyle" || local === "PolyStyle") { finishPaint(); return; }
        if (local === "Style") {
          if (styleFrame && styleFrame.kind === "style") {
            if (styleFrame.id) styles[hashXmlId(styleFrame.id)] = orderedStyle(styleFrame.bag);
            if (pm && pm.styleOwns === styleFrame) Object.assign(pm.inline, styleFrame.bag);
          }
          styleFrame = styleStack.pop() || null;
          return;
        }
        if (local === "StyleMap") {
          if (styleFrame && styleFrame.kind === "map" && styleFrame.id && styleFrame.url) styleMaps.push({ id: styleFrame.id, url: styleFrame.url });
          styleFrame = styleStack.pop() || null;
          return;
        }
        if (local === "Data" || local === "SimpleData") {
          if (pm && dataEl && dataEl.name) pm.extended[dataEl.name] = dataEl.value;
          dataEl = null;
          return;
        }
      } else if (local === "trkpt" || local === "rtept") {
        if (pt && pt.coord && gpxCur) {
          if (gpxCur.kind === "trk" && gpxCur.seg) {
            gpxCur.seg.coords.push(pt.coord);
            if (pt.time) gpxCur.seg.times.push(pt.time);
            addCoord(1);
          } else if (gpxCur.kind === "rte") {
            gpxCur.line.push(pt);
            addCoord(1);
          }
        }
        pt = null;
        return;
      } else if (local === "wpt") {
        if (gpxCur && gpxCur.kind === "wpt" && gpxCur.pt && gpxCur.pt.coord) {
          const props = gpxProps(null, gpxCur.props);
          wpts.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: gpxCur.pt.coord } });
          addCoord(1);
        }
        gpxCur = null; pt = null;
        return;
      } else if (local === "trkseg") {
        if (gpxCur && gpxCur.seg) {
          if (gpxCur.seg.coords.length >= 2) gpxCur.segs.push(gpxCur.seg);
          gpxCur.seg = null;
        }
        return;
      } else if (local === "trk") {
        if (gpxCur && gpxCur.kind === "trk") finishGpxTrack();
        gpxCur = null;
        return;
      } else if (local === "rte") {
        if (gpxCur && gpxCur.kind === "rte" && gpxCur.line.length >= 2) {
          const coords = new Array(gpxCur.line.length), times = [];
          for (let p = 0; p < gpxCur.line.length; p++) {
            coords[p] = gpxCur.line[p].coord;
            if (gpxCur.line[p].time) times.push(gpxCur.line[p].time);
          }
          const props = gpxProps("rte", gpxCur.props);
          if (times.length) props.coordinateProperties = { times: times };
          rtes.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
        }
        gpxCur = null;
        return;
      }
    }

    while (i < end) {
      if (i >= nextYield) { nextYield = i + XML_SLICE; yield; }
      const code = src.charCodeAt(i);
      if (code === 0) throw invalid();
      if (code !== 60) {
        if (isXmlSpace(code) && !coordMode && !textStack.length) { i++; continue; }
        i = yield* feedUntilTag(i);
        continue;
      }
      if (ext === "gpx") {
        const fast = scanFastPoint(i);
        if (fast) {
          if (names.length >= LIMITS.xmlDepth) throw new Error("XML nesting is deeper than " + LIMITS.xmlDepth + " elements.");
          if (!names.length && rooted) throw invalid();
          if (!names.length) rooted = true;
          if (++elements > LIMITS.xmlElements) throw new Error("File has more than " + LIMITS.xmlElements.toLocaleString() + " XML elements.");
          if (fast.kind === "wpt") wpts.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: fast.coord } });
          else if (fast.kind === "trkpt" && gpxCur && gpxCur.kind === "trk" && gpxCur.seg) gpxCur.seg.coords.push(fast.coord);
          else if (fast.kind === "rtept" && gpxCur && gpxCur.kind === "rte") gpxCur.line.push({ coord: fast.coord, time: null });
          else { i = fast.i; continue; }
          addCoord(1);
          if ((elements & 1023) === 0) yield;
          i = fast.i;
          continue;
        }
      }
      if (src.startsWith("!--", i + 1)) { i = yield* skipTo("-->", i + 4); continue; }
      if (src.charCodeAt(i + 1) === 63) { i = yield* skipTo("?>", i + 2); continue; }
      if (src.startsWith("![CDATA[", i + 1)) {
        const contentAt = i + 9;
        const closeAt = yield* skipTo("]]>", contentAt);
        const contentEnd = closeAt - 3;
        // CDATA is literal: "&" is not an entity reference.
        if (coordMode && (coordMode.k === "point" || coordMode.k === "spaced")) yield* readFlatNumbers(contentAt, contentEnd, coordMode.buf);
        else if (coordMode) yield* readTuples(contentAt, contentEnd, coordMode.buf);
        else if (textStack.length) {
          const item = textStack[textStack.length - 1];
          if (item.n + (contentEnd - contentAt) > LIMITS.propertyString) throw new Error("A property value exceeds the 100,000 character limit.");
          appendChunk(item, src.slice(contentAt, contentEnd));
        }
        i = closeAt;
        continue;
      }
      if (src.charCodeAt(i + 1) === 33) throw new Error("XML with a DOCTYPE or ENTITY declaration is not accepted.");
      if (src.charCodeAt(i + 1) === 47) {
        const named = readName(i + 2);
        let at = named.i;
        while (at < end && isXmlSpace(src.charCodeAt(at))) at++;
        if (src.charCodeAt(at) !== 62) throw invalid();
        const open = names.pop();
        if (open !== named.name) throw invalid();
        endTag(localOf(named.name));
        i = at + 1;
        continue;
      }
      if (names.length >= LIMITS.xmlDepth) throw new Error("XML nesting is deeper than " + LIMITS.xmlDepth + " elements.");
      if (!names.length && rooted) throw invalid();
      const named = readName(i + 1);
      const local = localOf(named.name);
      const wanted = ext === "gpx" && (local === "wpt" || local === "trkpt" || local === "rtept") ? ["lat", "lon"]
        : (local === "Placemark" || local === "Style" || local === "StyleMap") ? ["id"]
        : (local === "Data" || local === "SimpleData") ? ["name"] : null;
      const attrs = yield* readAttrs(named.i, wanted);
      if (!names.length) rooted = true;
      if (++elements > LIMITS.xmlElements) throw new Error("File has more than " + LIMITS.xmlElements.toLocaleString() + " XML elements.");
      names.push(named.name);
      startTag(local, attrs.found);
      if (attrs.empty) {
        names.pop();
        endTag(local);
      }
      if ((elements & 1023) === 0) yield;
      i = attrs.i;
    }
    if (names.length) throw invalid();
    for (let map = 0; map < styleMaps.length; map++) {
      const target = styles[hashXmlId(styleMaps[map].url)];
      if (target) styles[hashXmlId(styleMaps[map].id)] = target;
    }

    if (ext === "gpx") return trks.concat(rtes, wpts);
    const features = [];
    for (let mark = 0; mark < pending.length; mark++) {
      const feature = materialise(pending[mark]);
      if (feature) features.push(feature);
      if ((mark & 1023) === 1023) yield;
    }
    return features;
  }

  /* KML / GPX to a validated FeatureCollection. Yields between slices so the
     page can paint and Cancel can stop the scan. Placemarks with no geometry
     are left out, as before. */
  function* xmlToGeoJSONSteps(text, ext) {
    precheckXml(text, ext);
    yield;
    const features = yield* buildXmlFeatures(text, ext);
    yield;
    return validateFeatureCollection({ type: "FeatureCollection", features: features });
  }

  function xmlToGeoJSON(text, ext) {
    const job = xmlToGeoJSONSteps(text, ext);
    let step;
    do { step = job.next(); } while (!step.done);
    return step.value;
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
      // The declared size is the size a valid entry will actually produce.
      // Reject it before allocating, so a header that claims gigabytes cannot
      // reserve that buffer. Retained bytes are copied once into that buffer.
      // fflate may reuse the chunk it passes to accept, so the copy has to
      // happen before the next push.
      const ratioCap = Math.max(1024 * 1024, bytes.length * LIMITS.zipRatio);
      if (expanded + entry.expanded > LIMITS.expandedZipBytes) throw new Error("ZIP expands beyond the " + Math.round(LIMITS.expandedZipBytes / 1048576) + " MiB limit.");
      if (expanded + entry.expanded > ratioCap) throw new Error("ZIP compression ratio exceeds the safety limit.");
      const output = retain ? new Uint8Array(entry.expanded) : null;
      let actual = 0, written = 0, crc = 0xffffffff, finished = false;
      function accept(data, final) {
        actual += data.length;
        expanded += data.length;
        if (expanded > LIMITS.expandedZipBytes) throw new Error("ZIP expands beyond the " + Math.round(LIMITS.expandedZipBytes / 1048576) + " MiB limit.");
        if (expanded > ratioCap) throw new Error("ZIP compression ratio exceeds the safety limit.");
        if (actual > entry.expanded) throw new Error("ZIP actual expansion disagrees with its entry size.");
        for (let index = 0; index < data.length; index++) crc = (crc >>> 8) ^ table[(crc ^ data[index]) & 255];
        if (output) { output.set(data, written); written += data.length; }
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
      if (!finished || actual !== entry.expanded || written !== (output ? actual : 0)) throw new Error("ZIP entry is truncated or its actual expansion disagrees.");
      if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new Error("ZIP entry checksum disagrees with its extracted bytes.");
      if (output) extracted.set(entry.name, output);
    });
    return extracted;
  }

  function baseName(path) {
    const name = String(path).split("/").pop();
    return name.replace(/\.[^.]+$/, "");
  }

  /* Check .shp and .dbf headers before shpjs reads them. shpjs trusts the
     DBF record count, so a 73-byte .dbf claiming three billion records made
     it allocate until the page ran out of memory; and a .shp of empty
     records became millions of features before any limit applied. */
  function checkShapefile(shpBytes, dbfBytes) {
    const shp = new DataView(shpBytes.buffer, shpBytes.byteOffset, shpBytes.byteLength);
    if (shpBytes.byteLength < 100 || shp.getInt32(0) !== 9994) throw new Error("The .shp file is not a shapefile.");
    if (shp.getInt32(24) * 2 !== shpBytes.byteLength || shp.getInt32(28, true) !== 1000) throw new Error("The .shp file is truncated or its header is inconsistent.");
    let records = 0;
    for (let offset = 100; offset < shpBytes.byteLength;) {
      if (offset + 8 > shpBytes.byteLength) throw new Error("The .shp file has a truncated record header.");
      const length = shp.getInt32(offset + 4) * 2;   // big-endian, in 16-bit words
      // shpjs silently stops at a truncated record and returns the preceding
      // features. Reject the file instead of presenting an incomplete layer.
      if (length < 0 || (length > 0 && length < 4)) throw new Error("The .shp file has an invalid record length.");
      if (offset + 8 + length > shpBytes.byteLength) throw new Error("The .shp file has a truncated record.");
      if (++records > LIMITS.features) throw new Error("Shapefile has more than " + LIMITS.features.toLocaleString() + " records.");
      offset += 8 + length;
    }
    if (!dbfBytes) return;
    const dbf = new DataView(dbfBytes.buffer, dbfBytes.byteOffset, dbfBytes.byteLength);
    if (dbfBytes.byteLength < 33) throw new Error("The .dbf file is truncated.");
    const rows = dbf.getUint32(4, true), headerLength = dbf.getUint16(8, true), rowLength = dbf.getUint16(10, true);
    if (headerLength < 33 || headerLength > dbfBytes.byteLength || (headerLength - 33) % 32 !== 0 || dbf.getUint8(headerLength - 1) !== 13) throw new Error("The .dbf file header is inconsistent.");
    const fields = (headerLength - 33) / 32;
    if (rows > LIMITS.features) throw new Error("The .dbf file has more than " + LIMITS.features.toLocaleString() + " records.");
    if (fields > LIMITS.propertiesPerFeature) throw new Error("The .dbf file has more than " + LIMITS.propertiesPerFeature + " fields.");
    if (rows * fields > LIMITS.cells) throw new Error("The .dbf file has more than " + LIMITS.cells.toLocaleString() + " values.");
    let expectedRowLength = 1; // the deletion flag precedes every record
    for (let offset = 32; offset < headerLength - 1; offset += 32) expectedRowLength += dbf.getUint8(offset + 16);
    if (rowLength !== expectedRowLength || headerLength + rows * rowLength > dbfBytes.byteLength) throw new Error("The .dbf file is truncated or its header is inconsistent.");
    if (rows !== records) throw new Error("The .shp and .dbf record counts disagree.");
  }

  // shpjs turns a blank numeric DBF cell into NaN, and the same for a cell
  // that is not a number. Neither should reject the rest of the layer.
  function blankNonFiniteAttributes(fc) {
    const features = fc && fc.features;
    if (!Array.isArray(features)) return 0;
    let count = 0;
    for (let i = 0; i < features.length; i++) {
      const props = features[i] && features[i].properties;
      if (!props || typeof props !== "object") continue;
      const keys = Object.keys(props);
      for (let k = 0; k < keys.length; k++) {
        const value = props[keys[k]];
        if (typeof value === "number" && !Number.isFinite(value)) {
          props[keys[k]] = null;
          count++;
        }
      }
    }
    return count;
  }

  function shapefileDataset(name, raw, hasPrj) {
    const blanks = blankNonFiniteAttributes(raw);
    const warnings = [];
    if (!hasPrj) warnings.push("No .prj file: coordinates were assumed to be WGS84.");
    if (blanks) warnings.push(blanks.toLocaleString() + (blanks === 1 ? " blank or invalid numeric cell was" : " blank or invalid numeric cells were") + " read as missing.");
    return { name: name, geojson: validateFeatureCollection(raw), warnings: warnings };
  }

  async function shapefileParts(parts) {
    if (!parts.shp) throw new Error("Shapefile is missing its .shp file.");
    checkShapefile(parts.shp, parts.dbf);
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
    const layerCount = Array.from(entries.keys()).filter(function (n) { return /\.(shp|json|geojson|csv|kml|gpx)$/.test(n); }).length;
    if (layerCount > LIMITS.layersPerFile) throw new Error("ZIP contains more than " + LIMITS.layersPerFile + " layers.");
    const multiple = layerCount > 1;
    // Each layer is capped on its own; this caps them together, so many
    // small layers cannot add up to more than memory can hold.
    let total = 0;
    const counted = function (layer) {
      total += layer.geojson ? layer.geojson.features.length : layer.xml.items;
      if (total > LIMITS.featuresPerFile) throw new Error("ZIP layers together exceed " + LIMITS.featuresPerFile.toLocaleString() + " features.");
      layers.push(layer);
    };
    for (const [filename, bytes] of entries) {
      const label = multiple ? baseName(zipName) + " / " + baseName(filename) : baseName(zipName);
      if (filename.endsWith(".shp")) {
        const stem = filename.slice(0, -4);
        const raw = await shapefileParts({ shp: bytes, dbf: entries.get(stem + ".dbf"), prj: entries.get(stem + ".prj"), cpg: entries.get(stem + ".cpg") });
        counted(shapefileDataset(label, raw, entries.has(stem + ".prj")));
      } else if (/\.(geojson|json)$/.test(filename)) {
        counted(withNotes(label, jsonToGeoJSON(decodeText(bytes))));
      } else if (filename.endsWith(".csv")) {
        counted(withNotes(label, csvToGeoJSON(decodeText(bytes))));
      } else if (/\.(kml|gpx)$/.test(filename)) {
        // The page converts the text in slices (resolveXmlLayers) so Cancel
        // can stop a large track between chunks.
        if (bytes.length > LIMITS.fileBytes) throw new Error(filename + " is too large (limit " + Math.round(LIMITS.fileBytes / 1048576) + " MiB).");
        const ext = filename.slice(-3), text = decodeText(bytes);
        counted({ name: label, xml: { ext: ext, text: text, items: precheckXml(text, ext) }, warnings: [] });
      }
    }
    if (!layers.length) throw new Error("ZIP contains no shapefile, GeoJSON, CSV, KML or GPX layers.");
    return layers;
  }

  /* ------------------------------ Profiles -------------------------------- */
  // A profile is a saved workspace: datasets with their data and styles, the
  // map view and the basemap. OmaMap writes .omamap; WIMP's .sdv-profile.json
  // files are read too.

  const PROFILE_VERSION = 1;

  function checkWorkspace(collections) {
    let features = 0, coordinates = 0, bytes = 0;
    for (const fc of collections) {
      features += fc.features.length;
      coordinates += fc.coordinateCount;
      bytes += fc.estimatedBytes;
    }
    if (features > LIMITS.workspaceFeatures || coordinates > LIMITS.workspaceCoordinates || bytes > LIMITS.workspaceBytes)
      throw new Error("Workspace memory budget exceeded (1,000,000 features, 10,000,000 coordinates, 512 MiB estimated data and rendering storage). Remove datasets before adding more.");
  }

  function isProfile(data) {
    return !!data && typeof data === "object" && !Array.isArray(data) && (data.omamap === "profile" || data.__sdv_profile === true);
  }

  function cleanHex(v) { return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null; }
  function cleanNum(v, lo, hi, fallback) {
    // Null, blanks and booleans are not numeric settings. In particular,
    // null style values mean "use the default", not zero opacity/size.
    if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }
  function cleanText(v, max) { return typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : ""; }

  // Notes saved with a dataset (assumed CRS, skipped rows): shown as text only.
  function cleanWarnings(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (w) { return typeof w === "string"; }).slice(0, 20)
      .map(function (w) { return cleanText(w, 300).trim(); }).filter(Boolean);
  }

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
      out.byField = { field: bf.field.slice(0, LIMITS.propertyString), mode: bf.mode === "ranges" ? "ranges" : "categories", reverse: bf.reverse === true };
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
    if (data.datasets.length > LIMITS.layersPerFile) throw new Error("Profile has more than " + LIMITS.layersPerFile + " datasets.");
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
      datasets.push({ name: name, geojson: geojson, visible: ds.visible !== false,
        slot: Number.isSafeInteger(ds.slot) && ds.slot >= 0 && ds.slot <= 1000000 ? ds.slot : i,
        style: wimp ? wimpStyle(ds) : cleanStyle(ds.style), warnings: cleanWarnings(ds.warnings) });
      checkWorkspace(datasets.map(function (item) { return item.geojson; }));
    });
    let view = null;
    const v = wimp ? (data.map && Array.isArray(data.map.center) ? { lat: data.map.center[0], lng: data.map.center[1], zoom: data.map.zoom } : null) : data.view;
    if (v) {
      const lat = cleanNum(v.lat, -85, 85, null), lng = cleanNum(v.lng, -180, 180, null), zoom = cleanNum(v.zoom, 2, 22, null);
      if (lat !== null && lng !== null && zoom !== null) view = { lat: lat, lng: lng, zoom: zoom };
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

  // Serialize in bounded batches, yielding between batches in the browser.
  // A saved profile must fit the exact same UTF-8 byte limit as an import.
  async function profileBlob(profile) {
    const encoder = new TextEncoder(), chunks = [];
    let pending = "", bytes = 0, started = performance.now();
    function flush() {
      if (!pending) return;
      const chunk = encoder.encode(pending);
      bytes += chunk.byteLength;
      if (bytes > LIMITS.fileBytes) throw new Error("Profile exceeds the 100 MiB reopening limit. Remove datasets or save smaller workspaces. No file was saved.");
      chunks.push(chunk); pending = "";
    }
    function append(text) { pending += text; if (pending.length >= 262144) flush(); }
    function openObject(value) {
      const members = JSON.stringify(value).slice(1, -1);
      return "{" + members + (members ? "," : "");
    }
    const header = Object.assign({}, profile); delete header.datasets;
    append(openObject(header) + '"datasets":[');
    for (let d = 0; d < profile.datasets.length; d++) {
      const ds = profile.datasets[d], metadata = Object.assign({}, ds); delete metadata.geojson;
      append((d ? "," : "") + openObject(metadata) + '"geojson":{"type":"FeatureCollection","features":[');
      for (let i = 0; i < ds.geojson.features.length; i++) {
        append((i ? "," : "") + JSON.stringify(ds.geojson.features[i]));
        if (performance.now() - started >= 8) {
          await new Promise(function (resolve) { setTimeout(resolve, 0); });
          started = performance.now();
        }
      }
      append("]}}");
    }
    append("]}"); flush();
    return new Blob(chunks, { type: "application/x-omamap-profile" });
  }

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
    if (ext === "zip" || ext === "kmz") return zipToDatasets(buffer, name);
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

  /* On the page: convert KML / GPX layers that came back from a ZIP, then
     re-check the per-file feature total with the exact counts. `run` drives
     a generator (time-sliced and cancellable in the app). */
  async function resolveXmlLayers(datasets, run) {
    if (!Array.isArray(datasets)) return datasets;
    run = run || function (job) { let step; do { step = job.next(); } while (!step.done); return step.value; };
    for (const d of datasets) {
      if (!d.xml) continue;
      d.geojson = await run(xmlToGeoJSONSteps(d.xml.text, d.xml.ext));
      delete d.xml;
    }
    const total = datasets.reduce(function (sum, d) { return sum + d.geojson.features.length; }, 0);
    if (total > LIMITS.featuresPerFile) throw new Error("ZIP layers together exceed " + LIMITS.featuresPerFile.toLocaleString() + " features.");
    return datasets;
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
    return [shapefileDataset(name, raw, !!parts.prj)];
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
    xmlToGeoJSONSteps: xmlToGeoJSONSteps,
    resolveXmlLayers: resolveXmlLayers,
    inspectZipMetadata: inspectZipMetadata,
    bngToWgs84: bngToWgs84,
    PROFILE_VERSION: PROFILE_VERSION,
    checkWorkspace: checkWorkspace,
    profileBlob: profileBlob,
    extractZip: extractZip,
    parseBytes: parseBytes,
    parseShapefileSet: parseShapefileSet
  };
  root.OmaParse = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
