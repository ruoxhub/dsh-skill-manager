/**
 * A minimal zip writer for import tests.
 *
 * Test fixtures are generated rather than committed as binary archives, so a
 * reader change is exercised against a layout the test can read. CRCs stay at
 * zero because the import reader does not verify them; everything else (local
 * header, central directory, end record) follows the archive specification.
 *
 * Not a spec file: vitest collects only the .spec.ts files under tests/, so
 * this is a plain helper module the specs share.
 */
import { deflateRawSync } from 'node:zlib'

/** One file to place in a generated archive. */
export interface ZipInput {
  path: string
  content: string
}

/** The header variants a reader has to honour or refuse. */
export interface ZipOptions {
  /** Compression method written into both headers (0 stored, 8 deflate). */
  method?: number
  /** General-purpose flag bits (bit 0 marks an encrypted entry). */
  flags?: number
  /** Write the zip64 escape marker into the entry count. */
  zip64?: boolean
}

/**
 * Build a zip archive byte-for-byte.
 * @param files - archive entries in order.
 * @param options - method, flags and the zip64 marker.
 * @returns the archive bytes.
 */
export function buildZip(files: readonly ZipInput[], options: ZipOptions = {}): Buffer {
  const method = options.method ?? 0
  const flags = options.flags ?? 0
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const raw = Buffer.from(file.content, 'utf8')
    const data = method === 8 ? deflateRawSync(raw) : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  const count = options.zip64 === true ? 0xffff : files.length
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}
