import { readFileSync, writeFileSync } from 'node:fs'

export const README = 'README.md'

export const THEMES = {
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

export const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"

export const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
export const fmt = (n) => n.toLocaleString('en-US')

export const graphql = async (query, variables = {}) => {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'readme-stats-workflow',
        },
        body: JSON.stringify({ query, variables }),
    })
    const json = await res.json()
    if (!res.ok || json.errors) {
        throw new Error(`GraphQL request failed: ${JSON.stringify(json.errors || json)}`)
    }
    return json.data
}

// <picture> with a light and a dark SVG between two markers,
// only the part between the markers is replaced, the rest of the README stays untouched
export const replaceReadmeBlock = (marker, dir, image, alt) => {
    const block = `<!-- ${marker}:start -->

<picture>
    <source media="(prefers-color-scheme: dark)" srcset="${dir}/${image}-dark.svg" />
    <img src="${dir}/${image}-light.svg" alt="${escapeXml(alt)}" width="100%" />
</picture>

<!-- ${marker}:end -->`
    const readme = readFileSync(README, 'utf8')
    const pattern = new RegExp(`<!-- ${marker}:start -->[\\s\\S]*?<!-- ${marker}:end -->`)
    if (!pattern.test(readme)) throw new Error(`${marker} markers not found in README.md`)
    writeFileSync(README, readme.replace(pattern, () => block))
}
