/* GISzilMap — Cleveland metro house-hunting map. */
"use strict";

const GLENN = [-81.8622, 41.4155];

/* ---------- color system (validated dataviz palette) ---------- */
// sequential blue ramp, light -> dark (steps 100..700)
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
// validated all-pairs set; weakest pair (magenta/red, ΔE 13.2) is assigned to
// the two smallest categories (multi/asian) which rarely mass side by side
const DOT_COLORS = {
  white: "#2a78d6", black: "#008300", hispanic: "#eda100",
  asian: "#e34948", multi: "#e87ba4", other: "#4a3aa7",
};
const LISTING_COLOR = "#4a3aa7";
const PENDING_COLOR = "#eb6834";   // contingent / under contract
const SOLD_COLOR = "#52514e";
const CRIME_COLORS = { violent: "#d03b3b", property: "#898781" };

/* ---------- metric registry ---------- */
// prop: raw value column, score: 0-100 percentile column (higher=better),
// invert: true when the *raw* value reads "less is better" (legend direction)
const METRICS = {
  composite:  { label: "Composite score",         fmt: v => v.toFixed(0) + "/100" },
  s_car:      { label: "Commute · car",           prop: "car_min",     unit: " min", invert: true },
  s_transit:  { label: "Commute · transit",       prop: "transit_min", unit: " min", invert: true },
  s_bike:     { label: "Commute · bike",          prop: "bike_min",    unit: " min", invert: true },
  s_crime:    { label: "Crime rate",              prop: "crime_rate",  unit: "/1k",  invert: true },
  s_school:   { label: "School performance",      prop: "school_pi",   unit: "% PI" },
  s_amenity:  { label: "Cafés · bars · dining",   prop: "amenity_1km", unit: " in 1 km" },
  s_grocery:  { label: "Grocery walk",            prop: "grocery_walk_min", unit: " min", invert: true },
  s_park:     { label: "Park access",             prop: "green_frac_1km", unit: " green frac" },
  s_div_race: { label: "Racial diversity",        prop: "diversity_race", unit: "" },
  s_div_rel:  { label: "Religious diversity",     prop: "diversity_religion", unit: "" },
};
const WEIGHT_DEFAULTS = {
  s_car: 8, s_transit: 2, s_bike: 2, s_crime: 6, s_school: 6,
  s_amenity: 4, s_grocery: 3, s_park: 4, s_div_race: 2, s_div_rel: 1,
};
const NOTES = {
  s_crime: "Cleveland: incident-based per block group. Suburbs: FBI agency-reported annual rate, uniform across each municipality.",
  s_car: "Free-flow drive time — no rush-hour penalty.",
  s_transit: "GCRTA/Laketran/Akron METRO, weekday 07:30–08:30 median.",
  s_div_rel: "Congregation mix within 2 km (OSM), not adherence.",
  s_grocery: "Walk time to nearest major supermarket (Heinen's, Giant Eagle, Whole Foods, Trader Joe's, Marc's, Dave's, Aldi, Meijer, Costco…). Blank = over 45 min on foot.",
};

/* ---------- overlays ---------- */
const OVERLAYS = [
  { id: "listings",  label: "Listings",           color: LISTING_COLOR, on: true },
  { id: "sold",      label: "Recently sold",      color: SOLD_COLOR, on: false },
  { id: "racedots",  label: "Racial dot map",     color: DOT_COLORS.white, on: false },
  { id: "crimepts",  label: "Crime incidents",    color: CRIME_COLORS.violent, on: false },
  { id: "amenities", label: "Cafés/bars/dining",  color: "#eb6834", on: false },
  { id: "grocery",   label: "Grocery stores",     color: "#1baf7a", on: false },
  { id: "worship",   label: "Places of worship",  color: "#4a3aa7", on: false },
  { id: "parks",     label: "Parks",              color: "#008300", on: false },
  { id: "districts", label: "School districts",   color: "#52514e", on: false },
];

/* ---------- map bootstrap ---------- */
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const map = new maplibregl.Map({
  container: "map",
  center: [-81.68, 41.42],
  zoom: 10,
  maxBounds: [[-83.2, 40.4], [-80.2, 42.3]],
  style: {
    version: 8,
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/light",
    sources: {
      protomaps: { type: "vector", url: "pmtiles://tiles/basemap.pmtiles", attribution: "© OpenStreetMap" },
    },
    layers: basemaps.layers("protomaps", basemaps.namedFlavor("light"), { lang: "en" }),
  },
});
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-right");
// dynamic scale bars (resize with zoom): miles on top, km beneath
map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: "metric" }), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: "imperial" }), "bottom-right");

let bgData = null;          // blockgroups geojson (for composite + popups)
const bgIndex = new Map();  // GEOID -> properties
let bgOrder = null;         // [[geoid, lon, lat], ...] = matrix row/col order
let destMarker = null;      // commute-destination marker
let pickingDest = false;
const baseCommute = new Map();  // GEOID -> baked Glenn values (for reset)

map.on("load", async () => {
  /* block groups (choropleth base) */
  bgData = await (await fetch("tiles/blockgroups.geojson")).json();
  for (const f of bgData.features) {
    const p = f.properties;
    bgIndex.set(p.GEOID, p);
    baseCommute.set(p.GEOID, {
      car_min: p.car_min, transit_min: p.transit_min, bike_min: p.bike_min,
      s_car: p.s_car, s_transit: p.s_transit, s_bike: p.s_bike,
    });
  }
  bgOrder = await fetch("tiles/bg_order.json")
    .then(r => r.ok ? r.json() : null).catch(() => null);
  map.addSource("bg", { type: "geojson", data: bgData, promoteId: "GEOID" });
  map.addLayer({
    id: "bg-fill", type: "fill", source: "bg",
    paint: {
      "fill-color": [
        "case", ["==", ["feature-state", "val"], null], "rgba(0,0,0,0)",
        ["interpolate", ["linear"], ["feature-state", "val"],
          0, RAMP[0], 17, RAMP[1], 33, RAMP[2], 50, RAMP[3],
          67, RAMP[4], 83, RAMP[5], 100, RAMP[6]],
      ],
      "fill-opacity": 0.65,
    },
  }, firstLabelLayer());
  map.addLayer({
    id: "bg-line", type: "line", source: "bg",
    paint: { "line-color": "rgba(11,11,11,0.12)", "line-width": 0.4 },
    minzoom: 11,
  }, firstLabelLayer());

  /* county outline for orientation */
  map.addSource("counties", { type: "geojson", data: "tiles/counties.geojson" });
  map.addLayer({
    id: "county-line", type: "line", source: "counties",
    paint: { "line-color": "#52514e", "line-width": 1, "line-dasharray": [3, 2] },
  });

  /* overlays */
  map.addSource("racedots", { type: "vector", url: "pmtiles://tiles/race_dots.pmtiles" });
  map.addLayer({
    id: "racedots", type: "circle", source: "racedots", "source-layer": "dots",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 1.4, 15, 2.6],
      "circle-opacity": 0.85,
      "circle-color": ["match", ["get", "c"],
        "white", DOT_COLORS.white, "black", DOT_COLORS.black,
        "hispanic", DOT_COLORS.hispanic, "asian", DOT_COLORS.asian,
        "multi", DOT_COLORS.multi, DOT_COLORS.other],
    },
  }, firstLabelLayer());

  map.addSource("crimepts", { type: "vector", url: "pmtiles://tiles/crime.pmtiles" });
  map.addLayer({
    id: "crimepts", type: "circle", source: "crimepts", "source-layer": "crime",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 14, 4],
      "circle-opacity": 0.6,
      "circle-color": ["match", ["get", "kind"],
        "violent", CRIME_COLORS.violent, CRIME_COLORS.property],
    },
  }, firstLabelLayer());

  map.addSource("parks", { type: "geojson", data: "tiles/parks.geojson" });
  map.addLayer({
    id: "parks", type: "fill", source: "parks",
    paint: { "fill-color": "#008300", "fill-opacity": 0.35 },
  }, firstLabelLayer());

  map.addSource("amenities", { type: "geojson", data: "tiles/amenities.geojson" });
  map.addLayer({
    id: "amenities", type: "circle", source: "amenities", minzoom: 11,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2, 15, 5],
      "circle-color": ["match", ["get", "kind"],
        "cafe", "#eda100", "restaurant", "#eb6834", "fast_food", "#e87ba4",
        "#4a3aa7"],  // bar/pub
      "circle-stroke-color": "#fcfcfb", "circle-stroke-width": 0.8,
    },
  });

  map.addSource("grocery", { type: "geojson", data: "tiles/grocery.geojson" });
  map.addLayer({
    id: "grocery", type: "circle", source: "grocery",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"],
        8, ["case", ["get", "is_major"], 3, 1.5],
        14, ["case", ["get", "is_major"], 8, 4]],
      "circle-color": "#1baf7a",
      "circle-opacity": ["case", ["get", "is_major"], 0.95, 0.55],
      "circle-stroke-color": "#fcfcfb", "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: "grocery-label", type: "symbol", source: "grocery", minzoom: 12,
    filter: ["get", "is_major"],
    layout: {
      "text-field": ["coalesce", ["get", "chain"], ["get", "name"]],
      "text-size": 10, "text-offset": [0, 1.1], "text-anchor": "top",
      "text-font": ["Noto Sans Regular"], "text-optional": true,
    },
    paint: { "text-color": "#0b6b4a", "text-halo-color": "#fcfcfb",
             "text-halo-width": 1.2 },
  });

  map.addSource("worship", { type: "geojson", data: "tiles/worship.geojson" });
  map.addLayer({
    id: "worship", type: "circle", source: "worship", minzoom: 10,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 5],
      "circle-color": ["match", ["get", "religion"],
        "christian", "#2a78d6", "jewish", "#eda100", "muslim", "#1baf7a",
        "buddhist", "#eb6834", "hindu", "#e87ba4", "#898781"],
      "circle-stroke-color": "#fcfcfb", "circle-stroke-width": 0.8,
    },
  });

  map.addSource("districts", { type: "geojson", data: "tiles/school_districts.geojson" });
  map.addLayer({
    id: "districts", type: "line", source: "districts",
    paint: { "line-color": "#52514e", "line-width": 1.2 },
  });
  map.addLayer({
    id: "districts-label", type: "symbol", source: "districts", minzoom: 10,
    layout: {
      "text-field": ["coalesce", ["get", "district"], ["get", "name"]],
      "text-size": 11, "text-font": ["Noto Sans Regular"],
    },
    paint: { "text-color": "#52514e", "text-halo-color": "#fcfcfb", "text-halo-width": 1.2 },
  });

  map.addSource("listings", { type: "geojson", data: "tiles/listings.geojson" });
  map.addLayer({
    id: "listings", type: "circle", source: "listings",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 5, 15, 8],
      "circle-color": ["match", ["get", "status"],
        "contingent", PENDING_COLOR, "pending", PENDING_COLOR, LISTING_COLOR],
      "circle-stroke-color": "#fcfcfb", "circle-stroke-width": 1.2,
    },
  });

  map.addSource("sold", { type: "geojson", data: "tiles/sold.geojson" });
  map.addLayer({
    id: "sold", type: "circle", source: "sold",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 4, 15, 7],
      "circle-color": SOLD_COLOR, "circle-opacity": 0.8,
      "circle-stroke-color": "#fcfcfb", "circle-stroke-width": 1,
    },
  }, "listings");

  /* commute destination marker (defaults to NASA Glenn) */
  destMarker = new maplibregl.Marker({ color: "#e34948" }).setLngLat(GLENN)
    .setPopup(new maplibregl.Popup().setHTML("<b>Commute destination</b>"))
    .addTo(map);

  fetch("tiles/meta.json").then(r => r.ok ? r.json() : null).then(m => {
    if (m) $("data-stamp").textContent =
      `data as of ${m.updated} · ${m.listings.toLocaleString()} listings · ${m.sold.toLocaleString()} recent sales`;
  }).catch(() => {});
  buildPanel();
  applyOverlays();
  applyMetric();
  wirePopups();

  const savedDest = HASH.dest !== undefined
    ? (HASH.dest ? { geoid: HASH.dest } : null)
    : store.get("dest", null);
  if (savedDest?.geoid) setDestination(savedDest.geoid, false);
  openDeepLink();
});

function firstLabelLayer() {
  for (const l of map.getStyle().layers)
    if (l.type === "symbol") return l.id;
  return undefined;
}

/* ---------- panel ---------- */
const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => JSON.parse(localStorage.getItem("gzm_" + k) ?? JSON.stringify(d)),
  set: (k, v) => localStorage.setItem("gzm_" + k, JSON.stringify(v)),
};
let weights = store.get("weights", WEIGHT_DEFAULTS);

// URL-hash overrides, e.g. #metric=s_school&overlays=racedots,parks
const HASH = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));

function buildPanel() {
  const sel = $("metric");
  sel.add(new Option("— none —", "none"));
  for (const [k, m] of Object.entries(METRICS)) sel.add(new Option(m.label, k));
  sel.value = HASH.metric ?? store.get("metric", "composite");
  sel.onchange = () => { store.set("metric", sel.value); applyMetric(); };

  const wdiv = $("weights");
  for (const [k, def] of Object.entries(WEIGHT_DEFAULTS)) {
    const row = document.createElement("div");
    row.className = "wrow";
    row.innerHTML = `<label>${METRICS[k].label}</label>
      <input type="range" min="0" max="10" step="1" value="${weights[k] ?? def}">
      <span class="wval">${weights[k] ?? def}</span>`;
    const inp = row.querySelector("input");
    inp.oninput = () => {
      weights[k] = +inp.value;
      row.querySelector(".wval").textContent = inp.value;
      store.set("weights", weights);
      if ($("metric").value === "composite") applyMetric();
    };
    wdiv.appendChild(row);
  }

  const odiv = $("overlays");
  const saved = HASH.overlays !== undefined
    ? HASH.overlays.split(",").filter(Boolean)
    : store.get("overlays", null);
  for (const o of OVERLAYS) {
    if (saved) o.on = saved.includes(o.id);
    const row = document.createElement("label");
    row.className = "orow";
    row.innerHTML = `<input type="checkbox" ${o.on ? "checked" : ""}>
      <span class="swatch" style="background:${o.color}"></span> ${o.label}`;
    row.querySelector("input").onchange = (e) => {
      o.on = e.target.checked;
      store.set("overlays", OVERLAYS.filter(x => x.on).map(x => x.id));
      applyOverlays();
    };
    odiv.appendChild(row);
  }

  for (const id of ["pmin", "pmax", "bmin", "bamin", "age", "agemode", "lstatus", "soldwin", "lmin", "lmax"]) {
    $(id).value = HASH[id] ?? store.get(id, "");
    $(id).onchange = () => { store.set(id, $(id).value); applyListingFilter(); legendDots(); };
  }
  applyListingFilter();

  $("dest-change").onclick = () => {
    pickingDest = true;
    map.getCanvas().style.cursor = "crosshair";
    $("dest-label").textContent = "now click your workplace on the map…";
    if (matchMedia("(max-width: 640px)").matches)
      $("panel").classList.add("hidden");
  };
  $("dest-reset").onclick = resetDestination;

  $("panel-toggle").onclick = () => $("panel").classList.toggle("hidden");
  if (matchMedia("(max-width: 640px)").matches) $("panel").classList.add("hidden");
}

function applyOverlays() {
  for (const o of OVERLAYS) {
    const vis = o.on ? "visible" : "none";
    for (const id of [o.id, o.id + "-label"])
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
  }
  legendDots();
}

function applyListingFilter() {
  if (!map.getLayer("listings")) return;
  const f = ["all"];
  const st = $("lstatus").value;
  if (st === "active") f.push(["==", ["coalesce", ["get", "status"], "active"], "active"]);
  if (st === "pending") f.push(["!=", ["coalesce", ["get", "status"], "active"], "active"]);

  if ($("pmin").value) f.push([">=", ["get", "price"], +$("pmin").value]);
  if ($("pmax").value) f.push(["<=", ["get", "price"], +$("pmax").value]);
  if ($("bmin").value) f.push([">=", ["coalesce", ["get", "beds"], 0], +$("bmin").value]);
  if ($("bamin").value) f.push([">=", ["coalesce", ["get", "baths"], 0], +$("bamin").value]);
  // lot filters exclude listings with unknown lot size (mostly condos)
  if ($("lmin").value) f.push([">=", ["coalesce", ["get", "lot_sqft"], -1], +$("lmin").value * 43560]);
  if ($("lmax").value) f.push(["<=", ["coalesce", ["get", "lot_sqft"], 9e9], +$("lmax").value * 43560]);
  const age = $("age").value;  // n = newer than, o = older than
  if (age) {
    const days = +age.slice(1);
    // "price change" mode filters on days since the last price change this
    // tool observed; listings with no observed change are excluded
    const field = $("agemode").value === "change" ? "days_since_change" : "days_on_market";
    f.push(age[0] === "n"
      ? ["<=", ["coalesce", ["get", field], 99999], days]
      : [">=", ["coalesce", ["get", field], -1], days]);
  }
  map.setFilter("listings", f.length > 1 ? f : null);
  if (map.getLayer("sold")) {
    // same price/beds/baths constraints, plus the sold-within horizon
    const g = f.filter(x => { const j = JSON.stringify(x);
      return !(j.includes('"status"') || j.includes('"days_on_market"')); });
    g.push(["<=", ["coalesce", ["get", "days_since_sold"], 999], +$("soldwin").value]);
    map.setFilter("sold", g);
  }
}

/* ---------- dynamic commute destination ---------- */
async function fetchRow(mode, idx, n) {
  const resp = await fetch(`tiles/tt_${mode}.bin`, {
    headers: { Range: `bytes=${idx * n}-${(idx + 1) * n - 1}` },
  });
  if (!resp.ok && resp.status !== 206) throw new Error(`tt_${mode} HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  return resp.status === 206 ? buf : buf.subarray(idx * n, (idx + 1) * n);
}

function pctScores(minutes) {
  // percentile rank, lower minutes = higher score (like p10)
  const valid = minutes.filter(v => v != null).sort((a, b) => a - b);
  const m = valid.length;
  return minutes.map(v => {
    if (v == null || m < 2) return null;
    let lo = 0, hi = m;
    while (lo < hi) { const mid = (lo + hi) >> 1; valid[mid] <= v ? lo = mid + 1 : hi = mid; }
    return Math.round(1000 * (1 - (lo - 1) / (m - 1))) / 10;
  });
}

async function setDestination(geoid, save = true) {
  if (!bgOrder) return alert("travel-time matrix files not deployed yet");
  const n = bgOrder.length;
  const idx = bgOrder.findIndex(e => e[0] === geoid);
  if (idx < 0) return;
  $("dest-label").textContent = "loading…";
  let rows;
  try {
    rows = await Promise.all(["car", "transit", "bike"]
      .map(m => fetchRow(m, idx, n)));
  } catch (err) {
    $("dest-label").textContent = "matrix fetch failed";
    console.error(err);
    return;
  }
  const mins = rows.map(r => Array.from(r, v => v === 255 ? null : v));
  const scores = mins.map(pctScores);
  const fields = [["car_min", "s_car"], ["transit_min", "s_transit"],
                  ["bike_min", "s_bike"]];
  bgOrder.forEach(([g], i) => {
    const p = bgIndex.get(g);
    if (!p) return;
    fields.forEach(([raw, sc], k) => {
      p[raw] = mins[k][i];
      p[sc] = scores[k][i];
    });
  });
  const [, lon, lat] = bgOrder[idx];
  destMarker.setLngLat([lon, lat]);
  $("dest-label").textContent = `custom (block group ${geoid})`;
  if (save) store.set("dest", { geoid });
  applyMetric();
}

function resetDestination() {
  for (const [g, vals] of baseCommute) Object.assign(bgIndex.get(g), vals);
  destMarker.setLngLat(GLENN);
  $("dest-label").textContent = "NASA Glenn Research Center";
  store.set("dest", null);
  applyMetric();
}

/* ---------- choropleth ---------- */
function compositeOf(p) {
  let sum = 0, wsum = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = p[k];
    if (w > 0 && v != null && !Number.isNaN(v)) { sum += w * v; wsum += w; }
  }
  return wsum > 0 ? sum / wsum : null;
}

function applyMetric() {
  const key = $("metric").value;
  // fill stays technically visible at opacity 0 so block groups remain
  // clickable for the stats popup even with no choropleth selected
  map.setPaintProperty("bg-fill", "fill-opacity", key === "none" ? 0 : 0.65);
  map.setLayoutProperty("bg-line", "visibility", key === "none" ? "none" : "visible");
  $("metric-note").textContent = NOTES[key] ?? "";
  if (key === "none") { $("legend").innerHTML = ""; return; }

  for (const f of bgData.features) {
    const p = f.properties;
    const val = key === "composite" ? compositeOf(p) : (p[key] ?? null);
    map.setFeatureState({ source: "bg", id: p.GEOID }, { val });
  }
  legendRamp(key);
}

function legendRamp(key) {
  const m = METRICS[key];
  const bar = RAMP.map(c => `<div style="background:${c}"></div>`).join("");
  let lo = "worst", hi = "best";
  if (key !== "composite" && m.prop) {
    const vals = bgData.features.map(f => f.properties[m.prop]).filter(v => v != null);
    if (vals.length) {
      vals.sort((a, b) => a - b);
      const q = (p) => vals[Math.floor(p * (vals.length - 1))];
      // color follows the score (higher=better=darker); label with raw values
      lo = (m.invert ? q(0.98) : q(0.02)) + (m.unit ?? "");
      hi = (m.invert ? q(0.02) : q(0.98)) + (m.unit ?? "");
    }
  }
  $("legend").innerHTML =
    `<div class="bar">${bar}</div><div class="ends"><span>${lo}</span><span>${hi}</span></div>`;
}

function legendDots() {
  const parts = [];
  if (OVERLAYS.find(o => o.id === "listings").on && $("lstatus").value !== "active")
    parts.push(`<span><i style="background:${LISTING_COLOR}"></i>active</span>`,
               `<span><i style="background:${PENDING_COLOR}"></i>contingent/pending</span>`);
  if (OVERLAYS.find(o => o.id === "sold").on)
    parts.push(`<span><i style="background:${SOLD_COLOR}"></i>sold</span>`);
  if (OVERLAYS.find(o => o.id === "racedots").on)
    for (const [k, c] of Object.entries(DOT_COLORS))
      parts.push(`<span><i style="background:${c}"></i>${k}</span>`);
  if (OVERLAYS.find(o => o.id === "crimepts").on)
    for (const [k, c] of Object.entries(CRIME_COLORS))
      parts.push(`<span><i style="background:${c}"></i>${k}</span>`);
  $("dot-legend").innerHTML = parts.join(" ");
}

/* ---------- popups ---------- */
const fmt = (v, d = 0) => v == null || Number.isNaN(v) ? "—" : (+v).toFixed(d);

function wirePopups() {
  map.on("click", (e) => {
    if (pickingDest) {
      pickingDest = false;
      map.getCanvas().style.cursor = "";
      const hits = map.queryRenderedFeatures(e.point, { layers: ["bg-fill"] });
      if (hits.length) setDestination(hits[0].properties.GEOID);
      else $("dest-label").textContent = "click was outside the metro — try again";
      return;
    }
    const pad = 5;
    const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
    const tryLayers = (ids) => map.queryRenderedFeatures(box, { layers: ids.filter(l => map.getLayer(l)) });

    let feats = tryLayers(["listings", "sold"]);
    if (feats.length) return popupListing(e.lngLat, feats[0].properties);
    feats = tryLayers(["grocery", "amenities", "worship"]);
    if (feats.length) {
      const p = feats[0].properties;
      return new maplibregl.Popup().setLngLat(e.lngLat)
        .setHTML(`<b>${p.name ?? p.chain ?? "(unnamed)"}</b><br>${p.chain ?? p.kind ?? p.religion ?? ""} ${p.denomination ?? ""}`)
        .addTo(map);
    }
    feats = tryLayers(["bg-fill"]);
    if (feats.length)
      return popupScorecard(e.lngLat, bgIndex.get(feats[0].properties.GEOID));
  });
  for (const id of ["listings", "sold", "grocery", "amenities", "worship", "bg-fill"])
    map.on("mouseenter", id, () => map.getCanvas().style.cursor = "pointer");
}

const shareCache = new Map();  // id -> {props, lngLat}

function shareText(p, lngLat) {
  const price = p.price ? "$" + (+p.price).toLocaleString() : "price n/a";
  const hit = map.queryRenderedFeatures(map.project(lngLat), { layers: ["bg-fill"] });
  const bg = hit.length ? bgIndex.get(hit[0].properties.GEOID) : null;
  const comp = bg ? compositeOf(bg) : null;
  const deep = `${location.origin}${location.pathname}#at=${lngLat.lng.toFixed(5)},${lngLat.lat.toFixed(5)}&p=${encodeURIComponent(p.url ?? "")}`;
  const lines = [
    `🏠 ${price} · ${p.address ?? ""}, ${p.city ?? ""}`,
    `${fmt(p.beds)} bd · ${fmt(p.baths)} ba · ${p.sqft ? (+p.sqft).toLocaleString() + " sqft" : "sqft n/a"} · built ${p.year_built ?? "?"}`
      + (p.status && p.status !== "active" ? ` · ${p.status.toUpperCase()}` : ""),
  ];
  if (bg) lines.push(`Neighborhood ${comp != null ? fmt(comp) + "/100" : "—"} · car ${fmt(bg.car_min)} min · schools ${fmt(bg.school_pi)}% · grocery ${bg.grocery_walk_min != null ? fmt(bg.grocery_walk_min) + " min walk" : ">45 min walk"}`);
  if (p.url) lines.push(`Listing: ${p.url}`);
  lines.push(`Map: ${deep}`);
  return lines.join("\n");
}

window.shareListing = async (id) => {
  const it = shareCache.get(id);
  if (!it) return;
  const text = shareText(it.props, it.lngLat);
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
};

async function openDeepLink() {
  if (!HASH.at) return;
  const [lng, lat] = HASH.at.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  map.jumpTo({ center: [lng, lat], zoom: 15 });
  if (!HASH.p) return;
  const url = decodeURIComponent(HASH.p);
  for (const file of ["tiles/listings.geojson", "tiles/sold.geojson"]) {
    const fc = await fetch(file).then(r => r.ok ? r.json() : null).catch(() => null);
    const f = fc?.features.find(x => x.properties.url === url);
    if (f) {
      map.once("idle", () => popupListing({ lng, lat }, f.properties));
      return;
    }
  }
}

function popupListing(lngLat, p) {
  const price = p.price ? "$" + (+p.price).toLocaleString() : "—";
  const shareId = String(shareCache.size + 1);
  shareCache.set(shareId, { props: p, lngLat: { lng: lngLat.lng, lat: lngLat.lat } });
  // neighborhood context: the block group under the house
  const hit = map.queryRenderedFeatures(map.project(lngLat), { layers: ["bg-fill"] });
  const bg = hit.length ? bgIndex.get(hit[0].properties.GEOID) : null;
  const comp = bg ? compositeOf(bg) : null;
  const hood = bg ? `<div class="hood">Neighborhood score <b>${comp != null ? fmt(comp) + "/100" : "—"}</b>
      · car ${fmt(bg.car_min)} min · schools ${fmt(bg.school_pi)}% · crime ${bg.crime_rate != null ? fmt(bg.crime_rate, 1) : "n/a"}/1k
      · grocery ${bg.grocery_walk_min != null ? fmt(bg.grocery_walk_min) + " min walk" : ">45 min"}</div>` : "";
  const badge = p.status === "sold"
    ? `<span style="color:${SOLD_COLOR}">SOLD ${p.sold_date ?? ""}</span> · `
    : (p.status && p.status !== "active")
      ? `<span style="color:${PENDING_COLOR}">${p.status.toUpperCase()}</span> · ` : "";
  const photo = p.photo
    ? `<img src="${p.photo}" loading="lazy" alt="" referrerpolicy="no-referrer"
         style="width:100%;max-height:200px;object-fit:cover;border-radius:5px;margin-bottom:6px"
         onerror="this.remove()">` : "";
  new maplibregl.Popup({ maxWidth: "380px" }).setLngLat(lngLat).setHTML(`
    ${photo}<h3>${badge}${price} · ${p.address ?? ""}</h3>
    ${p.city ?? ""} ${p.zip ?? ""}<br>
    ${fmt(p.beds)} bd · ${fmt(p.baths)} ba · ${p.sqft ? (+p.sqft).toLocaleString() + " sqft" : "—"}
    ${p.lot_sqft ? " · " + (p.lot_sqft / 43560).toFixed(2) + " ac lot" : ""} · ${p.ptype ?? ""}<br>
    built ${p.year_built ?? "—"} · ${p.status === "sold" ? fmt(p.days_since_sold) + " days ago" : fmt(p.days_on_market) + " days on market"}
    ${p.price_changed ? `<br><b style="color:${p.price_change_pct < 0 ? "#006300" : "#d03b3b"}">${p.price_change_pct < 0 ? "▼" : "▲"} ${Math.abs(p.price_change_pct)}%</b> on ${p.price_changed}` : ""}<br>
    <a href="${p.url}" target="_blank" rel="noopener">listing ↗ (${p.source})</a>
    &nbsp;·&nbsp; <button class="share-btn" onclick="shareListing('${shareId}')">Share ⇪</button>
    ${hood}
  `).addTo(map);
}

function popupScorecard(lngLat, p) {
  if (!p) return;
  const comp = compositeOf(p);
  const row = (label, val, score) =>
    `<tr><td>${label}</td><td class="num">${val}</td><td class="num score">${score != null ? fmt(score) : ""}</td></tr>`;
  new maplibregl.Popup({ maxWidth: "380px" }).setLngLat(lngLat).setHTML(`
    <h3>Block group ${p.GEOID} · <b>${comp != null ? fmt(comp) + "/100" : "—"}</b></h3>
    <table>
      <tr><td></td><td class="num"><b>value</b></td><td class="num score"><b>pct</b></td></tr>
      ${row("Car commute", fmt(p.car_min) + " min", p.s_car)}
      ${row("Transit commute", fmt(p.transit_min) + " min", p.s_transit)}
      ${row("Bike commute", fmt(p.bike_min) + " min", p.s_bike)}
      ${row("Crime rate" + (p.crime_src === "agency" ? " (municipal)" : ""),
            p.crime_rate != null ? fmt(p.crime_rate, 1) + "/1k" : "no data", p.s_crime)}
      ${row("Schools (" + (p.district ?? "—") + ")", fmt(p.school_pi, 1) + "% PI, " + fmt(p.school_stars, 1) + "★", p.s_school)}
      ${row("Amenities ≤1 km", fmt(p.amenity_1km), p.s_amenity)}
      ${row("Grocery walk", p.grocery_walk_min != null ? fmt(p.grocery_walk_min) + " min" : ">45 min", p.s_grocery)}
      ${row("Nearest park", fmt(p.park_dist_m) + " m", p.s_park)}
      ${row("Racial diversity", fmt(p.diversity_race, 2), p.s_div_race)}
      ${row("Religious diversity", fmt(p.diversity_religion, 2), p.s_div_rel)}
    </table>
    <div class="score" style="margin-top:4px">
      ${fmt(p.pct_white)}% w · ${fmt(p.pct_black)}% b · ${fmt(p.pct_hispanic)}% h ·
      ${fmt(p.pct_asian)}% a · pop ${p.pop}
    </div>
  `).addTo(map);
}
