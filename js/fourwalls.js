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

/* Contact form: pre-fill from ?msg= and ?email= ------------------------ *
 * The listings page's empty-results CTA links to contact.html with the
 * visitor's search criteria encoded in the URL (see emptyCta() in
 * js/listings.fw.js), and the homepage valuation form submits here with
 * the visitor's email — so the form arrives pre-written.                 */
(function () {
  "use strict";

  function prefillContactMessage() {
    var params = new URLSearchParams(window.location.search);
    var box = document.querySelector("#contact-form textarea[name='message']");
    var msg = params.get("msg");
    if (box && !box.value && msg) box.value = msg;
    var email = document.querySelector("#contact-form input[name='email']");
    var addr = params.get("email");
    if (email && !email.value && addr) email.value = addr;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", prefillContactMessage);
  } else {
    prefillContactMessage();
  }
})();

/* Contact form: submit + confirmation popup ---------------------------- *
 * The theme wires #contact-form to inc/contact.php via AJAX, but PHP
 * never runs on the Cloudflare Worker host, so in production the call
 * dies silently — no email, no feedback. We unbind that handler and take
 * over: the fields POST as JSON to a Make webhook (scenario «Site -
 * Φόρμα επικοινωνίας», which emails panos@four-walls.gr), and on success
 * the .fw-popup confirmation appears. On localhost (preview server)
 * success is simulated so the popup can be seen while editing without
 * sending real emails.                                                  */
(function () {
  "use strict";
  var $ = window.jQuery;
  if (!$) return;

  var ENDPOINT = "https://hook.eu1.make.com/oh4zdr9kcp30fgvlk6x5idjjucrslagg";
  var IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  var ERROR_HTML =
    "Το μήνυμα δεν στάλθηκε — δοκιμάστε ξανά σε λίγο, ή επικοινωνήστε " +
    'μαζί μας απευθείας στο <a href="mailto:info@four-walls.gr">info@four-walls.gr</a> ' +
    'ή στο <a href="tel:+306907483463">+30 6907 483 463</a>.';

  var overlay = null;
  var lastFocus = null;

  function buildPopup() {
    var el = document.createElement("div");
    el.className = "fw-popup-overlay";
    el.innerHTML =
      '<div class="fw-popup" role="dialog" aria-modal="true" aria-labelledby="fw-popup-title">' +
        '<span class="fw-popup-check" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24"><path d="M4 12.5l5.5 5.5L20 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        "</span>" +
        '<h3 id="fw-popup-title">Το μήνυμά σας εστάλη!</h3>' +
        "<p>Σας ευχαριστούμε που επικοινωνήσατε με τη Four Walls. Θα σας απαντήσουμε το συντομότερο δυνατό.</p>" +
        '<button type="button" class="btn-nine text-uppercase rounded-3 fw-normal">Εντάξει</button>' +
      "</div>";
    el.querySelector("button").addEventListener("click", closePopup);
    el.addEventListener("click", function (e) {
      if (e.target === el) closePopup();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && el.classList.contains("is-open")) closePopup();
    });
    document.body.appendChild(el);
    return el;
  }

  function openPopup() {
    if (!overlay) overlay = buildPopup();
    lastFocus = document.activeElement;
    document.body.classList.add("fw-popup-lock");
    overlay.classList.add("is-open");
    overlay.querySelector("button").focus();
  }

  function closePopup() {
    overlay.classList.remove("is-open");
    document.body.classList.remove("fw-popup-lock");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  $(function () {
    var $form = $("#contact-form");
    if (!$form.length) return;

    // Drop the theme's contact.php handler. .off("submit") also removes
    // the validator's listener, so tear the validator down first and
    // re-init after — the inline Greek error messages keep working.
    if ($.fn.validator) $form.validator("destroy");
    $form.off("submit");
    if ($.fn.validator) $form.validator();

    $form.on("submit", function (e) {
      if (e.isDefaultPrevented()) return; // the validator found errors
      e.preventDefault();

      var form = this;
      var $btn = $form.find("button").last();
      var btnLabel = $btn.text();
      $btn.prop("disabled", true).text("Αποστολή...");

      var payload = {
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        message: form.message.value.trim(),
        page: window.location.pathname
      };

      var send = IS_LOCAL
        ? new Promise(function (resolve) {
            setTimeout(function () { resolve({ ok: true }); }, 500);
          })
        : fetch(ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

      send
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          form.reset();
          $form.find(".messages").empty();
          $btn.prop("disabled", false).text(btnLabel);
          openPopup();
        })
        .catch(function () {
          $btn.prop("disabled", false).text(btnLabel);
          $form.find(".messages").html(
            '<div class="alert alert-danger">' + ERROR_HTML + "</div>"
          );
        });
    });
  });
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
