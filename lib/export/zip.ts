// Minimal ZIP writer (STORED entries only — no compression). Dependency-free
// and isomorphic: TextEncoder + Uint8Array work in both the browser (client
// xlsx exports) and Node route handlers (bulk document downloads). STORED is
// fine for our uses — spreadsheets are small and PDFs are already compressed.

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeU16(out: Uint8Array, pos: number, value: number): void {
  out[pos] = value & 0xff
  out[pos + 1] = (value >>> 8) & 0xff
}

function writeU32(out: Uint8Array, pos: number, value: number): void {
  out[pos] = value & 0xff
  out[pos + 1] = (value >>> 8) & 0xff
  out[pos + 2] = (value >>> 16) & 0xff
  out[pos + 3] = (value >>> 24) & 0xff
}

// Fixed DOS timestamp (2020-01-01 00:00:00) so output is deterministic and
// we never touch Date in a client bundle. Any valid constant works — readers
// ignore it.
const DOS_TIME = 0
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1

export type ZipEntry = { name: string; data: Uint8Array }

export function makeZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const parts = entries.map((entry) => ({
    nameBytes: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
  }))

  const localSize = parts.reduce((sum, p) => sum + 30 + p.nameBytes.length + p.data.length, 0)
  const centralSize = parts.reduce((sum, p) => sum + 46 + p.nameBytes.length, 0)
  const out = new Uint8Array(localSize + centralSize + 22)

  let pos = 0
  const offsets: number[] = []
  for (const part of parts) {
    offsets.push(pos)
    writeU32(out, pos, 0x04034b50) // local file header signature
    writeU16(out, pos + 4, 20) // version needed to extract
    writeU16(out, pos + 6, 0) // general purpose flags
    writeU16(out, pos + 8, 0) // method: STORED
    writeU16(out, pos + 10, DOS_TIME)
    writeU16(out, pos + 12, DOS_DATE)
    writeU32(out, pos + 14, part.crc)
    writeU32(out, pos + 18, part.data.length) // compressed size
    writeU32(out, pos + 22, part.data.length) // uncompressed size
    writeU16(out, pos + 26, part.nameBytes.length)
    writeU16(out, pos + 28, 0) // extra field length
    out.set(part.nameBytes, pos + 30)
    out.set(part.data, pos + 30 + part.nameBytes.length)
    pos += 30 + part.nameBytes.length + part.data.length
  }

  const centralStart = pos
  parts.forEach((part, i) => {
    writeU32(out, pos, 0x02014b50) // central directory header signature
    writeU16(out, pos + 4, 20) // version made by
    writeU16(out, pos + 6, 20) // version needed to extract
    writeU16(out, pos + 8, 0) // general purpose flags
    writeU16(out, pos + 10, 0) // method: STORED
    writeU16(out, pos + 12, DOS_TIME)
    writeU16(out, pos + 14, DOS_DATE)
    writeU32(out, pos + 16, part.crc)
    writeU32(out, pos + 20, part.data.length) // compressed size
    writeU32(out, pos + 24, part.data.length) // uncompressed size
    writeU16(out, pos + 28, part.nameBytes.length)
    writeU16(out, pos + 30, 0) // extra field length
    writeU16(out, pos + 32, 0) // file comment length
    writeU16(out, pos + 34, 0) // disk number start
    writeU16(out, pos + 36, 0) // internal file attributes
    writeU32(out, pos + 38, 0) // external file attributes
    writeU32(out, pos + 42, offsets[i]) // local header offset
    out.set(part.nameBytes, pos + 46)
    pos += 46 + part.nameBytes.length
  })

  writeU32(out, pos, 0x06054b50) // end of central directory signature
  writeU16(out, pos + 4, 0) // disk number
  writeU16(out, pos + 6, 0) // central directory start disk
  writeU16(out, pos + 8, parts.length) // entries on this disk
  writeU16(out, pos + 10, parts.length) // total entries
  writeU32(out, pos + 12, centralSize)
  writeU32(out, pos + 16, centralStart)
  writeU16(out, pos + 20, 0) // comment length

  return out
}
