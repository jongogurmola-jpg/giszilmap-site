/* GISzilMap — Cleveland metro house-hunting map. */
"use strict";

const GLENN = [-81.8622, 41.4155];
const BUILD = "1790019911";  // replaced with the publish timestamp by publish.sh
// dev-mode cache buster: browsers heuristically cache fetch() results even
// across hard reloads; a unique query forces fresh data on every local load
const DEVQ = BUILD === "dev" ? "?t=" + Date.now() : "";
// self-heal a stale cached index.html: if the HTML shipped for a different
// build than this script, the browser cached an old page -> reload once.
try {
  if (window.__EXPECTED_BUILD && window.__EXPECTED_BUILD !== "dev"
      && window.__EXPECTED_BUILD !== BUILD
      && !sessionStorage.getItem("gzm_reloaded")) {
    sessionStorage.setItem("gzm_reloaded", "1");
    location.reload();
  } else {
    sessionStorage.removeItem("gzm_reloaded");
  }
} catch (e) {}

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
// "asking vs model value" mode: listing dots recoloured by the p22 hedonic model
const VALUE_UNDER = "#1a9850";     // asking below model value (beyond the noise band)
const VALUE_OVER = "#d7301f";      // asking above model value
const VALUE_NEUTRAL = "#c9b45a";   // within the model's own error band
const VALUE_UNSCORED = "#b8b6b0";  // pending, or outside the modelled segment
let valMeta = null;                // {n, mae, segment, asof} read off valuation.geojson
// houses-to-watch layer (p26): one colour per reason, in the author's priority order
const WATCH = {
  move_fast:   { color: "#d7301f", label: "likely under contract within a week", short: "move fast" },
  cut_likely:  { color: "#e6a100", label: "likely to cut price within a week",   short: "cut likely" },
  room:        { color: "#13a08f", label: "room to negotiate below asking",       short: "room below asking" },
  below_model: { color: "#9a9890", label: "asks under the value model for what it is (weakest signal — mostly what the model can't see)", short: "under model" },
};
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
  s_income:   { label: "Median HH income",        prop: "income", unit: "" },
  s_park:     { label: "Park access",             prop: "green_frac_1km", unit: " green frac" },
  s_div_race: { label: "Racial diversity",        prop: "diversity_race", unit: "" },
  s_div_rel:  { label: "Religious diversity",     prop: "diversity_religion", unit: "" },
};
const WEIGHT_DEFAULTS = {
  s_car: 8, s_transit: 2, s_bike: 2, s_crime: 6, s_school: 6,
  s_amenity: 4, s_grocery: 3, s_park: 4, s_div_race: 2, s_div_rel: 1,
  s_income: 0,
};
const NOTES = {
  s_crime: "Cleveland: incident-based per block group. Suburbs: FBI agency-reported annual rate, uniform across each municipality.",
  s_car: "Free-flow drive time — no rush-hour penalty.",
  s_transit: "GCRTA/Laketran/Akron METRO, weekday 07:30–08:30 median.",
  s_div_rel: "Congregation mix within 2 km (OSM), not adherence.",
  s_income: "ACS 2020\u20132024 median household income per block group (margins of error are large at this scale \u2014 read relatively).",
  s_grocery: "Walk time to nearest major supermarket (Heinen's, Giant Eagle, Whole Foods, Trader Joe's, Marc's, Dave's, Aldi, Meijer, Costco…). Blank = over 45 min on foot.",
};

const PTYPE_CATS = {
  single: ["Single Family Residential", "SINGLE_FAMILY"],
  condo: ["Condo/Co-op", "CONDOS", "Townhouse", "TOWNHOMES"],
  multi: ["Multi-Family (2-4 Unit)", "Multi-Family (5+ Unit)", "MULTI_FAMILY"],
  land: ["LAND", "FARM"],
  other: ["MOBILE"],
};

/* ---------- overlays ---------- */
const OVERLAYS = [
  { id: "listings",  label: "Listings",           color: LISTING_COLOR, on: true },
  { id: "watch",     label: "Houses to watch",     color: WATCH.move_fast.color, on: false },
  { id: "value",     label: "Asking vs model value", color: VALUE_UNDER, on: false },
  { id: "sold",      label: "Recently sold",      color: SOLD_COLOR, on: false },
  { id: "racedots",  label: "Racial dot map",     color: DOT_COLORS.white, on: false },
  { id: "trend",     label: "Ethnicity trend 2000→2020", color: DOT_COLORS.black, on: false },
  { id: "gent",      label: "Gentrification 2000→now", color: "#eb6834", on: false },
  { id: "crimetrend", label: "Crime change 2000→now", color: "#d03b3b", on: false },
  { id: "crimepts",  label: "Crime incidents",    color: CRIME_COLORS.violent, on: false },
  { id: "amenities", label: "Cafés/bars/dining",  color: "#eb6834", on: false },
  { id: "grocery",   label: "Grocery stores",     color: "#1baf7a", on: false },
  { id: "worship",   label: "Places of worship",  color: "#4a3aa7", on: false },
  { id: "stripclubs", label: "Strip clubs",         color: "#0b0b0b", on: false },
  { id: "housing",    label: "Public & subsidized housing", color: "#b5178a", on: false },
  { id: "speed",     label: "Speed limits",       color: "#eda100", on: false },
  { id: "traffic",   label: "Traffic volume / congestion", color: "#d03b3b", on: false },
  { id: "parks",     label: "Parks",              color: "#008300", on: false },
  { id: "districts", label: "School districts",   color: "#52514e", on: false },
];

/* ---------- map bootstrap ---------- */
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// optional #view=zoom/lat/lng to open on a spot (shareable)
const VIEW = (new URLSearchParams(location.hash.slice(1)).get("view") ?? "").split("/").map(Number);
const map = new maplibregl.Map({
  container: "map",
  center: VIEW.length === 3 && VIEW.every(Number.isFinite) ? [VIEW[2], VIEW[1]] : [-81.68, 41.42],
  zoom: VIEW.length === 3 && VIEW.every(Number.isFinite) ? VIEW[0] : 10,
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

let taxProfiles = null;     // {munis, counties, state}
let trafficProfiles = null;
const HOUSING_COLORS = { ph: "#b5178a", pba: "#f06292", lihtc: "#7e57c2" };
const HOUSING_LABEL = { ph: "public housing (housing authority)",
                        pba: "HUD project-based assisted", lihtc: "tax-credit (LIHTC)" }; // {groups:{g:{wd:[24],we:[24],df_wd,df_we,pk_wd,pk_we}}}

/* speed-limit bins (mph) and traffic scales */
const SPEED_BINS = [
  [20, "#4a3aa7", "≤20"], [25, "#2a78d6", "25"], [35, "#1baf7a", "30–35"],
  [45, "#eda100", "40–45"], [55, "#eb6834", "50–55"], [99, "#d03b3b", "60+"],
];
const SPEED_UNKNOWN = "#b8b6ae";
const VC_STOPS = [[0, "#1baf7a"], [0.5, "#a6cf4a"], [0.7, "#eda100"], [0.85, "#eb6834"], [1.0, "#d03b3b"], [1.3, "#6e0b0b"]];
const VPH_STOPS = [[0, "#d5e4f7"], [300, "#8db8ea"], [1000, "#2a78d6"], [3000, "#1d3f9c"], [8000, "#160a4a"]];
const AADT_STOPS = [[0, "#d5e4f7"], [4000, "#8db8ea"], [15000, "#2a78d6"], [50000, "#1d3f9c"], [130000, "#160a4a"]];
const TTIME_HOURS = { am: [7, 8], mid: [11, 12], pm: [16, 17], eve: [19, 20, 21], night: [23, 0, 1, 2, 3, 4] };
let taxHome = null;         // {muni, county, propRate, propSrc, homeVal}
let bgData = null;          // blockgroups geojson (for composite + popups)
const bgIndex = new Map();  // GEOID -> properties
let bgOrder = null;         // [[geoid, lon, lat], ...] = matrix row/col order
let destMarker = null;      // commute-destination marker
let pickingDest = false;
const baseCommute = new Map();  // GEOID -> baked Glenn values (for reset)

map.on("load", async () => {
  /* block groups (choropleth base) */
  bgData = await (await fetch("tiles/blockgroups.geojson?v=1790019911" + DEVQ)).json();
  for (const f of bgData.features) {
    const p = f.properties;
    bgIndex.set(p.GEOID, p);
    baseCommute.set(p.GEOID, {
      car_min: p.car_min, transit_min: p.transit_min, bike_min: p.bike_min,
      s_car: p.s_car, s_transit: p.s_transit, s_bike: p.s_bike,
    });
  }
  bgOrder = await fetch("tiles/bg_order.json?v=1790019911" + DEVQ)
    .then(r => r.ok ? r.json() : null).catch(() => null);
  taxProfiles = await fetch("tiles/tax_profiles.json?v=1790019911" + DEVQ)
    .then(r => r.ok ? r.json() : null).catch(() => null);
  trafficProfiles = await fetch("tiles/traffic_profiles.json?v=1790019911" + DEVQ)
    .then(r => r.ok ? r.json() : null).catch(() => null);
  const CATS = ["white", "black", "hispanic", "asian", "multi", "other"];
  for (const f of bgData.features) {
    const p = f.properties;
    let best = null, bv = 0;
    for (const c of CATS) {
      const v = p["d_" + c];
      if (v != null && v > bv) { bv = v; best = c; }
    }
    p.g_cat = best; p.g_pp = best ? bv : null;
  }
  window.__trendCount = bgData.features.filter(f => f.properties.g_cat).length;
  window.__map = map;  // debugging hook
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

  map.addLayer({
    id: "trend", type: "fill", source: "bg",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["match", ["coalesce", ["get", "g_cat"], "none"],
        "white", DOT_COLORS.white, "black", DOT_COLORS.black,
        "hispanic", DOT_COLORS.hispanic, "asian", DOT_COLORS.asian,
        "multi", DOT_COLORS.multi, "other", DOT_COLORS.other,
        "rgba(0,0,0,0)"],
      "fill-opacity": ["interpolate", ["linear"],
        ["coalesce", ["get", "g_pp"], 0], 0, 0.05, 5, 0.25, 15, 0.55, 35, 0.85],
    },
  }, firstLabelLayer());

  map.addLayer({
    id: "gent", type: "fill", source: "bg",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["case",
        ["!", ["to-boolean", ["get", "gentrifying"]]],
        ["case", ["==", ["coalesce", ["get", "gent_pp"], -1], -1],
          "rgba(0,0,0,0)", "#9ec5f4"],
        ["interpolate", ["linear"], ["coalesce", ["get", "gent_pp"], 0],
          0, "#fde4c8", 50, "#eb6834", 100, "#a33305"],
      ],
      "fill-opacity": ["case",
        ["==", ["coalesce", ["get", "gent_pp"], -1], -1], 0,
        ["interpolate", ["linear"], ["coalesce", ["get", "gent_pp"], 0],
          0, 0.25, 100, 0.8]],
    },
  }, firstLabelLayer());

  /* county outline for orientation */
  map.addSource("counties", { type: "geojson", data: "tiles/counties.geojson?v=1790019911" + DEVQ });
  map.addLayer({
    id: "county-line", type: "line", source: "counties",
    paint: { "line-color": "#52514e", "line-width": 1, "line-dasharray": [3, 2] },
  });

  /* overlays */
  for (const yr of ["2020", "2010", "2000"]) {
    map.addSource("racedots" + yr, { type: "vector", url: `pmtiles://tiles/race_dots_${yr}.pmtiles` });
    map.addLayer({
      id: "racedots" + yr, type: "circle", source: "racedots" + yr, "source-layer": "dots",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 1.4, 15, 2.6],
        "circle-opacity": 0.85,
        "circle-color": ["match", ["get", "c"],
          "white", DOT_COLORS.white, "black", DOT_COLORS.black,
          "hispanic", DOT_COLORS.hispanic, "asian", DOT_COLORS.asian,
          "multi", DOT_COLORS.multi, DOT_COLORS.other],
      },
    }, firstLabelLayer());
  }

  map.addSource("crimetrend", { type: "geojson", data: "tiles/crime_trend.geojson?v=1790019911" + DEVQ });
  map.addLayer({
    id: "crimetrend", type: "fill", source: "crimetrend",
    layout: { visibility: "none" },
    paint: {
      // diverging: green = rate fell since 2000, red = rose; opacity = magnitude
      "fill-color": ["case", ["==", ["coalesce", ["get", "d_rate_pct"], -9999], -9999],
        "rgba(0,0,0,0)",
        ["interpolate", ["linear"], ["get", "d_rate_pct"],
          -80, "#0a6b30", -30, "#67b57e", -5, "#dfe8df",
          5, "#e8c9c2", 40, "#d03b3b", 120, "#7a1010"]],
      "fill-opacity": ["case", ["==", ["coalesce", ["get", "d_rate_pct"], -9999], -9999], 0,
        ["interpolate", ["linear"],
          ["abs", ["get", "d_rate_pct"]], 0, 0.25, 60, 0.75]],
    },
  }, firstLabelLayer());
  map.addLayer({
    id: "crimetrend-line", type: "line", source: "crimetrend",
    layout: { visibility: "none" },
    paint: { "line-color": "rgba(11,11,11,0.25)", "line-width": 0.7 },
  }, firstLabelLayer());

  /* street speed limits (ODOT road inventory + surveyed OSM signs) */
  map.addSource("speed", { type: "vector", url: "pmtiles://tiles/roads_speed.pmtiles" });
  map.addLayer({
    id: "speed", type: "line", source: "speed", "source-layer": "roads",
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["!", ["has", "spd"]], SPEED_UNKNOWN,
        ["step", ["get", "spd"],
          SPEED_BINS[0][1], 21, SPEED_BINS[1][1], 26, SPEED_BINS[2][1],
          36, SPEED_BINS[3][1], 46, SPEED_BINS[4][1], 56, SPEED_BINS[5][1]]],
      "line-width": ["interpolate", ["exponential", 1.4], ["zoom"],
        8, ["case", ["<=", ["get", "fc"], 2], 1.6, 0.8],
        12, ["case", ["<=", ["get", "fc"], 2], 3.2, ["<=", ["get", "fc"], 4], 2.4, 1.6],
        15, ["case", ["<=", ["get", "fc"], 2], 7, ["<=", ["get", "fc"], 4], 5, 3.5]],
      "line-opacity": 0.85,
    },
  }, firstLabelLayer());

  /* traffic volume / congestion (ODOT AADT × FHWA hourly profiles) */
  map.addSource("traffic", { type: "vector", url: "pmtiles://tiles/traffic.pmtiles" });
  map.addLayer({
    id: "traffic", type: "line", source: "traffic", "source-layer": "traffic",
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#2a78d6", "line-width": 2, "line-opacity": 0.9 },
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

  map.addSource("parks", { type: "geojson", data: "tiles/parks.geojson?v=1790019911" + DEVQ });
  map.addLayer({
    id: "parks", type: "fill", source: "parks",
    paint: { "fill-color": "#008300", "fill-opacity": 0.35 },
  }, firstLabelLayer());

  map.addSource("amenities", { type: "geojson", data: "tiles/amenities.geojson?v=1790019911" + DEVQ });
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

  map.addSource("grocery", { type: "geojson", data: "tiles/grocery.geojson?v=1790019911" + DEVQ });
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

  map.addSource("worship", { type: "geojson", data: "tiles/worship.geojson?v=1790019911" + DEVQ });
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

  map.addSource("stripclubs", { type: "geojson", data: "tiles/stripclubs.geojson?v=1790019911" + DEVQ });
  map.loadImage("lib/bunny.png").then((img) => {
    if (!map.hasImage("bunny")) map.addImage("bunny", img.data);
    map.addLayer({
      id: "stripclubs", type: "symbol", source: "stripclubs",
      layout: {
        "icon-image": "bunny", "icon-allow-overlap": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.28, 14, 0.6],
        "icon-anchor": "bottom", "visibility": "none",
        "text-field": ["step", ["zoom"], "", 12, ["get", "name"]],
        "text-font": ["Noto Sans Regular"], "text-size": 10,
        "text-offset": [0, 0.4], "text-anchor": "top", "text-optional": true,
      },
      paint: { "text-color": "#0b0b0b", "text-halo-color": "#fcfcfb",
               "text-halo-width": 1.2 },
    });
    applyOverlays();
  }).catch(() => {});

  map.addSource("housing", { type: "geojson", data: "tiles/housing.geojson?v=1790019911" + DEVQ });
  // radius grows with units (log-ish): a scattered-site house stays a dot,
  // a 200-unit tower reads as a blob; public housing drawn on top.
  const unitR = (lo, hi) => ["interpolate", ["linear"], ["sqrt", ["coalesce", ["get", "units"], 1]],
                             1, lo, 15, hi];
  map.addLayer({
    id: "housing", type: "circle", source: "housing",
    layout: { visibility: "none",
              "circle-sort-key": ["match", ["get", "kind"], "ph", 3, "pba", 2, 1] },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, unitR(1.5, 5), 14, unitR(4, 16)],
      "circle-color": ["match", ["get", "kind"], "ph", HOUSING_COLORS.ph,
                       "pba", HOUSING_COLORS.pba, HOUSING_COLORS.lihtc],
      "circle-opacity": 0.8,
      "circle-stroke-color": "#fcfcfb", "circle-stroke-width": 0.8,
    },
  });
  map.addLayer({
    id: "housing-label", type: "symbol", source: "housing", minzoom: 12,
    filter: [">=", ["coalesce", ["get", "units"], 0], 40],
    layout: {
      visibility: "none",
      "text-field": ["get", "name"], "text-size": 10,
      "text-offset": [0, 1.2], "text-anchor": "top",
      "text-font": ["Noto Sans Regular"], "text-optional": true,
    },
    paint: { "text-color": "#7a0f5c", "text-halo-color": "#fcfcfb", "text-halo-width": 1.2 },
  });

  map.addSource("districts", { type: "geojson", data: "tiles/school_districts.geojson?v=1790019911" + DEVQ });
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

  map.addSource("listings", { type: "geojson", data: "tiles/listings.geojson?v=1790019911" + DEVQ });
  map.addLayer({
    id: "listings", type: "circle", source: "listings",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 5, 15, 8],
      "circle-color": ["match", ["get", "status"],
        "contingent", PENDING_COLOR, "pending", PENDING_COLOR, LISTING_COLOR],
      "circle-stroke-color": "#fcfcfb", "circle-stroke-width": 1.2,
    },
  });

  map.addSource("sold", { type: "geojson", data: "tiles/sold.geojson?v=1790019911" + DEVQ });
  map.addLayer({
    id: "sold", type: "circle", source: "sold",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 4, 15, 7],
      "circle-color": SOLD_COLOR, "circle-opacity": 0.8,
      "circle-stroke-color": "#fcfcfb", "circle-stroke-width": 1,
    },
  }, "listings");

  /* houses to watch: p26's flagged listings, drawn on top of the dots. Colour
     = the most urgent reason; a house with two reasons gets a dark ring. */
  map.addSource("watch", { type: "geojson", data: "tiles/watch.geojson?v=1790019911" + DEVQ });
  const watchColor = ["match", ["get", "watch_primary"],
    "move_fast", WATCH.move_fast.color, "cut_likely", WATCH.cut_likely.color,
    "room", WATCH.room.color, WATCH.below_model.color];
  const multi = [">", ["coalesce", ["get", "watch_n_reasons"], 1], 1];
  map.addLayer({
    id: "watch", type: "circle", source: "watch",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, ["case", multi, 5, 4], 12, ["case", multi, 9, 7], 15, ["case", multi, 13, 10]],
      "circle-color": watchColor,
      "circle-opacity": ["case", ["==", ["get", "watch_primary"], "below_model"], 0.55, 0.95],
      "circle-stroke-color": ["case", multi, "#0b0b0b", "#fcfcfb"],
      "circle-stroke-width": ["case", multi, 2.5, 1.5],
    },
  });
  map.addLayer({
    id: "watch-label", type: "symbol", source: "watch", minzoom: 12,
    layout: {
      "text-field": ["match", ["get", "watch_primary"],
        "move_fast", ["concat", ["to-string", ["round", ["*", 100, ["get", "p_contract_7d"]]]], "% contract"],
        "cut_likely", ["concat", ["to-string", ["round", ["*", 100, ["get", "p_cut_7d"]]]], "% cut"],
        "room", ["concat", ["to-string", ["get", "exp_stl_pct"]], "% room"],
        "under model"],
      "text-font": ["Noto Sans Regular"], "text-size": 10.5, "text-offset": [0, 1.3],
      "text-anchor": "top", "text-optional": true, "text-allow-overlap": false,
    },
    paint: { "text-color": ["case", ["==", ["get", "watch_primary"], "below_model"], "#7a7870", "#0b0b0b"],
             "text-halo-color": "#fcfcfb", "text-halo-width": 1.4 },
  });

  /* commute destination marker (defaults to NASA Glenn) */
  destMarker = new maplibregl.Marker({ color: "#e34948" }).setLngLat(GLENN)
    .setPopup(new maplibregl.Popup().setHTML("<b>Commute destination</b>"))
    .addTo(map);

  // aggregate visit counter (privacy-friendly: a bare count, no identifiers).
  // increment once per browser session; always display the running totals.
  (() => {
    const NS = "giszilmap-jongo-9f2a";
    const day = new Date().toISOString().slice(0, 10);
    // unique visitors = unique browsers, deduped by a persistent localStorage
    // flag (no IPs, no cookies, no fingerprinting). A new browser/device or
    // cleared storage counts once more — the standard cookieless limitation.
    const flag = (k) => { try { if (localStorage.getItem(k)) return false;
      localStorage.setItem(k, "1"); return true; } catch (e) { return false; } };
    const call = (key, isNew) =>
      fetch(`https://abacus.jasoncameron.dev/${isNew ? "hit" : "get"}/${NS}/${key}`)
        .then(r => r.json()).catch(() => null);
    Promise.all([
      call("uniques", flag("gzm_uv")),
      call("u-" + day, flag("gzm_uv_" + day)),
    ]).then(([tot, today]) => {
      if (!tot) return;
      const el = document.getElementById("visit-count");
      if (el) el.textContent = `\u25C9 ${tot.value.toLocaleString()} unique visitors`
        + (today ? ` \u00B7 ${today.value.toLocaleString()} today` : "");
    });
  })();

  fetch("tiles/meta.json?v=1790019911" + DEVQ).then(r => r.ok ? r.json() : null).then(m => {
    if (m) $("data-stamp").textContent =
      `data as of ${m.updated} · ${m.listings.toLocaleString()} listings · ${m.sold.toLocaleString()} recent sales`
      + ` · build ${BUILD} · trend ${window.__trendCount ?? 0} areas`;
  }).catch(() => {});
  Promise.all(["model_scorecard", "outcomes_model"].map(n =>
    fetch(`tiles/${n}.json` + DEVQ).then(r => r.ok ? r.json() : null).catch(() => null)))
    .then(([c, o]) => modelCard(c, o));
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
      if ((o.id === "trend" || o.id === "gent" || o.id === "crimetrend") && o.on && $("metric").value !== "none") {
        $("metric").value = "none";   // choropleth would bury the trend tint
        store.set("metric", "none");
        applyMetric();
      }
      if (o.id === "value" && o.on) {   // value mode restyles the listing dots, so they must be shown
        const l = OVERLAYS.find(x => x.id === "listings");
        if (!l.on) { l.on = true; odiv.querySelectorAll(".orow input")[OVERLAYS.indexOf(l)].checked = true;
                     store.set("overlays", OVERLAYS.filter(x => x.on).map(x => x.id)); }
      }
      applyOverlays();
    };
    odiv.appendChild(row);
  }

  $("dotyear").value = HASH.dotyear ?? store.get("dotyear", "2020");
  $("dotyear").onchange = () => { store.set("dotyear", $("dotyear").value); applyOverlays(); };
  const TDEF = { tmode: "vol", ttime: "day", tday: "wd", thour: "17" };
  for (const id of Object.keys(TDEF)) {
    $(id).value = HASH[id] ?? store.get(id, TDEF[id]);
    $(id).oninput = () => { store.set(id, $(id).value); applyTraffic(); };
  }
  const FILTER_DEFAULTS = { lstatus: "active", soldwin: "90", agemode: "listing" };
  for (const id of ["pmin", "pmax", "bmin", "bamin", "age", "agemode", "lstatus", "soldwin", "lmin", "lmax", "ptype", "sfmin", "sfmax", "ppsfmin", "ppsfmax"]) {
    $(id).value = HASH[id] ?? store.get(id, FILTER_DEFAULTS[id] ?? "");
    $(id).onchange = () => { store.set(id, $(id).value); applyListingFilter(); legendDots(); };
  }
  applyListingFilter();
  loadMarketData();

  $("dest-change").onclick = () => {
    pickingDest = true;
    map.getCanvas().style.cursor = "crosshair";
    $("dest-label").textContent = "now click your workplace on the map…";
    if (matchMedia("(max-width: 640px)").matches)
      $("panel").classList.add("hidden");
  };
  $("dest-reset").onclick = resetDestination;

  if (taxProfiles) {
    const names = Object.keys(taxProfiles.munis).sort();
    for (const sel of [$("work1"), $("work2")]) {
      sel.add(new Option("— same as home —", ""));
      sel.add(new Option("(township / no city tax)", "__none__"));
      for (const n of names) sel.add(new Option(n, n));
    }
    for (const id of ["inc1", "inc2", "work1", "work2", "homeval"]) {
      $(id).value = store.get("tax_" + id, $(id).value);
      $(id).oninput = $(id).onchange = () => { store.set("tax_" + id, $(id).value); computeTax(); };
    }
    for (const n of [1, 2]) {
      const cb = $("wfh" + n);
      cb.checked = store.get("tax_wfh" + n, false);
      const sync = () => { $("work" + n).disabled = cb.checked; };
      cb.onchange = () => { store.set("tax_wfh" + n, cb.checked); sync(); computeTax(); };
      sync();
    }
  }

  $("panel-toggle").onclick = () => $("panel").classList.toggle("hidden");
  if (matchMedia("(max-width: 640px)").matches) $("panel").classList.add("hidden");
}

function applyOverlays() {
  for (const o of OVERLAYS) {
    const vis = o.on ? "visible" : "none";
    if (o.id === "racedots") {
      const yr = $("dotyear").value;
      for (const y of ["2020", "2010", "2000"])
        map.setLayoutProperty("racedots" + y, "visibility",
          o.on && y === yr ? "visible" : "none");
      continue;
    }
    for (const id of [o.id, o.id + "-label", o.id + "-line"])
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
  }
  applyValueMode();
  const traffic = OVERLAYS.find(o => o.id === "traffic").on;
  $("traffic-widget").hidden = !traffic;
  if (traffic) applyTraffic(); else legendDots();
}

/* "Asking vs model value": recolour the listing dots by the p22 model's
   excess_pct (asking vs predicted sale value). Three-way split -- under /
   within the model's own error band / over -- using each house's
   local_mae_pct as the band, since the model reads century housing less
   reliably than post-war stock. Dot size grows with the gap beyond the band
   (saturating at +20 pts). Listings the model did not score (pending, or
   outside the modelled segment) stay as small faint dots so the map keeps
   its shape. */
function applyValueMode() {
  if (!map.getLayer("listings")) return;
  const on = OVERLAYS.find(o => o.id === "value").on;
  // with the watch layer up, the ordinary dots step back so the flagged houses read
  const dim = OVERLAYS.find(o => o.id === "watch").on ? 0.35 : 1;
  if (!on) {
    map.setPaintProperty("listings", "circle-color", ["match", ["get", "status"],
      "contingent", PENDING_COLOR, "pending", PENDING_COLOR, LISTING_COLOR]);
    map.setPaintProperty("listings", "circle-radius", ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 5, 15, 8]);
    map.setPaintProperty("listings", "circle-opacity", dim);
    map.setPaintProperty("listings", "circle-stroke-opacity", dim);
    return;
  }
  const ex = ["get", "excess_pct"], band = ["coalesce", ["get", "local_mae_pct"], ["get", "model_mae_pct"], 6];
  const scored = ["has", "excess_pct"];
  // 0..1 = how far beyond the noise band, saturating 20 points out
  const gap = ["min", 1, ["max", 0, ["/", ["-", ["abs", ex], band], 20]]];
  const size = ["case", ["!", scored], 0.55, ["+", 1, ["*", 1.5, gap]]];
  map.setPaintProperty("listings", "circle-color", ["case",
    ["!", scored], VALUE_UNSCORED,
    ["<", ex, ["-", 0, band]], VALUE_UNDER,
    [">", ex, band], VALUE_OVER,
    VALUE_NEUTRAL]);
  map.setPaintProperty("listings", "circle-radius", ["interpolate", ["linear"], ["zoom"],
    8, ["*", 2.5, size], 12, ["*", 5, size], 15, ["*", 8, size]]);
  map.setPaintProperty("listings", "circle-opacity", ["*", dim, ["case", scored, 1, 0.5]]);
  map.setPaintProperty("listings", "circle-stroke-opacity", dim);
}

/* "ppsf:190-300,price:250000-600000" -> "$190–300/sqft, $250k–600k asking" */
function segLabel(seg) {
  if (!seg || seg === "none") return "";
  const k = v => v >= 1000 ? Math.round(v / 1000) + "k" : String(v);
  return seg.split(",").map(part => {
    const [name, range] = part.split(":");
    const [a, b] = (range ?? "").split("-").map(Number);
    if (name === "ppsf") return `$${a}–${b}/sqft`;
    if (name === "price") return `$${k(a)}–${k(b)} asking`;
    return part;
  }).join(", ");
}

/* Why a house is on p26's watch list, in the author's priority order; the
   value-model reason last and quiet, since that gap is mostly what the model
   cannot see. Badges for as-is remarks and full point-of-sale inspection
   cities (escrow obligations for a buyer). */
function watchLine(p) {
  if (!p.watch_primary) return "";
  const pc = v => `${Math.round(100 * v)}%`;
  const rs = [];
  if (p.w_move_fast) rs.push(`<b style="color:${WATCH.move_fast.color}">⚡ ${WATCH.move_fast.label}</b> (${pc(p.p_contract_7d)})`);
  if (p.w_cut_likely) rs.push(`<b style="color:${WATCH.cut_likely.color}">✂ ${WATCH.cut_likely.label}</b> (${pc(p.p_cut_7d)})`);
  if (p.w_room) rs.push(`<b style="color:${WATCH.room.color}">${WATCH.room.label}</b>: ${(+p.exp_stl_pct).toFixed(1)}% (${(+p.stl_lo).toFixed(1)} to ${(+p.stl_hi).toFixed(1)}%)${p.exp_room_dollars ? `, about ${money(p.exp_room_dollars)}` : ""}`);
  if (p.w_below_model) rs.push(`<span style="color:#7a7870">${WATCH.below_model.label}</span>`);
  const badges = [];
  if (+p.pos_tier === 2) badges.push(`<span class="badge">point-of-sale inspection city</span>`);
  if (+p.kw_asis === 1) badges.push(`<span class="badge">listed as-is / TLC</span>`);
  return `<div class="hood value-pop"><b>On the watch list${p.watch_n_reasons > 1 ? ` — ${p.watch_n_reasons} reasons` : ""}</b>` +
    rs.map(r => `<br>${r}`).join("") + (badges.length ? `<br>${badges.join(" ")}` : "") + `</div>`;
}

/* Sidebar line on the value model: what it was fit on, how well it held
   out, and -- once scored listings have closed -- how its calls graded
   against real sales (p23). The backtest numbers are the ones that matter:
   bias_pct is what quietly invalidates the tool, since a biased model still
   looks precise. */
function modelCard(d, o) {
  const el = $("model-card");
  if (!el || (!d && !o)) return;
  d = d ?? {};
  const m = d.model ?? {}, c = d.scorecard ?? {};
  const seg = segLabel(m.segment);
  const parts = [];
  if (m.trained_on)
    parts.push(`trained on <b>${m.trained_on.toLocaleString()}</b> recent ${m.ptype === "single" ? "single-family" : (m.ptype ?? "")} sales${seg ? ` (${seg})` : ""}` +
      ` · holdout error <b>±${m.median_abs_err_pct}%</b> median, ${m.mean_abs_err_pct}% mean${m.r2_log != null ? `, R² ${(+m.r2_log).toFixed(2)}` : ""}` +
      ` · <b>${(m.scored_active ?? 0).toLocaleString()}</b> active listings scored`);
  const signed = v => v == null ? "—" : (v > 0 ? "+" : "") + (+v).toFixed(1) + "%";
  if (c.n_pairs) {
    const bias = Math.abs(c.bias_pct ?? 0) > 5 ? `<b style="color:${VALUE_OVER}">${signed(c.bias_pct)}</b>` : `<b>${signed(c.bias_pct)}</b>`;
    let g = `graded against <b>${c.n_pairs}</b> sales that closed after being priced` +
      (c.mode && c.mode.startsWith("backfill") ? " (temporal backfill)" : "") +
      `: median error <b>${c.median_err_pct}%</b>, bias ${bias}, ${c.within_10pct}% within 10%, p90 ${c.p90_err_pct}%`;
    if (c.auc_above_asking != null)
      g += ` · AUC <b>${c.auc_above_asking}</b> for picking houses that sell above asking (n=${c.auc_n}, base rate ${Math.round(100 * c.auc_base_rate)}%)`;
    if (c.signal_spread_pp != null)
      g += ` · called-cheap houses fetched ${signed(c.called_cheap_sold_vs_ask_pct)} vs asking, called-dear ${signed(c.called_dear_sold_vs_ask_pct)} (<b>${signed(c.signal_spread_pp).replace("%", " pts")}</b> spread)`;
    if (c.live_vs_holdout_ratio != null && c.live_vs_holdout_ratio > 1.5)
      g += ` · <b style="color:${VALUE_OVER}">live error ${c.live_vs_holdout_ratio}× the holdout figure — training window may have drifted from the market</b>`;
    if (c.status && c.status !== "ok") g += ` · <i>${c.status.replace("--", "—")}</i>`;
    if (c.live_log && c.live_log.n_pairs != null) g += ` · live log so far: ${c.live_log.n_pairs} pairs`;
    parts.push(g);
  } else {
    parts.push(`backtest: <i>${c.status ?? "no graded sales yet"}</i> — scored listings need weeks to close before the model's calls can be graded`);
  }
  // p26 outcome models: what happens next given the asking price
  if (o && o.sale_to_list) {
    const s = o.sale_to_list, pc = o.p_cut ?? {}, pu = o.p_contract ?? {};
    parts.push(`<b>Outcome models</b> (the "likely sale" line in popups; asking price taken as given): ` +
      `sale-vs-asking error <b>±${s.mae_model_pp} pts</b> on ${(s.n_test ?? 0).toLocaleString()} held-out sales, ` +
      `AUC <b>${s.auc_sells_above_asking}</b> for selling above asking${s.auc_dom_only != null ? ` (${s.auc_dom_only} from days-on-market alone, ${s.auc_day_one_no_timing} on day one)` : ""}` +
      (s.band_coverage_widened != null ? `, 20–80% band covers ${Math.round(100 * s.band_coverage_widened)}%` : "") +
      (pc.auc != null ? ` · price cut in ${o.horizon_days} d: AUC <b>${pc.auc}</b> (${pc.auc_dom_only} from age alone), base rate ${(100 * pc.base_rate).toFixed(0)}%, top decile ${(100 * pc.rate_in_top_decile).toFixed(0)}%` : "") +
      (pu.auc != null ? ` · under contract in ${o.horizon_days} d: AUC <b>${pu.auc}</b> (${pu.auc_dom_only} from age alone), base rate ${(100 * pu.base_rate).toFixed(0)}%, top decile ${(100 * pu.rate_in_top_decile).toFixed(0)}%` : "") +
      ` · ${(o.scored_active ?? 0).toLocaleString()} active listings scored`);
  }
  el.innerHTML = `<b>Value model</b> (drives the "Asking vs model value" overlay and the model line in listing popups): ` +
    parts.join("<br>") + (d.written ? ` <span class="dim">· scorecard ${d.written}</span>` : "");
  el.hidden = false;
}

/* JS twin of pipeline addr_key(): the join key between listings and the
   valuation layer (street suffixes and ordinals dropped). */
function addrKey(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9 ]/g, "")
    .replace(/\b(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|BOULEVARD|BLVD|COURT|CT|PLACE|PL|CIRCLE|CIR)\b/g, "")
    .replace(/\b(\d+)(ST|ND|RD|TH)\b/g, "$1").replace(/\s+/g, " ").trim();
}

/* Per-group multiplier turning AADT into the volume for the selected time:
   mean over selected hours of (day-type factor × hourly share). */
function trafficFactors() {
  const mode = $("tmode").value, when = $("ttime").value, day = $("tday").value;
  const daily = when === "day";
  const hours = when === "hour" ? [+$("thour").value] : (TTIME_HOURS[when] ?? []);
  const f = [1, 1, 1, 1, 1];
  if (!trafficProfiles) return { f, daily, hours, mode, day, hourly: false };
  for (let g = 0; g < 5; g++) {
    const pr = trafficProfiles.groups[g];
    if (!pr) continue;
    if (daily) {
      // volume: AADT itself; congestion: the busiest weekday hour
      f[g] = mode === "vc" ? pr.df_wd * pr.pk_wd : 1;
    } else {
      const shares = hours.map(h => pr[day][h]);
      f[g] = pr["df_" + day] * shares.reduce((a, b) => a + b, 0) / shares.length;
    }
  }
  return { f, daily, hours, mode, day, hourly: !daily || mode === "vc" };
}

function trafficVolumeExpr(f) {
  return ["*", ["get", "aadt"], ["match", ["get", "g"], 0, f[0], 1, f[1], 2, f[2], 3, f[3], f[4]]];
}

function applyTraffic() {
  if (!map.getLayer("traffic")) return;
  const t = trafficFactors();
  $("thour-row").hidden = $("ttime").value !== "hour";
  $("thour-val").textContent = `${$("thour").value.padStart(2, "0")}:00`;
  $("tday").disabled = t.daily;
  $("ttime").options[0].textContent = t.mode === "vc" ? "busiest hour of the day" : "daily average";
  const vol = trafficVolumeExpr(t.f);
  let color, width;
  if (t.mode === "vc") {
    const vc = ["/", vol, ["max", ["get", "cap"], 1]];
    color = ["interpolate", ["linear"], vc, ...VC_STOPS.flat()];
    width = ["interpolate", ["linear"], ["zoom"], 8, 1.4, 12, 3, 15, 6];
  } else {
    const stops = t.daily ? AADT_STOPS : VPH_STOPS;
    color = ["interpolate", ["linear"], vol, ...stops.flat()];
    const top = stops[stops.length - 1][0];
    const rel = ["min", 1, ["/", ["ln", ["max", vol, 1]], Math.log(top)]];
    width = ["interpolate", ["linear"], ["zoom"],
      8, ["+", 0.6, ["*", 2.4, rel]], 12, ["+", 1, ["*", 5, rel]], 15, ["+", 1.5, ["*", 9, rel]]];
  }
  map.setPaintProperty("traffic", "line-color", color);
  map.setPaintProperty("traffic", "line-width", width);
  legendDots();
}

function buildListingFilters() {
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
  // square footage; listings with unknown sqft are excluded when a bound is set
  if ($("sfmin").value) f.push([">=", ["coalesce", ["get", "sqft"], -1], +$("sfmin").value]);
  if ($("sfmax").value) f.push(["<=", ["coalesce", ["get", "sqft"], 9e9], +$("sfmax").value]);
  // $/sqft = price / sqft; requires both known when a bound is set
  const ppsfExpr = ["case",
    ["all", ["!=", ["coalesce", ["get", "sqft"], 0], 0], ["has", "price"]],
    ["/", ["get", "price"], ["get", "sqft"]], -1];
  if ($("ppsfmin").value) f.push([">=", ppsfExpr, +$("ppsfmin").value]);
  if ($("ppsfmax").value) f.push(["all", ["!=", ppsfExpr, -1], ["<=", ppsfExpr, +$("ppsfmax").value]]);
  const pt = $("ptype").value;
  if (pt && PTYPE_CATS[pt])
    f.push(["in", ["coalesce", ["get", "ptype"], ""], ["literal", PTYPE_CATS[pt]]]);
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
  // sold: same price/beds/baths constraints, plus the sold-within horizon
  const g = f.filter(x => { const j = JSON.stringify(x);
    return !(j.includes('"status"') || j.includes('"days_on_market"')); });
  g.push(["<=", ["coalesce", ["get", "days_since_sold"], 999], +$("soldwin").value]);
  return { listing: f, sold: g };
}

function applyListingFilter() {
  if (!map.getLayer("listings")) return;
  const { listing: f, sold: g } = buildListingFilters();
  map.setFilter("listings", f.length > 1 ? f : null);
  if (map.getLayer("sold")) map.setFilter("sold", g);
  marketInsights();
}

/* ---------- market insights ---------- */
let mktData = null;   // { listings: [{p, city, ll}], sold: [...] }, loaded once

function cityNorm(c) {
  // sources leak unit ids / hyphens / case into the city ("V4m67t Fairlawn",
  // "Mentor-on-the-lake", "Sheffield village"): strip and title-case
  if (!c) return null;
  const s = c.replace(/\b\w*\d\w*\b/g, " ").replace(/[-_]/g, " ")
             .replace(/\s+/g, " ").trim().toLowerCase();
  return s ? s.replace(/\b\w/g, ch => ch.toUpperCase()) : null;
}

// Evaluates the subset of MapLibre filter expressions buildListingFilters()
// emits, so the insights use exactly the filters the map shows.
function evalExpr(e, p) {
  if (!Array.isArray(e)) return e;
  const [op, ...a] = e;
  switch (op) {
    case "all": return a.every(x => evalExpr(x, p));
    case "get": return p[a[0]] ?? null;
    case "has": return p[a[0]] != null;
    case "literal": return a[0];
    case "coalesce":
      for (const x of a) { const v = evalExpr(x, p); if (v != null) return v; }
      return null;
    case "case":
      for (let i = 0; i + 1 < a.length; i += 2) if (evalExpr(a[i], p)) return evalExpr(a[i + 1], p);
      return evalExpr(a[a.length - 1], p);
    case "==": return evalExpr(a[0], p) === evalExpr(a[1], p);
    case "!=": return evalExpr(a[0], p) !== evalExpr(a[1], p);
    case ">=": return evalExpr(a[0], p) >= evalExpr(a[1], p);
    case "<=": return evalExpr(a[0], p) <= evalExpr(a[1], p);
    case "/": return evalExpr(a[0], p) / evalExpr(a[1], p);
    case "in": { const arr = evalExpr(a[1], p); return Array.isArray(arr) && arr.includes(evalExpr(a[0], p)); }
    default: return true;
  }
}

const median = (v) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
const money = v => v == null ? "—" : "$" + Math.round(v).toLocaleString();
const pct = (n, d) => d ? Math.round(n / d * 100) + "%" : "—";

// Grouped-bar histogram; each series is scaled to its own peak so shapes
// compare across different sample sizes. Dashed line = that series' median.
// Every bin is clickable (a transparent full-height hit strip per series)
// and lists its members below the chart via showBin().
const mktCharts = [];   // per chart: {series, bins, lo, step, tick, val}
function histSVG(series, { lo, hi, step, tick, val }) {
  const nb = Math.round((hi - lo) / step);
  const W = 288, H = 56, B = 13;
  const bw = W / nb, k = series.length, sw = (bw - 1.2) / k;
  const c = mktCharts.length;
  const bins = series.map(() => Array.from({ length: nb }, () => []));
  mktCharts.push({ series, bins, lo, step, tick, val });
  let svg = `<svg class="hist" viewBox="0 0 ${W} ${H + B}" width="100%" height="${H + B}" role="img">`;
  series.forEach((s, j) => {
    for (const it of s.items) bins[j][Math.max(0, Math.min(nb - 1, Math.floor((it.v - lo) / step)))].push(it);
    const mx = Math.max(1, ...bins[j].map(b => b.length));
    bins[j].forEach((b, i) => {
      const x = (i * bw + j * sw).toFixed(1), a = lo + i * step;
      const col = typeof s.color === "function" ? s.color(a) : s.color;
      if (b.length) {
        const h = Math.max(1, b.length / mx * (H - 3));
        svg += `<rect class="bar" x="${x}" y="${(H - h).toFixed(1)}" width="${sw.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}"/>`;
      }
      svg += `<rect class="hit" data-c="${c}" data-s="${j}" data-i="${i}" x="${x}" y="0" width="${sw.toFixed(1)}" height="${H}" fill="transparent"><title>${s.label} ${tick(a)}–${tick(a + step)}: ${b.length}${b.length ? " (click to list)" : ""}</title></rect>`;
    });
    const m = median(s.items.map(it => it.v));
    if (m != null) {
      const x = Math.max(0, Math.min(1, (m - lo) / (hi - lo))) * W;
      svg += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" stroke="${typeof s.color === "function" ? "#0b0b0b" : s.color}" stroke-width="1.2" stroke-dasharray="2 2" pointer-events="none"/>`;
    }
  });
  svg += `<line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="#c9c8c0" stroke-width="1"/>`;
  // ticks on bin edges, ~4 apart, last one at the (clamped) upper edge
  const tk = Math.ceil(nb / 4);
  for (let i = 0; i <= nb; i += tk) {
    if (i !== 0 && nb - i < tk / 2) continue;
    svg += `<text x="${(i * bw).toFixed(1)}" y="${H + B - 2}" font-size="9" fill="#898781" text-anchor="${i === 0 ? "start" : "middle"}">${tick(lo + i * step)}</text>`;
  }
  svg += `<text x="${W}" y="${H + B - 2}" font-size="9" fill="#898781" text-anchor="end">${tick(hi)}+</text>`;
  return svg + `</svg><div class="mkt-list" data-c="${c}" hidden></div>`;
}

function showBin(c, j, i) {
  const ch = mktCharts[c];
  if (!ch) return;
  const box = document.querySelector(`.mkt-list[data-c="${c}"]`);
  const svg = box.previousElementSibling;
  const items = [...ch.bins[j][i]].sort((a, b) => a.v - b.v);
  svg.querySelectorAll(".hit.sel").forEach(e => e.classList.remove("sel"));
  const same = box.dataset.sel === `${j}:${i}`;
  box.dataset.sel = same ? "" : `${j}:${i}`;
  if (same || !items.length) { box.hidden = true; return; }
  svg.querySelector(`.hit[data-s="${j}"][data-i="${i}"]`).classList.add("sel");
  const a = ch.lo + i * ch.step, top = i === ch.bins[j].length - 1 ? "+" : `–${ch.tick(a + ch.step)}`;
  const s = ch.series[j];
  const row = it => {
    const p = it.p;
    const st = p.status === "sold" ? `sold ${p.sold_date ?? ""}` : (p.status && p.status !== "active") ? p.status : "active";
    const link = p.url ? `<a href="${p.url}" target="_blank" rel="noopener">${p.address ?? "?"} ↗</a>` : (p.address ?? "?");
    return `<div class="mkt-item"><b>${ch.val(it.v)}</b> <span class="mkt-addr">${link}<small>${p.city ?? ""} · ${money(p.price)} · ${fmt(p.beds)} bd ${fmt(p.baths)} ba ${p.sqft ? (+p.sqft).toLocaleString() + " sqft" : ""} · ${st}</small></span><button class="mkt-go" data-c="${c}" data-s="${j}" data-i="${i}" data-k="${it.k}" title="show on map">⌖</button></div>`;
  };
  box.innerHTML = `<div class="mkt-list-head"><span>${s.label} ${ch.tick(a)}${top} · ${items.length} ${items.length === 1 ? "listing" : "listings"}</span><button class="mkt-close" data-c="${c}" title="close">×</button></div>` + items.map(row).join("");
  box.hidden = false;
}

function marketOutClick(ev) {
  const hit = ev.target.closest(".hit");
  if (hit) { showBin(+hit.dataset.c, +hit.dataset.s, +hit.dataset.i); return; }
  const go = ev.target.closest(".mkt-go");
  if (go) {
    const it = mktCharts[+go.dataset.c].bins[+go.dataset.s][+go.dataset.i].find(x => x.k === +go.dataset.k);
    if (!it) return;
    // turn on the layer the house lives in so the dot is there under the popup
    const ov = OVERLAYS.find(o => o.id === (it.p.status === "sold" ? "sold" : "listings"));
    if (ov && !ov.on) { ov.on = true; const cb = document.querySelectorAll("#overlays .orow input")[OVERLAYS.indexOf(ov)]; if (cb) cb.checked = true; applyOverlays(); }
    map.flyTo({ center: it.ll, zoom: Math.max(map.getZoom(), 15), duration: 900 });
    map.once("moveend", () => popupListing({ lng: it.ll[0], lat: it.ll[1] }, it.p));
    if (matchMedia("(max-width: 640px)").matches) $("panel").classList.add("hidden");
    return;
  }
  const close = ev.target.closest(".mkt-close");
  if (close) {
    const box = document.querySelector(`.mkt-list[data-c="${close.dataset.c}"]`);
    box.hidden = true; box.dataset.sel = "";
    box.previousElementSibling.querySelectorAll(".hit.sel").forEach(e => e.classList.remove("sel"));
  }
}

function buildCityOptions() {
  const counts = new Map();
  for (const r of mktData.listings) if (r.city) counts.set(r.city, (counts.get(r.city) ?? 0) + 1);
  for (const r of mktData.sold) if (r.city) counts.set(r.city, (counts.get(r.city) ?? 0) + 1);
  const sel = $("mcity");
  const cur = HASH.mcity ?? store.get("mcity", "");
  sel.innerHTML = "";
  sel.add(new Option("whole metro", ""));
  sel.add(new Option("current map view", "__view"));
  for (const c of [...counts.keys()].sort()) sel.add(new Option(`${c} (${counts.get(c)})`, c));
  sel.value = cur;
  if (sel.value !== cur) sel.value = "";
  sel.onchange = () => { store.set("mcity", sel.value); marketInsights(); };
  let t = null;
  map.on("moveend", () => { if (sel.value === "__view") { clearTimeout(t); t = setTimeout(marketInsights, 150); } });
}

async function loadMarketData() {
  try {
    const [l, s, v, w] = await Promise.all(["listings", "sold", "valuation", "watch"].map(n =>
      fetch(`tiles/${n}.geojson` + DEVQ).then(r => r.ok ? r.json() : { features: [] })));
    // houses-to-watch flags onto the listing records, so either layer's popup explains why
    if (w.features.length) {
      const key = p => addrKey(p.address) + "|" + addrKey(p.city);
      const wm = new Map(w.features.map(f => [key(f.properties), f.properties]));
      const WF = ["watch_primary", "watch_n_reasons", "w_move_fast", "w_cut_likely", "w_room", "w_below_model",
                  "exp_room_dollars", "pos_tier", "kw_asis", "exp_stl_pct", "stl_lo", "stl_hi", "exp_sale_price", "p_cut_7d", "p_contract_7d"];
      for (const f of l.features) {
        const m = wm.get(key(f.properties));
        if (m) for (const c of WF) if (m[c] != null && f.properties[c] == null) f.properties[c] = m[c];
      }
    }
    // join the model's verdict onto the listing features (popup + value mode)
    if (v.features.length) {
      const key = p => addrKey(p.address) + "|" + addrKey(p.city);
      const vm = new Map(v.features.map(f => [key(f.properties), f.properties]));
      const VF = ["pred_price", "excess_pct", "rel_discount", "local_mae_pct", "model_mae_pct", "pctile",
                  "exp_stl_pct", "stl_lo", "stl_hi", "exp_sale_price", "p_cut_7d", "p_contract_7d"];
      let n = 0;
      for (const f of l.features) {
        const m = vm.get(key(f.properties));
        if (!m || m.excess_pct == null) continue;
        for (const c of VF) if (m[c] != null) f.properties[c] = m[c];
        n++;
      }
      const p0 = v.features[0].properties;
      valMeta = { n, total: v.features.length, mae: p0.model_mae_pct, segment: p0.segment, asof: p0.asof };
      const src = map.getSource("listings");
      if (src) src.setData(l);
      if (!OVERLAYS.find(o => o.id === "traffic").on) legendDots();   // legend reads valMeta
    }
    let k = 0;
    const wrap = fc => fc.features.map(f => ({
      p: f.properties, city: cityNorm(f.properties.city), ll: f.geometry.coordinates, k: k++,
      wk: addrKey(f.properties.address) + "|" + addrKey(f.properties.city) }));
    mktData = { listings: wrap(l), sold: wrap(s) };
  } catch (e) {
    console.warn("market data", e);
    mktData = { listings: [], sold: [] };
  }
  buildCityOptions();
  $("market-out").addEventListener("click", marketOutClick);
  marketInsights();
}

function marketInsights() {
  const out = $("market-out");
  if (!mktData || !out) return;
  const city = $("mcity").value;
  const { listing: f, sold: g } = buildListingFilters();
  // status is the one listing filter ignored: the point is to see all stages
  const fl = f.filter(x => !JSON.stringify(x).includes('"status"'));
  const bounds = city === "__view" ? map.getBounds() : null;
  const inScope = r => city === "" ? true
    : city === "__view" ? bounds.contains(r.ll) : r.city === city;
  const L = mktData.listings.filter(r => inScope(r) && evalExpr(fl, r.p));
  const S = mktData.sold.filter(r => inScope(r) && evalExpr(g, r.p));
  const soldwin = +$("soldwin").value;

  const active = L.filter(r => !r.p.status || r.p.status === "active");
  const cont = L.filter(r => r.p.status === "contingent");
  const pend = L.filter(r => r.p.status === "pending");
  // items = {v, p, ll, k} so histogram bins can list and locate their members
  const pick = (rows, fn) => rows.map(r => ({ v: fn(r.p), p: r.p, ll: r.ll, k: r.k })).filter(it => it.v != null);
  const vals = items => items.map(it => it.v);
  const ppsf = rows => pick(rows, p => p.sqft > 0 && p.price / p.sqft > 10 && p.price / p.sqft < 1500 ? p.price / p.sqft : null);
  const ppsfA = ppsf(active), ppsfS = ppsf(S);
  const domA = pick(active, p => p.days_on_market);
  const domP = pick([...cont, ...pend], p => p.days_to_pending);
  const domS = pick(S, p => p.dom);
  const s2l = pick(S, p => p.sale_to_list);
  const above = s2l.filter(it => it.v > 0).length, at = s2l.filter(it => it.v === 0).length;
  const cuts = active.filter(r => r.p.price_change_pct < 0);
  // model verdicts (only listings inside the modelled segment carry one)
  const ex = pick(active, p => p.excess_pct);
  const band = p => p.local_mae_pct ?? p.model_mae_pct ?? 6;
  const exUnder = ex.filter(it => it.v < -band(it.p)).length, exOver = ex.filter(it => it.v > band(it.p)).length;
  const newWeek = active.filter(r => r.p.days_on_market != null && r.p.days_on_market <= 7).length;
  const perMonth = S.length / soldwin * 30.4;
  const supply = perMonth > 0 ? active.length / perMonth : null;

  const kv = (k, v, note = "") => `<div class="mkt-row"><span>${k}</span><b>${v}</b>${note ? `<i>${note}</i>` : ""}</div>`;
  const n = (arr) => `n=${arr.length}`;
  mktCharts.length = 0;
  if (!L.length && !S.length) { out.innerHTML = `<div class="note">nothing matches the current filters here</div>`; return; }
  let html = `<div class="mkt-grid">
    ${kv("active", active.length.toLocaleString(), newWeek ? `${newWeek} new this week` : "")}
    ${kv("contingent / pending", `${cont.length} / ${pend.length}`)}
    ${kv(`sold, last ${soldwin} d`, S.length.toLocaleString(), supply != null && active.length ? `${supply.toFixed(1)} months of supply` : "")}
    ${kv("median asking", money(median(active.map(r => r.p.price))), n(active))}
    ${kv("median sold", money(median(S.map(r => r.p.price))), n(S))}
    ${kv("asking $/sqft", money(median(vals(ppsfA))), n(ppsfA))}
    ${kv("sold $/sqft", money(median(vals(ppsfS))), n(ppsfS))}
    ${kv("days on market", domA.length ? fmt(median(vals(domA))) + " d" : "—", "active listings, median")}
    ${kv("days to pending", domP.length ? fmt(median(vals(domP))) + " d" : "—", domP.length ? `${n(domP)} observed` : "not yet observed")}
    ${kv("days to contract, sold", domS.length ? fmt(median(vals(domS))) + " d" : "—", n(domS))}
    ${kv("sale vs asking", s2l.length ? (median(vals(s2l)) > 0 ? "+" : "") + fmt(median(vals(s2l)), 1) + "%" : "—",
         s2l.length ? `${pct(above, s2l.length)} over · ${pct(at, s2l.length)} at · ${pct(s2l.length - above - at, s2l.length)} under (${n(s2l)})` : "no list prices")}
    ${kv("price cuts", active.length ? pct(cuts.length, active.length) : "—",
         cuts.length ? `median −${fmt(-median(cuts.map(r => r.p.price_change_pct)), 1)}% (seen since Aug 28)` : "of actives, seen since Aug 28")}
    ${ex.length ? kv("asking vs model, peer-adjusted", (median(vals(ex)) > 0 ? "+" : "") + fmt(median(vals(ex)), 1) + "%",
         `${pct(exUnder, ex.length)} under · ${pct(ex.length - exUnder - exOver, ex.length)} within noise · ${pct(exOver, ex.length)} over (${n(ex)} scored)`) : ""}
  </div>`;

  const chart = (title, svg) => `<div class="mkt-chart"><div class="mkt-title">${title}</div>${svg}</div>`;
  if (ppsfA.length + ppsfS.length >= 5) {
    const all = [...vals(ppsfA), ...vals(ppsfS)].sort((a, b) => a - b);
    const lo = Math.floor(quantile(all, 0.02) / 10) * 10, hi = Math.max(lo + 100, Math.ceil(quantile(all, 0.98) / 10) * 10);
    const step = Math.max(5, Math.ceil((hi - lo) / 18 / 5) * 5);
    html += chart(`price per sqft · <i style="color:${LISTING_COLOR}">asking</i> vs <i style="color:${SOLD_COLOR}">sold</i>`,
      histSVG([{ items: ppsfA, color: LISTING_COLOR, label: "asking" },
               { items: ppsfS, color: SOLD_COLOR, label: "sold" }],
              { lo, hi: lo + step * Math.ceil((hi - lo) / step), step, tick: v => "$" + Math.round(v), val: v => "$" + Math.round(v) + "/sqft" }));
  }
  if (s2l.length >= 5) {
    html += chart(`sale price vs asking · <i style="color:#006300">under</i> / <i style="color:#d03b3b">over</i>`,
      histSVG([{ items: s2l, label: "sold", color: a => a < 0 ? "#006300" : a >= 1 ? "#d03b3b" : "#898781" }],
              { lo: -16, hi: 16, step: 1, tick: v => (v > 0 ? "+" : "") + Math.round(v) + "%", val: v => (v > 0 ? "+" : "") + fmt(v, 1) + "%" }));
  }
  if (ex.length >= 5) {
    // bins coloured by the metro-wide noise band; the per-house band decides
    // the split in the row above, so the two can differ at the edges
    const mae = valMeta ? valMeta.mae : 6;
    html += chart(`asking vs model, peer-adjusted · <i style="color:${VALUE_UNDER}">under</i> / <i style="color:${VALUE_NEUTRAL}">within noise</i> / <i style="color:${VALUE_OVER}">over</i>`,
      histSVG([{ items: ex, label: "active", color: a => a + 2 <= -mae ? VALUE_UNDER : a >= mae ? VALUE_OVER : VALUE_NEUTRAL }],
              { lo: -32, hi: 32, step: 2, tick: v => (v > 0 ? "+" : "") + Math.round(v) + "%", val: v => (v > 0 ? "+" : "") + fmt(v, 1) + "%" }));
  }
  if (domA.length + domS.length >= 5) {
    html += chart(`days on market · <i style="color:${LISTING_COLOR}">active</i> vs <i style="color:${SOLD_COLOR}">sold (to contract)</i>`,
      histSVG([{ items: domA, color: LISTING_COLOR, label: "active" },
               { items: domS, color: SOLD_COLOR, label: "sold" }],
              { lo: 0, hi: 168, step: 7, tick: v => Math.round(v) + "", val: v => fmt(v) + " d" }));
  }
  if (active.length >= 5) {
    const pr = pick(active, p => p.price), prS = pick(S, p => p.price);
    const sorted = vals(pr).sort((a, b) => a - b);
    const lo = Math.floor(quantile(sorted, 0.02) / 25000) * 25000, hi = Math.ceil(quantile(sorted, 0.98) / 25000) * 25000;
    const step = Math.max(10000, Math.ceil((hi - lo) / 16 / 10000) * 10000);
    html += chart(`asking price · <i style="color:${LISTING_COLOR}">active</i> vs <i style="color:${SOLD_COLOR}">sold</i>`,
      histSVG([{ items: pr, color: LISTING_COLOR, label: "asking" },
               { items: prS, color: SOLD_COLOR, label: "sold" }],
              { lo, hi: lo + step * Math.ceil((hi - lo) / step), step, tick: v => "$" + Math.round(v / 1000) + "k", val: v => money(v) }));
  }
  out.innerHTML = html;
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

/* ---------- local tax burden ---------- */
function muniIncomeTax(income, workMuniName, homeMuni) {
  // returns {total, work, residence} municipal income tax for one earner
  const M = taxProfiles.munis;
  const home = M[homeMuni] || { rate: 0, cf: 0, cl: 0 };
  let workMuni = workMuniName;
  if (workMuniName === "") workMuni = homeMuni;        // same as home
  if (workMuniName === "__none__") workMuni = null;    // works in a township
  const work = workMuni ? (M[workMuni] || { rate: 0 }) : { rate: 0 };
  const workTax = income * (work.rate || 0);
  if (!workMuni || workMuni === homeMuni)
    return { total: Math.max(workTax, income * home.rate), work: income * home.rate, residence: 0, sameCity: true };
  // residence credits cf × min(workRate, creditLimit) against its own rate
  const credit = income * home.cf * Math.min(work.rate || 0, home.cl);
  const residenceOwed = Math.max(0, income * home.rate - credit);
  return { total: workTax + residenceOwed, work: workTax, residence: residenceOwed, sameCity: false };
}

function estimateTax(homeMuni, county, propRate, homeVal) {
  // reuses the current earner inputs; returns tax components for a residence
  const S = taxProfiles.state;
  const inc1 = +$("inc1").value || 0, inc2 = +$("inc2").value || 0;
  const combined = inc1 + inc2;
  const state = Math.max(0, combined - S.exempt) * S.rate;
  const e1 = muniIncomeTax(inc1, $("wfh1").checked ? "" : $("work1").value, homeMuni);
  const e2 = muniIncomeTax(inc2, $("wfh2").checked ? "" : $("work2").value, homeMuni);
  const muni = e1.total + e2.total;
  const prop = (homeVal || 0) * (propRate / 100);
  return { state, muni, prop, combined, income: state + muni,
           total: state + muni + prop,
           sales: taxProfiles.counties[county]?.sales };
}

function computeTax() {
  if (!taxProfiles || !taxHome) return;
  const M = taxProfiles.munis, S = taxProfiles.state;
  const inc1 = +$("inc1").value || 0, inc2 = +$("inc2").value || 0;
  const combined = inc1 + inc2;
  const homeMuni = taxHome.muni;
  const homeName = M[homeMuni] ? homeMuni : (homeMuni || "(unincorporated)");

  const state = Math.max(0, combined - S.exempt) * S.rate;
  const e1 = muniIncomeTax(inc1, $("wfh1").checked ? "" : $("work1").value, homeMuni);
  const e2 = muniIncomeTax(inc2, $("wfh2").checked ? "" : $("work2").value, homeMuni);
  const muni = e1.total + e2.total;

  const homeVal = +$("homeval").value || 0;
  const prop = homeVal * (taxHome.propRate / 100);
  const county = taxHome.county;
  const sales = taxProfiles.counties[county]?.sales;

  const totalIncomeTax = state + muni;
  const line = (l, v, cls = "") =>
    `<tr class="${cls}"><td>${l}</td><td class="num">$${Math.round(v).toLocaleString()}</td></tr>`;
  const rateNote = M[homeMuni]
    ? `${(M[homeMuni].rate * 100).toFixed(2)}% (${M[homeMuni].src})`
    : "no city income tax";
  $("tax-out").innerHTML = `
    <table class="tax-table">
      ${line("Ohio income tax (2.75%)", state)}
      ${line(`Municipal income tax`, muni)}
      <tr class="sub"><td colspan="2">home: ${homeName} — ${rateNote}${e1.sameCity && e2.sameCity ? "" : "; work-city credit applied"}</td></tr>
      ${homeVal ? line(`Property tax (${taxHome.propRate}%${taxHome.propSrc === "county-median" ? " est." : ""})`, prop) : `<tr><td>Property tax</td><td class="num">enter home value</td></tr>`}
      <tr class="tax-total"><td>Total annual tax</td><td class="num">$${Math.round(totalIncomeTax + prop).toLocaleString()}</td></tr>
      ${combined ? `<tr class="sub"><td colspan="2">effective rate on income: ${(100 * (totalIncomeTax + prop) / combined).toFixed(1)}%</td></tr>` : ""}
      <tr class="sub"><td colspan="2">${county} County sales tax: ${sales}%</td></tr>
    </table>`;
}

function bgAtPoint(lng, lat) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  for (const f of bgData.features) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) if (inRing(poly[0])) return f.properties;
  }
  return null;
}

function setTaxHome(props) {
  if (!taxProfiles || !props) return;
  taxHome = {
    muni: props.res_muni, county: props.county,
    propRate: props.prop_rate, propSrc: props.prop_src,
  };
  $("tax-home").innerHTML = `<b>Residence:</b> ${props.res_muni || "(unincorporated)"}, ${props.county} Co.`;
  computeTax();
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
  if (OVERLAYS.find(o => o.id === "watch").on) {
    for (const k of ["move_fast", "cut_likely", "room", "below_model"])
      parts.push(`<span><i style="background:${WATCH[k].color}${k === "below_model" ? ";opacity:.55" : ""}"></i>${WATCH[k].short}</span>`);
    parts.push(`<em class="legend-note">houses to watch (single-family, $250–600k): colour = most urgent reason, dark ring = two reasons · "under model" is the weakest signal, not "underpriced"</em>`);
  }
  const valueOn = OVERLAYS.find(o => o.id === "value").on && OVERLAYS.find(o => o.id === "listings").on;
  if (valueOn) {
    parts.push(`<span><i style="background:${VALUE_UNDER}"></i>asks below model, vs peers at its $/sqft</span>`,
               `<span><i style="background:${VALUE_NEUTRAL}"></i>within model noise (±${valMeta ? valMeta.mae : 6}%)</span>`,
               `<span><i style="background:${VALUE_OVER}"></i>asks above model, vs peers</span>`,
               `<span><i style="background:${VALUE_UNSCORED};opacity:.6"></i>not scored</span>`,
               `<em class="legend-note">dot grows with the gap beyond the noise band · sellers usually price in what the model can't see, so read this as "unusual price for the stats", not "bargain" · ${valMeta ? `${valMeta.n.toLocaleString()} active listings scored (${segLabel(valMeta.segment)}) · model run ${valMeta.asof}` : "model layer not loaded"}</em>`);
  } else if (OVERLAYS.find(o => o.id === "listings").on && $("lstatus").value !== "active")
    parts.push(`<span><i style="background:${LISTING_COLOR}"></i>active</span>`,
               `<span><i style="background:${PENDING_COLOR}"></i>contingent/pending</span>`);
  if (OVERLAYS.find(o => o.id === "sold").on)
    parts.push(`<span><i style="background:${SOLD_COLOR}"></i>sold</span>`);
  if (OVERLAYS.find(o => o.id === "crimetrend").on)
    parts.push(`<span><i style="background:#67b57e"></i>crime rate fell since 2000</span>`,
               `<span><i style="background:#d03b3b"></i>rose (darker/stronger = bigger change; FBI agency-reported)</span>`);
  if (OVERLAYS.find(o => o.id === "gent").on)
    parts.push(`<span><i style="background:#eb6834"></i>2000 low-income, real income rising (darker = faster)</span>`,
               `<span><i style="background:#9ec5f4"></i>2000 low-income, flat/declining</span>`);
  if (OVERLAYS.find(o => o.id === "trend").on) {
    for (const [k, c] of Object.entries(DOT_COLORS))
      parts.push(`<span><i style="background:${c}"></i>${k}</span>`);
    parts.push(`<em class="legend-note">= group with biggest share gain since 2000; darker = larger gain</em>`);
  }
  if (OVERLAYS.find(o => o.id === "speed").on) {
    for (const [, c, lab] of SPEED_BINS)
      parts.push(`<span><i class="bar" style="background:${c}"></i>${lab}</span>`);
    parts.push(`<span><i class="bar" style="background:${SPEED_UNKNOWN}"></i>not on file</span><em class="legend-note">mph · ODOT inventory, OSM-surveyed signs where mapped</em>`);
  }
  if (OVERLAYS.find(o => o.id === "traffic").on) {
    const t = trafficFactors();
    const stops = t.mode === "vc" ? VC_STOPS : t.daily ? AADT_STOPS : VPH_STOPS;
    const unit = t.mode === "vc" ? "" : t.daily ? " veh/day" : " veh/h";
    for (const [v, c] of stops)
      parts.push(`<span><i class="bar" style="background:${c}"></i>${t.mode === "vc" ? v.toFixed(2) : v.toLocaleString()}${unit}</span>`);
    parts.push(t.mode === "vc"
      ? `<em class="legend-note">volume ÷ capacity: 0.7 slowing · 0.85 heavy · ≥1 stop-and-go</em>`
      : `<em class="legend-note">${t.daily ? "annual average daily traffic (both directions)" : "estimated vehicles per hour, both directions"}</em>`);
  }
  if (OVERLAYS.find(o => o.id === "housing").on) {
    for (const k of ["ph", "pba", "lihtc"])
      parts.push(`<span><i style="background:${HOUSING_COLORS[k]}"></i>${HOUSING_LABEL[k]}</span>`);
    parts.push(`<em class="legend-note">dot size = units; one dot per building for public housing (HUD, 2025)</em>`);
  }
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

    let feats = tryLayers(["watch"]);
    if (feats.length && map.getLayoutProperty("watch", "visibility") === "visible") {
      // the listing record carries everything (photo, model lines); fall back to the layer's own fields
      const w = feats[0].properties, wk = addrKey(w.address) + "|" + addrKey(w.city);
      const l = mktData && mktData.listings.find(r => r.wk === wk);
      return popupListing(e.lngLat, l ? l.p : { ...w, status: "active", days_on_market: w.dom, source: "watch list" });
    }
    feats = tryLayers(["listings", "sold"]);
    if (feats.length) return popupListing(e.lngLat, feats[0].properties);
    feats = tryLayers(["housing"]);
    if (feats.length && map.getLayoutProperty("housing", "visibility") === "visible")
      return popupHousing(e.lngLat, feats[0].properties);
    feats = tryLayers(["stripclubs", "grocery", "amenities", "worship"]);
    if (feats.length) {
      const p = feats[0].properties;
      return new maplibregl.Popup().setLngLat(e.lngLat)
        .setHTML(`<b>${p.name ?? p.chain ?? "(unnamed)"}</b><br>${p.chain ?? p.kind ?? p.religion ?? ""} ${p.denomination ?? ""}`)
        .addTo(map);
    }
    feats = tryLayers(["traffic"]);
    if (feats.length && map.getLayoutProperty("traffic", "visibility") === "visible")
      return popupTraffic(e.lngLat, feats[0].properties);
    feats = tryLayers(["speed"]);
    if (feats.length && map.getLayoutProperty("speed", "visibility") === "visible") {
      const p = feats[0].properties;
      const cls = ["", "interstate", "freeway / expressway", "principal arterial",
                   "minor arterial", "major collector", "minor collector", "local street"][p.fc] ?? "";
      return new maplibregl.Popup().setLngLat(e.lngLat).setHTML(
        `<h3>${p.name || "(unnamed)"}</h3>` +
        (p.spd != null ? `<b>${p.spd} mph</b> <span class="popup-kv">(${p.src === "osm" ? "posted sign per OpenStreetMap" : "ODOT road inventory — statutory default on many local streets"})</span>`
                       : `<span class="popup-kv">no speed limit on file</span>`) +
        `<br><span class="popup-kv">${cls}${p.ln ? ` · ${p.ln} lanes` : ""}</span>`
      ).addTo(map);
    }
    feats = tryLayers(["crimetrend"]);
    if (feats.length && map.getLayoutProperty("crimetrend", "visibility") === "visible") {
      const p = feats[0].properties;
      return new maplibregl.Popup().setLngLat(e.lngLat).setHTML(
        `<h3>${p.NAME}</h3>crime rate (weighted, per 1k):<br>` +
        `2000: ${p.rate2000 ?? "n/a"} · 2010: ${p.rate2010 ?? "n/a"} · now: ${p.rate_now ?? "n/a"}` +
        (p.d_rate_pct != null ? `<br><b>${p.d_rate_pct > 0 ? "+" : ""}${p.d_rate_pct}% since 2000</b>` : "")
      ).addTo(map);
    }
    feats = tryLayers(["bg-fill"]);
    if (feats.length) {
      const props = bgIndex.get(feats[0].properties.GEOID);
      setTaxHome(props);
      return popupScorecard(e.lngLat, props);
    }
  });
  for (const id of ["watch", "listings", "sold", "grocery", "amenities", "worship", "housing", "traffic", "speed", "bg-fill"])
    map.on("mouseenter", id, () => map.getCanvas().style.cursor = "pointer");
}

function popupHousing(lngLat, p) {
  const kv = [];
  if (p.units != null) kv.push(`<b>${p.units} unit${p.units === 1 ? "" : "s"}</b>` +
    (p.aunits != null && p.aunits !== p.units ? ` <span class="popup-kv">(${p.aunits} subsidized/income-restricted)</span>` : ""));
  if (p.btype) kv.push(p.btype);
  if (p.prog) kv.push(p.prog);
  if (p.pop) kv.push(`for: ${p.pop.toLowerCase()}`);
  if (p.built) kv.push(`built ${p.built}`);
  if (p.eld != null || p.dis != null)
    kv.push(`residents: ${p.eld ?? "?"}% age 62+ · ${p.dis ?? "?"}% disabled`);
  if (p.rad) kv.push(`RAD conversion (${p.rad})`);
  if (p.rentassist) kv.push("some units also carry rental assistance");
  if (p.reac != null) kv.push(`last HUD REAC inspection score ${p.reac}/100`);
  if (p.expires) kv.push(`subsidy contract expires ${p.expires}`);
  if (p.status) kv.push(`<b>${p.status}</b>`);
  return new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(lngLat).setHTML(
    `<h3>${p.name || "(unnamed)"}</h3>` +
    `<span class="popup-kv" style="color:${HOUSING_COLORS[p.kind]}">${HOUSING_LABEL[p.kind]}</span><br>` +
    `<span class="popup-kv">${[p.addr, p.city].filter(Boolean).join(", ")}${p.owner ? ` · ${p.owner}` : ""}</span><br>` +
    kv.join("<br>")
  ).addTo(map);
}

function popupTraffic(lngLat, p) {
  const t = trafficFactors();
  const pr = trafficProfiles?.groups[p.g];
  const label = (trafficProfiles?.labels ?? [])[p.g] ?? "";
  const vol = Math.round(p.aadt * t.f[p.g]);
  const vc = vol / Math.max(p.cap, 1);
  const grade = vc < 0.5 ? "free-flowing" : vc < 0.7 ? "light" : vc < 0.85 ? "slowing" : vc < 1 ? "heavy" : "stop-and-go";
  const whenTxt = t.daily
    ? (t.mode === "vc" ? "busiest weekday hour" : "daily average")
    : `${$("ttime").selectedOptions[0].textContent.replace(/ · .*/, "")} on a ${t.day === "wd" ? "weekday" : "weekend day"}`;
  let spark = "";
  if (pr) {
    const day = t.daily ? "wd" : t.day;
    const hv = pr[day].map(sh => p.aadt * pr["df_" + day] * sh);
    const mx = Math.max(...hv);
    const W = 240, H = 46, bw = W / 24;
    const bars = hv.map((v, h) => {
      const sel = t.daily ? (t.mode === "vc" && v === mx) : t.hours.includes(h);
      const bh = Math.max(1, v / mx * (H - 12));
      return `<rect x="${(h * bw).toFixed(1)}" y="${(H - 10 - bh).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${sel ? "#d03b3b" : "#8db8ea"}"><title>${h}:00 — ${Math.round(v).toLocaleString()} veh/h</title></rect>`;
    }).join("");
    const ticks = [0, 6, 12, 18].map(h => `<text x="${h * bw}" y="${H - 1}" font-size="8" fill="#898781">${h}</text>`).join("");
    spark = `<svg class="spark" width="${W}" height="${H}">${bars}${ticks}</svg>` +
      `<span class="popup-kv">estimated hourly volume, ${day === "wd" ? "weekday" : "weekend"} (${label} profile)</span>`;
  }
  const trk = p.trk != null && p.aadt ? ` · ${(100 * p.trk / p.aadt).toFixed(0)}% trucks` : "";
  const html =
    `<h3>${p.name || "(unnamed road)"}</h3>` +
    `<b>${(+p.aadt).toLocaleString()} vehicles/day</b> <span class="popup-kv">(AADT ${p.yr ?? ""}${trk})</span><br>` +
    `<span class="popup-kv">${label}${p.rc ? " (inferred from volume)" : ""}${p.ln ? ` · ${p.ln} lanes` : ""} · capacity ≈ ${(+p.cap).toLocaleString()} veh/h ${p.src === "odot" ? "(ODOT model)" : "(planning default)"}</span><br>` +
    `<b>${whenTxt}:</b> ≈ ${vol.toLocaleString()} veh/h · v/c ${vc.toFixed(2)} — ${grade}` +
    (p.los ? `<br><span class="popup-kv">ODOT congestion model: LOS ${p.los}${p.pk != null ? `, peak hour ${p.pk}:00` : ""}${p.delay ? `, ${p.delay} veh-h delay/day` : ""}</span>` : "") +
    spark;
  return new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(lngLat).setHTML(html).addTo(map);
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
  const hp = bgAtPoint(lng, lat);
  if (hp) setTaxHome(bgIndex.get(hp.GEOID));
  if (!HASH.p) return;
  const url = decodeURIComponent(HASH.p);
  for (const file of ["tiles/listings.geojson?v=1790019911" + DEVQ, "tiles/sold.geojson?v=1790019911" + DEVQ]) {
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
  let taxLine = "";
  if (taxProfiles && bg && p.price) {
    const t = estimateTax(bg.res_muni, bg.county, bg.prop_rate, +p.price);
    const yr = (n) => "$" + Math.round(n).toLocaleString();
    taxLine = `<div class="hood tax-pop"><b>Est. total tax here: ${yr(t.total)}/yr</b><br>` +
      `income ${yr(t.income)} + property ${yr(t.prop)} ` +
      `(${bg.prop_rate}%${bg.prop_src === "county-median" ? " est." : ""})` +
      `${t.combined ? " · " + (100 * t.total / t.combined).toFixed(1) + "% of income" : ""}` +
      `<br><span style="font-size:10.5px">set incomes/workplaces in the Tax burden panel</span></div>`;
  }
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
    ${p.lot_sqft ? " · " + (p.lot_sqft / 43560).toFixed(2) + " ac lot" : ""} · ${p.ptype ?? ""}
    ${p.sqft && p.price ? "<br><b>$" + Math.round(p.price / p.sqft).toLocaleString() + "/sqft</b>" : ""}<br>
    built ${p.year_built ?? "—"} · ${p.status === "sold" ? fmt(p.days_since_sold) + " days ago" : fmt(p.days_on_market) + " days on market"}
    ${p.status === "sold" && p.list_price ? `<br>asked ${money(p.list_price)}${p.orig_price && p.orig_price !== p.list_price ? ` (first ${money(p.orig_price)})` : ""} · <b style="color:${p.sale_to_list > 0 ? "#d03b3b" : p.sale_to_list < 0 ? "#006300" : "#52514e"}">${p.sale_to_list > 0 ? "+" : ""}${fmt(p.sale_to_list, 1)}%</b>${p.dom != null ? ` · ${fmt(p.dom)} days to contract` : ""}` : ""}
    ${p.status !== "sold" && p.days_to_pending != null ? `<br>under contract after ${fmt(p.days_to_pending)} days` : ""}
    ${p.price_changed ? `<br><b style="color:${p.price_change_pct < 0 ? "#006300" : "#d03b3b"}">${p.price_change_pct < 0 ? "▼" : "▲"} ${Math.abs(p.price_change_pct)}%</b> on ${p.price_changed}` : ""}<br>
    <a href="${p.url}" target="_blank" rel="noopener">listing ↗ (${p.source})</a>
    &nbsp;·&nbsp; <button class="share-btn" onclick="shareListing('${shareId}')">Share ⇪</button>
    ${valueLine(p)}
    ${hood}
    ${taxLine}
  `).addTo(map);
}

/* Model verdict for the popup: asking vs the p22 hedonic estimate. Gaps
   inside the house's own noise band (local_mae_pct) are called "about
   right" rather than dressed up as a weak signal. */
function valueLine(p) {
  if (p.excess_pct == null || !p.pred_price || !p.price) return watchLine(p);
  const band = p.local_mae_pct ?? p.model_mae_pct ?? 6;
  const sp = v => (v > 0 ? "+" : "") + (+v).toFixed(1) + "%";
  // raw gap: what the seller asks vs what the model says the house sells for
  const raw = 100 * (p.price / p.pred_price - 1), gapD = p.price - p.pred_price;
  const rawCol = raw < -band ? VALUE_UNDER : raw > band ? VALUE_OVER : "#52514e";
  const head = `Model value <b>${money(p.pred_price)}</b>${p.sqft > 0 ? ` ($${Math.round(p.pred_price / p.sqft).toLocaleString()}/sqft)` : ""}` +
    ` · asking is <b style="color:${rawCol}">${sp(raw)} (${gapD < 0 ? "−" : "+"}${money(Math.abs(gapD))})</b> ${raw < 0 ? "below" : "above"} it`;
  // excess_pct is that gap re-centred on the house's $/sqft band: the model
  // under-values the dear end and over-values the cheap end, and p22 removes
  // the band median so the overlay ranks houses against their peers
  const ex = +p.excess_pct, off = raw - ex;
  const peer = ex < -band ? `<b style="color:${VALUE_UNDER}">${Math.abs(ex).toFixed(1)}% below</b> its peers`
    : ex > band ? `<b style="color:${VALUE_OVER}">${ex.toFixed(1)}% above</b> its peers`
    : `<b>${sp(ex)}</b> vs peers, inside the ±${(+band).toFixed(1)}% noise band`;
  const adj = Math.abs(off) >= 1
    ? `listings at this $/sqft typically ask ${sp(off)} vs the model, so it sits ${peer}`
    : `vs peers at this $/sqft: ${peer}`;
  const rel = p.rel_discount != null ? ` · vs its county/type/price band ${sp(p.rel_discount)}` : "";
  const rank = p.pctile != null
    ? (p.pctile <= 50 ? `cheapest ${Math.max(1, Math.round(p.pctile))}%` : `priciest ${Math.max(1, Math.round(100 - p.pctile))}%`)
      + " of scored listings by raw gap" : "";
  let outcome = watchLine(p);
  if (p.exp_stl_pct != null) {
    const col = p.exp_stl_pct < -0.5 ? VALUE_UNDER : p.exp_stl_pct > 0.5 ? VALUE_OVER : "#52514e";
    outcome += `<div class="hood value-pop">Likely sale <b>${money(p.exp_sale_price)}</b> · <b style="color:${col}">${sp(p.exp_stl_pct)}</b> vs asking` +
      (p.stl_lo != null ? ` <span class="popup-kv">(20–80% band ${sp(p.stl_lo)} to ${sp(p.stl_hi)})</span>` : "") +
      (p.p_cut_7d != null ? `<br>next 7 days: <b>${Math.round(100 * p.p_cut_7d)}%</b> chance of a price cut · <b>${Math.round(100 * p.p_contract_7d)}%</b> chance it goes under contract` : "") +
      `<br><span style="font-size:10.5px">outcome model: takes the asking price as given, ages with days on market</span></div>`;
  }
  return outcome + `<div class="hood value-pop">${head}<br>${adj}${rel}` +
    `<br><span style="font-size:10.5px">${rank ? rank + " · " : ""}hedonic model of recent sales, typical error ±${(+band).toFixed(1)}% here · sellers usually price in what the model can't see: a big gap is an unusual price for the stats, not proof of mispricing</span></div>`;
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
      ${row("Median HH income", p.income != null ? "$" + (+p.income).toLocaleString() : "—", p.s_income)}
      ${row("Racial diversity", fmt(p.diversity_race, 2), p.s_div_race)}
      ${row("Religious diversity", fmt(p.diversity_religion, 2), p.s_div_rel)}
    </table>
    <div class="score" style="margin-top:4px">
      ${fmt(p.pct_white)}% w · ${fmt(p.pct_black)}% b · ${fmt(p.pct_hispanic)}% h ·
      ${fmt(p.pct_asian)}% a · pop ${p.pop}
      ${p.inc2000r != null && p.income != null ? `<br>income (2024$): $${(+p.inc2000r).toLocaleString()} (2000) → $${(+p.income).toLocaleString()} (${p.d_income_pct > 0 ? "+" : ""}${p.d_income_pct}%)${p.gentrifying ? " · <b style=\"color:#a33305\">gentrifying</b>" : ""}` : ""}
      ${p.g_cat ? `<br>2000→2020: ${p.g_cat} +${fmt(p.g_pp, 1)}pp` +
        (() => { let w = null, wv = 0;
          for (const c of ["white","black","hispanic","asian","multi","other"]) {
            const v = p["d_" + c]; if (v != null && v < wv) { wv = v; w = c; } }
          return w ? `, ${w} ${fmt(wv, 1)}pp` : ""; })() : ""}
    </div>
  `).addTo(map);
}
