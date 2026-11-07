/* Intel HEX → flash image. Firmware comes from uploads and share links, so it is untrusted:
 * every record is checksummed and writes are bounds-checked against the flash size. */

export class HexError extends Error {
  constructor(message: string, public line: number) { super(`line ${line}: ${message}`); }
}

export const ATMEGA328P_FLASH = 32 * 1024;
/** Upper bound on the hex text we accept (a full 32 KB image is ~90 KB of hex). */
export const MAX_HEX_CHARS = 200_000;

export function parseIntelHex(text: string, flashSize = ATMEGA328P_FLASH): Uint8Array {
  if (typeof text !== 'string') throw new HexError('not text', 0);
  if (text.length > MAX_HEX_CHARS) throw new HexError('file too large for an ATmega328P', 0);
  const flash = new Uint8Array(flashSize);
  let base = 0, sawEof = false, sawData = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const n = i + 1;
    if (sawEof) throw new HexError('data after the end-of-file record', n);
    if (!/^:[0-9a-fA-F]+$/.test(l) || l.length < 11 || (l.length - 1) % 2) throw new HexError('not an Intel HEX record', n);
    const bytes = new Uint8Array((l.length - 1) / 2);
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(l.substr(1 + 2 * k, 2), 16);
    const len = bytes[0];
    if (bytes.length !== len + 5) throw new HexError('record length does not match its byte count', n);
    let sum = 0; for (const b of bytes) sum = (sum + b) & 0xff;
    if (sum !== 0) throw new HexError('bad checksum', n);
    const addr = (bytes[1] << 8) | bytes[2], type = bytes[3], data = bytes.subarray(4, 4 + len);
    switch (type) {
      case 0x00: {
        const at = base + addr;
        if (at < 0 || at + len > flashSize) throw new HexError(`address 0x${at.toString(16)} is outside the ${flashSize / 1024} KB flash`, n);
        flash.set(data, at); sawData = true; break;
      }
      case 0x01: sawEof = true; break;
      case 0x02: base = ((data[0] << 8) | data[1]) * 16; break;  // extended segment address
      case 0x04: base = ((data[0] << 8) | data[1]) << 16; break; // extended linear address
      case 0x03: case 0x05: break; // start address records: irrelevant for AVR
      default: throw new HexError(`unknown record type ${type}`, n);
    }
  }
  if (!sawData) throw new HexError('no program data', lines.length);
  return flash;
}
