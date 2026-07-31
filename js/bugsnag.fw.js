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
		metadata: {
			page: {
				path: location.pathname,
				lang: document.documentElement.lang || ''
			}
		}
	});
})();
