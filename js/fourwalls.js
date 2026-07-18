/* =====================================================================
   Four Walls — front-end helpers
   ===================================================================== */
(function () {
  "use strict";

  /* Current-page menu indicator -------------------------------------- *
   * Detects the page currently open and marks the matching item in the
   * main menu with the "current-page" class (pink highlight via CSS).
   * Works on every page without editing each file.                      */
  function normPath(href) {
    if (!href) return "";
    // strip query/hash, lower-case, compare the FULL path (not just the
    // last segment) so a section stays highlighted on its sub-pages.
    var clean = href.split("#")[0].split("?")[0].toLowerCase();
    if (!clean) return "";
    if (clean.charAt(0) !== "/") clean = "/" + clean; // root-absolute
    // Clean URLs and .html forms are the same page (/services ≡ /services.html).
    if (clean.slice(-5) === ".html") clean = clean.slice(0, -5);
    // Drop a trailing slash, but keep the root as "/"; "/" and "/index" are home.
    if (clean.length > 1 && clean.slice(-1) === "/") clean = clean.slice(0, -1);
    return clean === "/index" ? "/" : clean;
  }

  function markCurrentPage() {
    // /en/ needs no special casing: EN pages carry the EN header whose links
    // are all /en/… — so /en/services/buying compares against href="/en/services"
    // exactly like the Greek pair. The language switcher lives outside
    // .navbar-nav and is never considered.
    var here = normPath(window.location.pathname) || "/";

    var links = document.querySelectorAll(
      ".theme-main-menu .navbar-nav .nav-link[href], " +
      ".theme-main-menu .navbar-nav .dropdown-item[href]"
    );

    var exactTop = null;   // top-level item whose link IS the current page
    var sectionTop = null; // top-level item whose section CONTAINS it

    links.forEach(function (link) {
      var raw = (link.getAttribute("href") || "").split("#")[0].split("?")[0];
      var target = normPath(raw);
      if (!target) return; // "#"/empty hrefs

      var exact = target === here;
      // The current page lives under this link's section (e.g. /services/buying
      // under /services). Home/root links — written with a trailing slash
      // ("/" or "/en/") — are never section parents; every path starts with
      // them, so they'd swallow the whole site (or language).
      var isRoot = target === "/" || raw.slice(-1) === "/";
      var section = !isRoot && here.indexOf(target + "/") === 0;
      if (!exact && !section) return;

      // Highlight the exact link (useful for items inside the mega menu)
      if (exact) {
        var li = link.closest("li");
        if (li) li.classList.add("current-page");
      }

      // Remember the top-level <li> so the pink highlight lands on it.
      // Prefer an exact match; fall back to a section (parent) match.
      var topItem = link.closest(".navbar-nav > .nav-item");
      if (topItem) {
        if (exact && !exactTop) exactTop = topItem;
        else if (section && !sectionTop) sectionTop = topItem;
      }
    });

    var topMatch = exactTop || sectionTop;
    if (topMatch) topMatch.classList.add("current-page");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", markCurrentPage);
  } else {
    markCurrentPage();
  }
})();

/* Language switcher: land on the SAME page in the other language ------ *
 * The header partials ship a static fallback (/ or /en/); when the page's
 * head carries hreflang alternates (all indexable pages, plus the Worker-
 * injected listing detail pages), retarget the link to the exact
 * alternate URL. Pages without alternates (404) keep the fallback.      */
(function () {
  "use strict";

  function retarget() {
    var link = document.querySelector(".fw-lang-switch");
    if (!link) return;
    var want = link.getAttribute("hreflang");
    var alt = document.querySelector('link[rel="alternate"][hreflang="' + want + '"]');
    if (alt) {
      try {
        link.href = new URL(alt.href).pathname;
        return;
      } catch (e) { /* fall through to the path-based twin below */ }
    }
    // No on-page alternate to read: for listing detail pages the twin route
    // is a pure /en/ prefix toggle, so derive it from the current path. This
    // covers the local preview server (no head injection) and the prod
    // fallback where the Worker serves a plain shell (feed unavailable) —
    // both would otherwise leave the header's static /  or /en/ home target,
    // sending the visitor to the home page instead of the same property.
    // Everything else (e.g. a 404) keeps that static fallback.
    var path = location.pathname;
    if (/^\/properties\/[^/]+$/.test(path)) {
      link.href = "/en" + path;
    } else if (/^\/en\/properties\/[^/]+$/.test(path)) {
      link.href = path.slice(3);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", retarget);
  } else {
    retarget();
  }
})();

/* Contact form: pre-fill + scroll from the arriving URL ---------------- *
 * Every contact CTA on the site carries context so the form arrives
 * pre-written and in view:
 *   ?thema=<key>  — topic keys stamped on the CTA links (service pages,
 *                   FAQ, homepage) mapped to a ready opening line in the
 *                   page's language (keys are identical on el/en pages);
 *   ?msg=<text>   — free text, wins over ?thema= (composed on the fly by
 *                   the listings empty-results CTA, the listing detail
 *                   CTA and the homepage valuation form);
 *   ?email=       — visitor's email (homepage valuation form);
 *   #contact-form — scroll to the form. Any of the params above scrolls
 *                   too, once the page has settled (sticky-menu offset
 *                   via scroll-margin-top in css/fourwalls.css).        */
(function () {
  "use strict";

  var LANG = /^en\b/i.test(document.documentElement.lang || "") ? "en" : "el";

  var TOPICS = ({
    el: {
      "agora": "Γεια σας, ενδιαφέρομαι για αγορά ακινήτου. Θα ήθελα να συζητήσουμε τι αναζητώ.",
      "polisi": "Γεια σας, ενδιαφέρομαι να πουλήσω το ακίνητό μου. Θα ήθελα να συζητήσουμε τα επόμενα βήματα.",
      "enoikiasi": "Γεια σας, αναζητώ ακίνητο για ενοικίαση. Θα ήθελα τη βοήθειά σας.",
      "ektimisi": "Γεια σας, θα ήθελα μια εκτίμηση για το ακίνητό μου.",
      "anakainisi": "Γεια σας, θα ήθελα να συζητήσουμε ένα έργο ανακαίνισης.",
      "anakainisi-meriki": "Γεια σας, θα ήθελα προσφορά για μερική ανακαίνιση (π.χ. κουζίνα, μπάνιο, δάπεδα, χρώματα).",
      "anakainisi-oliki": "Γεια σας, θα ήθελα προσφορά για ολική ανακαίνιση.",
      "anakainisi-energeiaki": "Γεια σας, θα ήθελα προσφορά για ενεργειακή αναβάθμιση (κουφώματα, θέρμανση, μόνωση).",
      "diaxeirisi": "Γεια σας, θα ήθελα μια πρόταση για τη διαχείριση του ακινήτου μου.",
      "klisi": "Γεια σας, θα ήθελα να με καλέσετε στο τηλέφωνο που σημειώνω στη φόρμα.",
      "erotisi": "Γεια σας, θα ήθελα να ρωτήσω το εξής: "
    },
    en: {
      "agora": "Hello, I am interested in buying a property. I would like to discuss what I am looking for.",
      "polisi": "Hello, I am interested in selling my property. I would like to discuss the next steps.",
      "enoikiasi": "Hello, I am looking for a property to rent. I would appreciate your help.",
      "ektimisi": "Hello, I would like a valuation of my property.",
      "anakainisi": "Hello, I would like to discuss a renovation project.",
      "anakainisi-meriki": "Hello, I would like a quote for a partial renovation (e.g. kitchen, bathroom, floors, painting).",
      "anakainisi-oliki": "Hello, I would like a quote for a full renovation.",
      "anakainisi-energeiaki": "Hello, I would like a quote for an energy upgrade (windows, heating, insulation).",
      "diaxeirisi": "Hello, I would like a proposal for the management of my property.",
      "klisi": "Hello, I would like you to call me on the phone number I have entered in the form.",
      "erotisi": "Hello, I would like to ask the following: "
    }
  })[LANG];

  function prefillContactMessage() {
    var form = document.getElementById("contact-form");
    if (!form) return;
    var params = new URLSearchParams(window.location.search);

    var box = form.querySelector("textarea[name='message']");
    var msg = params.get("msg") || TOPICS[params.get("thema")] || "";
    if (box && !box.value && msg) box.value = msg;
    var email = form.querySelector("input[name='email']");
    var addr = params.get("email");
    if (email && !email.value && addr) email.value = addr;

    /* Scroll the form into view. The browser's own #contact-form jump
       fires before the lazy images above the form claim their height,
       so we correct after window load, when the layout has settled.    */
    if (window.location.hash !== "#contact-form" && !msg && !addr) return;
    var behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto" : "smooth";
    function scrollToForm() {
      setTimeout(function () {
        form.scrollIntoView({ behavior: behavior, block: "start" });
      }, 150);
    }
    if (document.readyState === "complete") scrollToForm();
    else window.addEventListener("load", scrollToForm);
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
 * over: the fields POST as JSON to the Worker's /api/contact, which
 * verifies the Cloudflare Turnstile token server-side and only then
 * relays to the Make webhook (scenario «Site - Φόρμα επικοινωνίας» →
 * email). The webhook URL is a Worker secret — never in this file. On
 * success the .fw-popup confirmation appears. On localhost (preview
 * server, no Worker) success is simulated so the popup can be seen
 * while editing without sending real emails.                           */
(function () {
  "use strict";
  var $ = window.jQuery;
  if (!$) return;

  var ENDPOINT = "/api/contact";
  var IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  var LANG = /^en\b/i.test(document.documentElement.lang || "") ? "en" : "el";
  var STR = ({
    el: {
      errorHtml:
        "Το μήνυμα δεν στάλθηκε — δοκιμάστε ξανά σε λίγο, ή επικοινωνήστε " +
        'μαζί μας απευθείας στο <a href="mailto:info@four-walls.gr">info@four-walls.gr</a> ' +
        'ή στο <a href="tel:+306907483463">+30 6907 483 463</a>.',
      turnstile:
        "Περιμένετε να ολοκληρωθεί ο έλεγχος ασφαλείας (το πλαίσιο πάνω από " +
        "το κουμπί) και πατήστε ξανά «Αποστολή».",
      popupTitle: "Το μήνυμά σας εστάλη!",
      popupBody: "Σας ευχαριστούμε που επικοινωνήσατε με τη Four Walls. Θα σας απαντήσουμε το συντομότερο δυνατό.",
      popupBtn: "Εντάξει",
      sending: "Αποστολή..."
    },
    en: {
      errorHtml:
        "Your message could not be sent — please try again shortly, or contact " +
        'us directly at <a href="mailto:info@four-walls.gr">info@four-walls.gr</a> ' +
        'or <a href="tel:+306907483463">+30 6907 483 463</a>.',
      turnstile:
        "Please wait for the security check to complete (the box above " +
        "the button) and press “Send” again.",
      popupTitle: "Your message has been sent!",
      popupBody: "Thank you for contacting Four Walls. We will get back to you as soon as possible.",
      popupBtn: "OK",
      sending: "Sending..."
    }
  })[LANG];
  var ERROR_HTML = STR.errorHtml;
  var TURNSTILE_MSG = STR.turnstile;

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
        '<h3 id="fw-popup-title"></h3>' +
        "<p></p>" +
        '<button type="button" class="btn-nine text-uppercase rounded-3 fw-normal"></button>' +
      "</div>";
    el.querySelector("h3").textContent = STR.popupTitle;
    el.querySelector("p").textContent = STR.popupBody;
    el.querySelector("button").textContent = STR.popupBtn;
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

      // Turnstile injects a hidden input with the proof-of-humanity
      // token once the (usually invisible) check completes.
      var tokenField = form.querySelector('input[name="cf-turnstile-response"]');
      var token = tokenField ? tokenField.value : "";
      if (!token && !IS_LOCAL) {
        $form.find(".messages").html(
          '<div class="alert alert-danger">' + TURNSTILE_MSG + "</div>"
        );
        return;
      }

      $btn.prop("disabled", true).text(STR.sending);

      var payload = {
        name: (form.name.value.trim() + " " + form.lastname.value.trim()).trim(),
        email: form.email.value.trim(),
        phone: form.phone ? form.phone.value.trim() : "",
        message: form.message.value.trim(),
        page: window.location.pathname,
        token: token,
        website: form.website ? form.website.value : ""
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
          // Tokens are single-use — rearm the widget for a second message.
          if (window.turnstile) window.turnstile.reset();
          $form.find(".messages").empty();
          $btn.prop("disabled", false).text(btnLabel);
          openPopup();
        })
        .catch(function () {
          if (window.turnstile) window.turnstile.reset();
          $btn.prop("disabled", false).text(btnLabel);
          $form.find(".messages").html(
            '<div class="alert alert-danger">' + ERROR_HTML + "</div>"
          );
        });
    });
  });
})();

/* Snappy scroll-to-top ------------------------------------------------ *
 * Bootstrap sets `:root { scroll-behavior: smooth }`, so every programmatic
 * scrollTop write (the theme's jQuery $.animate, and any scrollTo) gets
 * RE-smoothed by the browser with its own ease-in-out curve. That native
 * curve starts at near-zero speed — the page holds still for a beat before
 * it moves — and it overrides both CSS transitions and jQuery easing, which
 * is why neither touched it. Fix: drop the theme handler, temporarily switch
 * the root to `scroll-behavior: auto` so our per-frame writes land instantly,
 * and drive the scroll ourselves with an ease-OUT curve (full speed at the
 * start, decelerating into place). Honors prefers-reduced-motion.         */
(function () {
  "use strict";
  var btn = document.querySelector(".scroll-top");
  if (!btn) return;

  // Remove the theme's jQuery click handler (js/theme.js) so it can't also
  // fire and re-trigger the smooth-scrolled $.animate.
  if (window.jQuery) window.jQuery(btn).off("click");

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function prefersReduced() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  btn.addEventListener("click", function (e) {
    e.preventDefault();
    var root = document.documentElement;
    var startY = window.pageYOffset || root.scrollTop || 0;
    if (startY <= 0) return;

    if (prefersReduced()) {
      window.scrollTo(0, 0);
      return;
    }

    // Inline `auto` overrides the :root smooth rule for the duration of our
    // animation, so window.scrollTo(0, y) below is an instant jump each frame
    // and OUR easing controls the motion. Restored when we finish.
    var prevBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";

    var duration = 280;
    var start = null;
    function step(now) {
      if (start === null) start = now;
      var t = Math.min((now - start) / duration, 1);
      window.scrollTo(0, Math.round(startY * (1 - easeOutCubic(t))));
      if (t < 1) {
        window.requestAnimationFrame(step);
      } else {
        root.style.scrollBehavior = prevBehavior;
      }
    }
    window.requestAnimationFrame(step);
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
