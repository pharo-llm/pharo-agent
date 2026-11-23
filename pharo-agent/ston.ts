/**
 * A small reader for STON, the format Pharo Launcher stores its settings,
 * template sources (sources.list) and image metadata (meta-inf.ston) in.
 *
 *   PhLImage { #pharoVersion : '140', #vm : PhLVirtualMachine { #id : '140-x64' } }
 *   OrderedCollection [ 'a', 'b' ]      -> ['a', 'b']
 *   URL [ 'https://...' ]               -> 'https://...'
 *
 * Objects become plain objects with their class in `_class`. References (@1)
 * become { $ref: 1 }. Only reading is supported.
 */
export type Ston = string | number | boolean | null | Ston[] | StonObject
export type StonObject = { [key: string]: Ston }

export class StonError extends Error {}

export function parseSton(text: string): Ston {
  const reader = new Reader(text)
  const value = reader.value()
  reader.skip()
  return value
}

/** Classes written as `Class [ 'string' ]` that stand for that one string. */
const stringWrappers = new Set(['URL', 'ZnUrl', 'Path', 'FileReference'])

class Reader {
  private pos = 0
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  skip(): void {
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]!
      if (/\s/.test(char)) this.pos += 1
      else if (char === '"') {
        // Smalltalk-style comment
        const end = this.text.indexOf('"', this.pos + 1)
        this.pos = end < 0 ? this.text.length : end + 1
      } else break
    }
  }

  value(): Ston {
    this.skip()
    const char = this.text[this.pos]
    if (char === undefined) throw new StonError('Unexpected end of STON')
    if (char === "'") return this.string()
    if (char === '#') return this.symbol()
    if (char === '[') return this.list()
    if (char === '{') return this.map(undefined)
    if (char === '@') {
      this.pos += 1
      return { $ref: this.number() }
    }
    if (char === '-' || /\d/.test(char)) return this.number()
    if (/[A-Za-z]/.test(char)) {
      const name = this.identifier()
      if (name === 'true') return true
      if (name === 'false') return false
      if (name === 'nil') return null
      this.skip()
      const next = this.text[this.pos]
      if (next === '{') return this.map(name)
      if (next === '[') {
        const items = this.list()
        return stringWrappers.has(name) && typeof items[0] === 'string' ? items[0] : items
      }
      if (next === "'" ) return this.string()
      return name
    }
    throw new StonError(`Unexpected '${char}' at offset ${this.pos}`)
  }

  private string(): string {
    let out = ''
    this.pos += 1
    while (this.pos < this.text.length) {
      const char = this.text[this.pos]!
      if (char === "'") {
        if (this.text[this.pos + 1] === "'") {
          out += "'"
          this.pos += 2
          continue
        }
        this.pos += 1
        return out
      }
      if (char === '\\' && this.text[this.pos + 1] !== undefined) {
        const next = this.text[this.pos + 1]!
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
        this.pos += 2
        continue
      }
      out += char
      this.pos += 1
    }
    throw new StonError('Unterminated string')
  }

  private symbol(): string {
    this.pos += 1
    if (this.text[this.pos] === "'") return this.string()
    const match = /^[A-Za-z0-9_:.]+/.exec(this.text.slice(this.pos))
    if (!match) throw new StonError(`Bad symbol at offset ${this.pos}`)
    this.pos += match[0].length
    return match[0]
  }

  private number(): number {
    const match = /^-?\d+(\.\d+)?(e-?\d+)?/.exec(this.text.slice(this.pos))
    if (!match) throw new StonError(`Bad number at offset ${this.pos}`)
    this.pos += match[0].length
    return Number(match[0])
  }

  private identifier(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos))!
    this.pos += match[0].length
    return match[0]
  }

  private list(): Ston[] {
    this.pos += 1
    const items: Ston[] = []
    while (true) {
      this.skip()
      if (this.text[this.pos] === ']') {
        this.pos += 1
        return items
      }
      items.push(this.value())
      this.skip()
      if (this.text[this.pos] === ',') this.pos += 1
    }
  }

  private map(className: string | undefined): StonObject {
    this.pos += 1
    const object: StonObject = className ? { _class: className } : {}
    while (true) {
      this.skip()
      if (this.text[this.pos] === '}') {
        this.pos += 1
        return object
      }
      let key = String(this.value())
      this.skip()
      if (this.text[this.pos] === ':') this.pos += 1
      // `#key: value` (no space): the colon was read as part of the symbol.
      else if (key.endsWith(':')) key = key.slice(0, -1)
      else throw new StonError(`Expected ':' at offset ${this.pos}`)
      object[key] = this.value()
      this.skip()
      if (this.text[this.pos] === ',') this.pos += 1
    }
  }
}

export function stonString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
