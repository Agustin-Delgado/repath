// Makes the raster files and the page of the guidelines from the vector files, with a headless
// browser. Run after tools/build.py, with the app's dependencies installed (`npm ci` in web/):
//
//   node tools/make.cjs
const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');
// The browser comes from the app's own `playwright`, already a dev dependency of web/.
const { chromium } = require(join(__dirname, '..', '..', 'web', 'node_modules', 'playwright'));

const ROOT = join(__dirname, '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const assets = JSON.parse(read('tools', 'assets.json'));
const c = assets.colours;

// An .ico that holds PNG pictures: each entry is 16 bytes, then the files follow.
function ico(pictures) {
	const header = Buffer.alloc(6 + 16 * pictures.length);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(pictures.length, 4);
	let offset = header.length;
	pictures.forEach(({ size, data }, i) => {
		const at = 6 + 16 * i;
		header.writeUInt8(size === 256 ? 0 : size, at);
		header.writeUInt8(size === 256 ? 0 : size, at + 1);
		header.writeUInt16LE(1, at + 4);
		header.writeUInt16LE(32, at + 6);
		header.writeUInt32LE(data.length, at + 8);
		header.writeUInt32LE(offset, at + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...pictures.map((p) => p.data)]);
}

// Inline copies of the files, with ids made unique so several can share one page.
let uid = 0;
const inline = (folder, file, style = '') => {
	const n = ++uid;
	return read(folder, file)
		.replace(/id="(\w+)"/g, `id="$1${n}"`)
		.replace(/url\(#(\w+)\)/g, `url(#$1${n})`)
		.replace('<svg ', `<svg style="${style}" `);
};

const dots = (colour) =>
	`background-image:radial-gradient(${colour} 1.2px,transparent 1.6px);background-size:24px 24px;background-position:12px 12px`;

// The card a link to repath unfolds into: 1200 x 630.
const social = () => `<!doctype html><meta charset="utf-8"><body style="margin:0;width:1200px;height:630px;background:${c.night};${dots('#232936')};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:44px;font-family:system-ui,sans-serif">
	${inline('logo', 'repath-logo.svg', 'height:150px')}
	<div style="color:#8b96aa;font-size:34px;letter-spacing:-0.01em">A free circuit simulator that runs in your browser</div>
</body>`;

const swatch = (name, hex, use, dark) =>
	`<div class="swatch"><span style="background:${hex};${dark ? 'box-shadow:inset 0 0 0 1px #2c3442' : 'box-shadow:inset 0 0 0 1px #dfe3ea'}"></span><b>${name}</b><code>${hex}</code><small>${use}</small></div>`;

const wrong = (label, body) => `<div class="wrong"><div class="stage night">${body}</div><span>${label}</span></div>`;
const MARK = assets.mark.d;
const path = (more) => `<path d="${MARK}" fill="none" stroke-linecap="round" stroke-linejoin="round" ${more}/>`;
const bareSvg = (inner, defs = '') => `<svg viewBox="24 16 96 96" style="height:84px"><defs>${defs}</defs>${inner}</svg>`;

const guidelines = () => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>repath brand</title>
<link rel="icon" href="favicon/favicon.svg">
<style>
	:root{--ink:${c.ink};--night:${c.night};--paper:${c.paper};--snow:${c.snow};--rule:#dfe3ea;--muted:#5b6474}
	*{box-sizing:border-box}
	body{margin:0;background:#fff;color:var(--ink);font:16px/1.55 'Geist Variable',Geist,system-ui,-apple-system,'Segoe UI',sans-serif}
	main{max-width:980px;margin:0 auto;padding:0 24px 96px}
	header{background:var(--night);${dots('#232936')};color:var(--snow);padding:88px 24px 80px;display:flex;flex-direction:column;align-items:center;gap:28px;text-align:center}
	header p{margin:0;color:#8b96aa;max-width:520px}
	h2{font-size:22px;letter-spacing:-0.02em;margin:72px 0 6px}
	h2 small{color:var(--muted);font-weight:400;font-size:14px;margin-right:10px}
	p{margin:0 0 18px;max-width:680px;color:#2b3342}
	code{font:13px ui-monospace,'Geist Mono Variable',Consolas,monospace;background:#f1f3f6;padding:1px 5px;border-radius:4px}
	.row{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:22px 0}
	.stage{display:flex;align-items:center;justify-content:center;min-height:168px;padding:28px;border-radius:10px}
	.night{background:var(--night);color:var(--snow)}
	.day{background:var(--paper)}
	.white{background:#fff;box-shadow:inset 0 0 0 1px var(--rule)}
	.blue{background:${c.blue}}
	figure{margin:0}figcaption{font-size:13px;color:var(--muted);padding-top:8px}
	.swatch{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;align-items:center}
	.swatch span{grid-row:span 3;width:64px;height:64px;border-radius:10px}
	.swatch code{justify-self:start}.swatch small{color:var(--muted)}
	.sizes{display:flex;align-items:flex-end;gap:18px}
	.wrong span{display:block;font-size:13px;color:var(--muted);padding-top:8px}
	.wrong .stage{min-height:140px;position:relative}
	.wrong .stage::after{content:'';position:absolute;inset:10px;border-radius:6px;background:linear-gradient(to top right,transparent calc(50% - 1px),#ff6b7a calc(50% - 1px),#ff6b7a calc(50% + 1px),transparent calc(50% + 1px));opacity:.55}
	table{border-collapse:collapse;width:100%;font-size:14px;margin:18px 0}
	td,th{text-align:left;padding:8px 12px 8px 0;border-bottom:1px solid var(--rule);vertical-align:top}
	th{font-weight:600;color:var(--muted);font-size:13px}
	.build{position:relative}
</style>
<header>
	${inline('logo', 'repath-logo.svg', 'height:84px;max-width:100%')}
	<p>The identity of repath: one mark, one name, two colours. This page is the whole of it.</p>
</header>
<main>

<h2><small>01</small>The mark</h2>
<p>A lowercase <b>r</b> whose arm is a step response: the signal rises, overshoots, rings and settles. It is the picture a circuit simulator exists to draw, and it is the first letter of the name. One stroke, nothing else.</p>
<div class="row">
	<figure><div class="stage night">${inline('icon', 'repath-icon.svg', 'height:128px')}</div><figcaption>The icon: the mark on its tile. The main form.</figcaption></figure>
	<figure><div class="stage night">${inline('mark', 'repath-mark.svg', 'height:112px')}</div><figcaption>The mark alone, on a dark ground.</figcaption></figure>
	<figure><div class="stage day">${inline('mark', 'repath-mark-day.svg', 'height:112px')}</div><figcaption>The mark alone, on a light ground.</figcaption></figure>
</div>

<h2><small>02</small>Construction</h2>
<p>The mark is drawn on a grid of 128 units. The stroke is 7 units wide with round caps and round joins. The stem stands at x&nbsp;=&nbsp;36 and the arm settles at y&nbsp;=&nbsp;43, a third of the way down from the first peak. Never redraw it: take the path from the files.</p>
<div class="row">
	<figure><div class="stage white"><svg viewBox="0 0 128 128" style="height:260px">
		<g stroke="#dfe3ea" stroke-width=".5">${Array.from({ length: 9 }, (_, i) => `<path d="M${i * 16} 0v128M0 ${i * 16}h128"/>`).join('')}</g>
		<path d="M36 6v116M4 43h120M4 102h120" stroke="${c.blueDay}" stroke-width=".6" stroke-dasharray="2 2"/>
		${path(`stroke="${c.ink}" stroke-width="7" stroke-opacity=".9"`)}
		${path(`stroke="#fff" stroke-width=".7"`)}
	</svg></div><figcaption>Grid of 16 units. Dashed: the stem, the foot, and the level the arm settles on.</figcaption></figure>
	<figure><div class="stage white"><code style="white-space:pre-wrap;word-break:break-all;max-width:300px;background:none">${MARK}

stroke-width  7
linecap       round
linejoin      round
gradient      x 40 → 104
              25 % blue, 100 % green</code></div><figcaption>The whole drawing.</figcaption></figure>
</div>

<h2><small>03</small>Colour</h2>
<p>Two colours, and they mean something: <b>Signal blue</b> is the response while it moves, <b>Settled green</b> is where it comes to rest. The stroke runs from one to the other, left to right. Each has a darker twin for light grounds. Everything else is ink, paper and night.</p>
<div class="row">
	${swatch('Signal blue', c.blue, 'The mark, on dark', true)}
	${swatch('Settled green', c.green, 'End of the stroke, on dark', true)}
	${swatch('Signal blue, day', c.blueDay, 'The mark, on light', false)}
	${swatch('Settled green, day', c.greenDay, 'End of the stroke, on light', false)}
</div>
<div class="row">
	${swatch('Night', c.night, 'The ground the brand lives on', true)}
	${swatch('Ink', c.ink, 'The name on light grounds', true)}
	${swatch('Snow', c.snow, 'The name on dark grounds', false)}
	${swatch('Paper', c.paper, 'Light grounds', false)}
</div>

<h2><small>04</small>The name</h2>
<p>Always <b>repath</b>, lowercase, one word — also at the start of a sentence. Set in Geist, weight 600, tracking −0.035&nbsp;em. In the logo files it is outlines, so nothing needs the font.</p>
<div class="row">
	<figure><div class="stage night">${inline('wordmark', 'repath-wordmark-snow.svg', 'height:52px')}</div></figure>
	<figure><div class="stage day">${inline('wordmark', 'repath-wordmark-ink.svg', 'height:52px')}</div></figure>
</div>

<h2><small>05</small>The logo</h2>
<p>The mark and the name on one line. The mark stands on the baseline of the name and is 1.16 times as tall as the <b>h</b>; the space between them is 0.15 em of the type. The two are never set in any other arrangement: when there is no room for the line, use the icon.</p>
<div class="row">
	<figure><div class="stage night">${inline('logo', 'repath-logo.svg', 'height:58px')}</div><figcaption>On dark. The main one.</figcaption></figure>
	<figure><div class="stage day">${inline('logo', 'repath-logo-day.svg', 'height:58px')}</div><figcaption>On light.</figcaption></figure>
</div>
<div class="row">
	<figure><div class="stage white">${inline('logo', 'repath-logo-ink.svg', 'height:44px')}</div><figcaption>One colour, ink.</figcaption></figure>
	<figure><div class="stage night">${inline('logo', 'repath-logo-paper.svg', 'height:44px')}</div><figcaption>One colour, white.</figcaption></figure>
	<figure><div class="stage blue">${inline('logo', 'repath-logo-ink.svg', 'height:44px')}</div><figcaption>On a colour: one colour only.</figcaption></figure>
</div>

<h2><small>06</small>Space and size</h2>
<p>Keep a clear space around the logo and the icon of three stroke widths (21 units of the grid). The logo is never smaller than 20&nbsp;px tall; under that, use the icon. The glow belongs to the icon at 48&nbsp;px and over, on dark, and nowhere else.</p>
<p>At 32&nbsp;px and under the stroke would thin out to less than two pixels, so the <b>small cut</b> takes over: the same path with a stroke of 10.5 units and no glow. The favicon is the small cut.</p>
<div class="row">
	<figure><div class="stage night"><div class="sizes">${[96, 64, 48].map((n) => inline('icon', 'repath-icon.svg', `height:${n}px`)).join('')}</div></div><figcaption>The icon: 48 px and over.</figcaption></figure>
	<figure><div class="stage night"><div class="sizes">${[32, 24, 16].map((n) => inline('icon', 'repath-icon-small.svg', `height:${n}px`)).join('')}</div></div><figcaption>The small cut: 32 px and under.</figcaption></figure>
	<figure><div class="stage day"><div class="sizes">${[64, 32, 16].map((n, i) => inline('icon', i ? 'repath-icon-small.svg' : 'repath-icon-light.svg', `height:${n}px`)).join('')}</div></div><figcaption>The dark tile also goes on light grounds. The light tile is for print and light-only places.</figcaption></figure>
</div>

<h2><small>07</small>Not like this</h2>
<div class="row">
	${wrong('Do not turn the gradient round or change its colours.', bareSvg(path('stroke="url(#w1)" stroke-width="7"'), `<linearGradient id="w1" x1="40" x2="104" gradientUnits="userSpaceOnUse"><stop offset=".25" stop-color="#ff6b7a"/><stop offset="1" stop-color="#ffd400"/></linearGradient>`))}
	${wrong('Do not change the weight of the stroke.', bareSvg(path(`stroke="${c.blue}" stroke-width="2.5"`)))}
	${wrong('Do not stretch, slant or turn it.', `<div style="transform:scaleX(1.5) skewX(-14deg)">${bareSvg(path(`stroke="${c.blue}" stroke-width="7"`))}</div>`)}
	${wrong('Do not write the name in capitals or in another type.', `<span style="font:700 34px Georgia,serif;color:${c.snow}">RePath</span>`)}
</div>

<h2><small>08</small>Files</h2>
<table>
	<tr><th>Folder</th><th>What</th><th>Use</th></tr>
	<tr><td><code>logo/</code></td><td>Mark and name: colour for dark, <code>-day</code>, <code>-ink</code>, <code>-paper</code>, <code>-current</code></td><td>Headers, the README, slides</td></tr>
	<tr><td><code>mark/</code></td><td>The r alone, in the same five colourings</td><td>Inside the app, next to text</td></tr>
	<tr><td><code>icon/</code></td><td>The r on its tile: dark, light, and the small cut</td><td>App icon, avatars</td></tr>
	<tr><td><code>wordmark/</code></td><td>The name alone</td><td>Where the mark is already near</td></tr>
	<tr><td><code>favicon/</code></td><td><code>favicon.svg</code>, <code>favicon.ico</code>, <code>apple-touch-icon.png</code>, <code>icon-192.png</code>, <code>icon-512.png</code>, <code>icon-maskable-512.png</code></td><td>The site</td></tr>
	<tr><td><code>social/</code></td><td><code>og.png</code> (1200 × 630), <code>avatar-512.png</code></td><td>Link previews, profile pictures</td></tr>
	<tr><td><code>tools/</code></td><td><code>build.py</code> and <code>make.cjs</code></td><td>Rebuild every file from the one drawing</td></tr>
</table>
<p><code>-current</code> files take the colour of the text around them (<code>currentColor</code>): the ones to inline in a page.</p>

</main>
</html>
`;

(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	const shot = async (svg, size) => {
		await page.setViewportSize({ width: size, height: size });
		await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
		return page.screenshot({ omitBackground: true });
	};
	const out = (folder, file, data) => {
		mkdirSync(join(ROOT, folder), { recursive: true });
		writeFileSync(join(ROOT, folder, file), data);
	};

	const small = read('favicon', 'favicon.svg');
	const square = read('favicon', 'square.svg');
	const icon = read('icon', 'repath-icon.svg');
	const pictures = [];
	for (const size of [16, 32, 48]) pictures.push({ size, data: await shot(small, size) });
	out('favicon', 'favicon.ico', ico(pictures));
	out('favicon', 'apple-touch-icon.png', await shot(square, 180));
	out('favicon', 'icon-192.png', await shot(icon, 192));
	out('favicon', 'icon-512.png', await shot(icon, 512));
	out('favicon', 'icon-maskable-512.png', await shot(read('favicon', 'maskable.svg'), 512));
	out('social', 'avatar-512.png', await shot(square, 512));

	await page.setViewportSize({ width: 1200, height: 630 });
	await page.setContent(social());
	out('social', 'og.png', await page.screenshot());

	writeFileSync(join(ROOT, 'index.html'), guidelines());
	await page.setViewportSize({ width: 1100, height: 900 });
	await page.goto(`file:///${join(ROOT, 'index.html').split('\\').join('/').replace(/ /g, '%20')}`);
	await page.screenshot({ path: join(ROOT, 'tools', 'preview.png'), fullPage: true });
	await browser.close();
	console.log('done');
})();
