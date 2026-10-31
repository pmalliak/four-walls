'use strict';
import { buildSocialDesign } from '/social-design.mjs';
const $ = id => document.getElementById(id);
const { Modal, Carousel } = window.bootstrap;
const dialogTriggers = new Map();
function showDialog(id, trigger = document.activeElement) {
	dialogTriggers.set(id, trigger);
	Modal.getOrCreateInstance($(id)).show();
}
function hideDialog(id) { Modal.getOrCreateInstance($(id)).hide(); }
for (const id of ['property-dialog', 'design-dialog', 'image-viewer']) {
	$(id).addEventListener('hidden.bs.modal', () => { const trigger = dialogTriggers.get(id); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
}
$('property-dialog').addEventListener('shown.bs.modal', () => $('property-search').focus());
const labels = { draft: 'Πρόχειρο', pending: 'Προς έγκριση', approved: 'Εγκεκριμένο', scheduled: 'Προγραμματισμένο', publishing: 'Σε δημοσίευση', published: 'Δημοσιευμένο', blocked: 'Χρειάζεται ενημέρωση', needs_review: 'Έλεγχος στο Meta', cancelled: 'Ακυρωμένο' };
const channels = { instagram: 'Instagram', facebook: 'Facebook Page', marketplace: 'Marketplace' };
const eventLabels = { edited: 'Αποθηκεύτηκαν αλλαγές', submitted: 'Δημιουργήθηκαν εικόνες για έγκριση', claimed: 'Έναρξη δημοσίευσης', property_observed: 'Έλεγχος CRM', marketplace_exported: 'Λήψη πακέτου Marketplace', meta_created: 'Δημιουργία μέσου Meta', publication_requested: 'Αποστολή δημοσίευσης', manually_resolved: 'Χειροκίνητη επιβεβαίωση' };
const errors = {
	platform_history_must_be_preserved: 'Η δημιουργία συνδέεται με ανάρτηση Meta. Το ιστορικό της διατηρείται. Χρησιμοποιήστε τη διαγραφή από το Facebook ή την ακύρωση του τοπικού προσχεδίου.',
	platform_action_needs_review: 'Το αποτέλεσμα προηγούμενης ενέργειας χρειάζεται έλεγχο στο Meta. Δεν θα επαναληφθεί αυτόματα. Η ανανέωση μπορεί να επιβεβαιώσει μια αλλαγή κειμένου.',
	meta_permission_or_token_required: 'Χρειάζεται ανανέωση της σύνδεσης ή πρόσθετη άδεια στο Meta.',
	meta_request_rejected: 'Το Meta δεν επέτρεψε την ενέργεια. Ελέγξτε την ανάρτηση και τα δικαιώματα στο Meta.',
	meta_owner_mismatch: 'Η ανάρτηση δεν ανήκει στον συνδεδεμένο λογαριασμό.',
	meta_draft_was_published: 'Το πρόχειρο έχει δημοσιευτεί μέσα από το Meta. Διαχειριστείτε το εκεί.',
	platform_statistics_unavailable: 'Δεν υπάρχουν στατιστικά κοινού για αυτή τη δοκιμή ή τη διαγραμμένη ανάρτηση.',
	meta_test_already_attempted: 'Έγινε ήδη προσπάθεια δοκιμής αυτής της έκδοσης. Δείτε το ιστορικό πριν ετοιμάσετε νέα έκδοση.',
	meta_not_configured: 'Η σύνδεση με το Meta δεν είναι έτοιμη.',
	social_database_not_configured: 'Η βάση δημοσιεύσεων δεν έχει ρυθμιστεί ακόμη.',
	feed_missing_or_stale: 'Ο συγχρονισμός ακινήτων δεν είναι πρόσφατος. Δοκιμάστε μετά τον επόμενο συγχρονισμό.',
	photo_sources_pending_sync: 'Αναμένεται ο συγχρονισμός των πρωτότυπων φωτογραφιών από το EstatePrime. Δοκιμάστε ξανά μετά τον επόμενο συγχρονισμό.',
	revision_conflict_reload: 'Η δημοσίευση άλλαξε σε άλλη συνεδρία. Κλείστε τις τοπικές αλλαγές και πατήστε Ανανέωση.',
	property_unavailable: 'Το ακίνητο δεν είναι διαθέσιμο ή δεν έχει διαθέσιμες πρωτότυπες φωτογραφίες.',
	property_changed_reapprove: 'Τα στοιχεία ή οι φωτογραφίες άλλαξαν στο CRM. Αποθηκεύστε ξανά, δημιουργήστε νέες εικόνες και ζητήστε έγκριση.',
	property_changed_save_again: 'Τα στοιχεία ή οι φωτογραφίες άλλαξαν. Πατήστε Ανανέωση, ελέγξτε τις επιλογές σας και αποθηκεύστε ξανά.',
	select_1_to_10_photos: 'Επιλέξτε τουλάχιστον μία φωτογραφία. Το σύνολο μαζί με τις πρόσθετες κάρτες δεν μπορεί να ξεπερνά τις 10 εικόνες.',
	invalid_photo_selection: 'Κάποια επιλεγμένη φωτογραφία δεν είναι πλέον διαθέσιμη ως πρωτότυπη. Ανανεώστε και επιλέξτε ξανά φωτογραφίες.',
	clean_photos_confirmation_required: 'Ελέγξτε ότι οι επιλεγμένες φωτογραφίες δεν έχουν υδατογράφημα, επιβεβαιώστε το σχετικό πεδίο και αποθηκεύστε ξανά.',
	too_many_slides: 'Το σύνολο ξεπερνά τις 10 εικόνες. Αφαιρέστε φωτογραφίες ή απενεργοποιήστε μία πρόσθετη κάρτα.',
	carousel_1_to_10_slides: 'Το σύνολο ξεπερνά τις 10 εικόνες. Αφαιρέστε φωτογραφίες ή απενεργοποιήστε μία πρόσθετη κάρτα.',
	carousel_max_10_slides: 'Το σύνολο ξεπερνά τις 10 εικόνες. Αφαιρέστε φωτογραφίες ή απενεργοποιήστε μία πρόσθετη κάρτα.',
	invalid_creative: 'Επιλέξτε ένα διαθέσιμο πρότυπο εμφάνισης.',
	image_storage_not_configured: 'Η υπηρεσία εικόνων δεν έχει ρυθμιστεί.',
	photo_fetch_failed: 'Δεν ήταν δυνατή η λήψη μιας πρωτότυπης φωτογραφίας. Δοκιμάστε ξανά ή επιλέξτε άλλη φωτογραφία.',
	approver_required: 'Απαιτείται εξουσιοδοτημένος υπεύθυνος έγκρισης.',
	post_not_deletable: 'Η δημιουργία δεν μπορεί να διαγραφεί επειδή έχει δημοσιευτεί ή εκκρεμεί το αποτέλεσμα δημοσίευσης.',
	future_utc_time_required: 'Επιλέξτε μελλοντική ημερομηνία και ώρα.',
	Unauthorized: 'Η σύνδεση έληξε. Ανανεώστε τη σελίδα.',
	social_operation_failed: 'Η ενέργεια απέτυχε. Οι αλλαγές δεν επιβεβαιώθηκαν· ανανεώστε πριν δοκιμάσετε ξανά.'
};
const presets = [
	{ id: 'editorial', number: '01', name: 'Editorial', description: 'Μεγάλη φωτογραφία, καθαρή τυπογραφία και έντονα στοιχεία.' },
	{ id: 'architectural', number: '02', name: 'Architectural', description: 'Αρχιτεκτονικές γραμμές, καμπύλα πλαίσια και κάθετο λογότυπο.' },
	{ id: 'neighbourhood', number: '03', name: 'Neighbourhood', description: 'Θερμό φόντο και διακοσμητική εικονογράφηση γειτονιάς.' }
];
const classic = { preset: 'classic', version: 1, includeFacts: false, includeCta: false };
Object.assign(eventLabels, {
	meta_test_started: 'Έναρξη δοκιμής χωρίς δημοσίευση', meta_test_object: 'Δοκιμαστικό μέσο Meta',
	meta_test_failed: 'Η δοκιμή δεν ολοκληρώθηκε — ελέγξτε τα αναγνωριστικά',
	instagram_container_ready: 'Instagram: εικόνες έτοιμες, χωρίς δημοσίευση ή πρόχειρο στην εφαρμογή',
	facebook_draft_verified: 'Facebook: επιβεβαιωμένο αδημοσίευτο πρόχειρο'
});
let bootstrap, posts = [], active, selected = [], dirty = false, busy = false;
let creative = { ...classic }, starterPreset = 'architectural', photosConfirmedClean = false, lastInsertedLink = '', lastInsertedLabel = '';
let platformItems = [];
const editable = () => active && ['draft', 'pending', 'approved', 'scheduled', 'blocked'].includes(active.status);
const deletable = () => active && (editable() || active.status === 'cancelled') && !active.remote_id;
const propertyTitle = p => p?.title?.trim() ? p.title : `Ακίνητο${p?.area ? ` ${p.area} τ.μ.` : ''}${p?.location?.area || p?.location?.city ? `, ${p.location.area || p.location.city}` : ''}`;
const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; if (tag === 'button') n.classList.add('btn', className?.includes('primary') ? 'btn-primary' : 'btn-outline-secondary'); if (tag === 'textarea') n.classList.add('form-control'); return n; };
const selectedProperty = () => bootstrap?.feed.listings.find(p => p.id === $('property').value);
const currentProperty = () => bootstrap?.feed.listings.find(p => p.id === active?.property_id);
const extraSlides = () => Number(creative.includeFacts) + Number(creative.includeCta);
const totalSlides = () => selected.length + extraSlides();
const validSelection = () => selected.length > 0 && totalSlides() <= 10;
const priceLabel = p => p?.price == null ? 'Τιμή κατόπιν επικοινωνίας' : `€${Number(p.price).toLocaleString('el-GR')}${p.transaction === 'rent' ? '/μήνα' : ''}`;

function apiError(data) {
	const message = errors[data.error] || `Η ενέργεια δεν ολοκληρώθηκε (${data.error}).`;
	return new Error(message + (data.errorId ? ` Κωδικός σφάλματος: ${data.errorId}` : ''));
}
async function api(path, method = 'GET', body) {
	const response = await fetch(`/api/social${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
	const data = await response.json().catch(() => ({ error: 'Unauthorized' }));
	if (!response.ok) throw apiError(data);
	return data;
}
let messageTimer;
function message(text, kind = 'error') {
	clearTimeout(messageTimer);
	$('message').hidden = !text;
	$('message').dataset.kind = kind;
	$('message-text').textContent = text;
	$('dismiss-message').hidden = kind === 'pending';
	if (text && kind === 'success') messageTimer = setTimeout(() => { $('message').hidden = true; }, 5000);
}
$('dismiss-message').onclick = () => { clearTimeout(messageTimer); $('message').hidden = true; };
async function task(work, pending = 'Φόρτωση…', success = '') {
	if (busy) return;
	busy = true; message(pending, 'pending'); controls();
	try { await work(); message(success, 'success'); }
	catch (e) { message(e.message, 'error'); }
	finally { busy = false; controls(); }
}
function stepState() {
	let step = selectedProperty() ? 2 : 1;
	if (active) step = ['draft', 'blocked'].includes(active.status) || dirty ? 2 : active.status === 'pending' ? 3 : 4;
	document.querySelectorAll('.steps li').forEach(item => {
		const n = Number(item.dataset.step);
		item.classList.toggle('complete', n < step);
		if (n === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
	});
}
function nextStep() {
	if (!active) return;
	let title, detail;
	if (dirty) {
		title = 'Αποθηκεύστε τις αλλαγές σας';
		detail = 'Αποθηκεύστε και πατήστε «Δημιουργία εικόνων για έλεγχο». Θα χρειαστεί νέα έγκριση.';
		if (!selected.length) detail = 'Επιλέξτε τουλάχιστον μία πρωτότυπη φωτογραφία για να αποθηκεύσετε το προσχέδιο.';
		else if (totalSlides() > 10) detail = errors.too_many_slides;
		else if (!photosConfirmedClean) detail = 'Ελέγξτε ότι οι φωτογραφίες δεν έχουν υδατογράφημα και επιβεβαιώστε το πεδίο κάτω από τις φωτογραφίες πριν δημιουργήσετε εικόνες.';
	} else {
		const states = {
			draft: ['Ελέγξτε σχέδιο, φωτογραφίες και λεζάντα', 'Όταν είστε έτοιμοι, πατήστε «Δημιουργία εικόνων για έλεγχο». Δεν γίνεται δημοσίευση.'],
			pending: ['Ελέγξτε τις τελικές εικόνες', bootstrap?.canApprove ? 'Οι τελικές εικόνες εμφανίζονται παρακάτω. Επιβεβαιώστε ότι τις ελέγξατε και εγκρίνετε αυτή την έκδοση.' : 'Οι εικόνες είναι έτοιμες. Ένας υπεύθυνος έγκρισης πρέπει να ελέγξει και να εγκρίνει τη δημοσίευση.'],
			approved: ['Το περιεχόμενο έχει εγκριθεί', active.channel === 'marketplace' ? 'Κατεβάστε το πακέτο και καταχωρίστε το χειροκίνητα στο Marketplace.' : 'Επιλέξτε ημερομηνία και ώρα στο πεδίο προγραμματισμού παρακάτω.'],
			scheduled: ['Η δημοσίευση έχει προγραμματιστεί', bootstrap?.live ? 'Θα αποσταλεί στον επόμενο έλεγχο μετά την επιλεγμένη ώρα, εφόσον το ακίνητο παραμένει διαθέσιμο.' : 'Η αποστολή στο Meta είναι απενεργοποιημένη. Το περιεχόμενο θα παραμείνει σε αναμονή.'],
			blocked: ['Ελέγξτε τα ενημερωμένα στοιχεία', 'Το ακίνητο ή οι φωτογραφίες του άλλαξαν. Ελέγξτε τις επιλογές σας και αποθηκεύστε ξανά.'],
			publishing: ['Γίνεται αποστολή στο Meta', 'Περιμένετε να ολοκληρωθεί η αποστολή. Μην δημιουργήσετε δεύτερη ίδια δημοσίευση.'],
			published: ['Η δημοσίευση ολοκληρώθηκε', 'Οι εικόνες και η λεζάντα διατηρούνται στο ιστορικό αυτής της έκδοσης.'],
			cancelled: ['Η δημοσίευση ακυρώθηκε', 'Δεν θα αποσταλεί. Μπορείτε να ξεκινήσετε νέο προσχέδιο από την επιλογή ακινήτου.'],
			needs_review: ['Ελέγξτε το αποτέλεσμα στον λογαριασμό Meta', 'Η αποστολή δεν θα επαναληφθεί αυτόματα. Υπεύθυνος έγκρισης πρέπει να επιβεβαιώσει το αποτέλεσμα παρακάτω.']
		};
		[title, detail] = states[active.status] || ['Ελέγξτε την κατάσταση', 'Πατήστε Ανανέωση για την τελευταία ενημέρωση.'];
		if (active.status === 'draft' && !photosConfirmedClean) { title = 'Ελέγξτε τις επιλεγμένες φωτογραφίες'; detail = 'Βεβαιωθείτε ότι δεν έχουν υδατογράφημα ή λογότυπο, επιλέξτε το σχετικό πεδίο κάτω από τις φωτογραφίες και αποθηκεύστε.'; }
	}
	$('next-step').replaceChildren(el('strong', title), el('span', detail));
}
function controls() {
	document.querySelectorAll('button').forEach(b => { b.disabled = busy; });
	for (const id of ['property-search', 'property', 'new-channel', 'filter']) $(id).disabled = busy;
	$('choose-property').disabled = busy || !!active; $('new-channel').disabled = busy || !!active;
	$('create').disabled = busy || !selectedProperty();
	$('new-draft').hidden = !active;
	document.querySelectorAll('#starter-presets button').forEach(b => { b.disabled = busy; });
	stepState();
	if (!active) return;
	const canEdit = editable();
	for (const id of ['caption', 'template']) $(id).disabled = !canEdit || busy;
	$('destination').disabled = !canEdit || busy;
	$('copy-link').disabled = busy || !websiteLink(); $('add-link').disabled = busy || !canEdit || !websiteLink();
	for (const id of ['include-facts', 'include-cta']) $(id).disabled = !canEdit || busy || creative.preset === 'classic';
	document.querySelectorAll('#presets .preset,.photo').forEach(b => { b.disabled = busy || !canEdit; });
	document.querySelectorAll('.order-controls button').forEach(b => { b.disabled = busy || !canEdit || b.dataset.unavailable === 'true'; });
	$('save').hidden = !canEdit; $('save').disabled = busy || !dirty || !validSelection();
	$('submit').hidden = active.status !== 'draft'; $('submit').disabled = busy || dirty || !validSelection() || !photosConfirmedClean;
	$('clean-photos-confirm').disabled = busy || !canEdit || !selected.length;
	const canApprove = active.status === 'pending' && bootstrap?.canApprove;
	$('approve').hidden = !canApprove; $('approve').disabled = busy || dirty || !$('review-confirm').checked;
	$('review-label').hidden = !canApprove; $('review-confirm').disabled = busy || dirty;
	$('cancel').hidden = !canEdit;
	$('delete').hidden = !deletable();
	$('scheduling').hidden = active.status !== 'approved' || active.channel === 'marketplace'; $('schedule').disabled = busy || dirty;
	$('schedule-time').disabled = busy || dirty;
	$('meta-test').hidden = !['draft', 'pending', 'approved'].includes(active.status) || active.channel === 'marketplace' || !bootstrap?.canApprove;
	$('test').disabled = busy || dirty || !bootstrap?.canTest;
	$('marketplace-export').hidden = active.status !== 'approved' || active.channel !== 'marketplace'; $('package').disabled = busy || dirty;
	$('resolution').hidden = active.status !== 'needs_review' || !bootstrap?.canApprove;
	$('remote-id').disabled = busy;
	for (const control of document.querySelectorAll('#platform-targets button,#platform-targets textarea')) control.disabled = busy || dirty || control.dataset.locked === 'true';
	$('preview-stale').hidden = !dirty;
	$('close-editor').textContent = dirty ? 'Κλείσιμο χωρίς αποθήκευση' : 'Κλείσιμο';
	$('count').textContent = `${$('caption').value.length} / 2200${dirty ? ' · Μη αποθηκευμένες αλλαγές' : ' · Αποθηκευμένο κείμενο'}`;
	$('photo-count').textContent = `${selected.length} ${selected.length === 1 ? 'φωτογραφία' : 'φωτογραφίες'} · έως ${10 - extraSlides()}`;
	$('slide-count').textContent = `${totalSlides()} / 10 εικόνες`;
	$('slide-count').classList.toggle('over-limit', totalSlides() > 10);
	$('action-help').textContent = dirty ? 'Η αποθήκευση ενημερώνει το προσχέδιο. Δεν δημιουργεί εικόνες και δεν δημοσιεύει.' : active.status === 'draft' ? 'Η δημιουργία εικόνων αποθηκεύει μια έκδοση για έλεγχο. Η αποστολή στο Meta απαιτεί έγκριση και προγραμματισμό.' : '';
	nextStep();
}
function imageElement(url, className, alt = '') {
	const img = el('img', null, className); img.src = url; img.alt = alt; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
	img.onerror = () => { img.hidden = true; };
	return img;
}
const svgElement = (tag, attributes = {}) => {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
	return node;
};
const designAsset = path => path.replace(/^\/images\/social\//, '/social-assets/');
function designMiniature(preset, property, photo, kind, format, destination) {
	const height = format === 'square' ? 1080 : 1350;
	const p = property || {};
	const paths = { property: `/properties/${encodeURIComponent(p.code || p.id || '')}`, request: '/request', sell: '/list-property' };
	const link = destination === 'message' ? null : { shortUrl: `four-walls.gr${paths[destination] || ''}` };
	const design = buildSocialDesign({ preset, kind: kind === 'photo-only' ? 'photo' : kind, height, property: p, destination, channel: active?.channel || $('new-channel').value, link });
	const card = el('div', null, `design-artwork${format === 'square' ? ' square' : ''}`);
	card.setAttribute('aria-hidden', 'true');
	const loading = el('span', 'Φόρτωση προεπισκόπησης…', 'design-loading');
	let pendingImages = 0, imageFailed = false;
	const layer = attributes => {
		const image = svgElement('image', { ...attributes, visibility: 'hidden' });
		pendingImages++;
		image.onload = () => { image.removeAttribute('visibility'); pendingImages--; if (!pendingImages && !imageFailed) loading.hidden = true; };
		image.onerror = () => { imageFailed = true; loading.textContent = 'Δεν φορτώθηκε η προεπισκόπηση. Πατήστε Ανανέωση για να δοκιμάσετε ξανά.'; };
		return image;
	};
	const svg = svgElement('svg', { viewBox: `0 0 1080 ${height}`, width: 1080, height, focusable: 'false' });
	svg.append(svgElement('rect', { width: 1080, height, fill: '#fbf8f1' }));
	if (design.photo) {
		const box = { x: design.photo.left, y: design.photo.top, width: design.photo.width, height: design.photo.height };
		svg.append(photo ? layer({ ...box, href: photo, preserveAspectRatio: 'xMidYMid slice' }) : svgElement('rect', { ...box, fill: '#dce3e9' }));
	}
	svg.append(layer({ href: designAsset(design.frame), width: 1080, height }));
	svg.append(layer({ href: designAsset(design.logo.file), x: design.logo.left, y: design.logo.top, width: design.logo.width, height: design.logo.height ?? design.logo.width * 100 / 175.7, preserveAspectRatio: 'xMinYMin meet' }));
	for (const line of design.texts) {
		const text = svgElement('text', { x: line.left + (line.align === 'right' ? line.width : 0), y: line.top, fill: line.color, 'font-size': line.size, 'font-family': line.font === 'serif' ? 'SocialSerif' : 'SocialSans', 'font-weight': line.font === 'sans' ? 400 : 600, 'text-anchor': line.align === 'right' ? 'end' : 'start', 'dominant-baseline': 'hanging' });
		text.textContent = line.text; svg.append(text);
	}
	card.append(svg, loading); return card;
}
// New designs share artwork, typography and layout with the Worker. Approval
// still uses the immutable final images, including their actual photo crops.
function miniature(preset, property, photo, kind = 'cover', format = 'portrait', destination = 'property') {
	if (preset !== 'classic') return designMiniature(preset, property, photo, kind, format, destination);
	const p = property || { title: 'Επιλέξτε ακίνητο', location: {} };
	const card = el('div', null, `mini-slide ${preset} ${kind} ${format === 'square' ? 'square' : ''}`);
	card.setAttribute('aria-hidden', 'true');
	if (photo && ['cover', 'photo-only'].includes(kind)) card.append(imageElement(photo, 'mini-photo'));
	else if (['cover', 'photo-only'].includes(kind)) card.append(el('span', null, 'mini-photo'));
	card.append(el('span', null, 'mini-decoration'));
	card.append(imageElement('/fourwalls-logo.svg', 'mini-logo'));
	const copy = el('div', null, 'mini-copy');
	if (kind === 'cta') {
		const prompts = { property: ['Δείτε το ακίνητο', `Φωτογραφίες και πληροφορίες · four-walls.gr/properties/${p.code || p.id || ''}`], request: ['Ψάχνετε ακίνητο;', 'Συμπληρώστε το αίτημά σας · four-walls.gr/request'], sell: ['Θέλετε να πουλήσετε;', 'Στείλτε τα στοιχεία του ακινήτου · four-walls.gr/list-property'], message: ['Θέλετε να το δείτε;', `Στείλτε μας μήνυμα με τον κωδικό ${p.code || 'του ακινήτου'}.`] };
		const [title, detail] = prompts[destination] || prompts.message;
		copy.append(el('strong', title), el('small', detail));
	} else {
		copy.append(el('strong', propertyTitle(p)), el('small', [p.location?.area, p.location?.city].filter(Boolean).join(' · ')));
		if (kind === 'facts') {
			const facts = el('div', null, 'mini-facts');
			if (p.area) facts.append(el('span', `${p.area} τ.μ.`));
			facts.append(el('span', priceLabel(p)));
			if (p.code) facts.append(el('span', `Κωδικός ${p.code}`));
			copy.append(facts);
		} else copy.append(el('span', property ? priceLabel(p) : 'Στοιχεία από το CRM', 'mini-price'));
	}
	card.append(copy); return card;
}
function renderPresets(container, property, selectedId, choose, format = 'portrait') {
	$(container).replaceChildren(...presets.map(preset => {
		const option = el('div', null, 'preset-option');
		const button = el('button', null, 'preset'); button.type = 'button'; button.id = `${container}-${preset.id}`;
		button.setAttribute('aria-pressed', String(preset.id === selectedId));
		button.setAttribute('aria-label', `${preset.number} ${preset.name}. ${preset.description}`);
		button.append(miniature(preset.id, property, container === 'presets' ? selected[0] : property?.images?.[0], 'cover', format));
		const name = el('span', null, 'preset-name'); name.append(el('span', preset.name), el('b', preset.number));
		button.append(name, el('span', preset.description, 'preset-description'), el('span', preset.id === selectedId ? '✓ Επιλεγμένο' : 'Επιλογή προτύπου', 'preset-mark'));
		button.onclick = () => { if (busy) return; choose(preset.id); $(button.id)?.focus({ preventScroll: true }); };
		const enlarge = el('button', 'Μεγέθυνση', 'preset-enlarge'); enlarge.type = 'button';
		enlarge.setAttribute('aria-label', `Μεγέθυνση προτύπου ${preset.name}`);
		enlarge.onclick = () => {
			if (busy) return;
			$('design-title').textContent = `${preset.number} · ${preset.name}`;
			$('design-description').textContent = preset.description;
			const destination = container === 'presets' ? creative.destination || 'message' : 'property';
			const photo = container === 'presets' ? selected[0] : property?.images?.[0];
			$('design-slides').replaceChildren(...[['cover', 'Εξώφυλλο'], ['facts', 'Στοιχεία ακινήτου'], ['cta', 'Τελική κάρτα']].map(([kind, label]) => {
				const figure = el('figure'); figure.append(miniature(preset.id, property, photo, kind, format, destination), el('figcaption', label)); return figure;
			}));
			$('choose-design').hidden = container === 'presets' && !editable();
			$('choose-design').textContent = preset.id === selectedId ? 'Διατήρηση αυτού του προτύπου' : 'Επιλογή αυτού του προτύπου';
			$('choose-design').onclick = () => { if (busy || (container === 'presets' && !editable())) return; choose(preset.id); hideDialog('design-dialog'); $(button.id)?.focus({ preventScroll: true }); };
			showDialog('design-dialog');
		};
		option.append(button, enlarge); return option;
	}));
}
function starterPreview() {
	const p = selectedProperty();
	$('property-summary').textContent = p ? `${p.images.length} ${p.images.length === 1 ? 'πρωτότυπη φωτογραφία' : 'πρωτότυπες φωτογραφίες'} · ${priceLabel(p)}` : 'Επιλέξτε ακίνητο για να δείτε τα πρότυπα με τις φωτογραφίες του.';
	$('channel-help').textContent = $('new-channel').value === 'marketplace' ? 'Δημιουργεί αρχείο με εικόνες και κείμενο για χειροκίνητη καταχώριση.' : 'Δημιουργεί μία δημοσίευση με εικόνες και λεζάντα για το επιλεγμένο κανάλι.';
	renderPresets('starter-presets', p, starterPreset, id => { starterPreset = id; starterPreview(); });
	controls();
}
function propertyOptions() {
	if (!bootstrap) return;
	const chosen = selectedProperty();
	if (!chosen) $('property').value = '';
	$('property-selection').replaceChildren(chosen ? propertyContent(chosen) : el('span', 'Επιλέξτε ακίνητο'));
	$('choose-property').classList.toggle('has-selection', !!chosen);
	const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('el');
	const terms = normalize($('property-search').value).trim().split(/\s+/).filter(Boolean);
	const matches = bootstrap.feed.listings.filter(p => { const text = normalize([p.code, propertyTitle(p), p.location?.area, p.location?.city].filter(Boolean).join(' ')); return terms.every(term => text.includes(term)); });
	$('property-results-count').textContent = `${matches.length} ${matches.length === 1 ? 'ακίνητο' : 'ακίνητα'}${matches.length > 60 ? ' · Εμφανίζονται τα πρώτα 60. Περιορίστε την αναζήτηση.' : ''}`;
	$('property-results').replaceChildren(...matches.slice(0, 60).map(p => {
		const button = el('button', null, 'property-result'); button.type = 'button'; button.disabled = busy;
		button.setAttribute('aria-pressed', String(p.id === $('property').value));
		button.append(propertyContent(p), el('span', p.id === $('property').value ? '✓ Επιλεγμένο' : 'Επιλογή ακινήτου', 'property-select-label'));
		button.onclick = () => { if (busy) return; $('property').value = p.id; hideDialog('property-dialog'); propertyOptions(); $('empty').scrollIntoView({ block: 'start' }); };
		return button;
	}));
	if (!matches.length) $('property-results').append(el('p', 'Δεν βρέθηκαν ακίνητα με διαθέσιμες πρωτότυπες φωτογραφίες. Δοκιμάστε άλλο κωδικό ή περιοχή.'));
	starterPreview();
}
function propertyContent(p) {
	const content = el('span', null, 'property-content'), media = el('span', 'Χωρίς φωτογραφία', 'property-media');
	if (p.images?.[0]) { const image = imageElement(p.images[0], ''); image.onerror = () => { image.remove(); media.textContent = 'Χωρίς φωτογραφία'; }; media.replaceChildren(image); }
	const facts = el('span', null, 'property-facts');
	const transaction = { sale: 'Πώληση', rent: 'Ενοικίαση', shortterm: 'Βραχυχρόνια μίσθωση', auction: 'Δημοπρασία' }[p.transaction] || '';
	facts.append(el('small', p.code || p.id, 'property-code'), el('strong', propertyTitle(p)), el('span', [p.location?.area, p.location?.city].filter(Boolean).join(', ')), el('span', [transaction, p.area ? `${p.area} τ.μ.` : '', priceLabel(p)].filter(Boolean).join(' · '), 'property-price'));
	content.append(media, facts); return content;
}
function postList() {
	$('metric-total').textContent = posts.length;
	for (const status of ['draft', 'pending', 'scheduled']) $('metric-' + status).textContent = posts.filter(p => p.status === status).length;
	const visible = posts.filter(p => !$('filter').value || p.status === $('filter').value);
	$('queue-count').textContent = visible.length;
	document.querySelectorAll('.metric').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === $('filter').value)));
	$('posts').replaceChildren(...visible.map(p => {
		const button = el('button', null, 'post'); button.type = 'button'; button.setAttribute('aria-current', String(active?.id === p.id));
		const details = el('span');
		details.append(el('strong', p.snapshot.code || propertyTitle(p.snapshot)), el('small', propertyTitle(p.snapshot)), el('small', `${channels[p.channel]} · ${labels[p.status]}`));
		const current = bootstrap?.feed.listings.find(item => item.id === p.property_id);
		const thumbnail = current?.images?.[0] || (['published', 'cancelled', 'needs_review'].includes(p.status) ? p.snapshot.images?.[0] : null);
		if (thumbnail) button.append(imageElement(thumbnail, 'post-thumb'));
		button.append(details);
		button.onclick = () => task(async () => {
			if (dirty) throw new Error('Αποθηκεύστε τις αλλαγές ή επιλέξτε «Κλείσιμο χωρίς αποθήκευση» πριν ανοίξετε άλλη δημοσίευση.');
			await openPost(p.id); $('editor').scrollIntoView({ block: 'start' });
		});
		return button;
	}));
	if (!visible.length) $('posts').append(el('p', 'Δεν υπάρχουν δημοσιεύσεις σε αυτή την κατάσταση.'));
}
function contentChanged() {
	dirty = true; $('review-confirm').checked = false;
	renderEditorPresets(); layoutPreview(); linkPreview(); controls();
}
function websiteLink() {
	if (!active || !creative.destination || creative.destination === 'message') return null;
	const p = currentProperty() || active.snapshot;
	const paths = { property: `/properties/${encodeURIComponent(p.code || p.id)}`, request: '/request', sell: '/list-property' };
	const path = paths[creative.destination]; if (!path) return null;
	const label = { property: 'Σελίδα ακινήτου', request: 'Αίτημα αναζήτησης ακινήτου', sell: 'Αίτημα πώλησης ακινήτου' }[creative.destination];
	const url = new URL(path, 'https://four-walls.gr');
	url.searchParams.set('utm_source', active.channel);
	url.searchParams.set('utm_medium', 'social');
	url.searchParams.set('utm_campaign', `property_${p.code || p.id}`);
	url.searchParams.set('utm_content', active.id);
	return { label, url: url.href, shortUrl: `four-walls.gr${path}` };
}
function linkPreview() {
	const link = websiteLink();
	$('website-link-tools').hidden = !link;
	$('website-link').value = link?.url || '';
	const descriptions = { property: 'Η τελική κάρτα οδηγεί στη σελίδα του συγκεκριμένου ακινήτου.', request: 'Η τελική κάρτα προτείνει συμπλήρωση της φόρμας ζήτησης ακινήτου.', sell: 'Η τελική κάρτα προτείνει συμπλήρωση της φόρμας ανάθεσης ακινήτου.', message: 'Η τελική κάρτα ζητά μήνυμα με τον κωδικό του ακινήτου.' };
	$('destination-help').textContent = descriptions[creative.destination || 'message'];
	$('caption-link-state').textContent = !link ? '' : $('caption').value.includes(link.url) ? 'Ο σύνδεσμος υπάρχει στη λεζάντα.' : 'Ο νέος σύνδεσμος δεν έχει προστεθεί στη λεζάντα. Πατήστε «Προσθήκη συνδέσμου στη λεζάντα» για να τον συμπεριλάβετε.';
	$('channel-link-help').textContent = !link ? '' : active.channel === 'instagram' ? 'Οι σύνδεσμοι της λεζάντας δεν είναι αξιόπιστα πατήσιμοι μέσω της δημοσίευσης API. Αντιγράψτε τον σύνδεσμο για το προφίλ ή προσθέστε τον χειροκίνητα ως σύνδεσμο σε Story. Η κάρτα είναι εικόνα, όχι κουμπί.' : active.channel === 'facebook' ? 'Στο Facebook ο σύνδεσμος λειτουργεί μέσα στο κείμενο της δημοσίευσης. Η κάρτα είναι εικόνα, όχι κουμπί.' : 'Ο σύνδεσμος μπορεί να συμπεριληφθεί στο κείμενο του πακέτου για χειροκίνητη καταχώριση. Η κάρτα είναι εικόνα, όχι κουμπί.';
}
function renderEditorPresets() {
	const p = currentProperty() || active.snapshot;
	renderPresets('presets', p, creative.preset, id => {
		if (!editable()) return;
		if (creative.preset === id) return;
		if (creative.preset === 'classic') { creative.includeFacts = true; creative.includeCta = true; }
		creative.preset = id; creative.version = 1;
		$('include-facts').checked = creative.includeFacts; $('include-cta').checked = creative.includeCta;
		contentChanged();
	}, $('template').value);
	$('legacy-preset').hidden = creative.preset !== 'classic';
}
function photoGrid() {
	const p = currentProperty();
	const photos = editable() ? p?.images || [] : active.snapshot.images || [];
	$('photos').replaceChildren(...photos.map((url, i) => {
		const button = el('button', null, 'photo'); button.type = 'button';
		const index = selected.indexOf(url); button.setAttribute('aria-pressed', String(index >= 0));
		button.setAttribute('aria-label', `Φωτογραφία ${i + 1}${index >= 0 ? `, επιλογή ${index + 1}. Αφαίρεση` : '. Επιλογή'}`);
		button.append(imageElement(url, '', `Φωτογραφία ακινήτου ${i + 1}`), el('span', index >= 0 ? `${index === 0 ? 'Εξώφυλλο' : 'Επιλογή ' + (index + 1)} ✓` : 'Επιλογή'));
		button.onclick = () => {
			if (!editable() || busy) return;
			if (index >= 0) selected.splice(index, 1);
			else if (totalSlides() < 10) selected.push(url);
			else { message(errors.too_many_slides, 'error'); return; }
			photosConfirmedClean = false; $('clean-photos-confirm').checked = false;
			photoGrid(); contentChanged();
		};
		return button;
	}));
	if (!photos.length) $('photos').append(el('p', 'Δεν υπάρχουν διαθέσιμες πρωτότυπες φωτογραφίες. Ελέγξτε το ακίνητο στο EstatePrime.'));
	$('order').replaceChildren(...selected.map((url, i) => {
		const item = el('div', null, 'order-item');
		item.append(imageElement(url, '', `Επιλεγμένη φωτογραφία ${i + 1}`), el('span', i === 0 ? '1 · Εξώφυλλο' : `${i + 1} · Φωτογραφία`));
		const buttons = el('div', null, 'order-controls');
		for (const [symbol, title, unavailable, change] of [
			['←', `Μετακίνηση φωτογραφίας ${i + 1} αριστερά`, i === 0, () => { [selected[i - 1], selected[i]] = [selected[i], selected[i - 1]]; }],
			['→', `Μετακίνηση φωτογραφίας ${i + 1} δεξιά`, i === selected.length - 1, () => { [selected[i + 1], selected[i]] = [selected[i], selected[i + 1]]; }],
			['×', `Αφαίρεση φωτογραφίας ${i + 1}`, false, () => selected.splice(i, 1)]
		]) {
			const b = el('button', symbol); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.dataset.unavailable = String(unavailable);
			b.onclick = () => { if (busy || !editable() || unavailable) return; change(); photosConfirmedClean = false; $('clean-photos-confirm').checked = false; photoGrid(); contentChanged(); };
			buttons.append(b);
		}
		item.append(buttons); return item;
	}));
}
let previewCarousel, onViewerSlide;
function openImageViewer(plan, index, property, trigger) {
	previewCarousel?.dispose();
	$('viewer-slides').replaceChildren(...plan.map((slide, i) => {
		const item = el('div', null, 'carousel-item' + (i === index ? ' active' : ''));
		item.setAttribute('role', 'group'); item.setAttribute('aria-label', (i + 1) + ' / ' + plan.length + ': ' + slide.label);
		const frame = el('div', null, 'viewer-frame');
		frame.append(miniature(creative.preset, property, slide.photo, slide.kind, $('template').value, creative.destination || 'message'));
		item.append(frame); return item;
	}));
	$('viewer-jumps').replaceChildren(...plan.map((slide, i) => {
		const button = el('button', String(i + 1), 'viewer-jump'); button.type = 'button';
		button.setAttribute('aria-label', 'Εικόνα ' + (i + 1) + ': ' + slide.label);
		button.onclick = () => previewCarousel.to(i); return button;
	}));
	const update = i => {
		$('viewer-position').textContent = (i + 1) + ' / ' + plan.length + ' · ' + plan[i].label;
		[...$('viewer-jumps').children].forEach((button, n) => { if(n === i) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current'); });
	};
	$('preview-carousel').querySelectorAll('[data-bs-slide]').forEach(button => { button.hidden = plan.length < 2; });
	if (onViewerSlide) $('preview-carousel').removeEventListener('slid.bs.carousel', onViewerSlide);
	onViewerSlide = event => update(event.to);
	$('preview-carousel').addEventListener('slid.bs.carousel', onViewerSlide);
	previewCarousel = new Carousel($('preview-carousel'), { interval: false, ride: false, keyboard: true, touch: true, wrap: true });
	update(index); showDialog('image-viewer', trigger);
}
$('image-viewer').addEventListener('shown.bs.modal', () => $('preview-carousel').focus());
$('image-viewer').addEventListener('hidden.bs.modal', () => { previewCarousel?.dispose(); previewCarousel = null; $('viewer-slides').replaceChildren(); });
function layoutPreview() {
	if (!active) return;
	const p = currentProperty() || active.snapshot, plan = [];
	selected.forEach((url, i) => {
		plan.push({ kind: i === 0 ? 'cover' : 'photo-only', photo: url, label: i === 0 ? 'Εξώφυλλο' : `Φωτογραφία ${i + 1}` });
		if (creative.includeFacts && i === Math.min(1, selected.length - 1)) plan.push({ kind: 'facts', label: 'Στοιχεία ακινήτου' });
	});
	if (selected.length && creative.includeCta) plan.push({ kind: 'cta', label: 'Επικοινωνία' });
	$('layout-preview').replaceChildren(...plan.map((slide, i) => {
		const item = el('figure', null, `layout-item${creative.preset === 'classic' ? '' : 'design-layout'}`);
		const enlarge = el('button', null, 'layout-enlarge'); enlarge.type = 'button'; enlarge.setAttribute('aria-label', `Μεγέθυνση εικόνας ${i + 1}: ${slide.label}`);
		enlarge.append(miniature(creative.preset, p, slide.photo, slide.kind, $('template').value, creative.destination || 'message'));
		enlarge.onclick = () => openImageViewer(plan, i, p, enlarge);
		item.append(enlarge, el('figcaption', `${i + 1}. ${slide.label}`)); return item;
	}));
	if (!plan.length) $('layout-preview').append(el('p', 'Επιλέξτε φωτογραφίες για να δείτε τη σειρά της δημοσίευσης.'));
}
async function openPost(id) {
	active = await api(`/posts/${id}`); selected = [...active.photos]; dirty = false;
	creative = { ...classic, ...(active.creative || {}) };
	photosConfirmedClean = Boolean(active.photos_confirmed_clean);
	lastInsertedLink = active.websiteLink?.url || '';
	lastInsertedLabel = active.websiteLink?.label || '';
	let notice = '';
	if (editable()) {
		const originals = currentProperty()?.images || [];
		selected = selected.filter(url => originals.includes(url));
		if (selected.length !== active.photos.length || active.snapshot.photoSource !== 'estateprime_original') {
			dirty = true;
			photosConfirmedClean = false;
			notice = 'Το προσχέδιο χρειάζεται έλεγχο φωτογραφιών. Κρατήθηκαν μόνο διαθέσιμα πρωτότυπα. Επιλέξτε φωτογραφίες και αποθηκεύστε ξανά πριν δημιουργήσετε νέες εικόνες.';
		} else if (active.status === 'blocked') dirty = true;
	}
	$('photo-notice').textContent = notice; $('photo-notice').hidden = !notice;
	$('empty').hidden = true; $('editor').hidden = false;
	$('post-title').textContent = `${active.snapshot.code} · ${channels[active.channel]}`;
	$('status').textContent = labels[active.status];
	$('post-info').textContent = [propertyTitle(currentProperty() || active.snapshot), active.approved_by ? `Έγκριση: ${active.approved_by}` : '', active.scheduled_at ? `Προγραμματισμός: ${new Date(active.scheduled_at).toLocaleString('el-GR')}` : '', active.remote_id ? `Meta ID: ${active.remote_id}` : '', active.error ? (errors[active.error] || active.error) : ''].filter(Boolean).join(' · ');
	$('caption').value = active.caption; $('template').value = active.template;
	$('include-facts').checked = creative.includeFacts; $('include-cta').checked = creative.includeCta;
	$('destination').value = creative.destination || 'message';
	$('clean-photos-confirm').checked = photosConfirmedClean;
	$('review-confirm').checked = false;
	$('schedule-time').value = '';
	$('property').value = active.property_id; $('new-channel').value = active.channel; propertyOptions();
	photoGrid(); renderEditorPresets(); layoutPreview(); linkPreview(); postList();
	$('preview').hidden = !active.assets.length;
	$('renders').replaceChildren(...active.assets.map((url, i) => {
		const a = el('a', `Λήψη εικόνας ${i + 1}`); a.href = url; a.download = `fourwalls-${i + 1}.jpg`;
		a.prepend(imageElement(`${url}?revision=${active.revision}`, '', `Τελική εικόνα ${i + 1}`)); return a;
	}));
	$('schedule-mode').hidden = !!bootstrap.live;
	$('schedule-mode').textContent = 'Η αποστολή στο Meta είναι απενεργοποιημένη. Μπορείτε να ορίσετε χρόνο, αλλά η δημοσίευση θα παραμείνει σε αναμονή μέχρι την ενεργοποίηση.';
	const events = await api(`/posts/${id}/history`);
	$('history').replaceChildren(...events.filter(e => e.kind !== 'platform_snapshot').map(e => el('li', `${new Date(e.created_at).toLocaleString('el-GR')} · ${labels[e.kind] || eventLabels[e.kind] || e.kind} · ${e.actor}${e.detail && !e.kind.startsWith('platform_') ? ` · ${e.detail}` : ''}`)));
	platformItems = (await api(`/posts/${id}/platform`)).targets;
	renderPlatform();
	controls();
}

Object.assign(eventLabels, { platform_started: 'Έναρξη αλλαγής στο Facebook', platform_edited: 'Ενημέρωση κειμένου στο Facebook', platform_deleted: 'Διαγραφή από το Facebook', platform_removed: 'Η δημοσιευμένη ανάρτηση αφαιρέθηκε', platform_rejected: 'Η ενέργεια απορρίφθηκε από το Meta', platform_uncertain: 'Απαιτείται έλεγχος αποτελέσματος στο Meta' });
function renderPlatform() {
	const host = $('platform-targets'); host.replaceChildren();
	if (!platformItems.length) { host.append(el('p', 'Οι σύνδεσμοι εμφανίζονται μετά τη δοκιμή ή τη δημοσίευση. Τα στατιστικά κοινού αφορούν μόνο δημοσιευμένες αναρτήσεις.', 'help')); return; }
	const metricLabels = { views: 'Προβολές', viewers: 'Μοναδικοί θεατές', reach: 'Απήχηση', likes: 'Μου αρέσει', reactions: 'Αντιδράσεις', comments: 'Σχόλια', shares: 'Κοινοποιήσεις', saves: 'Αποθηκεύσεις', clicks: 'Κλικ στην ανάρτηση', linkClicks: 'Κλικ συνδέσμου' };
	for (const target of platformItems) {
		const card = el('article', null, 'platform-card');
		card.append(el('h4', target.deleted ? 'Διαγράφηκε από το Facebook' : target.kind === 'container' ? 'Δοκιμή Instagram — χωρίς δημοσίευση' : target.kind === 'draft' ? 'Πρόχειρο Facebook' : `Ανάρτηση ${channels[active.channel]}`), el('small', `Meta ID: ${target.id}`));
		const actions = el('div', null, 'actions'); card.append(actions);
		for (const [url, label] of [[target.url, `Άνοιγμα στο ${channels[active.channel]}`], [target.deleted ? null : target.manageUrl, target.kind === 'draft' ? 'Άνοιγμα προχείρων στο Meta' : 'Διαχείριση στο Meta']]) {
			if (!url) continue;
			const link = el('a', label); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
		}
		if (target.kind === 'container') { card.append(el('p', 'Οι εικόνες ελέγχθηκαν στο Instagram. Η δοκιμή δεν εμφανίζεται στην εφαρμογή και δεν έχει στατιστικά κοινού.')); host.append(card); continue; }
		if (target.deleted) { card.append(el('p', 'Το ιστορικό διατηρείται. Το τοπικό προσχέδιο δεν διαγράφηκε.')); host.append(card); continue; }
		const refresh = el('button', 'Ανανέωση στοιχείων & στατιστικών'); refresh.type = 'button';
		refresh.onclick = () => platformAction(target, 'refresh'); actions.append(refresh);
		if (target.pending) card.append(el('p', errors.platform_action_needs_review, 'notice'));
		if (target.snapshot) {
			card.append(el('p', `Τελευταία λήψη: ${new Date(target.snapshot.fetchedAt).toLocaleString('el-GR')}`, 'help'));
			if (!target.snapshot.published) card.append(el('p', 'Αδημοσίευτο: δεν υπάρχουν στατιστικά κοινού.'));
			else {
				const stats = el('dl', null, 'post-metrics');
				for (const [key, value] of Object.entries(target.snapshot.metrics)) {
					const group = el('div'); group.append(el('dt', metricLabels[key] || key), el('dd', value == null ? 'Μη διαθέσιμο' : value.toLocaleString('el-GR'))); stats.append(group);
				}
				card.append(stats, el('p', 'Τα στοιχεία μπορεί να καθυστερούν έως 24 ώρες. Μη διαθέσιμα δεδομένα δεν σημαίνουν μηδενική απόδοση. Η ανανέωση περιορίζεται σε μία λήψη ανά λεπτό.', 'help'));
				if (Object.values(target.snapshot.issues).includes('permission_required')) card.append(el('p', `Χρειάζεται πρόσθετη άδεια στατιστικών ${active.channel === 'facebook' ? '(read_insights)' : '(instagram_manage_insights)'} στη σύνδεση Meta.`, 'notice'));
			}
		} else card.append(el('p', 'Πατήστε ανανέωση για τα τρέχοντα στοιχεία από το Meta.', 'help'));
		if (active.channel === 'facebook' && bootstrap.canApprove) {
			const edit = el('details'); edit.append(el('summary', 'Επεξεργασία κειμένου στο Facebook'));
			const caption = el('textarea'); caption.rows = 6; caption.maxLength = 2200; caption.value = target.snapshot?.caption ?? '';
			caption.setAttribute('aria-label', `Κείμενο Facebook ${target.id}`); caption.dataset.locked = String(!target.snapshot || !!target.pending);
			const save = el('button', 'Αποθήκευση στο Facebook'); save.type = 'button'; save.dataset.locked = caption.dataset.locked;
			save.onclick = () => { if (confirm(`Να ενημερωθεί το κείμενο στο Facebook;\nΑνάρτηση: ${target.id}\nΤο τοπικό προσχέδιο δεν αλλάζει.`)) platformAction(target, 'edit', caption.value); };
			edit.append(caption, save); card.append(edit);
			const remove = el('button', 'Διαγραφή από το Facebook'); remove.type = 'button'; remove.dataset.locked = String(!!target.pending); remove.className = 'platform-delete';
			remove.onclick = () => { if (confirm(`Οριστική διαγραφή από το Facebook;\nΑνάρτηση: ${target.id}\nΘα αφαιρεθεί από το Facebook μαζί με τις αλληλεπιδράσεις της. Το ιστορικό στην εφαρμογή διατηρείται.`)) platformAction(target, 'delete'); };
			card.append(remove);
		}
		host.append(card);
	}
}
function platformAction(target, operation, caption) {
	return task(async () => {
		try { await api(`/posts/${active.id}/platform`, 'POST', { revision: active.revision, target_id: target.id, operation, caption, confirm_id: operation === 'refresh' ? undefined : target.id }); }
		finally { await reload(); }
	}, 'Επικοινωνία με το Meta…', operation === 'delete' ? 'Η ανάρτηση διαγράφηκε από το Facebook.' : operation === 'edit' ? 'Το κείμενο ενημερώθηκε στο Facebook.' : 'Τα διαθέσιμα στοιχεία ενημερώθηκαν.');
}
function closeEditor() {
	active = undefined; selected = []; dirty = false; creative = { ...classic }; photosConfirmedClean = false;
	$('editor').hidden = true; $('empty').hidden = false;
	postList(); starterPreview();
}
async function reload() {
	bootstrap = await api('/bootstrap'); posts = (await api('/posts')).posts;
	$('identity').textContent = bootstrap.actor;
	$('mode').textContent = bootstrap.live ? 'Η αποστολή στο Meta είναι ενεργή. Δημοσιεύονται μόνο εγκεκριμένες και προγραμματισμένες εκδόσεις.' : 'Η αποστολή στο Meta είναι απενεργοποιημένη. Μπορείτε να ετοιμάσετε εικόνες, να τις εγκρίνετε και να προγραμματίσετε. Δεν θα δημοσιευτούν μέχρι την ενεργοποίηση.';
	if (bootstrap.feed.source === 'sample') $('mode').textContent = 'Δοκιμαστικά δεδομένα. Δεν γίνεται αποστολή στο Meta.';
	$('feed-time').textContent = `Συγχρονισμός CRM: ${new Date(bootstrap.feed.generatedAt).toLocaleString('el-GR')}`;
	propertyOptions(); postList(); if (active) await openPost(active.id);
}
async function action(name, fields = {}) {
	await api(`/posts/${active.id}/${name}`, 'POST', { revision: active.revision, ...fields });
	await reload();
}
$('refresh').onclick = () => task(async () => { if (dirty) throw new Error('Αποθηκεύστε τις αλλαγές ή επιλέξτε «Κλείσιμο χωρίς αποθήκευση» πριν την ανανέωση.'); await reload(); }, 'Ανανέωση δεδομένων…', 'Τα δεδομένα ενημερώθηκαν.');
$('property-search').oninput = propertyOptions; $('filter').onchange = postList;
$('new-channel').onchange = starterPreview;
$('choose-property').onclick = () => { propertyOptions(); showDialog('property-dialog'); };
$('close-picker').onclick = () => hideDialog('property-dialog');
$('close-design').onclick = () => hideDialog('design-dialog');
$('today').textContent = new Intl.DateTimeFormat('el-GR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
document.querySelectorAll('.metric').forEach(b => { b.onclick = () => { $('filter').value = b.dataset.filter; postList(); $('queue').scrollIntoView({ block: 'start' }); }; });
$('close-editor').onclick = () => { closeEditor(); message('Το προσχέδιο διατηρεί την τελευταία αποθηκευμένη έκδοσή του.', 'success'); };
$('new-draft').onclick = () => {
	if (dirty) { message('Αποθηκεύστε ή επιλέξτε «Κλείσιμο χωρίς αποθήκευση» πριν ξεκινήσετε νέο προσχέδιο.', 'error'); return; }
	closeEditor(); $('empty').scrollIntoView({ block: 'start' });
};
$('create').onclick = () => task(async () => {
	if (dirty) throw new Error('Αποθηκεύστε πρώτα τις αλλαγές.');
	const post = await api('/posts', 'POST', { property_id: $('property').value, channel: $('new-channel').value, template: 'portrait', creative: { preset: starterPreset, version: 1, includeFacts: true, includeCta: true, destination: 'property' } });
	posts = (await api('/posts')).posts; await openPost(post.id); $('editor').scrollIntoView({ block: 'start' });
}, 'Δημιουργία προσχεδίου…', 'Το προσχέδιο δημιουργήθηκε. Επιλέξτε φωτογραφίες και ελέγξτε τη λεζάντα.');
$('template').oninput = contentChanged;
$('caption').oninput = () => { dirty = true; $('review-confirm').checked = false; linkPreview(); controls(); };
$('destination').onchange = () => { creative.destination = $('destination').value; contentChanged(); };
$('copy-link').onclick = async () => {
	const link = websiteLink(); if (!link || busy) return;
	try { await navigator.clipboard.writeText(link.url); message('Ο σύνδεσμος αντιγράφηκε.', 'success'); }
	catch { message('Αντιγράψτε τον σύνδεσμο από το πεδίο «Σύνδεσμος προς τον ιστότοπο».', 'error'); }
};
$('add-link').onclick = () => {
	const link = websiteLink(); if (!link || busy || !editable()) return;
	if ($('caption').value.includes(link.url)) { message('Ο σύνδεσμος υπάρχει ήδη στη λεζάντα.', 'success'); return; }
	const lines = $('caption').value.split('\n'), previous = lastInsertedLink ? lines.indexOf(lastInsertedLink) : -1;
	if (previous >= 0) {
		lines[previous] = link.url;
		if (previous > 0 && lastInsertedLabel && lines[previous - 1] === lastInsertedLabel) lines[previous - 1] = link.label;
	} else lines.push('', link.label, link.url);
	const caption = lines.join('\n');
	if (caption.length > 2200) { message('Η λεζάντα μαζί με τον σύνδεσμο ξεπερνά τους 2.200 χαρακτήρες. Συντομεύστε πρώτα το κείμενο.', 'error'); return; }
	$('caption').value = caption; lastInsertedLink = link.url; lastInsertedLabel = link.label;
	contentChanged(); message('Ο σύνδεσμος προστέθηκε στη λεζάντα. Αποθηκεύστε τις αλλαγές.', 'success');
};
for (const [id, key] of [['include-facts', 'includeFacts'], ['include-cta', 'includeCta']]) $(id).onchange = () => { creative[key] = $(id).checked; contentChanged(); };
$('review-confirm').onchange = controls;
$('clean-photos-confirm').onchange = () => { photosConfirmedClean = $('clean-photos-confirm').checked; contentChanged(); };
$('save').onclick = () => task(async () => {
	await api(`/posts/${active.id}`, 'PATCH', { revision: active.revision, channel: active.channel, template: $('template').value, caption: $('caption').value, photos: selected, creative, photos_confirmed_clean: photosConfirmedClean });
	await reload();
}, 'Αποθήκευση αλλαγών…', 'Οι αλλαγές αποθηκεύτηκαν. Δημιουργήστε τώρα τις εικόνες για έλεγχο.');
$('submit').onclick = () => task(async () => { await action('submit'); $('preview').scrollIntoView({ block: 'start' }); }, 'Δημιουργία τελικών εικόνων… Μπορεί να χρειαστεί λίγο χρόνο.', 'Οι εικόνες είναι έτοιμες για έλεγχο. Δεν έχει γίνει δημοσίευση.');
$('approve').onclick = () => task(async () => { if (!$('review-confirm').checked) throw new Error('Επιβεβαιώστε πρώτα ότι ελέγξατε τις εικόνες και τη λεζάντα.'); await action('approve'); $(active.channel === 'marketplace' ? 'marketplace-export' : 'scheduling').scrollIntoView({ block: 'start' }); }, 'Καταχώριση έγκρισης…', 'Η έκδοση εγκρίθηκε. Δεν έχει γίνει δημοσίευση.');
$('cancel').onclick = () => task(() => action('cancel'), 'Ακύρωση δημοσίευσης…', 'Η δημοσίευση ακυρώθηκε.');
$('test').onclick = () => task(async () => {
	try { await action('test'); }
	finally { await openPost(active.id); document.querySelector('.history-section').open = true; }
}, 'Δοκιμή στο Meta χωρίς δημόσια δημοσίευση…', 'Η δοκιμή ολοκληρώθηκε. Δείτε το αποτέλεσμα στο ιστορικό.');
$('delete').onclick = () => {
	if (busy || !deletable()) return;
	if (!window.confirm('Να διαγραφεί οριστικά αυτή η δημιουργία και το ιστορικό της; Θα χαθούν και τυχόν μη αποθηκευμένες αλλαγές.')) return;
	return task(async () => {
		await api(`/posts/${active.id}`, 'DELETE', { revision: active.revision });
		posts = posts.filter(post => post.id !== active.id);
		closeEditor(); $('create').focus();
	}, 'Διαγραφή δημιουργίας…', 'Η δημιουργία και το ιστορικό της διαγράφηκαν.');
};
$('timezone').textContent = `Ημερομηνία και ώρα (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
$('schedule').onclick = () => task(async () => {
	const at = new Date($('schedule-time').value);
	if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now()) throw new Error('Επιλέξτε μελλοντική ημερομηνία και ώρα.');
	await action('schedule', { at: at.toISOString() });
}, 'Αποθήκευση προγραμματισμού…', 'Ο προγραμματισμός αποθηκεύτηκε.');
$('resolve-published').onclick = () => task(() => action('resolve', { outcome: 'published', remote_id: $('remote-id').value.trim() }), 'Καταχώριση αποτελέσματος…', 'Το αποτέλεσμα καταχωρίστηκε.');
$('resolve-cancelled').onclick = () => task(() => action('resolve', { outcome: 'cancelled' }), 'Καταχώριση αποτελέσματος…', 'Το αποτέλεσμα καταχωρίστηκε.');
$('package').onclick = () => task(async () => {
	const response = await fetch(`/api/social/posts/${active.id}/package`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: active.revision }) });
	if (!response.ok) throw apiError(await response.json());
	const url = URL.createObjectURL(await response.blob()), a = el('a');
	a.href = url; a.download = `fourwalls-marketplace-${active.snapshot.code || active.id}.zip`; a.click();
	setTimeout(() => URL.revokeObjectURL(url), 60000); await openPost(active.id);
}, 'Προετοιμασία πακέτου Marketplace…', 'Το πακέτο κατέβηκε. Καταχωρίστε το χειροκίνητα στο Marketplace.');
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
starterPreview();
task(reload);
