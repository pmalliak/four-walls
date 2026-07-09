/* =====================================================================
   Four Walls — branded contact map (js/map.fw.js)

   MapLibre GL + OpenFreeMap vector tiles (free, no API key, no cookies —
   unlike the old Google iframe embed, which we could only tint with CSS
   filters). The style below is built from scratch in brand colors and
   deliberately renders NO labels except street names; the marker is the
   brand icon (images/icon/map-pin.fw.svg) and links to Google Maps for
   directions.

   Used only by contact.html (needs js/maplibre-gl.js + css/maplibre-gl.css).
   ===================================================================== */
(function () {
  "use strict";

  var PINK = "#ff0062";
  var NAVY = "#1C3457";

  /* Brand-derived map palette */
  var COLOR = {
    background: "#f9f6f7",   // near-white with a warm pink cast
    park:       "#e9eef0",   // desaturated navy-grey (no template green)
    water:      "#c5d3e2",   // light navy
    building:   "#efe7eb",
    roadMinor:  "#ffffff",
    roadMinorCase: "#e7dee3",
    roadMajor:  "#ffdce9",   // light pink fill for main streets
    roadMajorCase: "#f2bcd2",
    roadPath:   "#ffe4ee",   // pedestrian streets/paths (Φραγκίνη is one)
    rail:       "#ded3d9"
  };

  function widths(stops) {
    return ["interpolate", ["exponential", 1.6], ["zoom"]].concat(stops);
  }

  function roadFilter(classes) {
    return ["match", ["get", "class"], classes, true, false];
  }

  var MAJOR = ["motorway", "trunk", "primary", "secondary", "tertiary"];
  var MINOR = ["minor", "service", "track", "busway"];
  var PATH = ["path", "pedestrian"];

  function brandStyle() {
    return {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        openmaptiles: {
          type: "vector",
          url: "https://tiles.openfreemap.org/planet"
        }
      },
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": COLOR.background }
        },
        {
          id: "park",
          type: "fill",
          source: "openmaptiles",
          "source-layer": "park",
          paint: { "fill-color": COLOR.park, "fill-opacity": 0.8 }
        },
        {
          id: "water",
          type: "fill",
          source: "openmaptiles",
          "source-layer": "water",
          filter: ["!=", ["get", "brunnel"], "tunnel"],
          paint: { "fill-color": COLOR.water }
        },
        {
          id: "waterway",
          type: "line",
          source: "openmaptiles",
          "source-layer": "waterway",
          paint: { "line-color": COLOR.water, "line-width": 1.2 }
        },
        {
          id: "building",
          type: "fill",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 13.5,
          paint: {
            "fill-color": COLOR.building,
            "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0, 15, 0.9]
          }
        },
        {
          id: "rail",
          type: "line",
          source: "openmaptiles",
          "source-layer": "transportation",
          filter: ["==", ["get", "class"], "rail"],
          paint: {
            "line-color": COLOR.rail,
            "line-width": 1.2,
            "line-dasharray": [3, 3]
          }
        },
        {
          id: "road-minor-casing",
          type: "line",
          source: "openmaptiles",
          "source-layer": "transportation",
          minzoom: 13,
          filter: roadFilter(MINOR),
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLOR.roadMinorCase,
            "line-width": widths([13, 1.8, 16, 5.6, 18.5, 19])
          }
        },
        {
          id: "road-major-casing",
          type: "line",
          source: "openmaptiles",
          "source-layer": "transportation",
          filter: roadFilter(MAJOR),
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLOR.roadMajorCase,
            "line-width": widths([12, 2.4, 16, 8, 18.5, 26])
          }
        },
        {
          id: "road-path",
          type: "line",
          source: "openmaptiles",
          "source-layer": "transportation",
          minzoom: 14,
          filter: roadFilter(PATH),
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLOR.roadPath,
            "line-width": widths([14, 1.2, 16, 3.5, 18.5, 12])
          }
        },
        {
          id: "road-minor",
          type: "line",
          source: "openmaptiles",
          "source-layer": "transportation",
          minzoom: 13,
          filter: roadFilter(MINOR),
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLOR.roadMinor,
            "line-width": widths([13, 1, 16, 4, 18.5, 16])
          }
        },
        {
          id: "road-major",
          type: "line",
          source: "openmaptiles",
          "source-layer": "transportation",
          filter: roadFilter(MAJOR),
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": COLOR.roadMajor,
            "line-width": widths([12, 1.4, 16, 6, 18.5, 22])
          }
        },
        /* The ONLY labels on the map: street names */
        {
          id: "street-names",
          type: "symbol",
          source: "openmaptiles",
          "source-layer": "transportation_name",
          minzoom: 13,
          filter: roadFilter(MAJOR.concat(MINOR, PATH)),
          layout: {
            "symbol-placement": "line",
            "text-field": ["coalesce", ["get", "name"], ["get", "name:latin"]],
            "text-font": ["Noto Sans Regular"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 12.5, 18.5, 15],
            "text-rotation-alignment": "map"
          },
          paint: {
            "text-color": NAVY,
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.1
          }
        }
      ]
    };
  }

  function initContactMap() {
    var el = document.getElementById("fw-contact-map");
    if (!el || typeof maplibregl === "undefined") return;

    var lng = parseFloat(el.getAttribute("data-lng"));
    var lat = parseFloat(el.getAttribute("data-lat"));
    var zoom = parseFloat(el.getAttribute("data-zoom")) || 16;
    var title = el.getAttribute("data-title") || "";
    var directions = el.getAttribute("data-directions") || "";
    if (isNaN(lng) || isNaN(lat)) return;

    var fallback = el.innerHTML; // keep the "open in Google Maps" link
    el.innerHTML = "";

    var map;
    try {
      map = new maplibregl.Map({
        container: el,
        style: brandStyle(),
        center: [lng, lat],
        zoom: zoom,
        minZoom: 12,
        maxZoom: 18.5,
        cooperativeGestures: true,
        attributionControl: { compact: true },
        locale: {
          "NavigationControl.ZoomIn": "Μεγέθυνση",
          "NavigationControl.ZoomOut": "Σμίκρυνση",
          "AttributionControl.ToggleAttribution": "Εναλλαγή αναφοράς πηγής",
          "CooperativeGesturesHandler.WindowsHelpText":
            "Κρατήστε πατημένο το Ctrl και κάντε κύλιση για ζουμ στον χάρτη",
          "CooperativeGesturesHandler.MacHelpText":
            "Χρησιμοποιήστε ⌘ + κύλιση για ζουμ στον χάρτη"
        }
      });
    } catch (e) {
      // No WebGL (very old device) — put the plain link back
      el.innerHTML = fallback;
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

    /* Brand-icon pin (styled in css/fourwalls.css), links to directions */
    var pin = document.createElement(directions ? "a" : "div");
    pin.className = "fw-map-pin";
    if (directions) {
      pin.href = directions;
      pin.target = "_blank";
      pin.rel = "noopener";
    }
    if (title) pin.title = title;
    pin.innerHTML =
      '<img src="images/icon/map-pin.fw.svg" alt="' + title + '">';

    /* offset compensates for the ::after tail that pokes below the pin */
    new maplibregl.Marker({ element: pin, anchor: "bottom", offset: [0, -10] })
      .setLngLat([lng, lat])
      .addTo(map);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initContactMap);
  } else {
    initContactMap();
  }
})();
