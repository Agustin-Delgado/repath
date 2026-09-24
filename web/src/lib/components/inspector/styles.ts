/** The inspector's own vocabulary, so every panel in it reads alike. */

export const fieldLabel = 'text-[0.68rem] text-muted';

/** The box a value sits in; `data-rejected` turns it red while a refusal stands. */
export const fieldBox =
	'flex h-7 w-full items-center rounded-control border border-border bg-control text-ui text-fg focus-within:border-accent/70 data-[rejected]:border-danger';

export const fieldInput =
	'h-full min-w-0 flex-1 border-0 bg-transparent px-2 font-mono text-ui text-fg outline-none';

export const sectionTitle =
	'm-0 text-[0.62rem] font-semibold tracking-[0.08em] text-muted uppercase';

export const hint = 'm-0 text-[0.7rem] leading-relaxed text-muted';

export const problem = 'm-0 text-[0.68rem] leading-snug text-danger';
