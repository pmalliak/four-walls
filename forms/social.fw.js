'use strict';
const $ = id => document.getElementById(id);
const labels = { draft: 'Πρόχειρο', pending: 'Προς έγκριση', approved: 'Εγκεκριμένο', scheduled: 'Προγραμματισμένο', publishing: 'Σε δημοσίευση', published: 'Δημοσιευμένο', blocked: 'Χρειάζεται ενημέρωση', needs_review: 'Έλεγχος στο Meta', cancelled: 'Ακυρωμένο' };
const eventLabels = { edited: 'Αποθηκεύτηκαν αλλαγές', submitted: 'Στάλθηκε για έγκριση', claimed: 'Έναρξη δημοσίευσης', property_observed: 'Έλεγχος CRM', marketplace_exported: 'Λήψη πακέτου Marketplace', meta_created: 'Δημιουργία μέσου Meta', publication_requested: 'Αποστολή δημοσίευσης', manually_resolved: 'Χειροκίνητη επιβεβαίωση' };
const errors = { social_database_not_configured: 'Η βάση δημοσιεύσεων δεν έχει ρυθμιστεί ακόμη.', feed_missing_or_stale: 'Ο συγχρονισμός ακινήτων δεν είναι πρόσφατος. Δοκιμάστε μετά τον επόμενο συγχρονισμό.', revision_conflict_reload: 'Η δημοσίευση άλλαξε σε άλλη συνεδρία. Πατήστε Ανανέωση.', property_unavailable: 'Το ακίνητο δεν είναι διαθέσιμο.', property_changed_reapprove: 'Τα στοιχεία άλλαξαν στο CRM. Αποθηκεύστε ξανά και ζητήστε νέα έγκριση.', property_changed_save_again: 'Τα στοιχεία άλλαξαν. Αποθηκεύστε ξανά.', select_1_to_10_photos: 'Επιλέξτε από 1 έως 10 φωτογραφίες.', image_storage_not_configured: 'Η υπηρεσία εικόνων δεν έχει ρυθμιστεί.', approver_required: 'Απαιτείται εξουσιοδοτημένος υπεύθυνος έγκρισης.', future_utc_time_required: 'Επιλέξτε μελλοντική ημερομηνία και ώρα.', Unauthorized: 'Η σύνδεση έληξε. Ανανεώστε τη σελίδα.', social_operation_failed: 'Η ενέργεια απέτυχε. Οι αλλαγές δεν επιβεβαιώθηκαν· ανανεώστε πριν δοκιμάσετε ξανά.' };
let bootstrap, posts = [], active, selected = [], dirty = false, busy = false;
const editable = () => active && ['draft', 'pending', 'approved', 'scheduled', 'blocked'].includes(active.status);
const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
async function api(path, method = 'GET', body) {
	const response = await fetch(`/api/social${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
	const data = await response.json().catch(() => ({ error: 'Unauthorized' }));
	if (!response.ok) throw new Error(errors[data.error] || `Η ενέργεια δεν ολοκληρώθηκε (${data.error}).`);
	return data;
}
async function task(work) {
	if (busy) return;
	busy = true; $('message').textContent = 'Εκτέλεση…'; controls();
	try { await work(); $('message').textContent = 'Ολοκληρώθηκε.'; }
	catch (e) { $('message').textContent = e.message; }
	finally { busy = false; controls(); }
}
function controls() {
	document.querySelectorAll('button').forEach(b => { b.disabled = busy; });
	$('create').disabled = busy || !$('property').value;
	if (!active) { $('create').disabled = busy || !bootstrap?.feed.listings.length; return; }
	$('caption').disabled = $('template').disabled = !editable() || busy;
	$('save').hidden = !editable();
	$('save').disabled = busy || !dirty;
	$('submit').hidden = active.status !== 'draft'; $('submit').disabled = busy || dirty;
	$('approve').hidden = active.status !== 'pending' || !bootstrap.canApprove; $('approve').disabled = busy || dirty;
	$('cancel').hidden = !editable();
	$('scheduling').hidden = active.status !== 'approved' || active.channel === 'marketplace'; $('schedule').disabled = busy || dirty;
	$('package').hidden = active.status !== 'approved' || active.channel !== 'marketplace'; $('package').disabled = busy || dirty;
	$('resolution').hidden = active.status !== 'needs_review' || !bootstrap.canApprove;
	document.querySelectorAll('.photo').forEach(b => { b.disabled = busy || !editable(); });
	document.querySelectorAll('.order button').forEach((b, i) => { b.disabled = busy || !editable() || i === 0; });
	$('count').textContent = `${$('caption').value.length} / 2200${dirty ? ' · Μη αποθηκευμένες αλλαγές' : ''}`;
}
function propertyOptions() {
	const q = $('property-search').value.toLocaleLowerCase('el');
	$('property').replaceChildren(...bootstrap.feed.listings.filter(p => `${p.code} ${p.title} ${p.location.area}`.toLocaleLowerCase('el').includes(q)).map(p => {
		const option = el('option', `${p.code} · ${p.title}`); option.value = p.id; return option;
	}));
	$('create').disabled = !$('property').value || busy;
}
function postList() {
	const visible = posts.filter(p => !$('filter').value || p.status === $('filter').value);
	$('posts').replaceChildren(...visible.map(p => {
		const b = el('button', null, 'post'); b.type = 'button'; b.setAttribute('aria-current', String(active?.id === p.id));
		b.append(el('strong', p.snapshot.code || p.snapshot.title), el('small', `${p.channel} · ${labels[p.status]}`));
		b.onclick = () => task(async () => { if (dirty) throw new Error('Αποθηκεύστε τις αλλαγές πριν επιλέξετε άλλη δημοσίευση.'); await openPost(p.id); });
		return b;
	}));
	if (!visible.length) $('posts').append(el('p', 'Δεν υπάρχουν δημοσιεύσεις σε αυτή την κατάσταση.'));
}
function photoGrid() {
	const property = bootstrap.feed.listings.find(p => p.id === active.property_id) || active.snapshot;
	$('photos').replaceChildren(...property.images.map((url, i) => {
		const b = el('button', null, 'photo'); b.type = 'button'; b.disabled = !editable();
		const img = el('img'); img.src = url; img.alt = `Φωτογραφία ακινήτου ${i + 1}`; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
		const index = selected.indexOf(url); b.setAttribute('aria-pressed', String(index >= 0));
		b.append(img, el('span', index >= 0 ? `Επιλογή ${index + 1}` : 'Επιλογή'));
		b.onclick = () => { if (!editable() || busy) return; if (index >= 0) selected.splice(index, 1); else if (selected.length < 10) selected.push(url); else { $('message').textContent = 'Έως 10 φωτογραφίες ανά δημοσίευση.'; return; } dirty = true; photoGrid(); controls(); };
		return b;
	}));
	$('order').replaceChildren(...selected.map((url, i) => {
		const b = el('button', `← ${i + 1}`); b.type = 'button'; b.title = `Μετακίνηση φωτογραφίας ${i + 1} αριστερά`;
		b.disabled = !editable() || i === 0;
		b.onclick = () => { if (!editable() || busy || i === 0) return; [selected[i - 1], selected[i]] = [url, selected[i - 1]]; dirty = true; photoGrid(); controls(); };
		return b;
	}));
}
async function openPost(id) {
	active = await api(`/posts/${id}`); selected = [...active.photos]; dirty = false;
	$('empty').hidden = true; $('editor').hidden = false;
	$('post-title').textContent = `${active.snapshot.code} · ${active.channel}`;
	$('status').textContent = labels[active.status];
	$('post-info').textContent = [active.snapshot.title, active.approved_by ? `Έγκριση: ${active.approved_by}` : '', active.scheduled_at ? `Προγραμματισμός: ${new Date(active.scheduled_at).toLocaleString('el-GR')}` : '', active.remote_id ? `Meta ID: ${active.remote_id}` : '', active.error ? (errors[active.error] || active.error) : ''].filter(Boolean).join(' · ');
	$('caption').value = active.caption; $('template').value = active.template;
	photoGrid(); postList();
	$('preview').hidden = !active.assets.length;
	$('renders').replaceChildren(...active.assets.map((url, i) => {
		const a = el('a', `Λήψη εικόνας ${i + 1}`); a.href = url; a.download = `fourwalls-${i + 1}.jpg`;
		const img = el('img'); img.src = `${url}?revision=${active.revision}`; img.alt = `Τελική εικόνα ${i + 1}`; a.prepend(img); return a;
	}));
	const events = await api(`/posts/${id}/history`);
	$('history').replaceChildren(...events.map(e => el('li', `${new Date(e.created_at).toLocaleString('el-GR')} · ${labels[e.kind] || eventLabels[e.kind] || e.kind} · ${e.actor}${e.detail ? ` · ${e.detail}` : ''}`)));
	controls();
}
async function reload() {
	bootstrap = await api('/bootstrap'); posts = (await api('/posts')).posts;
	$('identity').textContent = bootstrap.actor;
	$('mode').textContent = bootstrap.live ? 'Η δημοσίευση Meta είναι ενεργή. Μόνο εγκεκριμένες, προγραμματισμένες δημοσιεύσεις αποστέλλονται.' : 'Η ζωντανή δημοσίευση είναι απενεργοποιημένη. Μπορείτε να ετοιμάσετε και να εγκρίνετε περιεχόμενο· τα προγραμματισμένα posts περιμένουν ενεργοποίηση.';
	if (bootstrap.feed.source === 'sample') $('mode').textContent = 'Δοκιμαστικά δεδομένα · Δεν γίνεται δημοσίευση. Η δημιουργία εικόνων απαιτεί τις υπηρεσίες Cloudflare.';
	$('feed-time').textContent = `Συγχρονισμός CRM: ${new Date(bootstrap.feed.generatedAt).toLocaleString('el-GR')}`;
	propertyOptions(); postList(); if (active) await openPost(active.id);
}
async function action(name, fields = {}) {
	await api(`/posts/${active.id}/${name}`, 'POST', { revision: active.revision, ...fields });
	await reload();
}
$('refresh').onclick = () => task(async () => { if (dirty) throw new Error('Αποθηκεύστε τις αλλαγές πριν την ανανέωση.'); await reload(); });
$('property-search').oninput = propertyOptions; $('filter').onchange = postList;
$('create').onclick = () => task(async () => {
	if (dirty) throw new Error('Αποθηκεύστε πρώτα τις αλλαγές.');
	const post = await api('/posts', 'POST', { property_id: $('property').value, channel: $('new-channel').value, template: 'square' });
	posts = (await api('/posts')).posts; await openPost(post.id);
});
for (const id of ['caption', 'template']) $(id).oninput = () => { dirty = true; controls(); };
$('save').onclick = () => task(async () => {
	await api(`/posts/${active.id}`, 'PATCH', { revision: active.revision, channel: active.channel, template: $('template').value, caption: $('caption').value, photos: selected });
	await reload();
});
for (const name of ['submit', 'approve', 'cancel']) $(name).onclick = () => task(() => action(name));
$('timezone').textContent = `Ημερομηνία και ώρα (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
$('schedule').onclick = () => task(async () => {
	const at = new Date($('schedule-time').value);
	if (!Number.isFinite(at.getTime())) throw new Error('Επιλέξτε ημερομηνία και ώρα.');
	await action('schedule', { at: at.toISOString() });
});
$('resolve-published').onclick = () => task(() => action('resolve', { outcome: 'published', remote_id: $('remote-id').value.trim() }));
$('resolve-cancelled').onclick = () => task(() => action('resolve', { outcome: 'cancelled' }));
$('package').onclick = () => task(async () => {
	const response = await fetch(`/api/social/posts/${active.id}/package`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: active.revision }) });
	if (!response.ok) { const error = await response.json(); throw new Error(errors[error.error] || error.error); }
	const url = URL.createObjectURL(await response.blob());
	const a = el('a'); a.href = url; a.download = `fourwalls-marketplace-${active.snapshot.code || active.id}.zip`; a.click();
	setTimeout(() => URL.revokeObjectURL(url), 60000); await openPost(active.id);
});
task(reload);
