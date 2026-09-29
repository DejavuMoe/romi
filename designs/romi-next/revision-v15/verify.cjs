// Syntax check for every v15 JSX and script file, and a check that every
// Chinese interface string can be shown in English: text in JSX goes through
// T(), and each string has an entry in locale-en.js. Behaviour and layout are
// measured live by exercise.cjs rather than asserted from a stored record.
//
//   node designs/romi-next/revision-v15/verify.cjs [--keys]
//
// --keys prints the strings that still lack an English entry.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const babel = require('../vendor/babel.js')

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8')
const jsx = fs.readdirSync(__dirname).filter((name) => name.endsWith('.jsx'))
const scripts = ['i18n.js', 'locale-en.js', 'icons.js', 'land.js', 'geo.js', 'fixtures.js', 'format.js', 'sim.js']
for (const name of jsx) babel.transform(read(name), { presets: ['react'] })
for (const name of scripts) new vm.Script(read(name), { filename: name })

// The English catalog, loaded the way the page loads it.
const sandbox = { window: {}, location: { search: '' }, localStorage: { getItem: () => null }, navigator: { language: 'zh-CN' }, document: { documentElement: {} }, Intl, URL, URLSearchParams, history: {} }
vm.createContext(sandbox)
vm.runInContext(read('i18n.js'), sandbox)
vm.runInContext(read('locale-en.js'), sandbox)
const en = sandbox.window.romiI18n.catalog('en')

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/
const walk = (node, parents, visit) => {
  if (!node || typeof node.type !== 'string') return
  visit(node, parents)
  for (const key of Object.keys(node)) {
    if (['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue
    const v = node[key]
    if (Array.isArray(v)) v.forEach((c) => walk(c, [...parents, node], visit))
    else if (v && typeof v.type === 'string') walk(v, [...parents, node], visit)
  }
}
const isT = (n) => n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'T'

const loose = []
const keys = new Map()
// Sample values on the design-system page and the sample-name table are data.
const DATA_FILES = new Set(['fixtures.js'])
for (const name of [...jsx, 'format.js']) {
  if (DATA_FILES.has(name)) continue
  const { ast } = babel.transform(read(name), { ast: true, code: false, babelrc: false, configFile: false, parserOpts: { plugins: ['jsx'] } })
  walk(ast.program, [], (node, parents) => {
    const parent = parents[parents.length - 1]
    const where = `${name}:${node.loc.start.line}`
    if (node.type === 'JSXText' && CJK.test(node.value)) loose.push(`${where} text outside T(): ${node.value.trim()}`)
    if (node.type === 'TemplateLiteral' && node.quasis.some((q) => CJK.test(q.value.cooked))) loose.push(`${where} template outside T(): ${node.quasis.map((q) => q.value.cooked).join('…')}`)
    if (node.type === 'StringLiteral' && CJK.test(node.value) && !(parent.type === 'ObjectProperty' && parent.key === node)) {
      if (!keys.has(node.value)) keys.set(node.value, where)
      if (parent.type === 'JSXAttribute') loose.push(`${where} attribute outside T(): ${node.value}`)
    }
  })
}
const missing = [...keys].filter(([k]) => !Object.prototype.hasOwnProperty.call(en, k))
const unused = Object.keys(en).filter((k) => !keys.has(k))

if (process.argv.includes('--keys')) {
  for (const [k, where] of missing) console.log(`${JSON.stringify(k)}: "",  // ${where}`)
  process.exit(0)
}
const problems = [...loose, ...missing.map(([k, where]) => `${where} no English for ${JSON.stringify(k)}`), ...unused.map((k) => `locale-en.js: unused entry ${JSON.stringify(k)}`)]
if (problems.length) {
  console.log(problems.join('\n'))
  console.log(`\n${problems.length} i18n problems.`)
  process.exit(1)
}
console.log(`syntax passed: ${[...scripts, ...jsx].join(', ')}.`)
console.log(`i18n passed: ${keys.size} strings, each with an English entry.`)
