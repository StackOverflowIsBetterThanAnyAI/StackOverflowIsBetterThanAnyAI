import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const LOGIN = process.env.GITHUB_LOGIN || 'StackOverflowIsBetterThanAnyAI'
const OUT_DIR = 'language-history'
const README = 'README.md'
const MAX_LANGUAGES = 10 // everything beyond this is folded into "Other"
const MAX_REPO_SIZE_KB = 1024 * 1024
const OTHER = 'Other'

const EXTENSIONS = {
    ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    py: 'Python', pyw: 'Python', ipynb: 'Jupyter Notebook',
    php: 'PHP', twig: 'Twig',
    java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy',
    c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', ino: 'C++',
    cs: 'C#', go: 'Go', rs: 'Rust', swift: 'Swift', dart: 'Dart', rb: 'Ruby',
    lua: 'Lua', r: 'R', jl: 'Julia', hs: 'Haskell', ex: 'Elixir', exs: 'Elixir',
    html: 'HTML', htm: 'HTML', vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
    css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
    sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', bat: 'Batchfile',
    sql: 'SQL', coffee: 'CoffeeScript', asm: 'Assembly', s: 'Assembly',
    vhd: 'VHDL', vhdl: 'VHDL', v: 'Verilog', sv: 'SystemVerilog', m: 'MATLAB',
}
const FILENAMES = { dockerfile: 'Dockerfile', makefile: 'Makefile' }

const IGNORED_PATH = new RegExp(
    [
        '(^|/)(node_modules|vendor|dist|build|out|coverage|\\.next|\\.nuxt|\\.svelte-kit|__pycache__|\\.venv|venv|site-packages|bower_components)/',
        '(^|/)migrations/',
        '(^|/)(var|public/bundles)/',
        '(^|/)config/reference\\.php$',
        '\\.min\\.(js|css)$',
        '\\.(bundle|chunk)\\.js$',
    ].join('|'),
    'i'
)

const languageOf = (path) => {
    if (IGNORED_PATH.test(path)) return null
    const name = basename(path).toLowerCase()
    if (FILENAMES[name]) return FILENAMES[name]
    const dot = name.lastIndexOf('.')
    return dot > 0 ? EXTENSIONS[name.slice(dot + 1)] || null : null
}

const newPath = (path) =>
    path.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/\//g, '/')

const graphql = async (query, variables = {}) => {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'language-history-workflow',
        },
        body: JSON.stringify({ query, variables }),
    })
    const json = await res.json()
    if (!res.ok || json.errors) {
        throw new Error(`GraphQL request failed: ${JSON.stringify(json.errors || json)}`)
    }
    return json.data
}

const REPO_FIELDS = 'nameWithOwner isPrivate isFork diskUsage defaultBranchRef { name }'

const listRepositories = async () => {
    const repos = new Map()
    for (const field of ['repositories', 'repositoriesContributedTo']) {
        const args =
            field === 'repositories'
                ? 'ownerAffiliations: [OWNER], isFork: false'
                : 'contributionTypes: [COMMIT], includeUserRepositories: false'
        let cursor = null
        do {
            const data = await graphql(
                `query($login: String!, $cursor: String) {
                    user(login: $login) {
                        ${field}(first: 100, after: $cursor, ${args}) {
                            pageInfo { hasNextPage endCursor }
                            nodes { ${REPO_FIELDS} }
                        }
                    }
                }`,
                { login: LOGIN, cursor }
            )
            const page = data.user[field]
            for (const repo of page.nodes) {
                if (repo.defaultBranchRef) repos.set(repo.nameWithOwner, repo)
            }
            cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
        } while (cursor)
    }
    return [...repos.values()]
}

const listOwnCommits = async (userId, nameWithOwner) => {
    const [owner, name] = nameWithOwner.split('/')
    const commits = new Map()
    let cursor = null
    do {
        const data = await graphql(
            `query($owner: String!, $name: String!, $author: ID!, $cursor: String) {
                repository(owner: $owner, name: $name) {
                    defaultBranchRef { target { ... on Commit {
                        history(first: 100, after: $cursor, author: { id: $author }) {
                            pageInfo { hasNextPage endCursor }
                            nodes { oid authoredDate }
                        }
                    } } }
                }
            }`,
            { owner, name, author: userId, cursor }
        )
        const history = data.repository?.defaultBranchRef?.target?.history
        if (!history) break
        for (const c of history.nodes) commits.set(c.oid, c.authoredDate.slice(0, 7))
        cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null
    } while (cursor)
    return commits
}

const git = (args, cwd) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 ** 3 })
    if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`)
    return res.stdout
}

const analyseRepository = (dir, commits, months) => {
    const log = git(
        ['log', '--no-merges', '-M', '--format=@@%H %aI', '--numstat', 'HEAD'],
        dir
    )
    let month = null
    for (const line of log.split('\n')) {
        if (line.startsWith('@@')) {
            const [sha, date] = line.slice(2).split(' ')
            month = commits ? commits.get(sha) || null : date.slice(0, 7)
            continue
        }
        if (!month || !line) continue
        const [added, deleted, ...rest] = line.split('\t')
        if (added === '-') continue // binary file
        const language = languageOf(newPath(rest.join('\t')))
        if (!language) continue
        const lines = Number(added) + Number(deleted)
        months[month] ??= {}
        months[month][language] = (months[month][language] || 0) + lines
    }
}

const collectData = async () => {
    const months = {}
    let repoCount = 0

    const local = process.env.LANGUAGE_HISTORY_REPOS
    if (local) {
        for (const dir of local.split(',')) {
            analyseRepository(dir.trim(), null, months)
            repoCount++
        }
    } else {
        const { user } = await graphql(`query($login: String!) { user(login: $login) { id } }`, {
            login: LOGIN,
        })
        const repos = await listRepositories()
        const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'language-history-'))
        try {
            for (const repo of repos) {
                if (repo.diskUsage > MAX_REPO_SIZE_KB) {
                    console.log(`skip ${repo.nameWithOwner}: larger than 1 GB`)
                    continue
                }
                const commits = await listOwnCommits(user.id, repo.nameWithOwner)
                if (!commits.size) continue

                const dir = join(workDir, repo.nameWithOwner.replace('/', '__'))
                const auth = repo.isPrivate ? `x-access-token:${process.env.GITHUB_TOKEN}@` : ''
                try {
                    git(['clone', '--bare', '--quiet', `https://${auth}github.com/${repo.nameWithOwner}.git`, dir])
                } catch {
                    console.log(`skip ${repo.isPrivate ? 'a private repository' : repo.nameWithOwner}: clone failed`)
                    continue
                }
                analyseRepository(dir, commits, months)
                rmSync(dir, { recursive: true, force: true })
                repoCount++
                // private repository names are not written to the public log
                console.log(`${repo.isPrivate ? 'private repository' : repo.nameWithOwner}: ${commits.size} commits`)
            }
        } finally {
            rmSync(workDir, { recursive: true, force: true })
        }
    }

    const sorted = Object.fromEntries(Object.entries(months).sort(([a], [b]) => a.localeCompare(b)))
    return {
        login: LOGIN,
        generatedAt: new Date().toISOString(),
        unit: 'lines changed (added + deleted)',
        repositories: repoCount,
        months: sorted,
    }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (key) => `${MONTH_NAMES[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`

const prepare = (data) => {
    const keys = Object.keys(data.months).filter((k) => Object.keys(data.months[k]).length)
    if (!keys.length) return null

    const end = data.generatedAt.slice(0, 7)
    const columns = []
    for (let [y, m] = keys[0].split('-').map(Number); ; m++) {
        if (m > 12) [y, m] = [y + 1, 1]
        const key = `${y}-${String(m).padStart(2, '0')}`
        columns.push(key)
        if (key >= end) break
    }

    const totals = {}
    for (const langs of Object.values(data.months)) {
        for (const [name, lines] of Object.entries(langs)) totals[name] = (totals[name] || 0) + lines
    }
    const ranked = Object.keys(totals).sort((a, b) => totals[b] - totals[a] || a.localeCompare(b))
    const named = ranked.length > MAX_LANGUAGES ? ranked.slice(0, MAX_LANGUAGES - 1) : ranked
    const languages = ranked.length > named.length ? [...named, OTHER] : named

    const value = {} // value[language][month]
    for (const lang of languages) value[lang] = {}
    for (const [month, langs] of Object.entries(data.months)) {
        for (const [name, lines] of Object.entries(langs)) {
            const lang = named.includes(name) ? name : OTHER
            value[lang][month] = (value[lang][month] || 0) + lines
        }
    }
    const languageTotals = Object.fromEntries(
        languages.map((l) => [l, Object.values(value[l]).reduce((a, b) => a + b, 0)])
    )

    const cells = languages
        .flatMap((l) => columns.map((c) => value[l][c] || 0))
        .filter((v) => v > 0)
        .sort((a, b) => a - b)
    const quantile = (q) => cells[Math.min(cells.length - 1, Math.floor(q * cells.length))]
    const thresholds = [...new Set([0.2, 0.4, 0.6, 0.8].map(quantile))]
    const bins = [] // [{ from, to }]
    let from = 1
    for (const t of thresholds) {
        if (t >= from) bins.push({ from, to: t })
        from = t + 1
    }
    bins.push({ from, to: cells[cells.length - 1] })
    const binOf = (v) => (v <= 0 ? -1 : bins.findIndex((b) => v <= b.to))

    return { columns, languages, value, languageTotals, bins, binOf, end, generatedAt: data.generatedAt }
}

const THEMES = {
    light: {
        surface: '#ffffff',
        text: '#1f2328',
        muted: '#59636e',
        empty: '#eff2f5',
        steps: ['#b7d3f6', '#6da7ec', '#2a78d6', '#1c5cab', '#0d366b'],
    },
    dark: {
        surface: '#0d1117',
        text: '#f0f6fc',
        muted: '#9198a1',
        empty: '#161b22',
        steps: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#b7d3f6'],
    },
}

const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const fmt = (n) => n.toLocaleString('en-US')
const compact = (n) =>
    n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n)

const renderSvg = (p, theme, title, desc) => {
    const t = THEMES[theme]
    const font =
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"

    const width = 800
    const left = 112 // language names
    const right = 64 // row totals
    const yearGap = 4
    const yearBreaks = p.columns.filter((c, i) => i > 0 && c.endsWith('-01')).length
    const pitch = Math.min(18, (width - 24 - left - right - yearBreaks * yearGap) / p.columns.length)
    const cellWidth = Math.max(2, pitch - 2)
    const rowPitch = 20
    const cellHeight = 16

    const top = 72
    const gridHeight = p.languages.length * rowPitch
    const height = top + gridHeight + 64

    const xs = []
    let x = 24 + left
    p.columns.forEach((c, i) => {
        if (i > 0 && c.endsWith('-01')) x += yearGap
        xs.push(x)
        x += pitch
    })
    const gridRight = x

    const out = []
    out.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
        `<title id="title">${escapeXml(title)}</title>`,
        `<desc id="desc">${escapeXml(desc)}</desc>`,
        `<rect width="${width}" height="${height}" rx="6" fill="${t.surface}"/>`,
        `<g font-family="${font}" font-size="12">`
    )

    let lx = 24
    out.push(`<text x="${lx}" y="${34.5}" fill="${t.muted}">Lines changed per month:</text>`)
    lx += 152
    const legendItems = [{ label: 'none', fill: t.empty }].concat(
        p.bins.map((b, i) => ({
            label: b.from === b.to ? compact(b.from) : `${compact(b.from)}–${compact(b.to)}`,
            fill: t.steps[i + (t.steps.length - p.bins.length)],
        }))
    )
    for (const item of legendItems) {
        out.push(
            `<rect x="${lx}" y="24" width="14" height="14" rx="2" fill="${item.fill}"/>`,
            `<text x="${lx + 19}" y="34.5" fill="${t.text}">${escapeXml(item.label)}</text>`
        )
        lx += 19 + item.label.length * 7 + 18
    }

    // rows
    p.languages.forEach((lang, r) => {
        const y = top + r * rowPitch
        out.push(
            `<text x="${24 + left - 10}" y="${y + 12.5}" text-anchor="end" fill="${t.text}">${escapeXml(lang)}</text>`
        )
        p.columns.forEach((c, i) => {
            const v = p.value[lang][c] || 0
            const bin = p.binOf(v)
            const fill = bin < 0 ? t.empty : t.steps[bin + (t.steps.length - p.bins.length)]
            out.push(
                `<rect x="${xs[i]}" y="${y}" width="${cellWidth}" height="${cellHeight}" rx="2" fill="${fill}"/>`
            )
        })
        out.push(
            `<text x="${gridRight + 8}" y="${y + 12.5}" fill="${t.muted}">${compact(p.languageTotals[lang])}</text>`
        )
    })

    const labelY = top + gridHeight + 14
    let lastLabelX = -Infinity
    p.columns.forEach((c, i) => {
        if (i === 0 || c.endsWith('-01')) {
            if (xs[i] - lastLabelX < 36) return
            out.push(`<text x="${xs[i]}" y="${labelY}" fill="${t.muted}">${c.slice(0, 4)}</text>`)
            lastLabelX = xs[i]
        }
    })
    out.push(
        `<text x="${gridRight + 8}" y="${labelY}" fill="${t.muted}">total</text>`,
        `<text x="24" y="${height - 14}" fill="${t.muted}">Lines added + deleted in my commits, by file type. Dependencies, build output and generated files are excluded.</text>`,
        '</g>',
        '</svg>',
        ''
    )
    return out.join('\n')
}

const describe = (p) => {
    const named = p.languages.filter((l) => l !== OTHER)
    const top3 = named
        .slice(0, 3)
        .map((l) => `${l} (${fmt(p.languageTotals[l])} lines)`)
        .join(', ')
    const years = [...new Set(p.columns.map((c) => c.slice(0, 4)))]
    const perYear = years
        .map((y) => {
            const best = named
                .map((l) => [l, p.columns.filter((c) => c.startsWith(y)).reduce((s, c) => s + (p.value[l][c] || 0), 0)])
                .sort((a, b) => b[1] - a[1])[0]
            return best && best[1] > 0 ? `${y}: mostly ${best[0]}` : null
        })
        .filter(Boolean)
        .join('; ')
    return `Heatmap of the lines of code I changed per month and language, ${monthLabel(p.columns[0])} to ${monthLabel(p.end)}. Most changed overall: ${top3}. ${perYear}.`
}

const MAX_RANKED = 8 // bars in the ranking, the rest is folded into "Other"

const rankLanguages = (data) => {
    const totals = {}
    for (const langs of Object.values(data.months)) {
        for (const [name, lines] of Object.entries(langs)) totals[name] = (totals[name] || 0) + lines
    }
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const sum = ranked.reduce((s, [, v]) => s + v, 0)
    const rows = ranked.length > MAX_RANKED ? ranked.slice(0, MAX_RANKED - 1) : ranked
    if (ranked.length > rows.length) {
        rows.push([OTHER, ranked.slice(rows.length).reduce((s, [, v]) => s + v, 0)])
    }
    return rows.map(([language, lines]) => ({ language, lines, share: (lines / sum) * 100 }))
}

const percent = (share) => `${share < 0.1 ? '<0.1' : share.toFixed(1)} %`

const renderRankingSvg = (rows, theme, title, desc) => {
    const t = THEMES[theme]
    const font =
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"

    const width = 800
    const left = 112 // language names
    const right = 136 // percentage and lines
    const top = 24
    const rowPitch = 24
    const barHeight = 14
    const height = top + rows.length * rowPitch + 36
    const barMax = width - 24 - left - right
    const maxShare = rows[0].share

    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
        `<title id="title">${escapeXml(title)}</title>`,
        `<desc id="desc">${escapeXml(desc)}</desc>`,
        `<rect width="${width}" height="${height}" rx="6" fill="${t.surface}"/>`,
        `<g font-family="${font}" font-size="12">`,
    ]
    rows.forEach((row, i) => {
        const y = top + i * rowPitch
        const barWidth = Math.max(2, (row.share / maxShare) * barMax)
        const fill = row.language === OTHER ? t.muted : t.steps[3]
        out.push(
            `<text x="${24 + left - 10}" y="${y + 11.5}" text-anchor="end" fill="${t.text}">${escapeXml(row.language)}</text>`,
            `<rect x="${24 + left}" y="${y}" width="${barMax}" height="${barHeight}" rx="2" fill="${t.empty}"/>`,
            `<rect x="${24 + left}" y="${y}" width="${barWidth.toFixed(1)}" height="${barHeight}" rx="2" fill="${fill}"/>`,
            `<text x="${24 + left + barMax + 10}" y="${y + 11.5}" fill="${t.text}">${percent(row.share)}</text>`,
            `<text x="${width - 24}" y="${y + 11.5}" text-anchor="end" fill="${t.muted}">${compact(row.lines)} lines</text>`
        )
    })
    out.push(
        `<text x="24" y="${height - 14}" fill="${t.muted}">Share of all lines added + deleted in my commits, by file type. Dependencies, build output and generated files are excluded.</text>`,
        '</g>',
        '</svg>',
        ''
    )
    return out.join('\n')
}

const describeRanking = (rows) =>
    `Bar chart of the languages I write the most, measured by the lines of code I changed: ${rows
        .map((r) => `${r.language} ${percent(r.share)} (${fmt(r.lines)} lines)`)
        .join(', ')}.`

const renderTable = (p) => {
    const years = [...new Set(p.columns.map((c) => c.slice(0, 4)))]
    const current = p.end.slice(0, 4)
    const header = `| Language | ${years.map((y) => (y === current ? `${y} (year to date)` : y)).join(' | ')} | Total |`
    const align = `| --- | ${years.map(() => '---:').join(' | ')} | ---: |`
    const body = p.languages.map((lang) => {
        const cells = years.map((y) => {
            const sum = Object.entries(p.value[lang])
                .filter(([c]) => c.startsWith(y))
                .reduce((s, [, v]) => s + v, 0)
            return sum ? fmt(sum) : '–'
        })
        return `| ${lang} | ${cells.join(' | ')} | **${fmt(p.languageTotals[lang])}** |`
    })
    return [header, align, ...body].join('\n')
}

// only the part between the markers is replaced, the rest of the README stays untouched
const replaceBlock = (readme, marker, image, desc) => {
    const block = `<!-- ${marker}:start -->

<picture>
    <source media="(prefers-color-scheme: dark)" srcset="${OUT_DIR}/${image}-dark.svg" />
    <img src="${OUT_DIR}/${image}-light.svg" alt="${escapeXml(desc)}" width="100%" />
</picture>

<!-- ${marker}:end -->`
    const pattern = new RegExp(`<!-- ${marker}:start -->[\\s\\S]*?<!-- ${marker}:end -->`)
    if (!pattern.test(readme)) throw new Error(`${marker} markers not found in README.md`)
    return readme.replace(pattern, () => block)
}

const updateReadme = (heatmapDesc, rankingDesc) => {
    let readme = readFileSync(README, 'utf8')
    readme = replaceBlock(readme, 'LANGUAGE_RANKING', 'ranking', rankingDesc)
    readme = replaceBlock(readme, 'LANGUAGE_HISTORY', 'heatmap', heatmapDesc)
    writeFileSync(README, readme)
}

const main = async () => {
    const fixture = process.env.LANGUAGE_HISTORY_FIXTURE
    if (!fixture && !process.env.LANGUAGE_HISTORY_REPOS && !process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN is missing')
    }
    const data = fixture ? JSON.parse(readFileSync(fixture, 'utf8')) : await collectData()
    const prepared = prepare(data)
    if (!prepared) {
        console.log('No activity found, nothing to render.')
        return
    }

    const desc = describe(prepared)
    const title = 'Coding activity per language over time'
    mkdirSync(OUT_DIR, { recursive: true })
    if (!fixture) writeFileSync(`${OUT_DIR}/data.json`, JSON.stringify(data, null, 4) + '\n')
    writeFileSync(`${OUT_DIR}/heatmap-light.svg`, renderSvg(prepared, 'light', title, desc))
    writeFileSync(`${OUT_DIR}/heatmap-dark.svg`, renderSvg(prepared, 'dark', title, desc))

    const ranking = rankLanguages(data)
    const rankingDesc = describeRanking(ranking)
    const rankingTitle = 'Most used languages'
    writeFileSync(`${OUT_DIR}/ranking-light.svg`, renderRankingSvg(ranking, 'light', rankingTitle, rankingDesc))
    writeFileSync(`${OUT_DIR}/ranking-dark.svg`, renderRankingSvg(ranking, 'dark', rankingTitle, rankingDesc))

    updateReadme(desc, rankingDesc)

    console.log(rankingDesc)
    console.log(desc)
    console.log(renderTable(prepared))
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
