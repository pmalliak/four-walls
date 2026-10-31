'use strict';
const $ = id => document.getElementById(id);
const labels = { draft: 'Πρόχειρο', pending: 'Προς έγκριση', approved: 'Εγκεκριμένο', scheduled: 'Προγραμματισμένο', publishing: 'Σε δημοσίευση', published: 'Δημοσιευμένο', blocked: 'Χρειάζεται ενημέρωση', needs_review: 'Έλεγχος στο Meta', cancelled: 'Ακυρωμένο' };
const channels = { instagram: 'Instagram', facebook: 'Facebook Page', marketplace: 'Marketplace' };
const eventLabels = { edited: 'Αποθηκεύτηκαν αλλαγές', submitted: 'Δημιουργήθηκαν εικόνες για έγκριση', claimed: 'Έναρξη δημοσίευσης', property_observed: 'Έλεγχος CRM', marketplace_exported: 'Λήψη πακέτου Marketplace', meta_created: 'Δημιουργία μέσου Meta', publication_requested: 'Αποστολή δημοσίευσης', manually_resolved: 'Χειροκίνητη επιβεβαίωση' };
const errors = {
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
let bootstrap, posts = [], active, selected = [], dirty = false, busy = false;
let creative = { ...classic }, starterPreset = 'architectural', photosConfirmedClean = false, lastInsertedLink = '', lastInsertedLabel = '';
const editable = () => active && ['draft', 'pending', 'approved', 'scheduled', 'blocked'].includes(active.status);
const deletable = () => active && (editable() || active.status === 'cancelled') && !active.remote_id;
const propertyTitle = p => p?.title?.trim() ? p.title : `Ακίνητο${p?.area ? ` ${p.area} τ.μ.` : ''}${p?.location?.area || p?.location?.city ? `, ${p.location.area || p.location.city}` : ''}`;
const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
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
	document.querySelectorAll('#presets button,.photo').forEach(b => { b.disabled = busy || !canEdit; });
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
	$('marketplace-export').hidden = active.status !== 'approved' || active.channel !== 'marketplace'; $('package').disabled = busy || dirty;
	$('resolution').hidden = active.status !== 'needs_review' || !bootstrap?.canApprove;
	$('remote-id').disabled = busy;
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
// Deliberately an indicative HTML preview. Approval uses only the rendered,
// immutable images returned by the Worker, never this browser composition.
function miniature(preset, property, photo, kind = 'cover', format = 'portrait', destination = 'property') {
	const p = property || { title: 'Επιλέξτε ακίνητο', location: {} };
	const card = el('div', null, `mini-slide ${preset} ${kind} ${format === 'square' ? 'square' : ''}`);
	card.setAttribute('aria-hidden', 'true');
	if (photo && ['cover', 'photo-only'].includes(kind)) card.append(imageElement(photo, 'mini-photo'));
	else if (['cover', 'photo-only'].includes(kind)) card.append(el('span', null, 'mini-photo'));
	card.append(el('span', null, 'mini-decoration'));
	if (preset !== 'classic') {
		const origin = ['localhost', '127.0.0.1'].includes(location.hostname) ? '' : 'https://four-walls.gr';
		const frame = imageElement(`${origin}/images/social/${preset}-${kind === 'photo-only' ? 'photo' : kind}${format === 'square' ? '-square' : ''}.png`, 'mini-frame');
		card.classList.add('has-frame');
		frame.onerror = () => { frame.hidden = true; card.classList.remove('has-frame'); };
		card.append(frame);
	}
	const logo = imageElement('/fourwalls-logo.svg', 'mini-logo'); card.append(logo);
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
		const button = el('button', null, 'preset'); button.type = 'button'; button.id = `${container}-${preset.id}`;
		button.setAttribute('aria-pressed', String(preset.id === selectedId));
		button.setAttribute('aria-label', `${preset.number} ${preset.name}. ${preset.description}`);
		button.append(miniature(preset.id, property, container === 'presets' ? selected[0] : property?.images?.[0], 'cover', format));
		const name = el('span', null, 'preset-name'); name.append(el('span', preset.name), el('b', preset.number));
		button.append(name, el('span', preset.description, 'preset-description'), el('span', preset.id === selectedId ? '✓ Επιλεγμένο' : 'Επιλογή προτύπου', 'preset-mark'));
		button.onclick = () => { if (busy) return; choose(preset.id); $(button.id)?.focus({ preventScroll: true }); };
		return button;
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
		button.onclick = () => { if (busy) return; $('property').value = p.id; $('property-dialog').close(); propertyOptions(); $('empty').scrollIntoView({ block: 'start' }); };
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
function layoutPreview() {
	if (!active) return;
	const p = currentProperty() || active.snapshot, plan = [];
	selected.forEach((url, i) => {
		plan.push({ kind: i === 0 ? 'cover' : 'photo-only', photo: url, label: i === 0 ? 'Εξώφυλλο' : `Φωτογραφία ${i + 1}` });
		if (creative.includeFacts && i === Math.min(1, selected.length - 1)) plan.push({ kind: 'facts', label: 'Στοιχεία ακινήτου' });
	});
	if (selected.length && creative.includeCta) plan.push({ kind: 'cta', label: 'Επικοινωνία' });
	$('layout-preview').replaceChildren(...plan.map((slide, i) => {
		const item = el('figure', null, 'layout-item');
		item.append(miniature(creative.preset, p, slide.photo, slide.kind, $('template').value, creative.destination || 'message'), el('figcaption', `${i + 1}. ${slide.label}`)); return item;
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
	$('history').replaceChildren(...events.map(e => el('li', `${new Date(e.created_at).toLocaleString('el-GR')} · ${labels[e.kind] || eventLabels[e.kind] || e.kind} · ${e.actor}${e.detail ? ` · ${e.detail}` : ''}`)));
	controls();
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
$('choose-property').onclick = () => { propertyOptions(); $('property-dialog').showModal(); $('property-search').focus(); };
$('close-picker').onclick = () => $('property-dialog').close();
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
