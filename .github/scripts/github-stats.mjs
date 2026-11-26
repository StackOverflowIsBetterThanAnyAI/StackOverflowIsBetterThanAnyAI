import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { THEMES, FONT, escapeXml, fmt, graphql, replaceReadmeBlock } from './shared.mjs'

const LOGIN = process.env.GITHUB_LOGIN || 'StackOverflowIsBetterThanAnyAI'
const OUT_DIR = 'github-stats'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthLabel = (iso) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

const BY_REPOSITORY = ['commit', 'issue', 'pullRequest', 'pullRequestReview']
    .map((type) => `${type}ContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner owner { login } } }`)
    .join('\n')

// contributionsCollection covers at most one year, so the whole time since sign-up is fetched year by year
const collectContributions = async (createdAt, now) => {
    let commits = 0
    let reviews = 0
    const contributedTo = new Set()
    for (let year = Number(createdAt.slice(0, 4)); year <= now.getUTCFullYear(); year++) {
        const from = year === Number(createdAt.slice(0, 4)) ? createdAt : `${year}-01-01T00:00:00Z`
        const to = year === now.getUTCFullYear() ? now.toISOString() : `${year}-12-31T23:59:59Z`
        const { user } = await graphql(
            `query($login: String!, $from: DateTime!, $to: DateTime!) {
                user(login: $login) {
                    contributionsCollection(from: $from, to: $to) {
                        totalCommitContributions
                        totalPullRequestReviewContributions
                        ${BY_REPOSITORY}
                    }
                }
            }`,
            { login: LOGIN, from, to }
        )
        const c = user.contributionsCollection
        commits += c.totalCommitContributions
        reviews += c.totalPullRequestReviewContributions
        for (const type of BY_REPOSITORY.match(/\w+ContributionsByRepository/g)) {
            for (const { repository } of c[type]) {
                // like "contributed to" on github-readme-stats: only repositories of other people
                if (repository.owner.login.toLowerCase() !== LOGIN.toLowerCase()) {
                    contributedTo.add(repository.nameWithOwner)
                }
            }
        }
    }
    return { commits, reviews, contributedTo: contributedTo.size }
}

const countStars = async () => {
    let stars = 0
    let cursor = null
    do {
        const { user } = await graphql(
            `query($login: String!, $cursor: String) {
                user(login: $login) {
                    repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER]) {
                        pageInfo { hasNextPage endCursor }
                        nodes { stargazerCount }
                    }
                }
            }`,
            { login: LOGIN, cursor }
        )
        for (const repo of user.repositories.nodes) stars += repo.stargazerCount
        cursor = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null
    } while (cursor)
    return stars
}

// the same number github-readme-stats uses with include_all_commits=true
const searchCommits = async () => {
    const res = await fetch(`https://api.github.com/search/commits?q=author:${encodeURIComponent(LOGIN)}&per_page=1`, {
        headers: {
            Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'readme-stats-workflow',
        },
    })
    if (!res.ok) throw new Error(`Commit search failed: ${res.status} ${await res.text()}`)
    return (await res.json()).total_count
}

const collectData = async () => {
    const now = new Date()
    const { user } = await graphql(
        `query($login: String!) {
            user(login: $login) {
                createdAt
                followers { totalCount }
                pullRequests { totalCount }
                openIssues: issues(states: OPEN) { totalCount }
                closedIssues: issues(states: CLOSED) { totalCount }
                lastYear: contributionsCollection { totalPullRequestReviewContributions }
            }
        }`,
        { login: LOGIN }
    )
    const contributions = await collectContributions(user.createdAt, now)
    const stars = await countStars()
    const pullRequests = user.pullRequests.totalCount
    const issues = user.openIssues.totalCount + user.closedIssues.totalCount

    return {
        login: LOGIN,
        generatedAt: now.toISOString(),
        since: user.createdAt,
        allTime: {
            stars,
            commits: contributions.commits,
            pullRequests,
            issues,
            reviews: contributions.reviews,
            contributedTo: contributions.contributedTo,
        },
        // exactly the inputs github-readme-stats feeds into its rank, so the letter stays comparable
        rankInputs: {
            commits: await searchCommits(),
            pullRequests,
            issues,
            reviewsLastYear: user.lastYear.totalPullRequestReviewContributions,
            stars,
            followers: user.followers.totalCount,
        },
    }
}

// Rank formula of github-readme-stats (MIT License, https://github.com/anuraghazra/github-readme-stats,
// src/calculateRank.js), with the medians for include_all_commits=true
const calculateRank = ({ commits, pullRequests, issues, reviewsLastYear, stars, followers }) => {
    const exponentialCdf = (x) => 1 - 2 ** -x
    const logNormalCdf = (x) => x / (1 + x)
    const parts = [
        [2, exponentialCdf(commits / 1000)],
        [3, exponentialCdf(pullRequests / 50)],
        [1, exponentialCdf(issues / 25)],
        [1, exponentialCdf(reviewsLastYear / 2)],
        [4, logNormalCdf(stars / 50)],
        [1, logNormalCdf(followers / 10)],
    ]
    const totalWeight = parts.reduce((s, [w]) => s + w, 0)
    const percentile = (1 - parts.reduce((s, [w, v]) => s + w * v, 0) / totalWeight) * 100
    const thresholds = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100]
    const levels = ['S', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C']
    return { level: levels[thresholds.findIndex((t) => percentile <= t)], percentile }
}

const topPercent = (percentile) => `Top ${percentile < 10 ? percentile.toFixed(1) : Math.round(percentile)} %`

const rowsOf = (data) => [
    ['Stars earned', data.allTime.stars],
    ['Commits', data.allTime.commits],
    ['Pull requests', data.allTime.pullRequests],
    ['Issues', data.allTime.issues],
    ['Pull request reviews', data.allTime.reviews],
    ['Contributed to (repositories)', data.allTime.contributedTo],
]

const renderSvg = (data, rank, theme, title, desc) => {
    const t = THEMES[theme]
    const width = 800
    const top = 48
    const rowPitch = 28
    const rows = rowsOf(data)
    const height = top + rows.length * rowPitch + 40
    const cx = width - 24 - 90
    const cy = top + (rows.length * rowPitch) / 2 - 6
    const r = 52
    const circumference = 2 * Math.PI * r
    const filled = circumference * (1 - rank.percentile / 100)

    const out = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
        `<title id="title">${escapeXml(title)}</title>`,
        `<desc id="desc">${escapeXml(desc)}</desc>`,
        `<rect width="${width}" height="${height}" rx="6" fill="${t.surface}"/>`,
        `<g font-family="${FONT}" font-size="14">`,
        `<text x="24" y="30" font-size="12" fill="${t.muted}">All time, since ${monthLabel(data.since)}</text>`,
    ]
    rows.forEach(([label, value], i) => {
        const y = top + i * rowPitch + 16
        out.push(
            `<text x="24" y="${y}" fill="${t.text}">${escapeXml(label)}</text>`,
            `<text x="400" y="${y}" text-anchor="end" font-weight="600" fill="${t.text}">${fmt(value)}</text>`
        )
    })
    out.push(
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.empty}" stroke-width="8"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.steps[3]}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`,
        `<text x="${cx}" y="${cy + 11}" text-anchor="middle" font-size="32" font-weight="700" fill="${t.text}">${escapeXml(rank.level)}</text>`,
        `<text x="${cx}" y="${cy + r + 28}" text-anchor="middle" font-size="12" fill="${t.muted}">${escapeXml(topPercent(rank.percentile))}</text>`,
        `<text x="24" y="${height - 14}" font-size="12" fill="${t.muted}">Rank calculated with the formula and inputs of github-readme-stats, so it stays comparable.</text>`,
        '</g>',
        '</svg>',
        ''
    )
    return out.join('\n')
}

const describe = (data, rank) =>
    `My GitHub statistics, all time since ${monthLabel(data.since)}: ${rowsOf(data)
        .map(([label, value]) => `${label}: ${fmt(value)}`)
        .join(', ')}. Rank ${rank.level} (${topPercent(rank.percentile)}), calculated like on github-readme-stats.`

const main = async () => {
    const fixture = process.env.GITHUB_STATS_FIXTURE
    if (!fixture && !process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is missing')
    const data = fixture ? JSON.parse(readFileSync(fixture, 'utf8')) : await collectData()
    const rank = calculateRank(data.rankInputs)
    const desc = describe(data, rank)
    const title = 'GitHub statistics'

    mkdirSync(OUT_DIR, { recursive: true })
    if (!fixture) writeFileSync(`${OUT_DIR}/data.json`, JSON.stringify(data, null, 4) + '\n')
    writeFileSync(`${OUT_DIR}/stats-light.svg`, renderSvg(data, rank, 'light', title, desc))
    writeFileSync(`${OUT_DIR}/stats-dark.svg`, renderSvg(data, rank, 'dark', title, desc))
    replaceReadmeBlock('GITHUB_STATS', OUT_DIR, 'stats', desc)
    console.log(desc)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
