/**
 * What floats over the app — menus, select lists — and the rows inside it.
 * Shared so a menu and a select read as one family.
 */
export const floatingSurface =
	'z-50 min-w-40 rounded-md border border-border bg-panel p-1 text-ui text-fg shadow-xl shadow-black/40 outline-none';

export const floatingItem = [
	'flex h-7 cursor-default select-none items-center gap-2 rounded px-2 text-strong outline-none',
	'data-[highlighted]:bg-hover data-[highlighted]:text-fg',
	'data-[focused]:bg-hover data-[focused]:text-fg',
	'data-[selected]:text-fg',
	'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
	'[&_svg]:size-3.5 [&_svg]:shrink-0'
].join(' ');
