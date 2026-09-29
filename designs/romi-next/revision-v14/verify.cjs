// Syntax check for every v14 JSX file. Behaviour and layout are measured live
// by exercise-v14.cjs rather than asserted from a stored record.
const fs = require('node:fs')
const path = require('node:path')
const babel = require('../vendor/babel.js')

const files = fs.readdirSync(__dirname).filter((name) => name.endsWith('.jsx'))
for (const name of files) babel.transform(fs.readFileSync(path.join(__dirname, name), 'utf8'), { presets: ['react'] })
console.log(`JSX syntax passed: ${files.join(', ')}.`)
