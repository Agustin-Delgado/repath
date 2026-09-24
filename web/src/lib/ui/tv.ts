import { createTV } from 'tailwind-variants';

/**
 * `tv`, told about the theme's own font sizes.
 *
 * tailwind-merge only knows Tailwind's stock scale, so it reads `text-ui` as a
 * colour and drops it the moment a real colour like `text-fg` comes along — or
 * the other way round. Every recipe in `$lib/ui` goes through this one.
 */
export const tv = createTV({
	twMergeConfig: {
		extend: {
			theme: {
				text: ['2xs', 'ui']
			}
		}
	}
});
