import type { VariantProps } from 'tailwind-variants';
import { tv } from '../tv';

/**
 * The one look every pressable thing in the app shares. Menu triggers and
 * select triggers are buttons too, so they take their chrome from here rather
 * than growing their own.
 */
export const buttonVariants = tv({
	base: [
		'relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5',
		'whitespace-nowrap rounded-control border font-[inherit] leading-none outline-none',
		'transition-colors duration-100',
		'data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent/60',
		'disabled:cursor-not-allowed disabled:opacity-50 data-[pending]:cursor-progress data-[pending]:opacity-60',
		'[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0'
	],
	variants: {
		variant: {
			/** The ordinary control: a raised chip on the panel. */
			default:
				'border-border bg-control text-fg data-[hovered]:bg-hover data-[pressed]:bg-hover',
			/** The one thing on the screen the user came to press. */
			primary:
				'border-accent bg-accent font-semibold text-accent-fg data-[hovered]:bg-accent/90',
			/** Quiet until touched: toolbar icons, dismiss crosses. */
			ghost:
				'border-transparent bg-transparent text-muted data-[hovered]:bg-hover data-[hovered]:text-fg'
		},
		size: {
			default: 'h-7 px-2.5 text-ui',
			sm: 'h-6 px-2 text-2xs',
			icon: 'size-7 px-0',
			/** A finger's width, for the phone bar. */
			touch: 'min-h-10 px-3 text-ui'
		},
		/** Lit while a mode the button controls is on. */
		active: {
			true: 'border-accent bg-accent/15 text-fg data-[hovered]:bg-accent/25',
			false: ''
		}
	},
	compoundVariants: [
		// Primary turned on reads as the live state; turning it off should not look
		// like the same invitation, so it steps back to an outline.
		{
			variant: 'primary',
			active: true,
			class: 'bg-transparent text-accent data-[hovered]:bg-accent/10'
		}
	],
	defaultVariants: { variant: 'default', size: 'default', active: false }
});

export type ButtonVariants = VariantProps<typeof buttonVariants>;
