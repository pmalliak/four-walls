/* =====================================================================
   Four Walls — Bugsnag error monitoring (marketing site)
   ---------------------------------------------------------------------
   Loads right after the self-hosted js/bugsnag.min.js (both stamped
   into every page via partials/header*.html). Reports only from the
   production hostnames; localhost / preview stay silent.
   Project: "four walls site" (the API key is public by design).
   ===================================================================== */
'use strict';
(function () {
	if (!window.Bugsnag) return;
	var prod = /(^|\.)four-walls\.gr$/.test(location.hostname);
	Bugsnag.start({
		apiKey: 'c3df8735e51f09e3ff7975d08c7a8c71',
		releaseStage: prod ? 'production' : 'development',
		enabledReleaseStages: ['production'],
		collectUserIp: false,
		/* The site has no inline scripts: all our code lives in /js/*.js.
		   A stack whose every frame points at the page itself therefore comes
		   from a script the browser injects (Chrome iOS translation, password
		   and autofill helpers, extensions), so drop it. Adding an inline
		   <script> to a page means revisiting this filter. */
		onError: function (event) {
			var frames = (event.errors && event.errors[0] && event.errors[0].stacktrace) || [];
			var bare = function (u) { return String(u || '').split(/[?#]/)[0]; };
			var page = bare(location.href);
			var injected = frames.length && frames.every(function (f) {
				return !f.file || bare(f.file) === page;
			});
			if (injected) return false;
		},
		metadata: {
			page: {
				path: location.pathname,
				lang: document.documentElement.lang || ''
			}
		}
	});
})();
