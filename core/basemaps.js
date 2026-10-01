"use strict";
/* Background maps. Selecting one sends tile requests for the visible area to
   that provider. Every origin here must also appear in index.html's CSP
   img-src. */
const OMAMAP_BASEMAPS = [
  {
    id: "streets", label: "Streets",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  },
  {
    id: "light", label: "Light",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    subdomains: "abcd", maxNativeZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  },
  {
    id: "dark", label: "Dark",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    subdomains: "abcd", maxNativeZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  },
  {
    id: "topo", label: "Topo",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: "abc", maxNativeZoom: 17,
    attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
  },
  {
    id: "satellite", label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maxNativeZoom: 19,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  },
  { id: "none", label: "None", url: null, attribution: "" }
];
