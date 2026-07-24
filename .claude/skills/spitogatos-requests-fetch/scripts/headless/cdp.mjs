// Minimal CDP client for the dedicated Edge instance on :9222 (no deps; node>=22 for WebSocket).
// Launch Edge first — see "Headless mode" in SKILL.md.
const BASE = 'http://127.0.0.1:9222';

export async function listTabs() {
	return (await fetch(BASE + '/json/list')).json();
}

export class Tab {
	static async open(url) {
		const r = await fetch(BASE + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
		return Tab.attach(await r.json());
	}
	static async find(urlPrefix) {
		const tabs = await listTabs();
		const t = tabs.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix));
		return t ? Tab.attach(t) : null;
	}
	static attach(info) {
		const tab = new Tab();
		tab.info = info;
		tab.ws = new WebSocket(info.webSocketDebuggerUrl);
		tab.msgId = 0;
		tab.pending = new Map();
		tab.ready = new Promise((res, rej) => {
			tab.ws.addEventListener('open', () => res());
			tab.ws.addEventListener('error', () => rej(new Error('ws error')));
		});
		tab.ws.addEventListener('message', (ev) => {
			const m = JSON.parse(ev.data);
			if (m.id && tab.pending.has(m.id)) {
				const { res, rej } = tab.pending.get(m.id);
				tab.pending.delete(m.id);
				m.error ? rej(new Error(m.error.message)) : res(m.result);
			}
		});
		return tab;
	}
	async send(method, params = {}) {
		await this.ready;
		const id = ++this.msgId;
		return new Promise((res, rej) => {
			this.pending.set(id, { res, rej });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	// Evaluate JS in the page; awaits promises; returns the JSON value. Throws on page exception.
	async eval(expression, { timeoutMs = 120000 } = {}) {
		const r = await this.send('Runtime.evaluate', {
			expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
		});
		if (r.exceptionDetails) {
			const d = r.exceptionDetails;
			throw new Error('page exception: ' + (d.exception?.description || d.text));
		}
		return r.result.value;
	}
	async navigate(url, { waitMs = 45000 } = {}) {
		await this.send('Page.enable');
		await this.send('Page.navigate', { url });
		const t0 = Date.now();
		while (Date.now() - t0 < waitMs) {
			await sleep(500);
			try {
				if ((await this.eval('document.readyState')) === 'complete') return;
			} catch { /* mid-navigation */ }
		}
		throw new Error('navigate timeout: ' + url);
	}
	// Real-input helpers (some login forms ignore synthetic .value writes).
	async clickSel(sel) {
		const p = await this.eval(`(()=>{ const el=document.querySelector(${JSON.stringify(sel)});
			if(!el) return null; el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect();
			return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
		if (!p) return false;
		for (const type of ['mousePressed', 'mouseReleased'])
			await this.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
		return true;
	}
	async typeSel(sel, value) {
		if (!(await this.clickSel(sel))) throw new Error('no element: ' + sel);
		await sleep(300);
		await this.eval(`document.querySelector(${JSON.stringify(sel)}).value=''`);
		await this.send('Input.insertText', { text: value });
		await sleep(300);
	}
	close() { try { this.ws.close(); } catch {} }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll an in-page condition until truthy or timeout; returns last value.
export async function waitFor(tab, expr, { timeoutMs = 60000, everyMs = 1000, label = expr } = {}) {
	const t0 = Date.now();
	let last;
	while (Date.now() - t0 < timeoutMs) {
		try { last = await tab.eval(expr); if (last) return last; } catch { /* mid-navigation */ }
		await sleep(everyMs);
	}
	throw new Error(`waitFor timeout (${label}); last=${JSON.stringify(last)}`);
}
