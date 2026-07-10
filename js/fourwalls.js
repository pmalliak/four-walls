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
    return (clean.split("/").pop() || "").toLowerCase();
  }

  function markCurrentPage() {
    var here = fileFromHref(window.location.pathname) || "index.html";

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
