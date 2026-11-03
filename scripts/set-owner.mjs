import { readFileSync, writeFileSync } from 'node:fs'

const owner = process.argv[2]
if (!owner || owner === 'OWNER') {
  console.error('用法: node scripts/set-owner.mjs <github-username>')
  process.exit(1)
}

for (const file of ['package.json', 'README.md', 'docs/PUBLISH.md', 'docs/market-entry.json']) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('OWNER')) {
    console.log(`skip ${file}（没有占位符）`)
    continue
  }
  writeFileSync(file, text.split('OWNER').join(owner), 'utf8')
  console.log(`updated ${file}`)
}
