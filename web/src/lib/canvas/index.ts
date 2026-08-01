/**
 * A small 2D editor engine: viewport, layered canvases, a spatial index,
 * snapping, and a tool protocol.
 *
 * Deliberately knows nothing about circuits. Everything schematic-specific
 * lives in `$lib/schematic`, which means this half can be tested without a
 * browser and reused for anything else that needs a pannable, zoomable,
 * pickable canvas.
 */

export * from './geometry';
export { Viewport, type ViewportState, type ViewportLimits } from './viewport';
export { LayeredSurface, type SurfaceSize } from './surface';
export { Painter, type StrokeStyle, type FillStyle, type TextStyle } from './painter';
export { Scene, type SceneItem } from './scene';
export { SnapIndex, type SnapKind, type SnapPoint, type SnapSegment, type SnapTarget } from './snap';
export { CanvasEditor, type EditorOptions, type RenderFn } from './editor';
export type { Tool, ToolContext, EditorPointer } from './tool';
