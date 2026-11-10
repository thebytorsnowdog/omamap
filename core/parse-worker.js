"use strict";
/* Parsing off the UI thread. Receives file bytes, returns validated
   FeatureCollections. The page converts KML and GPX itself, in slices. */
importScripts("vendor/fflate.js", "vendor/shp.js", "vendor/papaparse.min.js", "parse.js");

self.onmessage = async function (event) {
  const job = event.data || {};
  try {
    let datasets;
    if (job.kind === "file") datasets = await OmaParse.parseBytes(job.name, job.buffer);
    else if (job.kind === "shapefile-set") datasets = await OmaParse.parseShapefileSet(job.name, job.parts);
    else throw new Error("Unknown parse job.");
    self.postMessage({ id: job.id, ok: true, datasets: datasets });
  } catch (error) {
    self.postMessage({ id: job.id, ok: false, error: OmaParse.safeMessage(error, "The file was rejected.") });
  }
};
