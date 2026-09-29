// Static preview server for the prototypes in this directory.
//
// Review entry point only: it serves `designs/` read-only over loopback so a
// revision can be operated before it is approved. It is not part of the product
// and nothing here reaches a hub.
//
//   node designs/preview.mjs [port]
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname)
const PORT = Number(process.argv[2] || 4311)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  // The prototypes compile their JSX in the browser, so Babel has to recognise
  // these as sources rather than as scripts to execute directly.
  '.jsx': 'text/babel; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const server = createServer((request, response) => {
  const path = decodeURIComponent(request.url.split('?')[0])
  const file = join(ROOT, normalize(path))
  // Serving the design directory must not become a way to read the rest of the
  // checkout: `..` is normalised above and the result has to stay inside ROOT.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    response.writeHead(403).end('outside the design directory')
    return
  }
  let stat
  try {
    stat = statSync(file)
  } catch {
    response.writeHead(404).end('not found')
    return
  }
  if (stat.isDirectory()) {
    response.writeHead(404).end('directory listing is not served')
    return
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  })
  createReadStream(file).pipe(response)
})

server.listen(PORT, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${PORT}`
  console.log(`design preview on ${base}`)
  console.log(`  admin  ${base}/romi-next/revision-v12/index.html`)
  console.log(`  public ${base}/romi-next/revision-v12/public.html`)
})
