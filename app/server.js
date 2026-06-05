const fs = require("fs")
const http = require("http")
const path = require("path")
const { spawn } = require("child_process")
const { once } = require("events")
const { randomUUID } = require("crypto")

const ROOT = __dirname
const PUBLIC_DIR = path.join(ROOT, "public")
const DATA_DIR = path.join(ROOT, "data")
const BOOKMARKS_FILE = path.join(DATA_DIR, "bookmarks.json")
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 42188
const CATALOG_CACHE_MS = 30000
const FILE_INVENTORY_CACHE_MS = 15000
const LARGE_FILE_BYTES = 1024 ** 3

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
}

const MODEL_EXTENSIONS = new Set([
  ".safetensors",
  ".sft",
  ".ckpt",
  ".pth",
  ".pt",
  ".bin",
  ".onnx",
  ".gguf"
])

const DOWNLOAD_HOSTS = [
  "huggingface.co",
  "civitai.com",
  "civitai.red",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com"
]

const catalogCache = new Map()
const fileInventoryCache = new Map()
const jobs = new Map()

function getArg(name, fallback) {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1]
  const match = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  if (match) return match.slice(flag.length + 1)
  return fallback
}

const HOST = getArg("host", process.env.HOST || DEFAULT_HOST)
const PORT = Number(getArg("port", process.env.PORT || DEFAULT_PORT))

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  })
  res.end(body)
}

function sendError(res, status, message, detail) {
  sendJson(res, status, { error: message, detail })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body is too large"))
        req.destroy()
      }
    })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

async function readJson(req) {
  const body = await readBody(req)
  return body ? JSON.parse(body) : {}
}

function bookmarkKey(sourceModule, templateId) {
  return `${sourceModule || "default"}:${templateId}`
}

function cleanBookmarkTemplateId(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Template id is missing")
  }
  const trimmed = value.trim()
  if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`Template id is not safe: ${value}`)
  }
  return trimmed
}

function cleanBookmarkSourceModule(value) {
  const sourceModule = typeof value === "string" && value.trim()
    ? value.trim()
    : "default"
  if (!/^[a-zA-Z0-9_.-]+$/.test(sourceModule)) {
    throw new Error(`Template source is not safe: ${value}`)
  }
  return sourceModule
}

function cleanBookmarkText(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function normalizeBookmark(value) {
  if (!value || typeof value !== "object") return null
  const templateId = cleanBookmarkTemplateId(value.templateId || value.id || value.name)
  const sourceModule = cleanBookmarkSourceModule(value.sourceModule)
  const createdAt = cleanBookmarkText(value.createdAt) || new Date().toISOString()
  return {
    id: bookmarkKey(sourceModule, templateId),
    templateId,
    sourceModule,
    title: cleanBookmarkText(value.title),
    createdAt,
    updatedAt: cleanBookmarkText(value.updatedAt) || createdAt
  }
}

async function readBookmarks() {
  try {
    const text = await fs.promises.readFile(BOOKMARKS_FILE, "utf8")
    const data = JSON.parse(text)
    const input = Array.isArray(data?.bookmarks) ? data.bookmarks : []
    const byId = new Map()
    for (const item of input) {
      try {
        const bookmark = normalizeBookmark(item)
        if (bookmark) byId.set(bookmark.id, bookmark)
      } catch {
        // Ignore malformed bookmark records so one bad entry does not break the UI.
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

async function writeBookmarks(bookmarks) {
  await fs.promises.mkdir(DATA_DIR, { recursive: true })
  const sorted = [...bookmarks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const body = `${JSON.stringify({ version: 1, bookmarks: sorted }, null, 2)}\n`
  const tmp = `${BOOKMARKS_FILE}.${process.pid}.tmp`
  await fs.promises.writeFile(tmp, body, "utf8")
  await fs.promises.rename(tmp, BOOKMARKS_FILE)
  return sorted
}

async function saveBookmark(input) {
  const candidate = input?.template && typeof input.template === "object"
    ? input.template
    : input
  const incoming = normalizeBookmark({
    ...candidate,
    templateId: candidate?.templateId || candidate?.id || candidate?.name,
    sourceModule: candidate?.sourceModule || "default",
    updatedAt: new Date().toISOString()
  })
  const existing = await readBookmarks()
  const byId = new Map(existing.map((bookmark) => [bookmark.id, bookmark]))
  const previous = byId.get(incoming.id)
  const bookmark = {
    ...incoming,
    createdAt: previous?.createdAt || incoming.createdAt,
    updatedAt: new Date().toISOString()
  }
  byId.set(bookmark.id, bookmark)
  const bookmarks = await writeBookmarks(Array.from(byId.values()))
  return { bookmark, bookmarks }
}

async function removeBookmark(input) {
  const candidate = input?.template && typeof input.template === "object"
    ? input.template
    : input
  const templateId = cleanBookmarkTemplateId(candidate?.templateId || candidate?.id || candidate?.name)
  const sourceModule = cleanBookmarkSourceModule(candidate?.sourceModule)
  const id = bookmarkKey(sourceModule, templateId)
  const bookmarks = (await readBookmarks()).filter((bookmark) => bookmark.id !== id)
  return {
    removed: true,
    id,
    bookmarks: await writeBookmarks(bookmarks)
  }
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.startsWith("127.")
  )
}

function normalizeBaseUrl(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Missing ComfyUI URL")
  }
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ComfyUI URL must use http or https")
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error("ComfyFS only connects to loopback ComfyUI servers")
  }
  url.pathname = url.pathname.replace(/\/+$/, "")
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/+$/, "")
}

function buildUrl(baseUrl, route) {
  return `${baseUrl}${route.startsWith("/") ? route : `/${route}`}`
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "ComfyFS/0.1" }
    })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function getComfySystem(baseUrl, timeoutMs = 1200) {
  const routes = ["/api/system_stats", "/system_stats"]
  let lastError = null
  for (const route of routes) {
    try {
      const data = await fetchJson(buildUrl(baseUrl, route), timeoutMs)
      if (data?.system?.comfyui_version) return data
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error("ComfyUI system stats not found")
}

function isTemplateEntry(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.name === "string" &&
      (value.title || value.description || value.mediaType)
  )
}

function isTemplateCategory(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.title === "string" &&
      Array.isArray(value.templates)
  )
}

function normalizeCategoryInfo(category) {
  if (!category) return {}
  return {
    moduleName:
      typeof category.moduleName === "string" && category.moduleName
        ? category.moduleName
        : "default",
    title: category.title || "",
    group: typeof category.category === "string" ? category.category : "",
    type: typeof category.type === "string" ? category.type : "",
    icon: typeof category.icon === "string" ? category.icon : "",
    isEssential: Boolean(category.isEssential)
  }
}

function flattenTemplateIndex(index) {
  const templates = []
  const seen = new Set()

  function visit(value, categoryInfo = {}, trail = []) {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, categoryInfo, trail))
      return
    }
    if (!value || typeof value !== "object") return

    if (isTemplateCategory(value)) {
      const nextCategoryInfo = normalizeCategoryInfo(value)
      visit(value.templates, nextCategoryInfo, trail.concat(value.title))
      return
    }

    if (isTemplateEntry(value) && !seen.has(value.name)) {
      seen.add(value.name)
      templates.push(normalizeTemplateSummary(value, categoryInfo, trail))
    }

    for (const [key, child] of Object.entries(value)) {
      if (!Array.isArray(child)) continue
      const nextTrail =
        key === "templates" || key === "children" ? trail : trail.concat(key)
      visit(child, categoryInfo, nextTrail)
    }
  }

  visit(index)
  return templates
}

function normalizeTemplateSummary(template, categoryInfo, trail) {
  const tags = Array.isArray(template.tags) ? template.tags : []
  const modelLabels = Array.isArray(template.models)
    ? template.models.filter((model) => typeof model === "string")
    : []
  const isPartnerNode = template.openSource === false

  return {
    id: template.name,
    name: template.name,
    title: template.title || template.name,
    description: template.description || "",
    mediaType: template.mediaType || "image",
    mediaSubtype: template.mediaSubtype || "",
    thumbnail: Array.isArray(template.thumbnail)
      ? template.thumbnail.filter((item) => typeof item === "string")
      : typeof template.thumbnail === "string"
        ? [template.thumbnail]
        : [],
    tags,
    modelLabels,
    openSource: !isPartnerNode,
    partnerNode: isPartnerNode,
    size: Number(template.size || 0),
    vram: Number(template.vram || 0),
    usage: Number(template.usage || 0),
    searchRank: Number(template.searchRank || 0),
    username: template.username || "",
    date: template.date || "",
    sourceModule: categoryInfo.moduleName || "default",
    category: categoryInfo.title || trail.filter(Boolean).join(" / "),
    categoryTitle: categoryInfo.title || "",
    categoryGroup: categoryInfo.group || "",
    categoryType: categoryInfo.type || "",
    categoryIcon: categoryInfo.icon || "",
    categoryEssential: Boolean(categoryInfo.isEssential)
  }
}

function templatePreviewUrl(baseUrl, template, index = "1") {
  if (!template.mediaSubtype) return null
  const previewRoute = `/templates/${encodeURIComponent(template.name)}-${index}.${encodeURIComponent(template.mediaSubtype)}`
  const sourceUrl = buildUrl(baseUrl, previewRoute)
  return `/api/preview?url=${encodeURIComponent(sourceUrl)}`
}

async function proxyRemoteAsset(remoteUrl, res) {
  const url = new URL(remoteUrl)
  if (!["http:", "https:"].includes(url.protocol) || !isLoopbackHost(url.hostname)) {
    return sendError(res, 400, "Preview URL must point at a loopback ComfyUI server")
  }
  const response = await fetch(remoteUrl, {
    headers: { "user-agent": "ComfyFS/0.1" }
  })
  if (!response.ok || !response.body) {
    return sendError(res, response.status, "Preview asset not found")
  }
  const upstreamContentType = response.headers.get("content-type")
  const headers = {
    "content-type": upstreamContentType && upstreamContentType !== "application/octet-stream"
      ? upstreamContentType
      : contentTypeFromPath(url.pathname),
    "cache-control": "public, max-age=3600"
  }
  const contentLength = response.headers.get("content-length")
  if (contentLength) headers["content-length"] = contentLength
  res.writeHead(200, headers)
  for await (const chunk of response.body) {
    if (!res.write(chunk)) await once(res, "drain")
  }
  res.end()
}

function contentTypeFromPath(value) {
  const ext = path.extname(value).toLowerCase()
  return MIME_TYPES[ext] || "application/octet-stream"
}

function inferDirectoryFromUrl(value) {
  if (!value || typeof value !== "string") return ""
  try {
    const url = new URL(value)
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    const filename = parts.at(-1)
    const folder = parts.at(-2)
    if (filename && isModelFile(filename) && folder) return folder
  } catch {
    return ""
  }
  return ""
}

function isModelFile(name) {
  return MODEL_EXTENSIONS.has(path.extname(String(name)).toLowerCase())
}

function isIgnoredInventoryName(name) {
  return (
    name === ".DS_Store" ||
    /^put_.*_here(?:\..*)?$/i.test(name)
  )
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/")
}

function basenamePosix(value) {
  return path.posix.basename(toPosixPath(value))
}

function normalizeModelEntry(model) {
  if (!model || typeof model !== "object" || typeof model.name !== "string") {
    return null
  }
  if (!isModelFile(model.name)) return null
  const directory =
    typeof model.directory === "string" && model.directory.trim()
      ? model.directory.trim()
      : inferDirectoryFromUrl(model.url)
  return {
    name: model.name,
    directory,
    url: typeof model.url === "string" ? model.url : "",
    hash: typeof model.hash === "string" ? model.hash : "",
    hash_type: typeof model.hash_type === "string" ? model.hash_type : ""
  }
}

function extractModelsFromWorkflow(workflow) {
  const output = []

  function collectModels(models) {
    if (!Array.isArray(models)) return
    for (const model of models) {
      const normalized = normalizeModelEntry(model)
      if (normalized) output.push(normalized)
    }
  }

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== "object") return

    collectModels(value.models)
    if (value.properties && typeof value.properties === "object") {
      collectModels(value.properties.models)
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "models") continue
      visit(child)
    }
  }

  visit(workflow)
  const deduped = new Map()
  for (const model of output) {
    const key = `${model.directory}::${model.name}::${model.url}`
    if (!deduped.has(key)) deduped.set(key, model)
  }
  return Array.from(deduped.values())
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let index = 0
  async function worker() {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await mapper(items[current], current)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  )
  return results
}

function normalizeInstalledNames(files) {
  const names = new Set()
  if (!Array.isArray(files)) return names
  for (const file of files) {
    const candidates = []
    if (typeof file === "string") candidates.push(file)
    if (file && typeof file === "object") {
      candidates.push(file.name, file.file_name, file.path, file.filename)
    }
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate) continue
      names.add(candidate.replace(/\\/g, "/"))
      names.add(path.posix.basename(candidate.replace(/\\/g, "/")))
    }
  }
  return names
}

async function getInstalledModelMap(baseUrl, directories) {
  const entries = await mapLimit(Array.from(directories), 8, async (directory) => {
    try {
      const files = await fetchJson(
        buildUrl(baseUrl, `/api/experiment/models/${encodeURIComponent(directory)}`),
        5000
      )
      return [directory, normalizeInstalledNames(files)]
    } catch {
      try {
        const files = await fetchJson(
          buildUrl(baseUrl, `/models/${encodeURIComponent(directory)}`),
          5000
        )
        return [directory, normalizeInstalledNames(files)]
      } catch {
        return [directory, new Set()]
      }
    }
  })
  return new Map(entries)
}

function classifyTemplate(template, models) {
  if (!models.length) {
    return template.openSource ? "unknown" : "cloud"
  }
  const missing = models.filter((model) => !model.installed)
  return missing.length ? "missing" : "ready"
}

async function buildCatalog(baseUrl) {
  const cacheKey = baseUrl
  const cached = catalogCache.get(cacheKey)
  if (cached && Date.now() - cached.createdAt < CATALOG_CACHE_MS) {
    return cached.value
  }

  const [system, folderPaths, index] = await Promise.all([
    getComfySystem(baseUrl, 5000),
    fetchJson(buildUrl(baseUrl, "/internal/folder_paths"), 5000).catch(() => ({})),
    fetchJson(buildUrl(baseUrl, "/templates/index.json"), 8000)
  ])

  const summaries = flattenTemplateIndex(index)
  const templatesWithModels = await mapLimit(summaries, 16, async (template) => {
    try {
      const workflow = await fetchJson(
        buildUrl(baseUrl, `/templates/${encodeURIComponent(template.name)}.json`),
        8000
      )
      return {
        ...template,
        previewUrl: templatePreviewUrl(baseUrl, template),
        models: extractModelsFromWorkflow(workflow),
        loadError: ""
      }
    } catch (error) {
      return {
        ...template,
        previewUrl: templatePreviewUrl(baseUrl, template),
        models: [],
        loadError: error.message
      }
    }
  })

  const directories = new Set()
  for (const template of templatesWithModels) {
    for (const model of template.models) {
      if (model.directory) directories.add(model.directory)
    }
  }

  const installed = await getInstalledModelMap(baseUrl, directories)
  const templates = templatesWithModels.map((template) => {
    const models = template.models.map((model) => {
      const installedNames = installed.get(model.directory) || new Set()
      return {
        ...model,
        installed:
          installedNames.has(model.name) ||
          installedNames.has(path.posix.basename(model.name.replace(/\\/g, "/"))),
        downloadable: Boolean(model.url && model.directory)
      }
    })
    const status = classifyTemplate(template, models)
    const missingCount = models.filter((model) => !model.installed).length
    return {
      ...template,
      models,
      status,
      modelCount: models.length,
      missingCount
    }
  })

  const stats = {
    total: templates.length,
    ready: templates.filter((template) => template.status === "ready").length,
    missing: templates.filter((template) => template.status === "missing").length,
    unknown: templates.filter((template) => template.status === "unknown").length,
    cloud: templates.filter((template) => template.status === "cloud").length,
    missingFiles: templates.reduce((sum, template) => sum + template.missingCount, 0)
  }

  const value = {
    baseUrl,
    system: system.system,
    devices: system.devices || [],
    folderPaths,
    stats,
    templates
  }
  catalogCache.set(cacheKey, { createdAt: Date.now(), value })
  return value
}

function modelRootEntries(folderPaths) {
  const roots = []
  for (const [directory, paths] of Object.entries(folderPaths || {})) {
    if (directory === "custom_nodes" || !Array.isArray(paths)) continue
    const usable = paths
      .filter((item) => typeof item === "string" && item.trim())
      .filter((item) => !toPosixPath(item).includes("/output/"))
    for (const rootPath of usable) {
      roots.push({
        directory,
        rootPath: path.resolve(rootPath)
      })
    }
  }
  return roots
}

function referenceIndexFromCatalog(catalog) {
  const index = new Map()

  function add(key, reference) {
    if (!key) return
    if (!index.has(key)) index.set(key, [])
    const references = index.get(key)
    if (!references.some((item) => item.templateId === reference.templateId)) {
      references.push(reference)
    }
  }

  for (const template of catalog.templates || []) {
    for (const model of template.models || []) {
      if (!model.directory || !model.name) continue
      const reference = {
        templateId: template.id,
        title: template.title,
        status: template.status,
        category: template.categoryTitle || template.category || ""
      }
      const normalized = toPosixPath(model.name)
      add(`${model.directory}\n${normalized}`, reference)
      add(`${model.directory}\n${basenamePosix(normalized)}`, reference)
    }
  }

  return index
}

function fileReferences(referenceIndex, directory, relativePath) {
  const normalized = toPosixPath(relativePath)
  const references = [
    ...(referenceIndex.get(`${directory}\n${normalized}`) || []),
    ...(referenceIndex.get(`${directory}\n${basenamePosix(normalized)}`) || [])
  ]
  const unique = new Map()
  for (const reference of references) {
    unique.set(reference.templateId, reference)
  }
  return Array.from(unique.values()).sort((a, b) => a.title.localeCompare(b.title))
}

function fileInventoryStatus(file) {
  if (file.partial) return "partial"
  if (file.references.length > 0) return "referenced"
  if (file.modelFile) return "unused"
  return "local"
}

async function scanModelNode({ directory, rootPath, currentPath, relativePath, referenceIndex }) {
  const linkStat = await fs.promises.lstat(currentPath)
  const stat = linkStat.isSymbolicLink()
    ? await fs.promises.stat(currentPath)
    : linkStat
  const name = relativePath ? path.basename(currentPath) : directory
  const id = `${directory}:${toPosixPath(rootPath)}:${toPosixPath(relativePath || ".")}`

  if (stat.isDirectory()) {
    const node = {
      id,
      kind: relativePath ? "folder" : "root",
      name,
      directory,
      path: currentPath,
      rootPath,
      relativePath: toPosixPath(relativePath),
      size: 0,
      files: 0,
      folders: 0,
      modified: stat.mtime.toISOString(),
      symlink: linkStat.isSymbolicLink(),
      children: []
    }

    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true })
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const entry of entries) {
      if (isIgnoredInventoryName(entry.name)) continue
      const childRelative = relativePath ? path.join(relativePath, entry.name) : entry.name
      const childPath = path.join(currentPath, entry.name)
      try {
        const child = await scanModelNode({
          directory,
          rootPath,
          currentPath: childPath,
          relativePath: childRelative,
          referenceIndex
        })
        if (!child) continue
        node.children.push(child)
        node.size += child.size
        node.files += child.kind === "file" ? 1 : child.files
        node.folders += child.kind === "file" ? 0 : child.folders + 1
      } catch {
        // Ignore files that disappear or cannot be read during the scan.
      }
    }

    return node
  }

  if (!stat.isFile()) return null

  const normalizedRelative = toPosixPath(relativePath)
  const partial =
    normalizedRelative.endsWith(".comfyfs-part") ||
    normalizedRelative.endsWith(".comfysync-part")
  const modelFile = isModelFile(normalizedRelative)

  const references = fileReferences(referenceIndex, directory, normalizedRelative)
  const file = {
    id,
    kind: "file",
    name,
    directory,
    path: currentPath,
    rootPath,
    relativePath: normalizedRelative,
    size: stat.size,
    files: 1,
    folders: 0,
    modified: stat.mtime.toISOString(),
    symlink: linkStat.isSymbolicLink(),
    references,
    partial,
    modelFile,
    extension: path.extname(name).toLowerCase(),
    large: stat.size >= LARGE_FILE_BYTES
  }
  file.status = fileInventoryStatus(file)
  return file
}

function summarizeInventory(nodes) {
  const stats = {
    totalSize: 0,
    files: 0,
    folders: 0,
    roots: nodes.length,
    referenced: 0,
    unused: 0,
    partial: 0,
    local: 0,
    large: 0
  }
  const rootMap = new Map()

  function addRoot(directory, node) {
    const current = rootMap.get(directory) || {
      directory,
      size: 0,
      files: 0,
      folders: 0,
      roots: 0
    }
    current.size += node.size
    current.files += node.files
    current.folders += node.folders
    current.roots += 1
    rootMap.set(directory, current)
  }

  function visit(node) {
    if (node.kind === "file") {
      stats.files += 1
      stats.totalSize += node.size
      if (node.status === "referenced") stats.referenced += 1
      if (node.status === "unused") stats.unused += 1
      if (node.status === "partial") stats.partial += 1
      if (node.status === "local") stats.local += 1
      if (node.large) stats.large += 1
      return
    }
    stats.folders += node.kind === "folder" ? 1 : 0
    node.children.forEach(visit)
  }

  for (const node of nodes) {
    addRoot(node.directory, node)
    visit(node)
  }

  return {
    stats,
    roots: Array.from(rootMap.values()).sort((a, b) => b.size - a.size)
  }
}

async function buildFileInventory(baseUrl) {
  const cached = fileInventoryCache.get(baseUrl)
  if (cached && Date.now() - cached.createdAt < FILE_INVENTORY_CACHE_MS) {
    return cached.value
  }

  const catalog = await buildCatalog(baseUrl)
  const referenceIndex = referenceIndexFromCatalog(catalog)
  const roots = modelRootEntries(catalog.folderPaths)
  const nodes = []
  const errors = []

  for (const root of roots) {
    try {
      const stat = await fs.promises.stat(root.rootPath)
      if (!stat.isDirectory()) continue
      const node = await scanModelNode({
        directory: root.directory,
        rootPath: root.rootPath,
        currentPath: root.rootPath,
        relativePath: "",
        referenceIndex
      })
      nodes.push(node)
    } catch (error) {
      if (error.code === "ENOENT") continue
      errors.push({
        directory: root.directory,
        path: root.rootPath,
        error: error.message
      })
    }
  }

  const summary = summarizeInventory(nodes)
  const value = {
    baseUrl,
    generatedAt: new Date().toISOString(),
    stats: {
      ...summary.stats,
      missingReferences: catalog.stats.missingFiles
    },
    roots: summary.roots,
    nodes,
    errors
  }
  fileInventoryCache.set(baseUrl, { createdAt: Date.now(), value })
  return value
}

function isAllowedDownloadUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return true
    if (url.protocol !== "https:") return false
    const host = url.hostname.toLowerCase()
    return DOWNLOAD_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

function cleanRelativeModelName(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Model name is missing")
  }
  const normalized = value.replace(/\\/g, "/")
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`Model name must be relative: ${value}`)
  }
  const parts = normalized.split("/").filter(Boolean)
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Model name is not safe: ${value}`)
  }
  if (!isModelFile(parts.at(-1))) {
    throw new Error(`Unsupported model extension: ${value}`)
  }
  return parts.join(path.sep)
}

function selectDestination(folderPaths, directory) {
  const paths = Array.isArray(folderPaths[directory]) ? folderPaths[directory] : []
  const usable = paths.filter((item) => typeof item === "string" && item.trim())
  if (!usable.length) throw new Error(`ComfyUI has no folder path for ${directory}`)
  const nonOutput = usable.find((item) => !item.replace(/\\/g, "/").includes("/output/"))
  return nonOutput || usable[0]
}

function resolveDestination(baseDir, relativeName) {
  const root = path.resolve(baseDir)
  const destination = path.resolve(root, relativeName)
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error("Resolved destination escaped the model folder")
  }
  return destination
}

async function downloadModel(item) {
  if (!isAllowedDownloadUrl(item.url)) {
    throw new Error(`Download source is not allowed: ${item.url}`)
  }

  await fs.promises.mkdir(path.dirname(item.destination), { recursive: true })
  if (fs.existsSync(item.destination)) {
    item.status = "skipped"
    item.downloaded = item.total || 0
    return
  }

  const partial = `${item.destination}.comfyfs-part`
  const response = await fetch(item.url, {
    headers: { "user-agent": "ComfyFS/0.1" }
  })
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText}`)
  }

  const contentLength = Number(response.headers.get("content-length") || 0)
  if (contentLength > 0) item.total = contentLength
  item.status = "downloading"
  item.startedAt = new Date().toISOString()

  const stream = fs.createWriteStream(partial)
  try {
    for await (const chunk of response.body) {
      item.downloaded += chunk.length
      if (!stream.write(chunk)) {
        await once(stream, "drain")
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve()))
    })
  }

  await fs.promises.rename(partial, item.destination)
  item.status = "done"
  item.finishedAt = new Date().toISOString()
}

async function runDownloadJob(job) {
  job.status = "running"
  for (const item of job.items) {
    try {
      await downloadModel(item)
    } catch (error) {
      item.status = "error"
      item.error = error.message
      job.errors += 1
      try {
        await fs.promises.rm(`${item.destination}.comfyfs-part`, { force: true })
      } catch {
        // Best effort cleanup.
      }
    }
    job.completed += 1
  }
  job.status = job.errors ? "finished_with_errors" : "finished"
  job.finishedAt = new Date().toISOString()
  catalogCache.delete(job.baseUrl)
  fileInventoryCache.delete(job.baseUrl)
}

async function createDownloadJob(baseUrl, models) {
  if (!Array.isArray(models) || !models.length) {
    throw new Error("No models were provided")
  }
  const folderPaths = await fetchJson(buildUrl(baseUrl, "/internal/folder_paths"), 5000)
  const items = models.map((model) => {
    const normalized = normalizeModelEntry(model)
    if (!normalized?.directory || !normalized.url) {
      throw new Error(`Model is missing URL or directory: ${model?.name || "unknown"}`)
    }
    const baseDir = selectDestination(folderPaths, normalized.directory)
    const relativeName = cleanRelativeModelName(normalized.name)
    return {
      name: normalized.name,
      directory: normalized.directory,
      url: normalized.url,
      destination: resolveDestination(baseDir, relativeName),
      status: "queued",
      downloaded: 0,
      total: 0,
      error: ""
    }
  })

  const job = {
    id: randomUUID(),
    baseUrl,
    status: "queued",
    createdAt: new Date().toISOString(),
    finishedAt: "",
    completed: 0,
    errors: 0,
    total: items.length,
    items
  }
  jobs.set(job.id, job)
  runDownloadJob(job).catch((error) => {
    job.status = "error"
    job.error = error.message
    job.finishedAt = new Date().toISOString()
  })
  return job
}

async function deleteModelFile(baseUrl, model) {
  const folderPaths = await fetchJson(buildUrl(baseUrl, "/internal/folder_paths"), 5000)
  const normalized = normalizeModelEntry(model)
  if (!normalized?.directory) {
    throw new Error(`Model is missing a folder: ${model?.name || "unknown"}`)
  }

  const baseDir = selectDestination(folderPaths, normalized.directory)
  const relativeName = cleanRelativeModelName(normalized.name)
  const destination = resolveDestination(baseDir, relativeName)

  let stat
  try {
    stat = await fs.promises.lstat(destination)
  } catch (error) {
    if (error.code === "ENOENT") {
      catalogCache.delete(baseUrl)
      return {
        deleted: false,
        missing: true,
        name: normalized.name,
        directory: normalized.directory,
        destination
      }
    }
    throw error
  }

  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error("Refusing to delete a non-file model path")
  }

  await fs.promises.unlink(destination)
  catalogCache.delete(baseUrl)
  fileInventoryCache.delete(baseUrl)
  return {
    deleted: true,
    missing: false,
    name: normalized.name,
    directory: normalized.directory,
    destination
  }
}

function isPathInsideRoot(target, root) {
  const resolvedTarget = path.resolve(target)
  const resolvedRoot = path.resolve(root)
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  )
}

async function validateInventoryPath(baseUrl, filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("File path is missing")
  }

  const catalog = await buildCatalog(baseUrl)
  const roots = modelRootEntries(catalog.folderPaths).map((entry) => entry.rootPath)
  const target = path.resolve(filePath)
  if (!roots.some((root) => isPathInsideRoot(target, root))) {
    throw new Error("Path is outside ComfyUI model roots")
  }
  return target
}

async function deleteInventoryFile(baseUrl, filePath) {
  const target = await validateInventoryPath(baseUrl, filePath)

  let stat
  try {
    const linkStat = await fs.promises.lstat(target)
    stat = linkStat.isSymbolicLink()
      ? await fs.promises.stat(target)
      : linkStat
  } catch (error) {
    if (error.code === "ENOENT") {
      catalogCache.delete(baseUrl)
      fileInventoryCache.delete(baseUrl)
      return {
        deleted: false,
        missing: true,
        path: target,
        name: path.basename(target)
      }
    }
    throw error
  }

  if (!stat.isFile()) {
    throw new Error("Refusing to delete a non-file model path")
  }

  await fs.promises.unlink(target)
  catalogCache.delete(baseUrl)
  fileInventoryCache.delete(baseUrl)
  return {
    deleted: true,
    missing: false,
    path: target,
    name: path.basename(target)
  }
}

async function deleteInventoryFiles(baseUrl, paths) {
  if (!Array.isArray(paths) || !paths.length) {
    throw new Error("No files were provided")
  }

  const uniquePaths = Array.from(new Set(paths.filter((item) => typeof item === "string" && item.trim())))
  if (!uniquePaths.length) {
    throw new Error("No valid files were provided")
  }
  if (uniquePaths.length > 500) {
    throw new Error("Too many files selected")
  }

  const results = []
  const errors = []
  for (const filePath of uniquePaths) {
    try {
      results.push(await deleteInventoryFile(baseUrl, filePath))
    } catch (error) {
      errors.push({
        path: path.resolve(filePath),
        error: error.message
      })
    }
  }

  return {
    requested: uniquePaths.length,
    deleted: results.filter((item) => item.deleted).length,
    missing: results.filter((item) => item.missing).length,
    errors,
    results
  }
}

function openSystemPath(target, stat) {
  let command
  let args
  if (process.platform === "darwin") {
    command = "open"
    args = stat.isDirectory() ? [target] : ["-R", target]
  } else if (process.platform === "win32") {
    command = "explorer.exe"
    args = stat.isDirectory() ? [target] : [`/select,${target}`]
  } else {
    command = "xdg-open"
    args = [stat.isDirectory() ? target : path.dirname(target)]
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  })
  child.on("error", () => {})
  child.unref()
}

async function openInventoryPath(baseUrl, filePath) {
  const target = await validateInventoryPath(baseUrl, filePath)
  const linkStat = await fs.promises.lstat(target)
  const stat = linkStat.isSymbolicLink()
    ? await fs.promises.stat(target)
    : linkStat
  openSystemPath(target, stat)
  return {
    opened: true,
    path: target,
    directory: stat.isDirectory(),
    action: stat.isDirectory() ? "open" : "reveal"
  }
}

function getSafeStaticPath(pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname
  const decoded = decodeURIComponent(requested)
  const resolved = path.resolve(PUBLIC_DIR, `.${decoded}`)
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return null
  }
  return resolved
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/bookmarks") {
      return sendJson(res, 200, { bookmarks: await readBookmarks() })
    }

    if (req.method === "POST" && url.pathname === "/api/bookmarks") {
      const body = await readJson(req)
      return sendJson(res, 200, await saveBookmark(body))
    }

    if (req.method === "DELETE" && url.pathname === "/api/bookmarks") {
      const body = await readJson(req)
      return sendJson(res, 200, await removeBookmark(body))
    }

    if (req.method === "GET" && url.pathname === "/api/templates") {
      const baseUrl = normalizeBaseUrl(url.searchParams.get("baseUrl"))
      if (url.searchParams.has("refresh")) {
        catalogCache.delete(baseUrl)
        fileInventoryCache.delete(baseUrl)
      }
      return sendJson(res, 200, await buildCatalog(baseUrl))
    }

    if (req.method === "GET" && url.pathname === "/api/files") {
      const baseUrl = normalizeBaseUrl(url.searchParams.get("baseUrl"))
      if (url.searchParams.has("refresh")) {
        catalogCache.delete(baseUrl)
        fileInventoryCache.delete(baseUrl)
      }
      return sendJson(res, 200, await buildFileInventory(baseUrl))
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const baseUrl = normalizeBaseUrl(url.searchParams.get("baseUrl"))
      const [system, folderPaths] = await Promise.all([
        getComfySystem(baseUrl, 5000),
        fetchJson(buildUrl(baseUrl, "/internal/folder_paths"), 5000).catch(() => ({}))
      ])
      return sendJson(res, 200, {
        baseUrl,
        system: system.system,
        devices: system.devices || [],
        folderPaths
      })
    }

    if (req.method === "GET" && url.pathname === "/api/preview") {
      const remoteUrl = url.searchParams.get("url")
      if (!remoteUrl) return sendError(res, 400, "Preview URL is missing")
      return proxyRemoteAsset(remoteUrl, res)
    }

    if (req.method === "POST" && url.pathname === "/api/download") {
      const body = await readJson(req)
      const baseUrl = normalizeBaseUrl(body.baseUrl)
      const job = await createDownloadJob(baseUrl, body.models)
      return sendJson(res, 202, job)
    }

    if (req.method === "POST" && url.pathname === "/api/delete") {
      const body = await readJson(req)
      const baseUrl = normalizeBaseUrl(body.baseUrl)
      const result = await deleteModelFile(baseUrl, body.model)
      return sendJson(res, 200, result)
    }

    if (req.method === "POST" && url.pathname === "/api/delete-file") {
      const body = await readJson(req)
      const baseUrl = normalizeBaseUrl(body.baseUrl)
      const result = await deleteInventoryFile(baseUrl, body.path)
      return sendJson(res, 200, result)
    }

    if (req.method === "POST" && url.pathname === "/api/delete-files") {
      const body = await readJson(req)
      const baseUrl = normalizeBaseUrl(body.baseUrl)
      const result = await deleteInventoryFiles(baseUrl, body.paths)
      return sendJson(res, result.errors.length ? 207 : 200, result)
    }

    if (req.method === "POST" && url.pathname === "/api/open-path") {
      const body = await readJson(req)
      const baseUrl = normalizeBaseUrl(body.baseUrl)
      const result = await openInventoryPath(baseUrl, body.path)
      return sendJson(res, 200, result)
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/)
    if (req.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1])
      if (!job) return sendError(res, 404, "Job not found")
      return sendJson(res, 200, job)
    }

    return sendError(res, 404, "API route not found")
  } catch (error) {
    return sendError(res, 400, error.message)
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`)
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url)
  }

  const filePath = getSafeStaticPath(url.pathname)
  if (!filePath) return sendError(res, 403, "Forbidden")

  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) throw new Error("Not a file")
    const ext = path.extname(filePath)
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store"
    })
    fs.createReadStream(filePath).pipe(res)
  } catch {
    if (!path.extname(url.pathname)) {
      const indexPath = path.join(PUBLIC_DIR, "index.html")
      res.writeHead(200, {
        "content-type": MIME_TYPES[".html"],
        "cache-control": "no-store"
      })
      fs.createReadStream(indexPath).pipe(res)
      return
    }
    sendError(res, 404, "File not found")
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendError(res, 500, "Internal server error", error.message)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`ComfyFS listening at http://${HOST}:${PORT}`)
})
