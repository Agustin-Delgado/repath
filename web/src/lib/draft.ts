/**
 * Keeping the work in progress.
 *
 * A circuit being drawn lives in one tab's memory, and a tab is closed by
 * accident, reloaded by habit and killed along with everything else when the
 * power goes. So every change is written down as it happens — debounced, not
 * batched to some later save — and the next time the app opens it starts from
 * there.
 *
 * Kept in IndexedDB rather than `localStorage` for one reason: a transaction
 * can ask to be `strict`, which means it has reached the disk when it reports
 * that it is done. `localStorage` is written back to disk whenever the browser
 * gets round to it, which is seconds later — exactly the seconds a power cut
 * takes.
 *
 * Each tab keeps its own draft, named in `sessionStorage` so a reload finds it
 * again, and holds a lock on it so a second tab never writes over the first.
 * A draft remembers the link it came from, which is how a reload after
 * sharing keeps the twenty changes made since instead of going back to what
 * the link says: the changes are newer, and they are yours.
 */

/** One draft as stored. `doc` is the serialised editor, kept as text so a save can be skipped when nothing changed. */
export interface DraftRecord {
	id: string;
	savedAt: number;
	/** The share fragment this draft continues from, `#` included, or empty. */
	origin: string;
	/** Whether it has moved on from what `origin` holds. */
	edited: boolean;
	doc: string;
}

export interface DraftStore {
	all(): Promise<DraftRecord[]>;
	put(record: DraftRecord): Promise<void>;
	remove(id: string): Promise<void>;
}

/**
 * How many drafts are kept, newest first.
 *
 * A new one starts whenever a whole circuit arrives — an example, a file, a
 * link — so what was on screen before is still there to go back to. Twenty is
 * a few days of that, and each is a circuit's worth of text.
 */
export const DRAFTS_KEPT = 20;

const DB_NAME = 'repath';
const STORE = 'drafts';

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('The save was aborted.'));
	});
}

/** The browser's store, or null where there is none (a private window in some browsers, a test). */
export async function openDraftStore(): Promise<DraftStore | null> {
	if (typeof indexedDB === 'undefined') return null;
	let db: IDBDatabase;
	try {
		const opening = indexedDB.open(DB_NAME, 1);
		opening.onupgradeneeded = () => {
			if (!opening.result.objectStoreNames.contains(STORE)) {
				opening.result.createObjectStore(STORE, { keyPath: 'id' });
			}
		};
		db = await request(opening);
	} catch {
		return null;
	}
	return {
		async all() {
			const tx = db.transaction(STORE, 'readonly');
			return (await request(tx.objectStore(STORE).getAll())) as DraftRecord[];
		},
		async put(record) {
			const tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
			tx.objectStore(STORE).put(record);
			await done(tx);
		},
		async remove(id) {
			const tx = db.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).delete(id);
			await done(tx);
		}
	};
}

/** A store that forgets on reload. For tests, and for a browser that refuses IndexedDB. */
export function memoryDraftStore(): DraftStore & { records: Map<string, DraftRecord> } {
	const records = new Map<string, DraftRecord>();
	return {
		records,
		async all() {
			return [...records.values()].map((r) => ({ ...r }));
		},
		async put(record) {
			records.set(record.id, { ...record });
		},
		async remove(id) {
			records.delete(id);
		}
	};
}

/** What the app opens on. */
export type Start =
	| { kind: 'draft'; record: DraftRecord; /** Set when a link was followed and a newer draft of it won. */ over?: string }
	| { kind: 'link' }
	| { kind: 'empty' };

const newest = (records: readonly DraftRecord[]) =>
	records.reduce<DraftRecord | undefined>((a, b) => (a && a.savedAt >= b.savedAt ? a : b), undefined);

/**
 * Decide what the app opens on.
 *
 * In order: this tab's own draft, because a reload is the same tab carrying on
 * — unless the address bar holds some other link, which was put there on
 * purpose; then a link, unless there is a draft that continues it, which is newer by
 * construction; then the most recent draft of all, because opening the app
 * again after it was closed is carrying on too; and only then an empty sheet.
 *
 * A link with no draft behind it is someone else's circuit, or one of yours
 * opened somewhere new, and it is loaded as sent.
 */
export function chooseStart(
	records: readonly DraftRecord[],
	tabDraft: string | null,
	hash: string
): Start {
	const own = tabDraft ? records.find((r) => r.id === tabDraft) : undefined;
	// A different link in this tab's address bar was put there on purpose.
	if (own && (!hash || own.origin === hash)) return { kind: 'draft', record: own };
	if (hash) {
		const continued = newest(records.filter((r) => r.origin === hash));
		if (!continued) return { kind: 'link' };
		return continued.edited
			? { kind: 'draft', record: continued, over: hash }
			: { kind: 'draft', record: continued };
	}
	const last = newest(records);
	return last ? { kind: 'draft', record: last } : { kind: 'empty' };
}

/** Ids to delete so only the newest `kept` remain, never touching the ones in `keep`. */
export function staleDrafts(
	records: readonly DraftRecord[],
	keep: ReadonlySet<string>,
	kept = DRAFTS_KEPT
): string[] {
	return [...records]
		.sort((a, b) => b.savedAt - a.savedAt)
		.slice(kept)
		.filter((r) => !keep.has(r.id))
		.map((r) => r.id);
}

export const newDraftId = () =>
	`d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Writes one tab's draft as it changes.
 *
 * Debounced so a drag does not write on every frame, with a ceiling so a drag
 * that goes on for a long time is still written while it goes. What is handed
 * over is the editor's state as an object; it is only turned into text when it
 * is written, so the frames in between cost nothing but the handing over.
 */
export class Autosaver {
	private pending: unknown = undefined;
	private hasPending = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private firstPendingAt = 0;
	private lastDoc: string | null;
	/**
	 * What the draft held when `origin` was set, to tell whether it has moved on.
	 * `undefined` until the first write, for a draft that starts out as the link.
	 */
	private originDoc: string | null | undefined;
	private writing: Promise<void> = Promise.resolve();
	private failed = false;

	constructor(
		private readonly store: DraftStore,
		private current: { id: string; origin: string; edited: boolean; doc: string | null },
		private readonly options: {
			delay?: number;
			maxWait?: number;
			now?: () => number;
			/** Called once, the first time a write fails. */
			onError?: (cause: unknown) => void;
			/** Whether a document is empty, so an untouched empty sheet is never stored. */
			isEmpty?: (doc: unknown) => boolean;
		} = {}
	) {
		this.lastDoc = current.doc;
		this.originDoc = !current.origin || current.edited ? null : (current.doc ?? undefined);
	}

	get id(): string {
		return this.current.id;
	}

	/** The link this draft continues, or empty. */
	get origin(): string {
		return this.current.origin;
	}

	private get now(): number {
		return (this.options.now ?? Date.now)();
	}

	schedule(doc: unknown): void {
		const delay = this.options.delay ?? 300;
		const maxWait = this.options.maxWait ?? 1500;
		if (!this.hasPending) this.firstPendingAt = this.now;
		this.pending = doc;
		this.hasPending = true;
		clearTimeout(this.timer);
		const waited = this.now - this.firstPendingAt;
		this.timer = setTimeout(() => void this.flush(), Math.max(0, Math.min(delay, maxWait - waited)));
	}

	/** Write what is pending now. Resolves once it is on disk, or has failed. */
	flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.hasPending) return this.writing;
		const doc = this.pending;
		this.pending = undefined;
		this.hasPending = false;

		const text = JSON.stringify(doc);
		if (text === this.lastDoc) return this.writing;
		// An empty sheet nobody has drawn on is not a draft. One that was cleared
		// is — otherwise a reload would bring back what was just thrown away.
		if (this.lastDoc === null && this.options.isEmpty?.(doc)) return this.writing;
		this.lastDoc = text;
		if (this.originDoc === undefined) this.originDoc = text;
		const record: DraftRecord = {
			id: this.current.id,
			origin: this.current.origin,
			edited: this.current.origin !== '' && text !== this.originDoc,
			savedAt: this.now,
			doc: text
		};
		this.current.edited = record.edited;
		// One write at a time, in order, so an older state can never land last.
		this.writing = this.writing.then(() =>
			this.store.put(record).catch((cause) => {
				if (this.failed) return;
				this.failed = true;
				this.options.onError?.(cause);
			})
		);
		return this.writing;
	}

	/**
	 * Say which link this draft now continues: the one just shared.
	 *
	 * What is on screen is exactly what the link holds, so the draft is not
	 * ahead of it until the next change.
	 */
	async setOrigin(origin: string, doc: unknown): Promise<void> {
		await this.flush();
		const text = JSON.stringify(doc);
		this.current.origin = origin;
		this.originDoc = text;
		this.lastDoc = null;
		this.schedule(doc);
		await this.flush();
	}

	/**
	 * Start a new draft, leaving the current one as it stands.
	 *
	 * For when a whole circuit replaces the one on screen: the one being
	 * replaced was somebody's work.
	 */
	fork(id: string, origin: string, doc: unknown): void {
		// Whatever is pending was the old circuit, so it goes under the old name.
		void this.flush();
		this.current = { id, origin, edited: false, doc: null };
		this.lastDoc = null;
		this.originDoc = origin ? JSON.stringify(doc) : null;
		this.schedule(doc);
	}
}
