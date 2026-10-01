/**
 * Scramble-then-blur, drawn from the pixels Editframe has already painted for the current frame.
 *
 *   1. average the pixels under the box into coarse cells        (lossy)
 *   2. shuffle the cells at random, within tiles                 (position information destroyed)
 *   3. blur the shuffled cells                                    (looks like a soft blur)
 *
 * The permutation comes from crypto.getRandomValues and is thrown away immediately, so nothing in the
 * output (or anywhere else) can be used to unshuffle it. A plain blur is a known linear filter and can be
 * partly inverted; here, inverting the blur only returns the already-shuffled cells.
 */

import { type BoxState, ROUND_RADIUS, type ResolvedScramble, type Shape } from "./types";

/** crypto.getRandomValues() accepts at most 65536 bytes (16384 Uint32 values) per call. */
const MAX_RANDOM_VALUES = 16384;

/** The part of the frame a draw touches: the rotated box's centre and angle, and its clamped axis-aligned bounds. */
interface Region {
  cx: number;
  cy: number;
  /** rotation, radians */
  rad: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function makeCanvas(willReadFrequently = false) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", willReadFrequently ? { willReadFrequently: true } : undefined)!;
  return { canvas, ctx };
}

function secureRandom(n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i += MAX_RANDOM_VALUES) crypto.getRandomValues(out.subarray(i, Math.min(n, i + MAX_RANDOM_VALUES)));
  return out;
}

/** Fisher-Yates with fresh secure randomness. (The modulo bias is below 1e-5 for any tile that fits a frame.) */
function shuffleInPlace<T>(items: T[]) {
  const rnd = secureRandom(items.length);
  for (let a = items.length - 1; a > 0; a--) {
    const s = rnd[a] % (a + 1);
    [items[a], items[s]] = [items[s], items[a]];
  }
}

/** lx, ly are relative to the box centre, in the box's own (unrotated) axes. */
function withinShape(lx: number, ly: number, w: number, h: number, shape: Shape): boolean {
  if (Math.abs(lx) > w / 2 || Math.abs(ly) > h / 2) return false;
  if (shape === "ellipse") return (lx * lx) / ((w / 2) * (w / 2)) + (ly * ly) / ((h / 2) * (h / 2)) <= 1;
  return true;
}

/** Bounds of the box grown by `feather`, rotated, clamped to the frame. null if nothing of it is on screen. */
function regionBounds(box: BoxState, feather: number, frameW: number, frameH: number): Region | null {
  const w = box.w + 2 * feather;
  const h = box.h + 2 * feather;
  const rad = (box.r * Math.PI) / 180;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ex = (Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h) / 2;
  const ey = (Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h) / 2;
  const x = Math.max(0, Math.floor(cx - ex));
  const y = Math.max(0, Math.floor(cy - ey));
  const rw = Math.min(frameW, Math.ceil(cx + ex)) - x;
  const rh = Math.min(frameH, Math.ceil(cy + ey)) - y;
  return rw < 2 || rh < 2 ? null : { cx, cy, rad, x, y, w: rw, h: rh };
}

/** 1 for every cell whose centre lies inside the shape (w x h = the box grown by the feather). */
function cellsInsideShape(cw: number, ch: number, r: Region, w: number, h: number, shape: Shape): Uint8Array {
  const cos = Math.cos(-r.rad);
  const sin = Math.sin(-r.rad);
  const inside = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const dx = r.x + ((i + 0.5) * r.w) / cw - r.cx;
      const dy = r.y + ((j + 0.5) * r.h) / ch - r.cy;
      inside[j * cw + i] = withinShape(dx * cos - dy * sin, dx * sin + dy * cos, w, h, shape) ? 1 : 0;
    }
  }
  return inside;
}

/** Mean colour of the hidden cells, as a CSS colour. */
function meanColour(px: Uint32Array, inside: Uint8Array): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let q = 0; q < inside.length; q++) {
    if (!inside[q]) continue;
    const v = px[q];
    r += v & 255;
    g += (v >> 8) & 255;
    b += (v >> 16) & 255;
    n++;
  }
  return n ? `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})` : "#000";
}

/** Shuffles the inside cells independently within each square tile of `tileCells` x `tileCells`. */
function shuffleWithinTiles(px: Uint32Array, inside: Uint8Array, cw: number, ch: number, tileCells: number) {
  for (let ty = 0; ty * tileCells < ch; ty++) {
    for (let tx = 0; tx * tileCells < cw; tx++) {
      const cells: number[] = [];
      for (let j = ty * tileCells; j < Math.min(ch, (ty + 1) * tileCells); j++) {
        for (let i = tx * tileCells; i < Math.min(cw, (tx + 1) * tileCells); i++) {
          if (inside[j * cw + i]) cells.push(j * cw + i);
        }
      }
      const values = cells.map((q) => px[q]);
      shuffleInPlace(values);
      cells.forEach((q, n) => (px[q] = values[n]));
    }
  }
}

export class Scrambler {
  readonly overlay: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;
  /** the box averaged down to one pixel per cell, then shuffled */
  private readonly cells = makeCanvas(true);
  /** the shuffled cells blurred, on a canvas padded so the blur never fades to transparent inside the box */
  private readonly blurred = makeCanvas();
  /** alpha mask of the shape (opaque core, soft feather ring) */
  private readonly mask = makeCanvas();
  /** blurred pixels cut to the mask */
  private readonly piece = makeCanvas();

  constructor(
    private readonly frameW: number,
    private readonly frameH: number,
  ) {
    const { canvas, ctx } = makeCanvas();
    canvas.width = frameW;
    canvas.height = frameH;
    this.overlay = canvas;
    this.overlayCtx = ctx;
  }

  clear() {
    this.overlayCtx.clearRect(0, 0, this.frameW, this.frameH);
  }

  /**
   * Draws the scrambled+blurred stand-in for `box` (frame px, already padded) onto the overlay.
   * Returns the mean colour of the hidden region, used as the opaque base under the canvas.
   */
  draw(video: HTMLCanvasElement, box: BoxState, shape: Shape, opts: ResolvedScramble): string {
    if (!video.width || !video.height) throw new Error("video canvas has no pixels yet");
    const { cell, tile, blur, feather } = opts;

    // `box` is the private region and stays fully opaque. Everything below works on the box grown by the
    // feather, so the soft ring is made of the same scrambled-and-blurred pixels as the core.
    const region = regionBounds(box, feather, this.frameW, this.frameH);
    if (!region) return "#000";

    const cw = Math.max(1, Math.ceil(region.w / cell));
    const ch = Math.max(1, Math.ceil(region.h / cell));
    const img = this.downsample(video, region, cw, ch);
    const px = new Uint32Array(img.data.buffer); // one RGBA pixel per cell

    const inside = cellsInsideShape(cw, ch, region, box.w + 2 * feather, box.h + 2 * feather, shape);
    const mean = meanColour(px, inside);
    shuffleWithinTiles(px, inside, cw, ch, tile === "region" ? Math.max(cw, ch) : Math.max(1, Math.round(tile / cell)));
    for (let q = 0; q < px.length; q++) px[q] |= 0xff000000; // opaque, regardless of what the source alpha was
    this.cells.ctx.putImageData(img, 0, 0);

    const pad = this.blurCells(cw, ch, region, blur);
    this.drawMask(region, box, shape, feather);
    this.composite(region, pad);
    return mean;
  }

  /** Averages the part of the video under `region` into a cw x ch grid of cells. */
  private downsample(video: HTMLCanvasElement, r: Region, cw: number, ch: number): ImageData {
    const { canvas, ctx } = this.cells;
    canvas.width = cw;
    canvas.height = ch;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const k = video.width / this.frameW; // the video canvas may be a different resolution from the frame
    ctx.drawImage(video, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, cw, ch);
    return ctx.getImageData(0, 0, cw, ch);
  }

  /** Blurs the cells up to region size. Returns the padding added on every side. */
  private blurCells(cw: number, ch: number, r: Region, blur: number): number {
    const { canvas, ctx } = this.blurred;
    const pad = Math.ceil(blur * 2.5);
    canvas.width = r.w + 2 * pad;
    canvas.height = r.h + 2 * pad;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(this.cells.canvas, 0, 0, cw, ch, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";
    return pad;
  }

  /** Feathered alpha mask in region-local pixels: opaque core (the private region), soft ring outside it. */
  private drawMask(r: Region, core: BoxState, shape: Shape, feather: number) {
    const { canvas, ctx } = this.mask;
    canvas.width = r.w;
    canvas.height = r.h;
    const path = (w: number, h: number) => {
      ctx.beginPath();
      if (shape === "ellipse") ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      else if (shape === "round") ctx.roundRect(-w / 2, -h / 2, w, h, ROUND_RADIUS + (w - core.w) / 2);
      else ctx.rect(-w / 2, -h / 2, w, h);
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, r.w, r.h);
    ctx.setTransform(Math.cos(r.rad), Math.sin(r.rad), -Math.sin(r.rad), Math.cos(r.rad), r.cx - r.x, r.cy - r.y);
    ctx.fillStyle = "#fff";
    if (feather > 0) {
      ctx.filter = `blur(${feather * 0.35}px)`;
      path(core.w + feather, core.h + feather); // half-way through the ring, then blurred
      ctx.fill();
      ctx.filter = "none";
    }
    path(core.w, core.h); // the private region itself: always alpha 1
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Cuts the blurred pixels to the mask and draws them onto the overlay at the region's position. */
  private composite(r: Region, pad: number) {
    const { canvas, ctx } = this.piece;
    canvas.width = r.w;
    canvas.height = r.h;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, r.w, r.h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.blurred.canvas, pad, pad, r.w, r.h, 0, 0, r.w, r.h);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(this.mask.canvas, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    this.overlayCtx.drawImage(canvas, r.x, r.y);
  }
}
