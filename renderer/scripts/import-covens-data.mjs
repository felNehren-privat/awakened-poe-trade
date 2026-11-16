// @ts-check
//
// Imports Path of Exile 3.30 (Covens of Umbra) items and stats into the
// app's bundled English data (renderer/public/data/en/*.ndjson).
//
// Source: JIRPOS/PathOfPriceCheck-Data releases (MIT code; data built from the
// game files + GGG's public trade API). Only what changed between a 3.29
// baseline release and a 3.30 release is imported, so items and stats the app
// deliberately left out are not brought back.
//
// Usage (from the renderer folder):
//   node scripts/import-covens-data.mjs              # latest release vs. 3.29 baseline
//   node scripts/import-covens-data.mjs --dry-run    # show what would change
//   node scripts/import-covens-data.mjs --release data-20261116.383
//
// Safe to run repeatedly: entries that are already present are left alone.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(__dirname, '..')
const DATA_DIR = path.join(RENDERER, 'public/data/en')
const CACHE_DIR = path.join(RENDERER, '.cache/ppc-data')
const OVERRIDES_FILE = path.join(__dirname, 'covens-overrides.json')

const REPO = 'https://github.com/JIRPOS/PathOfPriceCheck-Data/releases'
// last release built from 3.29 game files (game_patch 3.29.3.6)
const DEFAULT_BASELINE = 'data-20261113.371'
const FILES = ['en-items.ndjson', 'en-stats.ndjson']

// PathOfPriceCheck item class -> app ItemCategory (renderer/src/parser/meta.ts)
const CATEGORY_MAP = {
  Viscera: 'Viscera',
  Jewels: 'Jewel'
}

// ---------- cli ----------

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return (i !== -1) ? args[i + 1] : undefined
}
const DRY_RUN = args.includes('--dry-run')
const RELEASE = opt('--release') ?? 'latest'
const BASELINE = opt('--baseline') ?? DEFAULT_BASELINE

// ---------- download ----------

async function fetchRelease (tag) {
  const manifestUrl = (tag === 'latest')
    ? `${REPO}/latest/download/manifest.json`
    : `${REPO}/download/${tag}/manifest.json`
  const res = await fetch(manifestUrl)
  if (!res.ok) throw new Error(`manifest ${tag}: HTTP ${res.status}`)
  const manifest = await res.json()
  const dir = path.join(CACHE_DIR, `data-${manifest.data_version}`)
  fs.mkdirSync(dir, { recursive: true })

  for (const name of FILES) {
    const entry = manifest.files.find(f => f.name === name)
    if (!entry) throw new Error(`${name} missing from ${tag}`)
    const dest = path.join(dir, name)
    if (!fs.existsSync(dest) || sha256(fs.readFileSync(dest)) !== entry.sha256) {
      const fileRes = await fetch(entry.url)
      if (!fileRes.ok) throw new Error(`${name}: HTTP ${fileRes.status}`)
      const buf = Buffer.from(await fileRes.arrayBuffer())
      if (sha256(buf) !== entry.sha256) throw new Error(`${name}: checksum mismatch`)
      fs.writeFileSync(dest, buf)
    }
  }
  return { dir, gamePatch: manifest.game_patch, version: manifest.data_version }
}

function sha256 (buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ---------- io ----------

function readNdjson (file) {
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function appendNdjson (file, records) {
  if (!records.length) return
  let text = fs.readFileSync(file, 'utf-8')
  if (!text.endsWith('\n')) text += '\n'
  text += records.map(r => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(file, text)
}

function rewriteNdjson (file, records) {
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

const itemKey = (item) => `${item.namespace}::${item.refName}`

// ---------- items ----------

function convertItem (src, overrides) {
  const over = overrides[src.refName] ?? {}
  const base = { name: src.name, refName: src.refName, namespace: src.namespace }
  const category = src.craftable?.category
  const metadataId = src.metadataId ?? ''

  if (src.namespace === 'UNIQUE') {
    return { ...base, unique: { base: src.unique.base }, icon: over.icon ?? '' }
  }

  if (src.namespace === 'GEM') {
    if (src.tradeName && src.tradeName.startsWith('Vaal ')) return null // transfigured Vaal gems need extra handling
    const gem = { maxLevel: 20 }
    if (src.tradeDisc) {
      Object.assign(gem, { transfigured: true, normalVariant: src.tradeName })
    }
    return {
      ...base,
      ...(src.tradeDisc ? { tradeDisc: src.tradeDisc } : {}),
      icon: over.icon ?? '',
      gem
    }
  }

  if (src.namespace !== 'ITEM' || !category) return null

  if (CATEGORY_MAP[category]) {
    return {
      ...base,
      craftable: { category: CATEGORY_MAP[category] },
      icon: over.icon ?? '',
      ...(src.w ? { w: src.w, h: src.h } : {})
    }
  }

  // Threads, Frayed Thread and other new stackables / fragments
  if (category === 'Stackable Currency' || category === 'Map Fragments') {
    const isThread = metadataId.startsWith('Metadata/Items/Threads/') ||
      metadataId === 'Metadata/Items/Currency/CurrencyStackedThread'
    if (!src.exchange && !isThread) return null
    const exchangeable = Boolean(src.exchange || over.exchangeable)
    return {
      ...base,
      // the trade site's exchange id; see covens-overrides.json for verified values
      ...(exchangeable ? { tradeTag: over.tradeTag ?? slug(src.name), exchangeable: true } : {}),
      icon: over.icon ?? ''
    }
  }

  return null
}

function slug (name) {
  return name.toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ +/g, '-')
}

// ---------- stats ----------

function flattenStats (records) {
  /** @type {Map<string, any>} */
  const byRef = new Map()
  for (const rec of records) {
    for (const stat of ('stats' in rec) ? rec.stats : [rec]) {
      if (!byRef.has(stat.ref)) byRef.set(stat.ref, stat)
    }
  }
  return byRef
}

function allIds (stat) {
  return new Set(Object.values(stat.trade?.ids ?? {}).flat())
}

function isPseudoOnly (stat) {
  const types = Object.keys(stat.trade?.ids ?? {})
  return types.length > 0 && types.every(t => t === 'pseudo')
}

// ---------- main ----------

async function main () {
  console.log(`Fetching ${RELEASE} and baseline ${BASELINE} ...`)
  const target = await fetchRelease(RELEASE)
  const baseline = await fetchRelease(BASELINE)
  console.log(`  target  ${target.version} (game ${target.gamePatch})`)
  console.log(`  baseline ${baseline.version} (game ${baseline.gamePatch})`)

  const overridesDoc = fs.existsSync(OVERRIDES_FILE)
    ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'))
    : {}
  const overrides = overridesDoc.items ?? {}
  // stats that predate 3.30 but are missing from the app and needed (e.g. on Viscera)
  const extraStats = new Set(overridesDoc.extraStats ?? [])

  // ---- items
  const appItemsFile = path.join(DATA_DIR, 'items.ndjson')
  const appItems = readNdjson(appItemsFile)
  const appItemKeys = new Set(appItems.map(itemKey))

  const newItems = readNdjson(path.join(target.dir, 'en-items.ndjson'))
  const oldItemKeys = new Set(readNdjson(path.join(baseline.dir, 'en-items.ndjson')).map(itemKey))

  const itemsToAdd = []
  const skippedItems = []
  for (const src of newItems) {
    if (oldItemKeys.has(itemKey(src)) || appItemKeys.has(itemKey(src))) continue
    const converted = convertItem(src, overrides)
    if (converted) {
      itemsToAdd.push(converted)
      appItemKeys.add(itemKey(converted))
    } else {
      skippedItems.push(itemKey(src))
    }
  }

  // update icons/tradeTags of already imported items when overrides change
  let itemsUpdated = 0
  for (const item of appItems) {
    const over = overrides[item.refName]
    if (!over) continue
    if (over.icon && item.icon === '') { item.icon = over.icon; itemsUpdated++ }
    if (over.tradeTag && item.exchangeable && item.tradeTag !== over.tradeTag) { item.tradeTag = over.tradeTag; itemsUpdated++ }
  }

  // ---- stats
  const appStatsFile = path.join(DATA_DIR, 'stats.ndjson')
  const appStats = readNdjson(appStatsFile)
  const appByRef = flattenStats(appStats)
  /** @type {Map<string, any>} matcher string -> app stat */
  const appMatchers = new Map()
  for (const stat of appByRef.values()) {
    for (const m of stat.matchers) {
      if (!appMatchers.has(m.string)) appMatchers.set(m.string, stat)
      if (m.advanced && !appMatchers.has(m.advanced)) appMatchers.set(m.advanced, stat)
    }
  }

  const newStats = readNdjson(path.join(target.dir, 'en-stats.ndjson'))
  const oldByRef = flattenStats(readNdjson(path.join(baseline.dir, 'en-stats.ndjson')))

  const statsToAdd = []
  let idsMerged = 0
  let statsMerged = 0
  for (const src of newStats) {
    if (src.options || isPseudoOnly(src)) continue
    const old = oldByRef.get(src.ref)
    // the app and the source sometimes name the same stat differently
    // ("+# to Strength" vs "# to Strength"), so also match on wording
    const app = appByRef.get(src.ref) ??
      src.matchers.map(m => appMatchers.get(m.string)).find(Boolean)

    if (app) {
      // existing wording: add trade ids that appeared with 3.30 (e.g. Viscera implicits)
      const oldIds = old ? allIds(old) : new Set()
      const appIds = allIds(app)
      let changed = false
      for (const [type, ids] of Object.entries(src.trade.ids)) {
        for (const id of ids) {
          if (oldIds.has(id) || appIds.has(id)) continue
          app.trade.ids[type] = [...(app.trade.ids[type] ?? []), id]
          appIds.add(id)
          idsMerged++
          changed = true
        }
      }
      if (changed) statsMerged++
      continue
    }

    if (old) {
      // existed before 3.30 and the app chose not to have it,
      // unless 3.30 gave it new trade ids (e.g. it can now roll on Viscera)
      const oldIds = allIds(old)
      const gainedIds = [...allIds(src)].some(id => !oldIds.has(id))
      if (!gainedIds && !extraStats.has(src.ref)) continue
    }

    const matchers = src.matchers.filter(m => !appMatchers.has(m.string))
    if (!matchers.length) continue

    const stat = {
      ref: src.ref,
      better: src.better,
      ...(src.dp ? { dp: true } : {}),
      matchers: matchers.map(m => ({
        string: m.string,
        ...(m.negate ? { negate: true } : {}),
        ...(m.value != null ? { value: m.value } : {})
      })),
      trade: { ids: src.trade.ids }
    }
    statsToAdd.push(stat)
    appByRef.set(stat.ref, stat)
    for (const m of matchers) appMatchers.set(m.string, stat)
  }

  // ---- report
  const count = (pred) => itemsToAdd.filter(pred).length
  console.log('\nItems to add:', itemsToAdd.length)
  console.log('  Viscera  ', count(i => i.craftable?.category === 'Viscera'))
  console.log('  Threads  ', count(i => / Thread$|^Frayed Thread$/.test(i.name)))
  console.log('  Uniques  ', count(i => i.namespace === 'UNIQUE'))
  console.log('  Gems     ', count(i => i.namespace === 'GEM'))
  console.log('  Other    ', itemsToAdd.length - count(i =>
    i.craftable?.category === 'Viscera' || / Thread$|^Frayed Thread$/.test(i.name) ||
    i.namespace === 'UNIQUE' || i.namespace === 'GEM'))
  console.log('Items updated from overrides:', itemsUpdated)
  console.log('Items skipped (need manual support):', skippedItems.length, skippedItems.join(', '))
  console.log('Stats to add:', statsToAdd.length)
  console.log(`Trade ids merged into existing stats: ${idsMerged} (${statsMerged} stats)`)

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing written')
    return
  }

  if (itemsUpdated) {
    rewriteNdjson(appItemsFile, appItems)
  }
  appendNdjson(appItemsFile, itemsToAdd)
  if (statsMerged) {
    rewriteNdjson(appStatsFile, appStats)
  }
  appendNdjson(appStatsFile, statsToAdd)
  console.log('\nWrote', path.relative(RENDERER, appItemsFile), 'and', path.relative(RENDERER, appStatsFile))
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
