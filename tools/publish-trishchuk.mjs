#!/usr/bin/env node
// Publishes this fork's packages to npm under the @trishchuk scope without renaming anything in the source tree.
//
// The source keeps the upstream @ptc-org names (and upstream's version) so the branch stays mergeable upstream.
// Only the built dist/packages/<pkg>/package.json is rewritten:
//   - name                          @ptc-org/nestjs-query-x  ->  @trishchuk/nestjs-query-x
//   - version                       --version=<v> when given (the fork's release line), else the source version
//   - deps on sibling packages      "@ptc-org/nestjs-query-core": "npm:@trishchuk/nestjs-query-core@<version>"
// Sibling dependencies are derived from what the compiled code actually requires, because upstream no longer writes
// them into the built manifests. The dependency KEY stays @ptc-org, so the compiled require('@ptc-org/...') resolves
// to the fork's package, and a consumer that aliases @ptc-org/* -> npm:@trishchuk/* ends up with exactly one copy of
// core (two copies silently break nestjs-query's shared metadata and instanceof checks).
//
// Usage: node tools/publish-trishchuk.mjs [--dry-run] [--skip-build] [--version=<v>] [--tag=<dist-tag>]
//          [--otp=<2fa code>] [core query-graphql query-typeorm query-drizzle ...]
// A prerelease version is published under the `next` dist-tag unless --tag says otherwise, so `latest` keeps
// pointing at the last stable release.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FORK_REPO = 'https://github.com/x51xxx/nestjs-query'
const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const dryRun = args.includes('--dry-run')
const skipBuild = args.includes('--skip-build')
const otp = flag('otp')
const versionOverride = flag('version')
const requested = args.filter((a) => !a.startsWith('--'))
const projects = requested.length ? requested : ['core', 'query-graphql', 'query-typeorm', 'query-drizzle']
// core goes first: every other package depends on it.
projects.sort((a, b) => (a === 'core' ? -1 : b === 'core' ? 1 : 0))

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: 'inherit' })
const forkName = (name) => name.replace(/^@ptc-org\//, '@trishchuk/')
const published = (name, version) => {
  try {
    return (
      execFileSync('npm', ['view', `${name}@${version}`, 'version', '--registry=https://registry.npmjs.org'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() === version
    )
  } catch {
    return false
  }
}
const jsFiles = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : jsFiles(path)
    return path.endsWith('.js') ? [path] : []
  })
const requiredSiblings = (dir) => {
  const found = new Set()
  for (const file of jsFiles(dir)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/require\(["'](@ptc-org\/nestjs-query-[a-z-]+)["']\)/g)) {
      found.add(match[1])
    }
  }
  return found
}

if (!skipBuild) run('yarn', ['nx', 'run-many', '-t', 'build', '-p', projects.join(','), '--skip-nx-cache'])

const manifests = projects.map((project) => {
  const dir = join('dist', 'packages', project)
  const file = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (!pkg.name.startsWith('@ptc-org/') && !pkg.name.startsWith('@trishchuk/')) throw new Error(`${file}: unexpected name ${pkg.name}`)
  pkg.name = forkName(pkg.name)
  if (versionOverride) pkg.version = versionOverride
  return { project, dir, file, pkg }
})
const batch = new Map(manifests.map(({ pkg }) => [pkg.name, pkg.version]))
const releaseVersion = manifests[0].pkg.version
const tag = flag('tag') ?? (releaseVersion.includes('-') ? 'next' : 'latest')

for (const { dir, file, pkg } of manifests) {
  const ownName = pkg.name.replace(/^@trishchuk\//, '@ptc-org/')
  const declared = new Set(
    ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) => Object.keys(pkg[field] ?? {}))
  )
  for (const sibling of requiredSiblings(dir)) {
    if (sibling !== ownName && !declared.has(sibling)) {
      pkg.dependencies = { ...pkg.dependencies, [sibling]: releaseVersion }
    }
  }

  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (!dep.startsWith('@ptc-org/nestjs-query-')) continue
      const target = forkName(dep)
      // A sibling built in this batch is pinned to the batch's version; otherwise keep the version that was written.
      const version = batch.get(target) ?? String(range).replace(/^npm:@trishchuk\/[^@]+@/, '').replace(/^[\^~]/, '')
      if (batch.get(target) !== version && !published(target, version)) {
        throw new Error(`${pkg.name} depends on ${dep}@${version}, but ${target}@${version} is neither in this batch nor on npm`)
      }
      pkg[field][dep] = `npm:${target}@${version}`
    }
  }
  pkg.homepage = `${FORK_REPO}#readme`
  pkg.bugs = { url: `${FORK_REPO}/issues` }
  pkg.repository = { ...pkg.repository, url: `git+${FORK_REPO}.git` }
  pkg.publishConfig = { access: 'public' }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  const siblings = Object.entries(pkg.dependencies ?? {}).filter(([dep]) => dep.startsWith('@ptc-org/'))
  console.log(`${pkg.name}@${pkg.version} [${tag}]`, JSON.stringify(Object.fromEntries(siblings)))
}

for (const { dir, pkg } of manifests) {
  if (!dryRun && published(pkg.name, pkg.version)) {
    console.log(`skip ${pkg.name}@${pkg.version}: already on npm`)
    continue
  }
  run('npm', [
    'publish',
    dir,
    '--access',
    'public',
    '--tag',
    tag,
    '--registry=https://registry.npmjs.org',
    ...(dryRun ? ['--dry-run'] : []),
    ...(otp ? [`--otp=${otp}`] : [])
  ])
}
