import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.9.0/+esm";

function parseGPX(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const points = Array.from(doc.querySelectorAll("trkpt")).map((pt) => {
    const lon = Number(pt.getAttribute("lon"));
    const lat = Number(pt.getAttribute("lat"));
    return [lon, lat];
  });

  if (!points.length) {
    throw new Error("Ingen sporpunkt fundet i GPX-filen.");
  }
  return points;
}

function utmZoneFromLon(lon) {
  return Math.floor((lon + 180) / 6) + 1;
}

function optimalNorwayEpsg(lon) {
  if (lon < 12) return 25832;
  if (lon < 24) return 25833;
  return 25835;
}

function inferLocalEtrs89Utm(pointsLonLat) {
  const lons = pointsLonLat.map((p) => p[0]);
  const meanLon = lons.reduce((a, b) => a + b, 0) / lons.length;
  if (meanLon >= 4 && meanLon <= 31.5) {
    return optimalNorwayEpsg(meanLon);
  }
  const zone = utmZoneFromLon(meanLon);
  return 25800 + zone;
}

function transformerForPoints(pointsLonLat) {
  const epsg = inferLocalEtrs89Utm(pointsLonLat);
  const zone = epsg - 25800;
  const utmDef = `+proj=utm +zone=${zone} +ellps=GRS80 +units=m +no_defs`;
  const transformer = proj4("EPSG:4326", utmDef);
  return { transformer, epsg, utmDef };
}

function projectPoints(pointsLonLat, transformer) {
  const xs = [];
  const ys = [];
  for (const [lon, lat] of pointsLonLat) {
    const [x, y] = transformer.forward([lon, lat]);
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

self.addEventListener("message", (event) => {
  const { id, xmlText } = event.data || {};
  try {
    const pointsLonLat = parseGPX(xmlText);
    const { transformer, epsg, utmDef } = transformerForPoints(pointsLonLat);
    const { xs, ys } = projectPoints(pointsLonLat, transformer);
    self.postMessage({
      id,
      ok: true,
      payload: { pointsLonLat, xs, ys, epsg, utmDef },
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
