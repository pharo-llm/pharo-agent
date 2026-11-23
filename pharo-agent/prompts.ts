/**
 * Small terminal prompts for setup: an arrow-key menu (numbers work too) and
 * a text question. Without a TTY the menu falls back to a numbered list read
 * line by line, so scripted input still works.
 */
import readline from 'node:readline'
import { style } from './ui.ts'

export type Choice<T> = { label: string; value: T; hint?: string }

export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

export async function select<T>(title: string, choices: Choice<T>[], options: { initial?: number; footer?: string } = {}): Promise<T> {
  if (!choices.length) throw new Error(`No choices for: ${title}`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) return selectFromLines(title, choices, options.initial ?? 0)
  const out = process.stdout
  let index = Math.min(Math.max(options.initial ?? 0, 0), choices.length - 1)
  let drawn = 0
  const draw = () => {
    if (drawn) out.write(`\x1b[${drawn}A\x1b[J`)
    const lines = [style.bold(title)]
    choices.forEach((choice, i) => {
      const active = i === index
      const label = `${i + 1}. ${choice.label}`
      lines.push(`${active ? style.blue('❯') : ' '} ${active ? style.blue(label) : label}${choice.hint ? style.dim(`  ${choice.hint}`) : ''}`)
    })
    lines.push(style.dim(options.footer ?? '↑/↓ to move · enter to select · esc to cancel'))
    out.write(`${lines.join('\n')}\n`)
    drawn = lines.length
  }
  readline.emitKeypressEvents(process.stdin)
  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()
  out.write('\x1b[?25l') // hide cursor while choosing
  draw()
  try {
    return await new Promise<T>((resolve, reject) => {
      const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
        if (key?.ctrl && key.name === 'c') return finish(() => reject(new PromptCancelled()))
        if (key?.name === 'escape') return finish(() => reject(new PromptCancelled()))
        if (key?.name === 'up' || key?.name === 'k') index = (index - 1 + choices.length) % choices.length
        else if (key?.name === 'down' || key?.name === 'j' || key?.name === 'tab') index = (index + 1) % choices.length
        else if (key?.name === 'return' || key?.name === 'enter') return finish(() => resolve(choices[index]!.value))
        else if (text && /^[1-9]$/.test(text) && Number(text) <= choices.length) {
          index = Number(text) - 1
          draw()
          return finish(() => resolve(choices[index]!.value))
        } else return
        draw()
      }
      const finish = (done: () => void) => {
        process.stdin.off('keypress', onKey)
        // Collapse the menu to one line: the question and the answer.
        out.write(`\x1b[${drawn}A\x1b[J${style.bold(title)} ${style.blue(choices[index]!.label)}\n`)
        drawn = 0
        done()
      }
      process.stdin.on('keypress', onKey)
    })
  } finally {
    out.write('\x1b[?25h')
    process.stdin.setRawMode(wasRaw)
    process.stdin.pause()
  }
}

async function selectFromLines<T>(title: string, choices: Choice<T>[], initial: number): Promise<T> {
  process.stdout.write(`${title}\n`)
  choices.forEach((choice, i) => process.stdout.write(`  ${i + 1}. ${choice.label}${choice.hint ? `  (${choice.hint})` : ''}\n`))
  const answer = (await ask(`Choose 1-${choices.length}`, String(initial + 1))).trim()
  const picked = Number(answer)
  return (choices[picked - 1] ?? choices[initial]!).value
}

/** One line of text, with a default shown in brackets. */
export async function ask(question: string, fallback = ''): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      rl.question(`${question}${fallback ? style.dim(` [${fallback}]`) : ''}: `, resolve)
      rl.once('close', () => reject(new PromptCancelled()))
      rl.once('SIGINT', () => reject(new PromptCancelled()))
    })
    return answer.trim() || fallback
  } finally {
    rl.close()
  }
}
