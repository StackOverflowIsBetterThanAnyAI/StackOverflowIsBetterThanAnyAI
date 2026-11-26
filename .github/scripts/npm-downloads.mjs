import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { THEMES, FONT, escapeXml, fmt, replaceReadmeBlock } from './shared.mjs'

const NPM_USER = process.env.NPM_USER || 'muenzi01'
const OUT_DIR = 'npm-downloads'
const DAY = 24 * 60 * 60 * 1000

// categorical slots in fixed order, validated for colour vision deficiencies on both GitHub surfaces
const SERIES = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'],
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`
const isoDay = (date) => date.toISOString().slice(0, 10)

const getJson = async (url) => {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, { headers: { 'User-Agent': 'readme-stats-workflow' } })
        if (res.ok) return res.json()
        // the downloads API rate limits bursts, so wait a bit and try again
        if (attempt >= 4 || (res.status !== 429 && res.status < 500)) {
            throw new Error(`${url} failed: ${res.status} ${await res.text()}`)
        }
        await new Promise((r) => setTimeout(r, attempt * 5000))
    }
}

const listPackages = async () => {
    const result = await getJson(
        `https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(NPM_USER)}&size=250`
    )
    return result.objects.map((o) => o.package.name).sort((a, b) => a.localeCompare(b))
}

// the downloads API returns at most 18 months per request, so the history is fetched year by year
const dailyDownloads = async (name, created, until) => {
    const days = {}
    for (let start = new Date(created.slice(0, 10)); start <= until; start = new Date(start.getTime() + 365 * DAY)) {
        const end = new Date(Math.min(start.getTime() + 364 * DAY, until.getTime()))
        const range = await getJson(`https://api.npmjs.org/downloads/range/${isoDay(start)}:${isoDay(end)}/${encodeURIComponent(name)}`)
        for (const { day, downloads } of range.downloads) days[day] = downloads
    }
    return days
}

const collectData = async () => {
    const yesterday = new Date(Date.now() - DAY)
    const packages = []
    for (const name of await listPackages()) {
        const meta = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
        const days = await dailyDownloads(name, meta.time.created, yesterday)
        const months = {}
        for (const [day, downloads] of Object.entries(days)) {
            months[day.slice(0, 7)] = (months[day.slice(0, 7)] || 0) + downloads
        }
        const last30 = Object.entries(days)
            .filter(([day]) => day > isoDay(new Date(yesterday.getTime() - 30 * DAY)))
            .reduce((s, [, v]) => s + v, 0)
        packages.push({ name, created: meta.time.created, last30Days: last30, months })
        console.log(`${name}: ${Object.values(days).reduce((a, b) => a + b, 0)} downloads`)
    }
    return { user: NPM_USER, generatedAt: new Date().toISOString(), packages }
}

const prepare = (data) => {
    // only complete months, the current one would always look like a drop
    const lastMonth = new Date(data.generatedAt.slice(0, 7) + '-01T00:00:00Z')
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1)
    const end = lastMonth.toISOString().slice(0, 7)
    const first = data.packages.map((p) => p.created.slice(0, 7)).sort()[0]
    const columns = []
    for (let [y, m] = first.split('-').map(Number); ; m++) {
        if (m > 12) [y, m] = [y + 1, 1]
        const key = `${y}-${String(m).padStart(2, '0')}`
        if (key > end) break
        columns.push(key)
    }
    const series = data.packages.map((p, i) => ({
        name: p.name,
        slot: i,
        values: columns.map((c) => p.months[c] || 0),
    }))
    for (const s of series) s.total = s.values.reduce((a, b) => a + b, 0)
    const monthTotals = columns.map((_, i) => series.reduce((s, x) => s + x.values[i], 0))
    return {
        columns,
        series,
        monthTotals,
        total: monthTotals.reduce((a, b) => a + b, 0),
        last30Days: data.packages.reduce((s, p) => s + p.last30Days, 0),
    }
}

const niceStep = (max, ticks) => {
    const raw = max / ticks
    const magnitude = 10 ** Math.floor(Math.log10(raw))
    return [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= raw)
}
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n))

const renderSvg = (p, theme, title, desc) => {
    const t = THEMES[theme]
    const colors = SERIES[theme]
    const width = 800
    const left = 24 + 44 // y axis labels
    const right = 24
    const legendTop = 44
    const legendRows = Math.ceil(p.series.length / 2)
    const plotTop = legendTop + legendRows * 22 + 16
    const plotHeight = 200
    const plotBottom = plotTop + plotHeight
    const height = plotBottom + 60

    const max = Math.max(1, ...p.monthTotals)
    const step = niceStep(max, 4)
    const yMax = Math.ceil(max / step) * step
    const y = (v) => plotBottom - (v / yMax) * plotHeight

    const plotWidth = width - left - right
    const pitch = plotWidth / p.columns.length
    const barWidth = Math.max(2, Math.min(28, pitch * 0.7))

    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
        `<title id="title">${escapeXml(title)}</title>`,
        `<desc id="desc">${escapeXml(desc)}</desc>`,
        `<rect width="${width}" height="${height}" rx="6" fill="${t.surface}"/>`,
        `<g font-family="${FONT}" font-size="12">`,
        `<text x="24" y="30" fill="${t.text}"><tspan font-weight="600">${fmt(p.last30Days)}</tspan> downloads in the last 30 days · <tspan font-weight="600">${fmt(p.total)}</tspan> since ${monthLabel(p.columns[0])}</text>`,
    ]

    // legend: two columns, name and total next to the swatch, so identity never depends on colour alone
    p.series.forEach((s, i) => {
        const lx = 24 + (i % 2) * 380
        const ly = legendTop + Math.floor(i / 2) * 22
        out.push(
            `<rect x="${lx}" y="${ly}" width="12" height="12" rx="2" fill="${colors[s.slot]}"/>`,
            `<text x="${lx + 18}" y="${ly + 10.5}" fill="${t.text}">${escapeXml(s.name)} <tspan fill="${t.muted}">${fmt(s.total)}</tspan></text>`
        )
    })

    // recessive grid
    for (let v = 0; v <= yMax; v += step) {
        out.push(
            `<line x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? t.muted : t.empty}" stroke-width="1"/>`,
            `<text x="${left - 8}" y="${y(v) + 4}" text-anchor="end" fill="${t.muted}">${compact(v)}</text>`
        )
    }

    // stacked bars, 2px surface gap between segments, only the top segment gets rounded corners
    p.columns.forEach((c, i) => {
        const x = left + i * pitch + (pitch - barWidth) / 2
        let base = 0
        const segments = p.series.filter((s) => s.values[i] > 0)
        segments.forEach((s, k) => {
            const v = s.values[i]
            const y0 = y(base)
            const y1 = y(base + v)
            base += v
            const h = Math.max(1, y0 - y1 - (k > 0 ? 2 : 0))
            const top = y0 - (k > 0 ? 2 : 0) - h
            const isTop = k === segments.length - 1
            if (isTop && h > 4) {
                const r = Math.min(4, barWidth / 2)
                out.push(
                    `<path d="M${x} ${top + h}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + barWidth - r}Q${x + barWidth} ${top} ${x + barWidth} ${top + r}V${top + h}Z" fill="${colors[s.slot]}"/>`
                )
            } else {
                out.push(`<rect x="${x}" y="${top}" width="${barWidth}" height="${h}" fill="${colors[s.slot]}"/>`)
            }
        })
        if (i === 0 || c.endsWith('-01')) {
            out.push(`<text x="${x}" y="${plotBottom + 18}" fill="${t.muted}">${i === 0 && !c.endsWith('-01') ? monthLabel(c) : c.slice(0, 4)}</text>`)
        }
    })

    out.push(
        `<text x="24" y="${height - 14}" fill="${t.muted}">Downloads per complete month, from the npm registry. They include automated installs such as CI runs and mirrors.</text>`,
        '</g>',
        '</svg>',
        ''
    )
    return out.join('\n')
}

const describe = (p) => {
    const best = p.monthTotals.indexOf(Math.max(...p.monthTotals))
    return `Stacked bar chart of the monthly npm downloads of my packages, ${monthLabel(p.columns[0])} to ${monthLabel(
        p.columns[p.columns.length - 1]
    )}. ${fmt(p.last30Days)} downloads in the last 30 days, ${fmt(p.total)} in total: ${[...p.series]
        .sort((a, b) => b.total - a.total)
        .map((s) => `${s.name} ${fmt(s.total)}`)
        .join(', ')}. Busiest month: ${monthLabel(p.columns[best])} with ${fmt(p.monthTotals[best])} downloads.`
}

const main = async () => {
    const fixture = process.env.NPM_DOWNLOADS_FIXTURE
    const data = fixture ? JSON.parse(readFileSync(fixture, 'utf8')) : await collectData()
    const prepared = prepare(data)
    if (!prepared.columns.length) {
        console.log('No complete month yet, nothing to render.')
        return
    }
    const desc = describe(prepared)
    const title = 'npm downloads per month'
    mkdirSync(OUT_DIR, { recursive: true })
    if (!fixture) writeFileSync(`${OUT_DIR}/data.json`, JSON.stringify(data, null, 4) + '\n')
    writeFileSync(`${OUT_DIR}/downloads-light.svg`, renderSvg(prepared, 'light', title, desc))
    writeFileSync(`${OUT_DIR}/downloads-dark.svg`, renderSvg(prepared, 'dark', title, desc))
    replaceReadmeBlock('NPM_DOWNLOADS', OUT_DIR, 'downloads', desc)
    console.log(desc)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
