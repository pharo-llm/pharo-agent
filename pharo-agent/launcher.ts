/**
 * Pharo images and VMs, stored exactly the way Pharo Launcher stores them, so
 * that an image made here shows up in Pharo Launcher and the other way round.
 *
 * Layout (Pharo Launcher's own rules):
 *   settings   <preferences>/pharo-launcher/settings.ston
 *   images     <images>/<Name>/<Name>.image (+ .changes, *.sources,
 *              pharo.version, meta-inf.ston)
 *   vms        <vms>/<version>-x64/...   ("x64" means 64-bit, whatever the CPU)
 *   templates  sources.list (STON), downloads cached in <preferences>/pharo/templateCache
 *
 * <preferences> is ~/Library/Preferences on macOS, $XDG_CONFIG_HOME (~/.config)
 * on Linux and %APPDATA% on Windows. The default images and vms directories are
 * in ~/Documents/Pharo (macOS, Windows) or ~/Pharo (Linux), unless the settings
 * file says otherwise.
 *
 * Nothing here needs Pharo Launcher installed, and nothing drives its CLI
 * (which older Launchers, such as 3.0.x, do not have).
 */
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileCapture, isDirectory, isFile, pathExists, which, xdgCacheDir } from './platform.ts'
import { parseSton, stonString } from './ston.ts'
import type { Ston, StonObject } from './ston.ts'

export class LauncherError extends Error {}

type Env = NodeJS.ProcessEnv

// ---------------------------------------------------------------------------
// Locations

export type LauncherLocations = {
  /** Pharo Launcher's settings file, when it exists. */
  settingsFile?: string
  /** ~/Documents/Pharo or ~/Pharo: Launcher's core directory. */
  coreDir: string
  imagesDir: string
  vmsDir: string
  /** Where Launcher keeps downloaded templates (also its "Templates" group). */
  templateCacheDir: string
  /** The official template list Launcher caches, and the user's own. */
  sourcesFile: string
  mySourcesFile: string
  /** Where each setting came from, for `images where`. */
  origin: { imagesDir: string; vmsDir: string }
}

export type LocationOverrides = { imagesDir?: string; vmsDir?: string; env?: Env; platform?: NodeJS.Platform }

function home(env: Env): string {
  return env.HOME || env.USERPROFILE || os.homedir()
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Pharo's `FileLocator preferences` on each platform. */
export function preferencesDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform)
  if (platform === 'darwin') return p.join(home(env), 'Library', 'Preferences')
  if (platform === 'win32') return env.APPDATA || p.join(home(env), 'AppData', 'Roaming')
  return env.XDG_CONFIG_HOME || p.join(home(env), '.config')
}

/** Pharo Launcher's `launcherUserFilesLocation`. */
export function defaultCoreDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform)
  return platform === 'darwin' || platform === 'win32' ? p.join(home(env), 'Documents', 'Pharo') : p.join(home(env), 'Pharo')
}

export function launcherSettingsFile(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).join(preferencesDir(env, platform), 'pharo-launcher', 'settings.ston')
}

/** Read `#pharoLauncher#<name>` values out of Launcher's settings.ston. */
export function parseLauncherSettings(text: string): Record<string, Ston> {
  const settings: Record<string, Ston> = {}
  let parsed: Ston
  try {
    parsed = parseSton(text)
  } catch {
    return settings
  }
  for (const item of Array.isArray(parsed) ? parsed : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const id = item.settingNodeIdentifier
    if (typeof id === 'string') settings[id.split('#').filter(Boolean).at(-1)!] = item.realValue ?? null
  }
  return settings
}

export async function launcherLocations(overrides: LocationOverrides = {}): Promise<LauncherLocations> {
  const env = overrides.env ?? process.env
  const platform = overrides.platform ?? process.platform
  const p = pathFor(platform)
  const settingsPath = launcherSettingsFile(env, platform)
  let settings: Record<string, Ston> = {}
  let settingsFile: string | undefined
  try {
    settings = parseLauncherSettings(await readFile(settingsPath, 'utf8'))
    settingsFile = settingsPath
  } catch {
    // Launcher never ran (or isn't installed): its defaults apply.
  }
  const str = (key: string) => (typeof settings[key] === 'string' && settings[key] ? settings[key] as string : undefined)
  const coreDir = str('launcherCoreDirString') ?? defaultCoreDir(env, platform)
  const imagesFromEnv = overrides.imagesDir ?? env.PHARO_AGENT_IMAGES_DIR
  const vmsFromEnv = overrides.vmsDir ?? env.PHARO_AGENT_VMS_DIR
  return {
    settingsFile,
    coreDir,
    imagesDir: imagesFromEnv ?? str('locationString') ?? p.join(coreDir, 'images'),
    vmsDir: vmsFromEnv ?? str('vmStoreString') ?? p.join(coreDir, 'vms'),
    templateCacheDir: p.join(preferencesDir(env, platform), 'pharo', 'templateCache'),
    sourcesFile: p.join(coreDir, 'sources.list'),
    mySourcesFile: p.join(coreDir, 'mysources.list'),
    origin: {
      imagesDir: imagesFromEnv ? 'configured' : str('locationString') ? 'Pharo Launcher settings' : 'Pharo Launcher default',
      vmsDir: vmsFromEnv ? 'configured' : str('vmStoreString') ? 'Pharo Launcher settings' : 'Pharo Launcher default',
    },
  }
}

// ---------------------------------------------------------------------------
// Images

export type PharoImage = {
  name: string
  dir: string
  imagePath: string
  /** Launcher form: '140' for Pharo 14.0. */
  version?: string
  /** 64 or 32 */
  arch?: '64' | '32'
  formatNumber?: number
  template?: string
  templateUrl?: string
  /** VM folder recorded by Launcher, relative to the vms directory. */
  vmRelativePath?: string[]
  modifiedAt?: string
  /** Launcher images vs. images found elsewhere on disk. */
  source: 'launcher' | 'found'
}

export function versionLabel(version?: string): string {
  if (!version || !/^\d+$/.test(version)) return version ?? '?'
  return `${version.slice(0, -1) || '0'}.${version.slice(-1)}`
}

/** The VM generation an image needs: '13.1' and '131' both run on the 130 VM. */
export function vmVersionFor(version: string): string {
  return /^\d{3}$/.test(version) ? `${version.slice(0, 2)}0` : version
}

/** Image format from its header: the first word, little-endian. */
export async function readImageFormat(imagePath: string): Promise<{ formatNumber?: number; arch?: '64' | '32' }> {
  try {
    const handle = await open(imagePath, 'r')
    try {
      const buffer = Buffer.alloc(4)
      await handle.read(buffer, 0, 4, 0)
      const formatNumber = buffer.readUInt32LE(0)
      if (formatNumber === 0) return {}
      return { formatNumber, arch: formatNumber >= 68000 ? '64' : '32' }
    } finally {
      await handle.close()
    }
  } catch {
    return {}
  }
}

/** "Pharo14.0-64bit-1ad0bf2.sources" -> "140". */
export function versionFromSourcesName(name: string): string | undefined {
  const match = /Pharo(\d+)\.(\d+)/i.exec(name)
  return match ? `${match[1]}${match[2]}` : undefined
}

/** "https://files.pharo.org/image/140/latest-64.zip" -> "140". */
export function versionFromUrl(url: string): string | undefined {
  return /\/image\/(\d+)\//.exec(url)?.[1] ?? /Pharo64-(\d+)(?:\.\d+)?\.zip/i.exec(url)?.[1]?.concat('0')
}

/** Read one image directory the way Launcher does: D/D.image, else the only *.image in D. */
export async function readImageDirectory(dir: string, source: PharoImage['source'] = 'launcher'): Promise<PharoImage | undefined> {
  const name = path.basename(dir)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  const images = entries.filter(entry => entry.endsWith('.image'))
  const imageFile = images.includes(`${name}.image`) ? `${name}.image` : images.length === 1 ? images[0] : undefined
  if (!imageFile) return undefined
  return describeImage(path.join(dir, imageFile), source, entries)
}

export async function describeImage(imagePath: string, source: PharoImage['source'], entries?: string[]): Promise<PharoImage> {
  const dir = path.dirname(imagePath)
  const files = entries ?? await readdir(dir).catch(() => [] as string[])
  const image: PharoImage = {
    // Images found elsewhere are often all called Pharo.image or run.image: keep their folder.
    name: source === 'launcher' ? path.basename(dir) : `${path.basename(dir)}/${path.basename(imagePath, '.image')}`,
    dir,
    imagePath,
    source,
  }
  const header = await readImageFormat(imagePath)
  image.formatNumber = header.formatNumber
  image.arch = header.arch
  if (files.includes('meta-inf.ston')) {
    try {
      const meta = parseSton(await readFile(path.join(dir, 'meta-inf.ston'), 'utf8')) as StonObject
      if (typeof meta.pharoVersion === 'string') image.version = meta.pharoVersion
      if (meta.architecture === '64' || meta.architecture === '32') image.arch = meta.architecture
      const template = meta.originTemplate as StonObject | undefined
      if (template && typeof template.name === 'string') image.template = template.name
      if (template && typeof template.url === 'string') image.templateUrl = template.url
      image.vmRelativePath = recordedVmPath(meta)
    } catch {
      // A damaged meta-inf.ston only loses the details it held.
    }
  }
  if (files.includes('pharo.version')) {
    const text = (await readFile(path.join(dir, 'pharo.version'), 'utf8').catch(() => '')).trim()
    if (/^\d+$/.test(text)) image.version = text
  }
  if (!image.version) {
    const sources = files.find(file => file.endsWith('.sources'))
    image.version = sources ? versionFromSourcesName(sources) : undefined
  }
  try {
    image.modifiedAt = (await stat(imagePath)).mtime.toISOString()
  } catch {
    // keep undefined
  }
  return image
}

function recordedVmPath(meta: StonObject): string[] | undefined {
  const configs = meta.launchConfigurations
  if (!Array.isArray(configs)) return undefined
  for (const config of configs) {
    const vm = (config as StonObject | null)?.vm as StonObject | undefined
    const ref = (vm?.executableRef ?? vm?.vmBinaryRef) as StonObject | undefined
    if (ref && Array.isArray(ref.path) && ref.origin === 'launcherVMsLocation') return ref.path.map(String)
  }
  return undefined
}

export async function listLauncherImages(locations: LauncherLocations): Promise<PharoImage[]> {
  let entries: string[]
  try {
    entries = await readdir(locations.imagesDir)
  } catch {
    return []
  }
  const images: PharoImage[] = []
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry.startsWith('.')) continue
    const dir = path.join(locations.imagesDir, entry)
    if (!await isDirectory(dir)) continue
    const image = await readImageDirectory(dir)
    if (image) images.push(image)
  }
  return images
}

/** Images outside Launcher's directory: the workspace, and (with deep) the usual places. */
export async function findOtherImages(locations: LauncherLocations, options: { cwd: string; deep?: boolean }): Promise<PharoImage[]> {
  const found = new Set<string>()
  const add = (file: string) => {
    if (!file.endsWith('.image')) return
    if (file.startsWith(locations.imagesDir + path.sep)) return
    // Skip Pharo Launcher's own control image.
    if (/PharoLauncher\.image$/.test(file)) return
    found.add(file)
  }
  for (const file of await walk(options.cwd, 4, 200)) add(file)
  if (options.deep) {
    if (process.platform === 'darwin' && await which('mdfind')) {
      const result = await execFileCapture(['mdfind', 'kMDItemFSName == "*.image"'], { timeoutMs: 10_000 })
      for (const line of result.stdout.split('\n')) if (line.trim()) add(line.trim())
    } else {
      for (const root of ['Desktop', 'Downloads', 'Documents', 'Projects', 'dev', 'src'].map(dir => path.join(os.homedir(), dir))) {
        for (const file of await walk(root, 5, 300)) add(file)
      }
    }
  }
  const images: PharoImage[] = []
  for (const file of [...found].sort()) {
    if (!await isFile(file)) continue
    const header = await readImageFormat(file)
    if (!header.formatNumber) continue // not a Pharo image (macOS has other *.image files)
    images.push(await describeImage(file, 'found'))
  }
  return images
}

async function walk(root: string, depth: number, limit: number, out: string[] = []): Promise<string[]> {
  if (depth < 0 || out.length >= limit) return out
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (out.length >= limit) break
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'pharo-local') continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) await walk(full, depth - 1, limit, out)
    else if (entry.isFile() && entry.name.endsWith('.image')) out.push(full)
  }
  return out
}

export async function findImage(locations: LauncherLocations, query: string, cwd = process.cwd()): Promise<PharoImage> {
  if (query.endsWith('.image') || query.includes('/') || query.includes('\\')) {
    const file = path.resolve(cwd, query.endsWith('.image') ? query : path.join(query, `${path.basename(query)}.image`))
    if (await isFile(file)) {
      const inLauncher = path.dirname(path.dirname(file)) === path.resolve(locations.imagesDir)
      return inLauncher ? (await readImageDirectory(path.dirname(file)))! : describeImage(file, 'found')
    }
  }
  const images = await listLauncherImages(locations)
  const exact = images.find(image => image.name === query) ?? images.find(image => image.name.toLowerCase() === query.toLowerCase())
  if (exact) return exact
  const partial = images.filter(image => image.name.toLowerCase().includes(query.toLowerCase()))
  if (partial.length === 1) return partial[0]!
  if (partial.length > 1) throw new LauncherError(`"${query}" matches several images: ${partial.map(image => image.name).join(', ')}`)
  throw new LauncherError(`No image named "${query}" in ${locations.imagesDir}`)
}

// ---------------------------------------------------------------------------
// VMs

export type PharoVm = { id: string; dir: string; executable?: string; guiExecutable?: string }

/**
 * The executable inside a VM folder. Windows has two: PharoConsole.exe keeps
 * stdout (headless, scripts) and Pharo.exe is the windowed one.
 */
export async function vmExecutables(dir: string, platform: NodeJS.Platform = process.platform): Promise<{ executable?: string; guiExecutable?: string }> {
  // `platform` picks the layout; the files are on this machine's filesystem.
  const p = path
  const candidates = platform === 'darwin'
    ? [p.join(dir, 'Pharo.app', 'Contents', 'MacOS', 'Pharo')]
    : platform === 'win32'
      ? [p.join(dir, 'PharoConsole.exe'), p.join(dir, 'Pharo.exe')]
      : [p.join(dir, 'pharo'), p.join(dir, 'bin', 'pharo'), p.join(dir, 'lib', 'pharo')]
  const existing: string[] = []
  for (const candidate of candidates) if (await pathExists(candidate)) existing.push(candidate)
  if (platform === 'win32') {
    const gui = existing.find(file => file.endsWith('Pharo.exe'))
    return { executable: existing.find(file => file.endsWith('PharoConsole.exe')) ?? gui, guiExecutable: gui ?? existing[0] }
  }
  return { executable: existing[0], guiExecutable: existing[0] }
}

export async function listVms(locations: LauncherLocations): Promise<PharoVm[]> {
  let entries: string[]
  try {
    entries = await readdir(locations.vmsDir)
  } catch {
    return []
  }
  const vms: PharoVm[] = []
  for (const entry of entries.sort()) {
    const dir = path.join(locations.vmsDir, entry)
    if (entry === 'private' || entry.startsWith('.') || !await isDirectory(dir)) continue
    vms.push({ id: entry, dir, ...await vmExecutables(dir) })
  }
  return vms
}

function vmNumber(id: string): number {
  return Number(/^(\d+)/.exec(id)?.[1] ?? 0)
}

export type VmResolution = { executable?: string; guiExecutable?: string; id?: string; reason: string; missingVersion?: string }

/**
 * The VM for an image, in Launcher's order of preference: the one recorded in
 * its meta-inf.ston, a VM shipped next to the image (zeroconf layout), the
 * <version>-x64 folder, then the closest newer 64-bit Spur VM (9.0+ VMs run
 * every later image format they know).
 */
export async function resolveVm(locations: LauncherLocations, image: PharoImage): Promise<VmResolution> {
  if (image.vmRelativePath?.length) {
    const executable = path.join(locations.vmsDir, ...image.vmRelativePath)
    if (await pathExists(executable)) {
      const dir = path.join(locations.vmsDir, image.vmRelativePath[0]!)
      return { ...await vmExecutables(dir), executable, id: image.vmRelativePath[0], reason: 'recorded by Pharo Launcher' }
    }
  }
  for (const local of ['pharo-vm', 'vm']) {
    const dir = path.join(image.dir, local)
    const found = await vmExecutables(dir)
    if (found.executable) return { ...found, id: local, reason: 'shipped next to the image' }
  }
  const arch = image.arch === '32' ? 'x86' : 'x64'
  const version = image.version ? vmVersionFor(image.version) : undefined
  const vms = await listVms(locations)
  if (version) {
    const exact = vms.find(vm => vm.id === `${version}-${arch}` && vm.executable)
    if (exact) return { executable: exact.executable, guiExecutable: exact.guiExecutable, id: exact.id, reason: 'matches the image version' }
    const wanted = Number(version)
    if (wanted >= 90 && arch === 'x64') {
      const newer = vms
        .filter(vm => vm.executable && vm.id.endsWith('-x64') && vmNumber(vm.id) >= wanted)
        .sort((a, b) => vmNumber(a.id) - vmNumber(b.id))[0]
      if (newer) return { executable: newer.executable, guiExecutable: newer.guiExecutable, id: newer.id, reason: `newest compatible VM (no ${version}-${arch} installed)`, missingVersion: version }
    }
    return { reason: `no VM for Pharo ${versionLabel(version)} installed`, missingVersion: version }
  }
  const newest = vms.filter(vm => vm.executable && vm.id.endsWith('-x64')).sort((a, b) => vmNumber(b.id) - vmNumber(a.id))[0]
  if (newest) return { executable: newest.executable, guiExecutable: newest.guiExecutable, id: newest.id, reason: 'image version unknown: newest VM' }
  return { reason: 'image version unknown and no VM installed' }
}

/** files.pharo.org's VM build for this machine. */
export function vmDownloadUrl(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const osName = platform === 'darwin' ? 'Darwin' : platform === 'win32' ? 'Windows' : 'Linux'
  const cpu = arch === 'arm64' ? 'arm64' : 'x86_64'
  return `https://files.pharo.org/get-files/${version}/pharo-vm-${osName}-${cpu}-stable.zip`
}

export async function downloadVm(locations: LauncherLocations, version: string, options: { onProgress?: Progress } = {}): Promise<PharoVm> {
  if (Number(version) < 90) throw new LauncherError(`Pharo ${versionLabel(version)} needs a pre-9.0 VM; download it with Pharo Launcher.`)
  const id = `${version}-x64`
  const dir = path.join(locations.vmsDir, id)
  const existing = await vmExecutables(dir)
  if (existing.executable) return { id, dir, ...existing }
  await mkdir(locations.vmsDir, { recursive: true })
  const zip = path.join(xdgCacheDir(), 'vms', `${id}-${process.platform}-${process.arch}.zip`)
  await download(vmDownloadUrl(version), zip, { onProgress: options.onProgress, label: `VM ${id}` })
  const staging = path.join(locations.vmsDir, `.${id}.downloading-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  await extractZip(zip, staging)
  await rm(dir, { recursive: true, force: true })
  await rename(staging, dir)
  const found = await vmExecutables(dir)
  if (!found.executable) throw new LauncherError(`Downloaded VM ${id} but found no Pharo executable in ${dir}`)
  return { id, dir, ...found }
}

// ---------------------------------------------------------------------------
// Templates

export type Template = { name: string; url: string; group: string }
export const officialSourcesUrl = 'https://files.pharo.org/pharo-launcher/sources.list'

/** Flatten a Launcher sources.list into templates (URL entries, grouped). */
export function parseSourcesList(text: string): Template[] {
  const templates: Template[] = []
  const visit = (node: Ston, group: string) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, group)
      return
    }
    if (!node || typeof node !== 'object') return
    const type = node.type
    const name = typeof node.name === 'string' ? node.name : ''
    if (type === 'URL' && typeof node.url === 'string') templates.push({ name, url: node.url, group })
    else if (Array.isArray(node.templates)) visit(node.templates, name || group)
  }
  try {
    visit(parseSton(text), 'Templates')
  } catch {
    // unreadable list: no templates from it
  }
  return templates
}

export async function listTemplates(locations: LauncherLocations, options: { refresh?: boolean } = {}): Promise<Template[]> {
  const ourCopy = path.join(xdgCacheDir(), 'sources.list')
  let official: string | undefined
  if (!options.refresh) {
    official = await readFile(locations.sourcesFile, 'utf8').catch(() => undefined) ?? await readFile(ourCopy, 'utf8').catch(() => undefined)
  }
  if (!official) {
    try {
      const response = await fetch(officialSourcesUrl, { signal: AbortSignal.timeout(15_000) })
      if (response.ok) {
        official = await response.text()
        await mkdir(path.dirname(ourCopy), { recursive: true })
        await writeFile(ourCopy, official, 'utf8')
      }
    } catch {
      // offline: fall back to whatever is cached
    }
    official ??= await readFile(locations.sourcesFile, 'utf8').catch(() => undefined) ?? await readFile(ourCopy, 'utf8').catch(() => undefined)
  }
  const templates: Template[] = []
  // Templates already downloaded (Launcher's "Templates" group): usable offline.
  for (const file of (await readdir(locations.templateCacheDir).catch(() => [] as string[])).sort()) {
    if (file.endsWith('.zip')) templates.push({ name: file.slice(0, -4), url: `file://${path.join(locations.templateCacheDir, file)}`, group: 'Local templates' })
  }
  const mine = await readFile(locations.mySourcesFile, 'utf8').catch(() => undefined)
  if (mine) templates.push(...parseSourcesList(mine).map(template => ({ ...template, group: `My templates: ${template.group}` })))
  if (official) templates.push(...parseSourcesList(official))
  return templates
}

export function findTemplate(templates: Template[], query: string): Template {
  const lower = query.toLowerCase()
  const remote = templates.filter(template => template.group !== 'Local templates')
  const pick = (list: Template[]) =>
    list.find(template => template.name === query)
    ?? list.find(template => template.name.toLowerCase() === lower)
  const exact = pick(remote) ?? pick(templates)
  if (exact) return exact
  const partial = templates.filter(template => template.name.toLowerCase().includes(lower))
  const names = [...new Set(partial.map(template => template.name))]
  if (names.length === 1) return partial.find(template => template.group !== 'Local templates') ?? partial[0]!
  if (names.length > 1) throw new LauncherError(`"${query}" matches several templates:\n  ${names.slice(0, 15).join('\n  ')}`)
  throw new LauncherError(`No template matches "${query}". List them with: pharo-agent images templates`)
}

// ---------------------------------------------------------------------------
// Create, copy, delete

export type Progress = (event: { label: string; received: number; total?: number }) => void

export function validateImageName(name: string): void {
  if (!name.trim()) throw new LauncherError('Image name is empty')
  if (/[\\/:*?"<>|]/.test(name) || name.startsWith('.')) throw new LauncherError(`Invalid image name "${name}": avoid / \\ : * ? " < > | and a leading dot`)
}

export async function createImage(
  locations: LauncherLocations,
  input: { name: string; template?: Template; zipPath?: string },
  options: { onProgress?: Progress } = {},
): Promise<PharoImage> {
  validateImageName(input.name)
  const target = path.join(locations.imagesDir, input.name)
  if (await pathExists(target)) throw new LauncherError(`An image named "${input.name}" already exists in ${locations.imagesDir}`)
  let zip = input.zipPath
  if (!zip && input.template) {
    if (input.template.url.startsWith('file://')) zip = input.template.url.slice('file://'.length)
    else {
      // Shared with Pharo Launcher: a template it downloaded is reused, and the other way round.
      zip = path.join(locations.templateCacheDir, `${input.template.name}.zip`)
      if (!await isFile(zip)) await download(input.template.url, zip, { onProgress: options.onProgress, label: input.template.name })
    }
  }
  if (!zip) throw new LauncherError('createImage needs a template or a zip file')
  await mkdir(locations.imagesDir, { recursive: true })
  const staging = path.join(locations.imagesDir, `.${input.name}.creating-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  try {
    await extractZip(zip, staging)
    const imageFile = await findFirst(staging, '.image', 3)
    if (!imageFile) throw new LauncherError(`The template ${path.basename(zip)} holds no .image file`)
    const sourceDir = path.dirname(imageFile)
    const base = path.basename(imageFile, '.image')
    const files = await readdir(sourceDir)
    const changes = files.find(file => file === `${base}.changes`) ?? files.find(file => file.endsWith('.changes'))
    await rename(imageFile, path.join(sourceDir, `${input.name}.image`))
    if (changes) await rename(path.join(sourceDir, changes), path.join(sourceDir, `${input.name}.changes`))
    else await writeFile(path.join(sourceDir, `${input.name}.changes`), '')
    await rename(sourceDir, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const image = (await readImageDirectory(target))!
  const version = image.version ?? (input.template ? versionFromUrl(input.template.url) : undefined)
  if (version && !await pathExists(path.join(target, 'pharo.version'))) await writeFile(path.join(target, 'pharo.version'), version)
  await writeFile(path.join(target, 'meta-inf.ston'), metaInfSton({
    name: input.name,
    version,
    formatNumber: image.formatNumber,
    arch: image.arch ?? '64',
    templateName: input.template?.name ?? path.basename(zip, '.zip'),
    templateUrl: input.template?.url ?? `file://${zip}`,
  }), 'utf8')
  return (await readImageDirectory(target))!
}

/** meta-inf.ston in the shape Pharo Launcher writes and reads. */
export function metaInfSton(input: { name: string; version?: string; formatNumber?: number; arch: '64' | '32'; templateName: string; templateUrl: string }): string {
  const version = input.version ?? '0'
  const vmId = `${vmVersionFor(version)}-${input.arch === '32' ? 'x86' : 'x64'}`
  const vmPath = process.platform === 'darwin'
    ? [vmId, 'Pharo.app', 'Contents', 'MacOS', 'Pharo']
    : process.platform === 'win32' ? [vmId, 'Pharo.exe'] : [vmId, 'pharo']
  const relative = (parts: string[]) => `RelativePath [ ${parts.map(stonString).join(', ')} ]`
  const format = input.formatNumber ?? 68021
  // Object order matters: @1 is this PhLImage and @4 its vmManager.
  return `PhLImage {
	#formatNumber : ${format},
	#architecture : '${input.arch}',
	#pharoVersion : '${version}',
	#originTemplate : PhLRemoteTemplate {
		#name : ${stonString(input.templateName)},
		#url : URL [ ${stonString(input.templateUrl)} ]
	},
	#vmManager : PhLVirtualMachineManager {
		#imageFile : FileLocator {
			#path : ${relative([input.name, `${input.name}.image`])},
			#origin : #launcherImagesLocation
		},
		#imageFormatNumber : ${format},
		#imageVersion : '${version}'
	},
	#launchConfigurations : OrderedCollection [
		PhLLaunchConfiguration {
			#image : @1,
			#name : 'Default',
			#imageArguments : OrderedCollection [ ],
			#vm : PhLVirtualMachine {
				#executableRef : FileLocator {
					#path : ${relative(vmPath)},
					#origin : #launcherVMsLocation
				},
				#vmBinaryRef : FileLocator {
					#path : ${relative(vmPath)},
					#origin : #launcherVMsLocation
				},
				#manager : @4,
				#flavour : '',
				#id : '${vmId}',
				#blessing : 'stable'
			}
		}
	],
	#shouldRunInitializationScript : false
}`
}

export async function copyImage(locations: LauncherLocations, image: PharoImage, newName: string): Promise<PharoImage> {
  validateImageName(newName)
  const target = path.join(locations.imagesDir, newName)
  if (await pathExists(target)) throw new LauncherError(`An image named "${newName}" already exists`)
  const staging = path.join(locations.imagesDir, `.${newName}.copying-${process.pid}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  for (const entry of await readdir(image.dir)) {
    if (entry === 'pharo-agent' || entry === 'PharoDebug.log') continue
    const from = path.join(image.dir, entry)
    let to = path.join(staging, entry)
    if (path.join(image.dir, entry) === image.imagePath) to = path.join(staging, `${newName}.image`)
    else if (entry === `${path.basename(image.imagePath, '.image')}.changes`) to = path.join(staging, `${newName}.changes`)
    await cp(from, to, { recursive: true, preserveTimestamps: true })
  }
  const meta = path.join(staging, 'meta-inf.ston')
  if (await isFile(meta)) {
    const text = await readFile(meta, 'utf8')
    await writeFile(meta, text.replace(
      `RelativePath [ ${stonString(image.name)}, ${stonString(`${image.name}.image`)} ]`,
      `RelativePath [ ${stonString(newName)}, ${stonString(`${newName}.image`)} ]`,
    ), 'utf8')
  }
  await rename(staging, target)
  return (await readImageDirectory(target))!
}

export async function deleteImage(locations: LauncherLocations, image: PharoImage): Promise<void> {
  if (image.source !== 'launcher' || path.dirname(image.dir) !== path.resolve(locations.imagesDir)) {
    throw new LauncherError(`Only images in ${locations.imagesDir} can be deleted from here (${image.imagePath} was found elsewhere).`)
  }
  const running = await runningImagePids(image)
  if (running.length) throw new LauncherError(`"${image.name}" is running (pid ${running.join(', ')}). Stop it first.`)
  await rm(image.dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Processes: a running image is a VM whose command line names its file.

export type VmProcess = { pid: number; command: string }

export async function listVmProcesses(): Promise<VmProcess[]> {
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*.image*' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
    const result = await execFileCapture(['powershell.exe', '-NoProfile', '-Command', script], { timeoutMs: 15_000 })
    return result.stdout.split(/\r?\n/).map(line => line.split('\t')).filter(parts => parts.length >= 2 && /^\d+$/.test(parts[0]!)).map(([pid, ...rest]) => ({ pid: Number(pid), command: rest.join('\t') }))
  }
  const result = await execFileCapture(['ps', '-axo', 'pid=,args='], { timeoutMs: 10_000 })
  return result.stdout.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((match): match is RegExpExecArray => Boolean(match && match[2]!.includes('.image'))).map(match => ({ pid: Number(match[1]), command: match[2]! }))
}

export async function runningImagePids(image: PharoImage, processes?: VmProcess[]): Promise<number[]> {
  const list = processes ?? await listVmProcesses()
  const paths = new Set([image.imagePath])
  try {
    paths.add(await realpath(image.imagePath))
  } catch {
    // keep the given path
  }
  return list.filter(entry => [...paths].some(file => entry.command.includes(file)) && entry.pid !== process.pid).map(entry => entry.pid)
}

// ---------------------------------------------------------------------------
// Downloads and archives

export async function download(url: string, destination: string, options: { onProgress?: Progress; label?: string } = {}): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new LauncherError(`Download failed (HTTP ${response.status}): ${url}`)
  const total = Number(response.headers.get('content-length')) || undefined
  const partial = `${destination}.part-${process.pid}`
  let received = 0
  let last = 0
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (options.onProgress && Date.now() - last > 150) {
      last = Date.now()
      options.onProgress({ label: options.label ?? path.basename(destination), received, total })
    }
  })
  try {
    await pipeline(source, createWriteStream(partial))
    options.onProgress?.({ label: options.label ?? path.basename(destination), received, total: total ?? received })
    await rename(partial, destination)
  } catch (error) {
    await rm(partial, { force: true })
    throw error
  }
}

/** ditto on macOS keeps app bundles intact; tar is bsdtar on Windows 10+. */
export async function extractZip(zip: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  let command: string[]
  if (process.platform === 'darwin') command = ['ditto', '-x', '-k', zip, destination]
  else if (process.platform === 'win32') command = ['tar', '-xf', zip, '-C', destination]
  else if (await which('unzip')) command = ['unzip', '-q', '-o', zip, '-d', destination]
  else if (await which('bsdtar')) command = ['bsdtar', '-xf', zip, '-C', destination]
  else throw new LauncherError('Install unzip to extract Pharo downloads (e.g. sudo apt install unzip).')
  const result = await execFileCapture(command, { timeoutMs: 600_000 })
  if (result.exitCode !== 0) throw new LauncherError(`Could not extract ${zip}: ${result.stderr || result.stdout}`)
}

async function findFirst(root: string, extension: string, depth: number): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.startsWith('._')) return path.join(root, entry.name)
  if (depth <= 0) return undefined
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== '__MACOSX') {
      const found = await findFirst(path.join(root, entry.name), extension, depth - 1)
      if (found) return found
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Ports

/** First free loopback port from `start`, skipping `taken`. */
export async function freePort(start = 4044, taken: Set<number> = new Set()): Promise<number> {
  for (let port = start; port < start + 200; port += 1) {
    if (taken.has(port)) continue
    const free = await new Promise<boolean>(resolve => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new LauncherError(`No free port between ${start} and ${start + 199}`)
}

export function newToken(): string {
  return randomUUID()
}

