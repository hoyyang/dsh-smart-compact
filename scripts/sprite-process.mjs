#!/usr/bin/env node
/**
 * sprite-process.mjs — luminance→alpha sprite pipeline (reproducible).
 *
 * Input: a white-glow-on-black PNG (from dsh-image-gen, optionally resized).
 * Output: a compact RGBA PNG whose RGB is flat white and whose alpha carries the
 * generated luminance shape — "shape from the model, colour from code" (the CSS
 * gradient underneath paints the palette, so both themes stay clean).
 *
 * Usage: node scripts/sprite-process.mjs <in.png> <out.png>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

const [input, output] = process.argv.slice(2)
if (input === undefined || output === undefined) {
  console.error('usage: sprite-process.mjs <in.png> <out.png>')
  process.exit(1)
}

// ---------- minimal PNG decode (8-bit, color types 2/6, no interlace) ----------
const buf = readFileSync(input)
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG: ' + input)

let off = 8
let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
const idat = []
while (off < buf.length) {
  const len = buf.readUInt32BE(off)
  const type = buf.toString('ascii', off + 4, off + 8)
  const data = buf.subarray(off + 8, off + 8 + len)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0)
    height = data.readUInt32BE(4)
    bitDepth = data[8]
    colorType = data[9]
    interlace = data[12]
  } else if (type === 'IDAT') {
    idat.push(data)
  } else if (type === 'IEND') break
  off += 12 + len
}
if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth)
if (interlace !== 0) throw new Error('interlaced PNG not supported')
const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
if (channels === 0) throw new Error('unsupported color type ' + colorType)

const raw = inflateSync(Buffer.concat(idat))
const stride = width * channels
const pixels = Buffer.alloc(width * height * channels)
const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
let pos = 0
for (let y = 0; y < height; y++) {
  const filter = raw[pos++]
  const row = raw.subarray(pos, pos + stride)
  pos += stride
  const out = pixels.subarray(y * stride, (y + 1) * stride)
  const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null
  for (let x = 0; x < stride; x++) {
    const left = x >= channels ? out[x - channels] : 0
    const up = prev !== null ? prev[x] : 0
    const ul = prev !== null && x >= channels ? prev[x - channels] : 0
    let v = row[x]
    if (filter === 1) v += left
    else if (filter === 2) v += up
    else if (filter === 3) v += (left + up) >> 1
    else if (filter === 4) v += paeth(left, up, ul)
    out[x] = v & 0xff
  }
}

// ---------- luminance → alpha (crushed floor, gentle lift) ----------
const FLOOR = 10
const GAMMA = 0.85
// Identity tint ramp: mint highlight through teal into electric blue, ending in
// indigo at the bottom edge — the button's own palette, baked into the sprite so
// the core needs no runtime mask (a failed mask-image renders fully transparent,
// which shipped as an all-black button once already).
const RAMP = [
  [0.0, [234, 255, 251]],
  [0.35, [94, 234, 212]],
  [0.55, [45, 212, 191]],
  [0.8, [59, 130, 246]],
  [1.0, [99, 102, 241]],
]
const rampAt = (t) => {
  const c = Math.min(1, Math.max(0, t))
  for (let i = 1; i < RAMP.length; i++) {
    if (c <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1]
      const [t1, c1] = RAMP[i]
      const k = t1 === t0 ? 0 : (c - t0) / (t1 - t0)
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ]
    }
  }
  return RAMP[RAMP.length - 1][1]
}
const rgba = Buffer.alloc(width * height * 4)
for (let i = 0; i < width * height; i++) {
  const o = i * channels
  let lum
  if (channels === 1) lum = pixels[o]
  else lum = Math.round(0.2126 * pixels[o] + 0.7152 * pixels[o + 1] + 0.0722 * pixels[o + 2])
  const a = lum <= FLOOR ? 0 : Math.min(255, Math.round(Math.pow((lum - FLOOR) / (255 - FLOOR), GAMMA) * 255))
  // Brighter core pixels sit higher on the ramp highlight; Y drags the hue down
  // toward blue/indigo at the sprite's bottom edge.
  const y = Math.floor(i / width)
  const [r, g, b] = rampAt(y / Math.max(1, height - 1) * 0.55 + (lum / 255) * 0.45)
  rgba[i * 4] = r
  rgba[i * 4 + 1] = g
  rgba[i * 4 + 2] = b
  rgba[i * 4 + 3] = a
}

// ---------- minimal PNG encode (RGBA, filter 0) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b) => {
  let c = 0xffffffff
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(width, 0)
ihdr.writeUInt32BE(height, 4)
ihdr[8] = 8
ihdr[9] = 6
const strideOut = width * 4
const rawOut = Buffer.alloc((strideOut + 1) * height)
for (let y = 0; y < height; y++) {
  rawOut[y * (strideOut + 1)] = 1 // Sub filter: smooth glow gradients compress far better
  const row = rawOut.subarray(y * (strideOut + 1) + 1, (y + 1) * (strideOut + 1))
  rgba.copy(row, 0, y * strideOut, (y + 1) * strideOut)
  for (let x = strideOut - 1; x >= 4; x--) row[x] = (row[x] - row[x - 4]) & 0xff
}
const png = Buffer.concat([
  PNG_SIG,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(rawOut, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync(output, png)
console.log(JSON.stringify({ width, height, bytes: png.length }))
