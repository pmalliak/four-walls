/* =====================================================================
   Four Walls — front-end helpers
   ===================================================================== */
(function () {
  "use strict";

  /* Current-page menu indicator -------------------------------------- *
   * Detects the page currently open and marks the matching item in the
   * main menu with the "current-page" class (pink highlight via CSS).
   * Works on every page without editing each file.                      */
  function fileFromHref(href) {
    if (!href) return "";
    // strip query/hash, take last path segment (no default — "#"/"" => "")
    var clean = href.split("#")[0].split("?")[0];
    if (!clean) return "";
    var last = (clean.split("/").pop() || "").toLowerCase();
    // Clean URLs and .html forms are the same page (/akinita ≡ akinita.html);
    // a path ending in "/" is the home page.
    if (last.slice(-5) === ".html") last = last.slice(0, -5);
    return last || (clean.charAt(clean.length - 1) === "/" ? "index" : "");
  }

  function markCurrentPage() {
    var here = fileFromHref(window.location.pathname) || "index";

    var links = document.querySelectorAll(
      ".theme-main-menu .navbar-nav .nav-link[href], " +
      ".theme-main-menu .navbar-nav .dropdown-item[href]"
    );

    var topMatch = null;

    links.forEach(function (link) {
      var target = fileFromHref(link.getAttribute("href"));
      if (!target || target === "#") return;
      if (target !== here) return;

      // Highlight the exact link (useful for items inside the mega menu)
      var li = link.closest("li");
      if (li) li.classList.add("current-page");

      // Remember the top-level <li> so the pink highlight lands on it
      var topItem = link.closest(".navbar-nav > .nav-item");
      if (topItem && !topMatch) topMatch = topItem;
    });

    if (topMatch) topMatch.classList.add("current-page");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", markCurrentPage);
  } else {
    markCurrentPage();
  }
})();

/* Hero search: swap price ranges for Αγορά / Ενοικίαση ---------------- *
 * The search form lets the visitor pick a deal type. Sale and rent use
 * very different price scales, so we rebuild the price dropdown to match
 * the chosen deal and refresh nice-select. Runs on jQuery ready so the
 * theme's niceSelect() init has already wrapped the <select>.           */
(function () {
  "use strict";
  var $ = window.jQuery;
  if (!$) return;

  var RANGES = {
    sale: [
      ["1", "Έως €100.000"],
      ["2", "€100.000-200.000"],
      ["3", "€200.000-300.000"],
      ["4", "€300.000-500.000"],
      ["5", "€500.000+"]
    ],
    buy: [
      ["1", "Έως €100.000"],
      ["2", "€100.000-200.000"],
      ["3", "€200.000-300.000"],
      ["4", "€300.000-500.000"],
      ["5", "€500.000+"]
    ],
    rent: [
      ["1", "Έως €400/μήνα"],
      ["2", "€400-600/μήνα"],
      ["3", "€600-900/μήνα"],
      ["4", "€900-1.500/μήνα"],
      ["5", "€1.500+/μήνα"]
    ]
  };

  $(function () {
    var $deal = $("#fw-deal");
    var $price = $("#fw-price");
    if (!$deal.length || !$price.length) return;

    function applyRanges(deal) {
      var rows = RANGES[deal] || RANGES.buy;
      var html = rows
        .map(function (r) {
          return '<option value="' + r[0] + '">' + r[1] + "</option>";
        })
        .join("");
      $price.html(html).niceSelect("update");
    }

    $deal.on("change", function () {
      applyRanges(this.value);
    });
    applyRanges($deal.val());
  });
})();

/* Contact form: pre-fill the message from ?msg= ----------------------- *
 * The listings page's empty-results CTA links to contact.html with the
 * visitor's search criteria encoded in the URL, so the message arrives
 * pre-written (see emptyCta() in js/listings.fw.js).                    */
(function () {
  "use strict";

  function prefillContactMessage() {
    var box = document.querySelector("#contact-form textarea[name='message']");
    if (!box || box.value) return;
    var msg = new URLSearchParams(window.location.search).get("msg");
    if (msg) box.value = msg;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", prefillContactMessage);
  } else {
    prefillContactMessage();
  }
})();

/* Featured-banner parallax -------------------------------------------- *
 * The photo collage behind «Επιλεγμένο ακίνητο του μήνα» (#fw-featured)
 * scrolls slower than the page: as the section crosses the viewport the
 * collage is translated up to ±210px (it overshoots the section by 220px
 * each way in fourwalls.css, so no edge is ever exposed). Skipped for
 * visitors who prefer reduced motion.                                   */
(function () {
  "use strict";

  var MAX_SHIFT = 210;

  function init() {
    var banner = document.getElementById("fw-featured");
    if (!banner) return;
    var collage = banner.querySelector(".fw-feat-collage");
    if (!collage) return;

    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var ticking = false;

    function update() {
      ticking = false;
      if (reduceMotion.matches) {
        collage.style.transform = "";
        return;
      }
      var rect = banner.getBoundingClientRect();
      var vh = window.innerHeight;
      if (rect.bottom < 0 || rect.top > vh) return;
      // 0 → section entering from below, 1 → section leaving at the top
      var progress = (vh - rect.top) / (vh + rect.height);
      var shift = (progress - 0.5) * 2 * MAX_SHIFT;
      collage.style.transform = "translateY(" + shift.toFixed(1) + "px)";
    }

    function requestUpdate() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate, { passive: true });
    reduceMotion.addEventListener("change", requestUpdate);
    update();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
