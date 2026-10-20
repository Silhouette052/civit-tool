// Tiny in-memory images for the image tests. The reader skips CRCs and image data, but the files are still valid.

import zlib from 'node:zlib'

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes) => {
  let c = 0xff_ff_ff_ff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xff_ff_ff_ff) >>> 0
}

export function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, crc])
}

export function png(chunks) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8 // bit depth; colour type 0 (grey)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...chunks,
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

export const tEXt = (key, text) =>
  pngChunk('tEXt', Buffer.concat([Buffer.from(`${key}\0`, 'latin1'), Buffer.from(text, 'latin1')]))
export const iTXt = (key, text) =>
  pngChunk(
    'iTXt',
    Buffer.concat([Buffer.from(`${key}\0\x01\0\0\0`, 'latin1'), zlib.deflateSync(Buffer.from(text, 'utf8'))]),
  )

/** A TIFF block: IFD0 -> Exif IFD -> UserComment (UNICODE, UTF-16 in the given byte order). */
export function tiffWithUserComment(text, {little = false} = {}) {
  const body = Buffer.from(text, 'utf16le')
  if (!little) body.swap16()
  const comment = Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), body])

  const tiff = Buffer.alloc(8 + 18 + 18 + comment.length)
  const u16 = (value, at) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at))
  const u32 = (value, at) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at))
  tiff.write(little ? 'II' : 'MM', 0, 'latin1')
  u16(42, 2)
  u32(8, 4)
  // IFD0 at 8: one entry, the Exif IFD pointer (LONG) to 26
  u16(1, 8)
  u16(0x87_69, 10)
  u16(4, 12)
  u32(1, 14)
  u32(26, 18)
  u32(0, 22)
  // Exif IFD at 26: UserComment (UNDEFINED) with its data at 44
  u16(1, 26)
  u16(0x92_86, 28)
  u16(7, 30)
  u32(comment.length, 32)
  u32(44, 36)
  u32(0, 40)
  comment.copy(tiff, 44)
  return tiff
}

export function jpeg(tiff) {
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const length = Buffer.alloc(2)
  length.writeUInt16BE(app1.length + 2)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    length,
    app1,
    Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]),
  ])
}

export function webp(tiff) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32LE(data.length, 4)
    return Buffer.concat([head, data, Buffer.alloc(data.length % 2)])
  }

  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    chunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])),
    chunk('EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])),
  ])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}
