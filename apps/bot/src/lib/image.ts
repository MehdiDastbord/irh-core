/**
 * Welcome card generator.
 *
 * Renders a PNG with a vertical gradient and scaled bitmap text using a
 * dependency-free PNG encoder (zlib deflate + CRC32). No native modules, no
 * fonts to download, deterministic output that is unit testable.
 *
 * Limitation: member avatars are not composited (that would require a PNG/JPEG
 * decoder). The card renders the member name, server name and member number.
 */

import { deflateSync } from 'node:zlib';

const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  "'": ['00100', '00100', '00000', '00000', '00000', '00000', '00000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  _: ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
};

export interface Theme {
  readonly from: [number, number, number];
  readonly to: [number, number, number];
  readonly accent: [number, number, number];
}

export const THEMES: Record<string, Theme> = {
  aurora: { from: [12, 18, 42], to: [58, 33, 110], accent: [126, 166, 255] },
  midnight: { from: [5, 8, 20], to: [20, 28, 62], accent: [90, 120, 255] },
  ember: { from: [30, 10, 12], to: [92, 32, 18], accent: [255, 150, 90] },
};

type Rgb = [number, number, number];

class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly pixels: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
  }

  set(x: number, y: number, color: Rgb, alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    const [r, g, b] = color;
    if (alpha >= 1) {
      this.pixels[index] = r;
      this.pixels[index + 1] = g;
      this.pixels[index + 2] = b;
      this.pixels[index + 3] = 255;
      return;
    }
    this.pixels[index] = Math.round((this.pixels[index] ?? 0) * (1 - alpha) + r * alpha);
    this.pixels[index + 1] = Math.round((this.pixels[index + 1] ?? 0) * (1 - alpha) + g * alpha);
    this.pixels[index + 2] = Math.round((this.pixels[index + 2] ?? 0) * (1 - alpha) + b * alpha);
    this.pixels[index + 3] = 255;
  }

  fillGradient(theme: Theme): void {
    for (let y = 0; y < this.height; y += 1) {
      const t = y / Math.max(1, this.height - 1);
      const r = Math.round(theme.from[0] + (theme.to[0] - theme.from[0]) * t);
      const g = Math.round(theme.from[1] + (theme.to[1] - theme.from[1]) * t);
      const b = Math.round(theme.from[2] + (theme.to[2] - theme.from[2]) * t);
      for (let x = 0; x < this.width; x += 1) {
        const v = 1 - (x / Math.max(1, this.width)) * 0.18;
        this.set(x, y, [Math.round(r * v), Math.round(g * v), Math.round(b * v)]);
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number, color: Rgb, alpha = 1): void {
    for (let py = y; py < y + height; py += 1) for (let px = x; px < x + width; px += 1) this.set(px, py, color, alpha);
  }

  roundRect(x: number, y: number, width: number, height: number, radius: number, color: Rgb, alpha = 1): void {
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const dx = Math.max(radius - px, 0, px - (width - radius - 1));
        const dy = Math.max(radius - py, 0, py - (height - radius - 1));
        if (dx * dx + dy * dy <= radius * radius) this.set(x + px, y + py, color, alpha);
      }
    }
  }

  drawText(text: string, x: number, y: number, scale: number, color: Rgb, maxWidth: number): void {
    let cursor = x;
    for (const char of text.toUpperCase()) {
      const glyph = FONT[char];
      if (!glyph) continue;
      if (cursor + 6 * scale > x + maxWidth) break;
      for (let row = 0; row < 7; row += 1) {
        const bits = glyph[row] ?? '';
        for (let column = 0; column < 5; column += 1) {
          if (bits[column] === '1') this.fillRect(cursor + column * scale, y + row * scale, scale, scale, color);
        }
      }
      cursor += 6 * scale;
    }
  }

  toPng(): Buffer {
    const stride = this.width * 4 + 1;
    const raw = Buffer.alloc(stride * this.height);
    for (let y = 0; y < this.height; y += 1) {
      raw[y * stride] = 0;
      Buffer.from(this.pixels.buffer, y * this.width * 4, this.width * 4).copy(raw, y * stride + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function renderWelcomeCard(input: { username: string; serverName: string; memberCount: number; theme?: string }): Buffer {
  const theme = THEMES[input.theme ?? 'aurora'] ?? THEMES.aurora!;
  const width = 800;
  const height = 260;
  const canvas = new Canvas(width, height);
  canvas.fillGradient(theme);
  canvas.fillRect(0, height - 8, width, 8, theme.accent);
  canvas.roundRect(30, 30, 6, height - 60, 3, theme.accent);

  canvas.drawText('WELCOME', 60, 52, 4, theme.accent, width - 120);
  const name = input.username.slice(0, 22);
  canvas.drawText(name, 60, 108, 7, [255, 255, 255], width - 120);
  canvas.drawText(`TO ${input.serverName.slice(0, 26)}`, 60, 178, 3, [208, 214, 235], width - 120);
  canvas.drawText(`MEMBER #${input.memberCount}`, 60, 208, 3, [160, 176, 214], width - 120);

  return canvas.toPng();
}
