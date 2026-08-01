/**
 * Drawing primitives on top of a 2D context.
 *
 * Two coordinate spaces, switched explicitly:
 *
 * - **World** — what the schematic is drawn in. The viewport transform is baked
 *   into the context, so a resistor is always drawn at the same coordinates
 *   whatever the zoom.
 * - **Screen** — CSS pixels. Used for anything that must not scale: text, the
 *   grid, selection handles.
 *
 * Stroke widths are always given in *screen* pixels and converted internally, so
 * a 2 px wire stays 2 px whether you are zoomed to 25% or 400%. Text is drawn in
 * screen space on purpose: scaling a rasterized glyph is what makes canvas text
 * look muddy, and going through screen space avoids it entirely.
 */

import type { Rect, Vec2 } from './geometry';
import type { Viewport } from './viewport';

export interface StrokeStyle {
	color: string;
	/** Screen pixels. */
	width?: number;
	/** Dash pattern in screen pixels. */
	dash?: readonly number[];
	cap?: CanvasLineCap;
	join?: CanvasLineJoin;
	alpha?: number;
}

export interface FillStyle {
	color: string;
	alpha?: number;
}

export interface TextStyle {
	/** Screen pixels. */
	size: number;
	color: string;
	align?: CanvasTextAlign;
	baseline?: CanvasTextBaseline;
	family?: string;
	weight?: string;
	/** Below this rendered size the text is skipped rather than drawn as mush. */
	minSize?: number;
}

const DEFAULT_FAMILY =
	'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

export class Painter {
	readonly ctx: CanvasRenderingContext2D;
	readonly viewport: Viewport;
	private dpr = 1;

	constructor(ctx: CanvasRenderingContext2D, viewport: Viewport) {
		this.ctx = ctx;
		this.viewport = viewport;
	}

	/** Clear the whole layer and enter world space. */
	begin(dpr: number): void {
		this.dpr = dpr;
		const { ctx } = this;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
		this.world();
	}

	/** World coordinates: the viewport transform is applied. */
	world(): void {
		const { scale, x, y } = this.viewport;
		const s = this.dpr * scale;
		this.ctx.setTransform(s, 0, 0, s, this.dpr * x, this.dpr * y);
	}

	/** Screen coordinates in CSS pixels. */
	screen(): void {
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
	}

	/** World units per screen pixel. Useful for hit tolerances and margins. */
	get unit(): number {
		return 1 / this.viewport.scale;
	}

	private applyStroke(style: StrokeStyle): void {
		const { ctx } = this;
		ctx.strokeStyle = style.color;
		ctx.globalAlpha = style.alpha ?? 1;
		ctx.lineWidth = (style.width ?? 1) * this.unit;
		ctx.lineCap = style.cap ?? 'round';
		ctx.lineJoin = style.join ?? 'round';
		ctx.setLineDash(style.dash ? style.dash.map((d) => d * this.unit) : []);
	}

	private applyFill(style: FillStyle): void {
		this.ctx.fillStyle = style.color;
		this.ctx.globalAlpha = style.alpha ?? 1;
	}

	private reset(): void {
		this.ctx.globalAlpha = 1;
		this.ctx.setLineDash([]);
	}

	strokePath(path: Path2D, style: StrokeStyle): void {
		this.applyStroke(style);
		this.ctx.stroke(path);
		this.reset();
	}

	fillPath(path: Path2D, style: FillStyle): void {
		this.applyFill(style);
		this.ctx.fill(path);
		this.reset();
	}

	line(a: Vec2, b: Vec2, style: StrokeStyle): void {
		const { ctx } = this;
		this.applyStroke(style);
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.stroke();
		this.reset();
	}

	polyline(points: readonly Vec2[], style: StrokeStyle): void {
		if (points.length < 2) return;
		const { ctx } = this;
		this.applyStroke(style);
		ctx.beginPath();
		ctx.moveTo(points[0].x, points[0].y);
		for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
		ctx.stroke();
		this.reset();
	}

	/** `radius` is in world units. */
	circle(centre: Vec2, radius: number, fill?: FillStyle, stroke?: StrokeStyle): void {
		const { ctx } = this;
		ctx.beginPath();
		ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
		if (fill) {
			this.applyFill(fill);
			ctx.fill();
			this.reset();
		}
		if (stroke) {
			this.applyStroke(stroke);
			ctx.stroke();
			this.reset();
		}
	}

	/** A dot of a fixed screen size, whatever the zoom. */
	dot(centre: Vec2, screenRadius: number, fill: FillStyle, stroke?: StrokeStyle): void {
		this.circle(centre, screenRadius * this.unit, fill, stroke);
	}

	rect(r: Rect, fill?: FillStyle, stroke?: StrokeStyle): void {
		const { ctx } = this;
		if (fill) {
			this.applyFill(fill);
			ctx.fillRect(r.x, r.y, r.w, r.h);
			this.reset();
		}
		if (stroke) {
			this.applyStroke(stroke);
			ctx.strokeRect(r.x, r.y, r.w, r.h);
			this.reset();
		}
	}

	/**
	 * Draw text anchored at a world point but rendered at a fixed screen size.
	 *
	 * Returns false when the label was skipped for being too small — callers can
	 * use that to decide whether to bother computing more labels.
	 */
	text(content: string, at: Vec2, style: TextStyle): boolean {
		if (style.size < (style.minSize ?? 5)) return false;

		const { ctx } = this;
		const anchor = this.viewport.toScreen(at);
		this.screen();
		ctx.font = `${style.weight ? `${style.weight} ` : ''}${style.size}px ${style.family ?? DEFAULT_FAMILY}`;
		ctx.fillStyle = style.color;
		ctx.textAlign = style.align ?? 'center';
		ctx.textBaseline = style.baseline ?? 'alphabetic';
		ctx.fillText(content, anchor.x, anchor.y);
		this.world();
		return true;
	}

	/** Run `draw` with an extra transform applied, then restore. */
	transformed(translate: Vec2, rotationDegrees: number, draw: () => void): void {
		const { ctx } = this;
		ctx.save();
		ctx.translate(translate.x, translate.y);
		if (rotationDegrees) ctx.rotate((rotationDegrees * Math.PI) / 180);
		draw();
		ctx.restore();
	}

	save(): void {
		this.ctx.save();
	}

	restore(): void {
		this.ctx.restore();
	}
}
