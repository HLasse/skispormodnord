# GPX Webapp

Client-side web app that turns a GPX track into a multi-page topo PDF. It mirrors the logic in `main.py` (UTM zone inference, page grid ordering, recentering) and renders everything in the browser.

## Features
- GPX upload (click or drag/drop) with file name + track length summary.
- Paper sizes: A3, A4, A5 with portrait/landscape orientation.
- Map scales: 1:25 000, 1:50 000, 1:100 000 at 300 DPI.
- Overlap control between pages with overlap-preserving layout.
- Base map + grid from Kartverket WMS, plus track overlay.
- Per-page labels for scale and UTM zone.
- Optional magnetic declination + grid convergence per page (computed at page center).
- Preview thumbnails and a full-size viewer with zoom + paging.
- PDF download (multi-page).

## Limitations
- Norway only. The map sources and UTM zone logic assume Norwegian coverage.
- Requires direct WMS access from the browser. If CORS blocks requests, rendering will fail.
- Rendering is client-side; large GPX files or many pages can take time and memory.

## How it works
1. Parse GPX points in EPSG:4326.
2. Infer an ETRS89 / UTM zone from the track and project points.
3. Compute page grid from the track bbox, scale, paper size, and overlap.
4. Recenter per-page bboxes around local track points, then align to preserve overlap.
5. For each page, stitch WMTS tiles into a basemap, overlay WMS grid + track + labels.
6. Embed the page images into a multi-page PDF and expose a download link.

## Run locally
Use any static server so ES module imports work:

```bash
python3 -m http.server 5173
```

Then open `http://localhost:5173/webapp/`.

## Implementation notes
- Main logic: `webapp/main.js`
- UI layout and copy: `webapp/index.html`
- Styling: `webapp/style.css`
- Libraries: `proj4` (projection), `pdf-lib` (PDF), `geomagnetism` (declination)

## Map sources
- WMTS base map: https://cache.kartverket.no/v1/wmts/1.0.0 (capabilities: https://cache.kartverket.no/v1/wmts/1.0.0/WMTSCapabilities.xml)
- Base map WMS: https://wms.geonorge.no/skwms1/wms.topo (layer: topo)
- Grid WMS: https://wms.geonorge.no/skwms1/wms.rutenett (layer: 1km_rutelinje)
