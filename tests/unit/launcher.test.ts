import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseSton } from '../../pharo-agent/ston.ts'
import {
  copyImage,
  createImage,
  defaultCoreDir,
  deleteImage,
  findTemplate,
  launcherLocations,
  listLauncherImages,
  metaInfSton,
  parseLauncherSettings,
  parseSourcesList,
  preferencesDir,
  readImageDirectory,
  resolveVm,
  versionFromSourcesName,
  versionFromUrl,
  versionLabel,
  vmDownloadUrl,
  vmExecutables,
  vmVersionFor,
} from '../../pharo-agent/launcher.ts'
import { splitArgs } from '../../pharo-agent/cli.ts'

test('reads STON as Pharo Launcher writes it', () => {
  const value = parseSton(`PhLImage {
    #pharoVersion : '140',
    #quoted : 'it''s quoted',
    #templateNameFormat: '{6} ({5})',
    #url : URL [ 'https://files.pharo.org/image/140/latest-64.zip' ],
    #path : RelativePath [ '140-x64', 'Pharo.app' ],
    #image : @1,
    #flag : true,
    #nothing : nil,
    #count : 68021
  }`) as Record<string, unknown>
  assert.equal(value._class, 'PhLImage')
  assert.equal(value.pharoVersion, '140')
  assert.equal(value.quoted, "it's quoted")
  assert.equal(value.templateNameFormat, '{6} ({5})')
  assert.equal(value.url, 'https://files.pharo.org/image/140/latest-64.zip')
  assert.deepEqual(value.path, ['140-x64', 'Pharo.app'])
  assert.deepEqual(value.image, { $ref: 1 })
  assert.equal(value.flag, true)
  assert.equal(value.nothing, null)
  assert.equal(value.count, 68021)
})

test('reads image and VM folders from Pharo Launcher settings', () => {
  const settings = parseLauncherSettings(`[
    StoredSetting { #settingNodeIdentifier : '#pharoLauncher#locationString', #realValue : '/data/images' },
    StoredSetting { #settingNodeIdentifier : '#pharoLauncher#vmStoreString', #realValue : '/data/vms' },
    StoredSetting { #settingNodeIdentifier : '#pharoLauncher#quitOnLaunch', #realValue : false }
  ]`)
  assert.equal(settings.locationString, '/data/images')
  assert.equal(settings.vmStoreString, '/data/vms')
  assert.equal(settings.quitOnLaunch, false)
})

test('uses Pharo Launcher locations on macOS, Linux and Windows', () => {
  assert.equal(preferencesDir({ HOME: '/Users/me' }, 'darwin'), '/Users/me/Library/Preferences')
  assert.equal(preferencesDir({ HOME: '/home/me' }, 'linux'), '/home/me/.config')
  assert.equal(preferencesDir({ HOME: '/home/me', XDG_CONFIG_HOME: '/cfg' }, 'linux'), '/cfg')
  assert.equal(preferencesDir({ USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'), 'C:\\Users\\me\\AppData\\Roaming')
  assert.equal(defaultCoreDir({ HOME: '/Users/me' }, 'darwin'), '/Users/me/Documents/Pharo')
  assert.equal(defaultCoreDir({ HOME: '/home/me' }, 'linux'), '/home/me/Pharo')
  assert.equal(defaultCoreDir({ USERPROFILE: 'C:\\Users\\me' }, 'win32'), 'C:\\Users\\me\\Documents\\Pharo')
})

test('downloads the VM built for this OS and CPU', () => {
  assert.equal(vmDownloadUrl('140', 'darwin', 'arm64'), 'https://files.pharo.org/get-files/140/pharo-vm-Darwin-arm64-stable.zip')
  assert.equal(vmDownloadUrl('130', 'linux', 'x64'), 'https://files.pharo.org/get-files/130/pharo-vm-Linux-x86_64-stable.zip')
  assert.equal(vmDownloadUrl('120', 'win32', 'x64'), 'https://files.pharo.org/get-files/120/pharo-vm-Windows-x86_64-stable.zip')
})

test('works out Pharo versions from files and URLs', () => {
  assert.equal(versionFromSourcesName('Pharo14.0-64bit-1ad0bf2.sources'), '140')
  assert.equal(versionFromSourcesName('Pharo13.1-64bit-45e803d.sources'), '131')
  assert.equal(vmVersionFor('131'), '130')
  assert.equal(versionFromUrl('https://files.pharo.org/image/120/latest-64.zip'), '120')
  assert.equal(versionFromUrl('https://github.com/moosetechnology/Moose/releases/download/v13.x.x/Moose13-stable-Pharo64-13.zip'), '130')
  assert.equal(versionLabel('140'), '14.0')
  assert.equal(versionLabel('61'), '6.1')
})

test('flattens sources.list template groups', () => {
  const templates = parseSourcesList(`OrderedCollection [
    PhLTemplateSource { #type : #Cache, #name : 'Templates' },
    PhLTemplateSource { #type : #URLGroup, #name : 'Official distributions', #templates : [
      PhLTemplateSource { #type : #URL, #name : 'Pharo 14.0 - 64bit (stable)', #url : 'https://files.pharo.org/image/140/latest-64.zip' },
      PhLTemplateSource { #type : #URL, #name : 'Pharo 13.0 - 64bit (stable)', #url : 'https://files.pharo.org/image/130/latest-64.zip' }
    ] },
    PhLTemplateSource { #type : #HttpListing, #name : 'Pharo 15.0', #url : 'https://files.pharo.org/image/150/', #filterPattern : 'x', #templateNameFormat: '{6}' }
  ]`)
  assert.deepEqual(templates.map(template => `${template.group}/${template.name}`), [
    'Official distributions/Pharo 14.0 - 64bit (stable)',
    'Official distributions/Pharo 13.0 - 64bit (stable)',
  ])
  assert.equal(findTemplate(templates, 'pharo 14.0 - 64bit (stable)').url, 'https://files.pharo.org/image/140/latest-64.zip')
  assert.throws(() => findTemplate(templates, 'stable'), /matches several templates/)
})

test('finds the executable inside each OS layout', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-vm-'))
  try {
    await mkdir(path.join(dir, 'bin'), { recursive: true })
    await writeFile(path.join(dir, 'bin', 'pharo'), '')
    await writeFile(path.join(dir, 'PharoConsole.exe'), '')
    await writeFile(path.join(dir, 'Pharo.exe'), '')
    assert.equal((await vmExecutables(dir, 'linux')).executable, path.join(dir, 'bin', 'pharo'))
    const windows = await vmExecutables(dir, 'win32')
    assert.match(windows.executable!, /PharoConsole\.exe$/)
    assert.match(windows.guiExecutable!, /Pharo\.exe$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A Launcher layout with an image directory, as Pharo Launcher leaves it. */
async function fakeLauncher(): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-launcher-'))
  const env = { HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData'), XDG_CONFIG_HOME: path.join(root, '.config') }
  return { root, env }
}

function imageHeader(): Buffer {
  const header = Buffer.alloc(64)
  header.writeUInt32LE(68021, 0)
  return header
}

test('lists Launcher images with version, template and recorded VM', async () => {
  const { root, env } = await fakeLauncher()
  try {
    const locations = await launcherLocations({ env, imagesDir: path.join(root, 'images'), vmsDir: path.join(root, 'vms') })
    const dir = path.join(locations.imagesDir, 'My Image')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'My Image.image'), imageHeader())
    await writeFile(path.join(dir, 'My Image.changes'), '')
    await writeFile(path.join(dir, 'pharo.version'), '140\n')
    await writeFile(path.join(dir, 'meta-inf.ston'), metaInfSton({ name: 'My Image', version: '140', arch: '64', formatNumber: 68021, templateName: 'Pharo 14.0 - 64bit (stable)', templateUrl: 'https://files.pharo.org/image/140/latest-64.zip' }))
    await mkdir(path.join(locations.imagesDir, 'not an image'), { recursive: true })
    const [image, ...rest] = await listLauncherImages(locations)
    assert.equal(rest.length, 0)
    assert.equal(image!.name, 'My Image')
    assert.equal(image!.version, '140')
    assert.equal(image!.arch, '64')
    assert.equal(image!.formatNumber, 68021)
    assert.equal(image!.template, 'Pharo 14.0 - 64bit (stable)')
    assert.equal(image!.vmRelativePath?.[0], '140-x64')

    // No VM yet: it says which one is missing.
    assert.equal((await resolveVm(locations, image!)).missingVersion, '140')
    // A newer compatible VM is used when the exact one is missing.
    const newer = path.join(locations.vmsDir, '150-x64')
    const executable = process.platform === 'darwin' ? path.join(newer, 'Pharo.app', 'Contents', 'MacOS', 'Pharo') : process.platform === 'win32' ? path.join(newer, 'PharoConsole.exe') : path.join(newer, 'pharo')
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, '')
    const resolved = await resolveVm(locations, image!)
    assert.equal(resolved.id, '150-x64')
    assert.equal(resolved.executable, executable)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const hasZip = spawnSync('zip', ['-v']).status === 0

test('creates, copies and deletes images like Pharo Launcher', { skip: hasZip ? false : 'zip is not installed' }, async () => {
  const { root, env } = await fakeLauncher()
  try {
    const locations = await launcherLocations({ env, imagesDir: path.join(root, 'images'), vmsDir: path.join(root, 'vms') })
    // A template zip shaped like files.pharo.org's: image, changes, sources and pharo.version in a folder.
    const content = path.join(root, 'zip', 'Pharo14-SNAPSHOT')
    await mkdir(content, { recursive: true })
    await writeFile(path.join(content, 'Pharo14-SNAPSHOT-64bit.image'), imageHeader())
    await writeFile(path.join(content, 'Pharo14-SNAPSHOT-64bit.changes'), 'changes')
    await writeFile(path.join(content, 'Pharo14.0-64bit-abc.sources'), 'sources')
    await writeFile(path.join(content, 'pharo.version'), '140')
    const zip = path.join(root, 'template.zip')
    assert.equal(spawnSync('zip', ['-qr', zip, 'Pharo14-SNAPSHOT'], { cwd: path.join(root, 'zip') }).status, 0)

    const template = { name: 'Pharo 14.0 - 64bit (stable)', url: `file://${zip}`, group: 'Local templates' }
    const image = await createImage(locations, { name: 'Demo', template })
    assert.deepEqual((await readdir(image.dir)).sort(), ['Demo.changes', 'Demo.image', 'Pharo14.0-64bit-abc.sources', 'meta-inf.ston', 'pharo.version'])
    assert.equal(image.version, '140')
    assert.equal(image.template, 'Pharo 14.0 - 64bit (stable)')
    await assert.rejects(createImage(locations, { name: 'Demo', template }), /already exists/)
    await assert.rejects(createImage(locations, { name: '../escape', template }), /Invalid image name/)

    const copy = await copyImage(locations, image, 'Demo copy')
    assert.ok((await readdir(copy.dir)).includes('Demo copy.image'))
    assert.match(await readFile(path.join(copy.dir, 'meta-inf.ston'), 'utf8'), /RelativePath \[ 'Demo copy', 'Demo copy\.image' \]/)
    assert.equal((await readImageDirectory(copy.dir))?.name, 'Demo copy')

    await deleteImage(locations, copy)
    assert.deepEqual((await listLauncherImages(locations)).map(each => each.name), ['Demo'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('chat commands keep quoted image names together', () => {
  assert.deepEqual(splitArgs('image create "My Image" --template "Pharo 14.0 - 64bit (stable)"'), ['image', 'create', 'My Image', '--template', 'Pharo 14.0 - 64bit (stable)'])
})

test('never picks a port that fetch refuses to connect to', async () => {
  const { freePort, assertUsablePort } = await import('../../pharo-agent/launcher.ts')
  const port = await freePort(4045)
  assert.notEqual(port, 4045)
  assert.throws(() => assertUsablePort(4045), /bad port/)
  assert.doesNotThrow(() => assertUsablePort(4046))
})
