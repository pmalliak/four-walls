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
		/* Browser-injected scripts (Chrome iOS page translation, extensions)
		   report frames that point at the page URL with no line numbers.
		   Our own code always has line numbers, so drop those events. */
		onError: function (event) {
			var frames = (event.errors && event.errors[0] && event.errors[0].stacktrace) || [];
			var page = location.href.split('#')[0];
			var injected = frames.length && frames.every(function (f) {
				return !f.lineNumber && (!f.file || f.file.split('#')[0] === page);
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
