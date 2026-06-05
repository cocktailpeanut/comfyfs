const THEME_KEY = "comfyfs-theme"

const state = {
  theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  baseUrl: "",
  catalog: null,
  templates: [],
  bookmarks: [],
  bookmarksLoading: false,
  selectedId: "",
  view: "templates",
  category: "all",
  filter: "all",
  search: "",
  files: null,
  filesLoading: false,
  fileSearch: "",
  fileFilter: "all",
  fileRoot: "all",
  selectedFileId: "",
  selectedFileIds: new Set(),
  bulkDeleting: false,
  fileDeleting: null,
  jobs: new Map(),
  polling: new Map()
}

const els = {
  form: document.querySelector("#connect-form"),
  themeLight: document.querySelector("#theme-light"),
  themeDark: document.querySelector("#theme-dark"),
  baseUrl: document.querySelector("#base-url"),
  refresh: document.querySelector("#refresh-button"),
  search: document.querySelector("#search"),
  nav: document.querySelector("#template-nav"),
  notice: document.querySelector("#notice"),
  grid: document.querySelector("#template-grid"),
  detail: document.querySelector("#detail"),
  connectionDot: document.querySelector("#connection-dot"),
  viewTabs: document.querySelectorAll(".view-tab"),
  templatesView: document.querySelector("#templates-view"),
  bookmarksView: document.querySelector("#bookmarks-view"),
  bookmarksGrid: document.querySelector("#bookmarks-grid"),
  bookmarksDetail: document.querySelector("#bookmarks-detail"),
  bookmarksNotice: document.querySelector("#bookmarks-notice"),
  filesView: document.querySelector("#files-view"),
  fileSearch: document.querySelector("#file-search"),
  filesNotice: document.querySelector("#files-notice"),
  fileSummary: document.querySelector("#file-summary"),
  fileBulkBar: document.querySelector("#file-bulk-bar"),
  fileRootFilters: document.querySelector("#file-root-filters"),
  fileStatusFilters: document.querySelector("#file-status-filters"),
  fileTree: document.querySelector("#file-tree"),
  fileDetail: document.querySelector("#file-detail"),
  jobs: document.querySelector("#jobs"),
  jobsTitle: document.querySelector("#jobs-title"),
  jobsList: document.querySelector("#jobs-list")
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

function iconMarkup(name) {
  const icons = {
    bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"></path>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path>',
    external: '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"></path><path d="M3.2 10h17.6l-1.4 8.4A2 2 0 0 1 17.4 20H6.6a2 2 0 0 1-2-1.6Z"></path>',
    listCheck: '<path d="M11 6h10"></path><path d="M11 12h10"></path><path d="M11 18h10"></path><path d="m3 6 1 1 2-2"></path><path d="m3 12 1 1 2-2"></path><path d="m3 18 1 1 2-2"></path>',
    check: '<path d="M20 6 9 17l-5-5"></path>',
    trash: '<path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>'
  }
  return `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ""}</svg>`
}

function buttonContent(icon, label) {
  return `${iconMarkup(icon)}<span>${escapeHtml(label)}</span>`
}

function applyTheme(theme, persist = true) {
  const nextTheme = theme === "dark" ? "dark" : "light"
  state.theme = nextTheme
  document.documentElement.dataset.theme = nextTheme
  els.themeLight?.setAttribute("aria-pressed", String(nextTheme === "light"))
  els.themeDark?.setAttribute("aria-pressed", String(nextTheme === "dark"))
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, nextTheme)
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (!value) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

function formatDate(value) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })
}

function waitForPaint() {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(done, 0)
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(done))
    setTimeout(done, 80)
  })
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...options
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(data?.error || response.statusText)
  }
  return data
}

function setNotice(message, tone = "") {
  els.notice.textContent = message
  els.notice.dataset.tone = tone
}

function setBookmarksNotice(message, tone = "") {
  els.bookmarksNotice.textContent = message
  els.bookmarksNotice.dataset.tone = tone
}

function templateBookmarkKey(template) {
  return `${template.sourceModule || "default"}:${template.id || template.name}`
}

function bookmarkRecordKey(bookmark) {
  return `${bookmark.sourceModule || "default"}:${bookmark.templateId}`
}

function isBookmarked(template) {
  const key = templateBookmarkKey(template)
  return state.bookmarks.some((bookmark) => bookmarkRecordKey(bookmark) === key)
}

function bookmarkedTemplates() {
  const templatesByKey = new Map(
    state.templates.map((template) => [templateBookmarkKey(template), template])
  )
  return state.bookmarks
    .map((bookmark) => templatesByKey.get(bookmarkRecordKey(bookmark)))
    .filter(Boolean)
}

function comfyTemplateUrl(template) {
  try {
    const url = new URL(state.baseUrl)
    url.searchParams.set("template", template.name)
    url.searchParams.set("source", template.sourceModule || "default")
    return url.toString()
  } catch {
    return ""
  }
}

function statusLabel(status, missingCount = 0) {
  if (status === "ready") return "Ready"
  if (status === "missing") return `${missingCount} missing`
  if (status === "cloud") return "API"
  if (status === "unknown") return "Unknown"
  return status
}

function classifyTemplate(template) {
  if (!template.models.length) {
    return template.openSource ? "unknown" : "cloud"
  }
  return template.models.some((model) => !model.installed) ? "missing" : "ready"
}

function updateTemplateStatus(template) {
  template.missingCount = template.models.filter((model) => !model.installed).length
  template.status = classifyTemplate(template)
}

function updateCatalogStats() {
  if (!state.catalog) return
  state.catalog.stats = {
    total: state.templates.length,
    ready: state.templates.filter((template) => template.status === "ready").length,
    missing: state.templates.filter((template) => template.status === "missing").length,
    unknown: state.templates.filter((template) => template.status === "unknown").length,
    cloud: state.templates.filter((template) => template.status === "cloud").length,
    missingFiles: state.templates.reduce((sum, template) => sum + template.missingCount, 0)
  }
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function displayGroupName(value) {
  return String(value || "")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}

function templateSearchHaystack(template) {
  return [
    template.title,
    template.name,
    template.description,
    template.username,
    template.categoryTitle,
    template.categoryGroup,
    ...(template.tags || []),
    ...(template.modelLabels || []),
    ...(template.models || []).map((model) => model.name)
  ]
    .join(" ")
    .toLowerCase()
}

function matchesTemplateControls(template) {
  if (state.filter !== "all" && template.status !== state.filter) return false
  const term = state.search.trim().toLowerCase()
  return !term || templateSearchHaystack(template).includes(term)
}

function addCategoryItem(map, key, template, counted = true) {
  if (!key) return
  const existing = map.get(key)
  if (existing) {
    if (counted) existing.count += 1
    return
  }
  map.set(key, {
    count: counted ? 1 : 0,
    icon: template.categoryIcon || "",
    label: template.categoryTitle || key,
    type: template.categoryType || ""
  })
}

function buildNavigation() {
  const essentials = new Map()
  const groups = new Map()
  const extensions = new Map()
  let partnerNodes = 0
  let hasPartnerNodes = false
  let visibleTotal = 0

  for (const template of state.templates) {
    const counted = matchesTemplateControls(template)
    if (counted) visibleTotal += 1
    if (template.categoryEssential) {
      addCategoryItem(essentials, template.categoryTitle, template, counted)
    } else if (template.categoryGroup && template.categoryTitle) {
      if (!groups.has(template.categoryGroup)) groups.set(template.categoryGroup, new Map())
      addCategoryItem(groups.get(template.categoryGroup), template.categoryTitle, template, counted)
    }
    if (template.partnerNode) {
      hasPartnerNodes = true
      if (counted) partnerNodes += 1
    }
    if (template.sourceModule && template.sourceModule !== "default") {
      const existing = extensions.get(template.sourceModule)
      extensions.set(template.sourceModule, (existing || 0) + (counted ? 1 : 0))
    }
  }

  const sections = [
    {
      items: [
        { id: "all", label: "All Templates", count: visibleTotal },
        { id: "popular", label: "Popular", count: visibleTotal }
      ]
    }
  ]

  if (essentials.size) {
    sections[0].items.push(
      ...Array.from(essentials.entries()).map(([title, item]) => ({
        id: `essential:${slug(title)}`,
        label: item.label,
        count: item.count,
        type: item.type
      }))
    )
  }

  for (const [groupName, categoryMap] of groups.entries()) {
    const items = Array.from(categoryMap.entries()).map(([title, item]) => ({
      id: `group:${slug(groupName)}:${slug(title)}`,
      label: item.label,
      count: item.count,
      type: item.type
    }))
    if (items.length) {
      sections.push({
        title: displayGroupName(groupName),
        items
      })
    }
  }

  if (hasPartnerNodes) {
    sections.push({
      items: [{ id: "partner-nodes", label: "Partner Nodes", count: partnerNodes }]
    })
  }

  if (extensions.size) {
    sections.push({
      title: "Extensions",
      items: Array.from(extensions.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([moduleName, count]) => ({
          id: `extension:${slug(moduleName)}`,
          label: moduleName,
          count
        }))
    })
  }

  return sections
}

function navigationIds() {
  return new Set(
    buildNavigation()
      .flatMap((section) => section.items)
      .map((item) => item.id)
  )
}

function matchesCategory(template) {
  if (state.category === "all" || state.category === "popular") return true
  if (state.category === "partner-nodes") return Boolean(template.partnerNode)
  if (state.category.startsWith("essential:")) {
    return (
      template.categoryEssential &&
      slug(template.categoryTitle) === state.category.slice("essential:".length)
    )
  }
  if (state.category.startsWith("group:")) {
    const [, groupSlug, titleSlug] = state.category.split(":")
    return (
      slug(template.categoryGroup) === groupSlug &&
      slug(template.categoryTitle) === titleSlug
    )
  }
  if (state.category.startsWith("extension:")) {
    return slug(template.sourceModule) === state.category.slice("extension:".length)
  }
  return true
}

function computeFreshness(date) {
  if (!date) return 0.5
  const value = new Date(date)
  if (Number.isNaN(value.getTime())) return 0.5
  const days = (Date.now() - value.getTime()) / (1000 * 60 * 60 * 24)
  return Math.max(0.1, 1 / (1 + days / 90))
}

function sortTemplates(templates) {
  if (state.category !== "popular") return templates
  const maxUsage = Math.max(1, ...templates.map((template) => Number(template.usage || 0)))
  return [...templates].sort((a, b) => {
    const scoreA = (Number(a.usage || 0) / maxUsage) * 0.9 + computeFreshness(a.date) * 0.1
    const scoreB = (Number(b.usage || 0) / maxUsage) * 0.9 + computeFreshness(b.date) * 0.1
    return scoreB - scoreA
  })
}

function applyCompletedDownloads(job) {
  const installedItems = (job.items || []).filter((item) => ["done", "skipped"].includes(item.status))
  if (!installedItems.length) return false

  let changed = false
  const completedKeys = new Set(installedItems.map((item) => `${item.directory}\n${item.name}`))
  for (const template of state.templates) {
    let templateChanged = false
    for (const model of template.models) {
      if (!model.installed && completedKeys.has(`${model.directory}\n${model.name}`)) {
        model.installed = true
        templateChanged = true
        changed = true
      }
    }
    if (templateChanged) updateTemplateStatus(template)
  }

  if (changed) updateCatalogStats()
  return changed
}

function applyDeletedModel(deletedModel) {
  let changed = false
  const deletedKey = `${deletedModel.directory}\n${deletedModel.name}`
  for (const template of state.templates) {
    let templateChanged = false
    for (const model of template.models) {
      if (model.installed && `${model.directory}\n${model.name}` === deletedKey) {
        model.installed = false
        templateChanged = true
        changed = true
      }
    }
    if (templateChanged) updateTemplateStatus(template)
  }

  if (changed) updateCatalogStats()
  return changed
}

function filteredTemplates() {
  const templates = state.templates.filter((template) => {
    if (!matchesCategory(template)) return false
    return matchesTemplateControls(template)
  })
  return sortTemplates(templates)
}

function previewMarkup(template, large = false) {
  const url = template.previewUrl
  const fallback = `<div class="preview-fallback">${escapeHtml((template.title || "FS").slice(0, 2).toUpperCase())}</div>`
  if (!url) return fallback
  const escaped = escapeHtml(url)
  const isVideo = /\.(mp4|webm|mov)(?:$|[?#])/i.test(url)
  if (isVideo) {
    return `<video src="${escaped}" muted loop playsinline ${large ? "controls" : "autoplay"}></video>`
  }
  return `<img src="${escaped}" alt="" loading="lazy" onerror="this.replaceWith(document.createElement('div'))" />`
}

function templateCardMarkup(template) {
  const missing = template.models.filter((model) => !model.installed && model.downloadable)
  return `
    <article class="template-card ${template.id === state.selectedId ? "selected" : ""}" data-id="${escapeHtml(template.id)}" role="button" tabindex="0" aria-label="Inspect ${escapeHtml(template.title)}">
      <div class="preview">
        ${previewMarkup(template)}
        <div class="badge-row">
          <span class="badge ${escapeHtml(template.status)}">${escapeHtml(statusLabel(template.status, template.missingCount))}</span>
          ${isBookmarked(template) ? '<span class="badge">Bookmarked</span>' : ""}
          ${template.openSource ? '<span class="badge ready">Open</span>' : '<span class="badge cloud">API</span>'}
        </div>
      </div>
      <div class="card-body">
        <div class="template-title">
          <h3>${escapeHtml(template.title)}</h3>
        </div>
        <p class="template-description">${escapeHtml(template.description || "No description in template metadata.")}</p>
        <div class="template-meta">
          <span>${escapeHtml(formatBytes(template.size))}</span>
          <span>${escapeHtml(template.modelCount)} files</span>
          <span>${escapeHtml(template.usage)} uses</span>
        </div>
        <div class="tags">
          ${(template.tags || []).slice(0, 4).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
        </div>
        ${missing.length ? `<div class="template-meta"><span>${escapeHtml(missing.length)} downloadable missing file${missing.length === 1 ? "" : "s"}</span></div>` : ""}
      </div>
    </article>
  `
}

function renderTemplateCards(target, templates, emptyMessage) {
  if (!templates.length) {
    target.innerHTML = `<div class="empty-grid">${escapeHtml(emptyMessage)}</div>`
    return
  }
  target.innerHTML = templates.map(templateCardMarkup).join("")
}

function renderStats() {
  const stats = state.catalog?.stats
  if (!els.connectionDot) return
  if (state.catalog?.system) {
    const version = state.catalog.system.comfyui_version
    const templates = state.catalog.system.installed_templates_version
    els.connectionDot.dataset.state = "connected"
    els.connectionDot.title = `${state.baseUrl} - ComfyUI ${version} - templates ${templates || "unknown"} - ${stats?.missingFiles || 0} missing files`
  } else {
    els.connectionDot.dataset.state = "offline"
    els.connectionDot.title = "Not connected"
  }
}

function renderNav() {
  if (!state.catalog) {
    els.nav.innerHTML = ""
    return
  }

  const sections = buildNavigation()
  els.nav.innerHTML = `
    <div class="nav-title">
      <span class="eyebrow">Templates</span>
    </div>
    ${sections
      .map(
        (section) => `
          <div class="nav-section">
            ${section.title ? `<div class="nav-heading">${escapeHtml(section.title)}</div>` : ""}
            ${section.items
              .map(
                (item) => `
                  <button type="button" class="nav-item ${item.id === state.category ? "active" : ""}" data-category="${escapeHtml(item.id)}">
                    <span>${escapeHtml(item.label)}</span>
                    <b>${escapeHtml(item.count)}</b>
                  </button>
                `
              )
              .join("")}
          </div>
        `
      )
      .join("")}
  `
}

function renderGrid() {
  const templates = filteredTemplates()
  if (!state.catalog) {
    els.grid.innerHTML = ""
    return
  }
  renderTemplateCards(els.grid, templates, "No templates match this view.")
}

function fileStatus(model) {
  if (model.installed) return '<span class="badge ready">Installed</span>'
  if (model.downloadable) return '<span class="badge missing">Missing</span>'
  return '<span class="badge unknown">No URL</span>'
}

function fileActions(template, model, index) {
  const actions = [fileStatus(model)]
  if (model.installed) {
    actions.push(`<button class="danger compact" data-action="delete-model" data-id="${escapeHtml(template.id)}" data-model-index="${index}">${buttonContent("trash", "Delete")}</button>`)
  }
  return `<div class="file-actions">${actions.join("")}</div>`
}

function renderTemplateDetail(target, candidates = state.templates, empty = {}) {
  const template = candidates.find((item) => item.id === state.selectedId)
  if (!template) {
    target.innerHTML = `
      <div class="detail-empty">
        <span class="eyebrow">${escapeHtml(empty.eyebrow || "Selection")}</span>
        <h2>${escapeHtml(empty.title || "No template selected")}</h2>
        <p>${escapeHtml(empty.body || "Choose a template to see required files and destination folders.")}</p>
      </div>
    `
    return
  }

  const missing = template.models.filter((model) => !model.installed && model.downloadable)
  const downloadAction = missing.length
    ? `<button data-action="download-template" data-id="${escapeHtml(template.id)}">${buttonContent("download", "Download missing files")}</button>`
    : ""
  const openUrl = comfyTemplateUrl(template)
  const openClass = missing.length ? "button-link secondary" : "button-link"
  const openAction = openUrl
    ? `<a class="${openClass}" href="${escapeHtml(openUrl)}" data-action="open-comfyui" target="_blank" rel="noopener noreferrer">${buttonContent("external", "Open in ComfyUI")}</a>`
    : `<button class="secondary" disabled>${buttonContent("external", "Open in ComfyUI")}</button>`
  const bookmarked = isBookmarked(template)
  const bookmarkAction = `<button class="secondary" data-action="toggle-bookmark" data-id="${escapeHtml(template.id)}">${buttonContent("bookmark", bookmarked ? "Remove bookmark" : "Bookmark")}</button>`
  const actions = [downloadAction, openAction, bookmarkAction].filter(Boolean).join("")
  const files = template.models.length
    ? template.models
        .map(
          (model, index) => `
            <div class="file-row">
              <div>
                <strong>${escapeHtml(model.name)}</strong>
                <div class="file-meta">${escapeHtml(model.directory || "unknown folder")}</div>
              </div>
              ${fileActions(template, model, index)}
            </div>
          `
        )
        .join("")
    : `<div class="file-row"><div><strong>No local model metadata</strong><div class="file-meta">This template does not declare downloadable files.</div></div><span class="badge ${template.openSource ? "unknown" : "cloud"}">${template.openSource ? "Unknown" : "API"}</span></div>`

  target.innerHTML = `
    <div class="detail-content">
      <div class="detail-hero">${previewMarkup(template, true)}</div>
      <div>
        <h2>${escapeHtml(template.title)}</h2>
      </div>
      <p>${escapeHtml(template.description || "No description in template metadata.")}</p>
      <div class="template-meta">
        <span class="badge ${escapeHtml(template.status)}">${escapeHtml(statusLabel(template.status, template.missingCount))}</span>
        <span>${escapeHtml(template.name)}</span>
        <span>${escapeHtml(formatBytes(template.size))}</span>
        <span>${escapeHtml(template.modelCount)} files</span>
      </div>
      <div class="detail-actions template-actions">${actions}</div>
      <div class="file-list">${files}</div>
    </div>
  `
}

function renderDetail() {
  renderTemplateDetail(els.detail)
}

function setFilesNotice(message, tone = "") {
  els.filesNotice.textContent = message
  els.filesNotice.dataset.tone = tone
}

function fileStatusLabel(node) {
  if (node.kind !== "file") return node.files > 0 ? "-" : "Empty"
  if (node.status === "referenced") {
    return `Referenced${node.references.length ? ` by ${node.references.length}` : ""}`
  }
  if (node.status === "unused") return "Unused"
  if (node.status === "partial") return "Partial"
  return "Other"
}

function fileStatusBadge(node) {
  if (node.kind !== "file") {
    return node.files > 0
      ? '<span class="file-dash">-</span>'
      : '<span class="badge">Empty</span>'
  }
  const klass =
    node.status === "referenced"
      ? "ready"
      : node.status === "unused"
        ? "unknown"
        : node.status === "partial"
          ? "missing"
          : "cloud"
  return `<span class="badge ${klass}">${escapeHtml(fileStatusLabel(node))}</span>`
}

function nodeSearchText(node) {
  return [
    node.name,
    node.directory,
    node.relativePath,
    node.path,
    ...(node.references || []).map((reference) => reference.title)
  ]
    .join(" ")
    .toLowerCase()
}

function filePassesStatus(node) {
  if (state.fileFilter === "all") return true
  if (state.fileFilter === "large") return Boolean(node.large)
  return node.status === state.fileFilter
}

function filteredFileNode(node, term) {
  if (state.fileRoot !== "all" && node.directory !== state.fileRoot) return null
  const matchesSearch = !term || nodeSearchText(node).includes(term)

  if (node.kind === "file") {
    return matchesSearch && filePassesStatus(node) ? node : null
  }

  const children = (node.children || [])
    .map((child) => filteredFileNode(child, term))
    .filter(Boolean)
  if (children.length || (state.fileFilter === "all" && matchesSearch)) {
    return { ...node, children }
  }
  return null
}

function visibleFileNodes() {
  if (!state.files) return []
  const term = state.fileSearch.trim().toLowerCase()
  return state.files.nodes
    .map((node) => filteredFileNode(node, term))
    .filter(Boolean)
}

function flattenFileRows(nodes, depth = 0, rows = []) {
  for (const node of nodes) {
    rows.push({ node, depth })
    if (node.kind !== "file") {
      flattenFileRows(node.children || [], depth + 1, rows)
    }
  }
  return rows
}

function findFileNode(id, nodes = state.files?.nodes || []) {
  for (const node of nodes) {
    if (node.id === id) return node
    const child = findFileNode(id, node.children || [])
    if (child) return child
  }
  return null
}

function collectFileNodes(nodes = state.files?.nodes || [], files = []) {
  for (const node of nodes) {
    if (node.kind === "file") {
      files.push(node)
    } else {
      collectFileNodes(node.children || [], files)
    }
  }
  return files
}

function visibleFileRows() {
  return flattenFileRows(visibleFileNodes())
}

function visibleFileItems() {
  return visibleFileRows()
    .map(({ node }) => node)
    .filter((node) => node.kind === "file")
}

function selectedFileNodes() {
  return collectFileNodes().filter((node) => state.selectedFileIds.has(node.id))
}

function pruneSelectedFiles() {
  const validIds = new Set(collectFileNodes().map((node) => node.id))
  for (const id of state.selectedFileIds) {
    if (!validIds.has(id)) state.selectedFileIds.delete(id)
  }
}

function selectedFileSummary(nodes = selectedFileNodes()) {
  return {
    count: nodes.length,
    size: nodes.reduce((sum, node) => sum + Number(node.size || 0), 0),
    referenced: nodes.filter((node) => node.status === "referenced").length,
    unused: nodes.filter((node) => node.status === "unused").length,
    partial: nodes.filter((node) => node.status === "partial").length,
    other: nodes.filter((node) => node.status === "local").length,
    roots: Array.from(new Set(nodes.map((node) => node.directory))).sort()
  }
}

function fileDeletingMessage(operation = state.fileDeleting) {
  if (!operation) return ""
  const count = Number(operation.count || 0)
  const label = count === 1
    ? `Deleting ${operation.name || "file"}`
    : `Deleting ${count} files`
  const size = Number(operation.size || 0)
  return `${label}${size ? ` (${formatBytes(size)})` : ""}. Waiting for the filesystem...`
}

function renderFileSummary() {
  const stats = state.files?.stats
  if (!stats) {
    els.fileSummary.innerHTML = ""
    return
  }
  els.fileSummary.innerHTML = [
    ["Total storage", formatBytes(stats.totalSize)],
    ["Files", stats.files],
    ["Roots", stats.roots],
    ["Referenced", stats.referenced],
    ["Unused", stats.unused],
    ["Other", stats.local || 0],
    ["Missing refs", stats.missingReferences]
  ]
    .map(
      ([label, value]) => `
        <div class="summary-chip">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `
    )
    .join("")
}

function renderRootFilters() {
  if (!state.files) {
    els.fileRootFilters.innerHTML = ""
    return
  }
  const roots = state.files.roots || []
  if (state.fileRoot !== "all" && !roots.some((root) => root.directory === state.fileRoot)) {
    state.fileRoot = "all"
  }
  els.fileRootFilters.innerHTML = `
    <div class="nav-title">
      <span class="eyebrow">Model Roots</span>
    </div>
    <div class="nav-section">
      <button class="nav-item ${state.fileRoot === "all" ? "active" : ""}" data-file-root="all">
        <span>All roots</span>
        <b>${escapeHtml(roots.length)}</b>
      </button>
      ${roots
        .map(
          (root) => `
            <button class="nav-item ${state.fileRoot === root.directory ? "active" : ""}" data-file-root="${escapeHtml(root.directory)}">
              <span>${escapeHtml(root.directory)}</span>
              <b>${escapeHtml(formatBytes(root.size))}</b>
            </button>
          `
        )
        .join("")}
    </div>
  `
}

function renderFileBulkBar() {
  if (!els.fileBulkBar) return
  els.fileBulkBar.setAttribute("role", "status")
  els.fileBulkBar.setAttribute("aria-live", "polite")
  if (!state.files) {
    els.fileBulkBar.hidden = true
    els.fileBulkBar.classList.remove("is-busy")
    els.fileBulkBar.removeAttribute("aria-busy")
    els.fileBulkBar.innerHTML = ""
    return
  }
  const selected = selectedFileNodes()
  const summary = selectedFileSummary(selected)
  const deleting = state.fileDeleting
  els.fileBulkBar.hidden = false
  els.fileBulkBar.classList.toggle("is-busy", Boolean(deleting))
  els.fileBulkBar.setAttribute("aria-busy", deleting ? "true" : "false")
  if (deleting) {
    els.fileBulkBar.innerHTML = `
      <div class="bulk-copy">
        <strong><span class="inline-spinner" aria-hidden="true"></span>${escapeHtml(fileDeletingMessage(deleting))}</strong>
        <span>ComfyFS is refreshing the model roots after deletion.</span>
      </div>
      <div class="bulk-actions">
        <button class="secondary" disabled>Working</button>
      </div>
      <div class="bulk-progress" aria-hidden="true"></div>
    `
    return
  }
  if (!selected.length) {
    els.fileBulkBar.innerHTML = `
      <div class="bulk-copy">
        <strong>No files selected</strong>
        <span>Use checkboxes to select files for bulk actions. Folders are not deletable.</span>
      </div>
      <div class="bulk-actions">
        <button class="secondary" data-bulk-action="select-visible">Select visible</button>
        <button class="secondary" data-bulk-action="select-unused">Select unused</button>
        <button class="secondary" data-bulk-action="select-partial">Select partial</button>
      </div>
    `
    return
  }

  els.fileBulkBar.innerHTML = `
    <div class="bulk-copy">
      <strong>${escapeHtml(summary.count)} file${summary.count === 1 ? "" : "s"} selected</strong>
      <span>${escapeHtml(formatBytes(summary.size))} across ${escapeHtml(summary.roots.join(", ") || "model roots")}${summary.referenced ? ` - ${escapeHtml(summary.referenced)} referenced` : ""}</span>
    </div>
    <div class="bulk-actions">
      <button class="secondary" data-bulk-action="select-visible">Select visible</button>
      <button class="secondary" data-bulk-action="select-unused">Select unused</button>
      <button class="secondary" data-bulk-action="select-partial">Select partial</button>
      <button class="secondary" data-bulk-action="clear-selection">Clear</button>
      <button class="danger" data-bulk-action="delete-selected" ${state.bulkDeleting ? "disabled" : ""}>${state.bulkDeleting ? "Deleting..." : "Delete selected"}</button>
    </div>
  `
}

function renderFileTree() {
  if (!state.files) {
    els.fileTree.innerHTML = ""
    return
  }

  const rows = visibleFileRows()
  if (!rows.length) {
    els.fileTree.innerHTML = `<div class="empty-grid">No model files match this view.</div>`
    return
  }

  els.fileTree.innerHTML = `
    <div class="file-tree-table">
      <div class="file-tree-head">
        <span></span>
        <span>Name</span>
        <span>Size</span>
        <span>Modified</span>
        <span>Status</span>
      </div>
      ${rows
        .map(({ node, depth }) => {
          const selected = node.id === state.selectedFileId
          const checked = state.selectedFileIds.has(node.id)
          const icon = node.kind === "file" ? "file" : "dir"
          const meta =
            node.kind === "file"
              ? node.relativePath
              : node.kind === "root"
                ? node.path
                : node.relativePath
          return `
            <div class="file-tree-row ${selected ? "selected" : ""} ${checked ? "bulk-selected" : ""}" data-file-id="${escapeHtml(node.id)}" role="button" tabindex="0" style="--depth: ${depth}">
              ${
                node.kind === "file"
                  ? `<label class="file-select" aria-label="Select ${escapeHtml(node.name)}"><input type="checkbox" data-file-select="${escapeHtml(node.id)}" ${checked ? "checked" : ""} ${state.fileDeleting ? "disabled" : ""} /><span></span></label>`
                  : '<span class="file-select-spacer" aria-hidden="true"></span>'
              }
              <span class="file-name">
                <span class="file-icon">${icon}</span>
                <span>
                  <strong>${escapeHtml(node.name)}</strong>
                  <small>${escapeHtml(meta || node.directory)}</small>
                </span>
              </span>
              <span>${escapeHtml(formatBytes(node.size))}</span>
              <span>${escapeHtml(formatDate(node.modified))}</span>
              <span>${fileStatusBadge(node)}</span>
            </div>
          `
        })
        .join("")}
    </div>
  `
}

function renderFileDetail() {
  const node = findFileNode(state.selectedFileId)
  if (!node) {
    els.fileDetail.innerHTML = `
      <div class="detail-empty">
        <span class="eyebrow">Selection</span>
        <h2>No file selected</h2>
        <p>Choose a file to see size, path, and template references.</p>
      </div>
    `
    return
  }

  const references = (node.references || [])
    .map(
      (reference) => `
        <div class="reference-row">
          <strong>${escapeHtml(reference.title)}</strong>
          <span class="badge ready">Uses this file</span>
        </div>
      `
    )
    .join("")

  els.fileDetail.innerHTML = `
    <div class="detail-content">
      <div>
        <span class="eyebrow">${escapeHtml(node.kind)}</span>
        <h2>${escapeHtml(node.name)}</h2>
      </div>
      <div class="info-list">
        <div>
          <span>Path</span>
          <strong>${escapeHtml(node.path)}</strong>
        </div>
        <div>
          <span>Size</span>
          <strong>${escapeHtml(formatBytes(node.size))}</strong>
        </div>
        <div>
          <span>Modified</span>
          <strong>${escapeHtml(formatDate(node.modified))}</strong>
        </div>
        <div>
          <span>Model root</span>
          <strong>${escapeHtml(node.directory)}</strong>
        </div>
      </div>
      <div class="detail-actions">
        <button class="secondary" data-file-action="open-path" data-file-id="${escapeHtml(node.id)}" ${state.fileDeleting ? "disabled" : ""}>${buttonContent(node.kind === "file" ? "file" : "folder", node.kind === "file" ? "Reveal file" : "Open folder")}</button>
        ${
          node.kind !== "file" && collectFileNodes([node]).length
            ? `<button class="secondary" data-file-action="select-descendants" data-file-id="${escapeHtml(node.id)}" ${state.fileDeleting ? "disabled" : ""}>${buttonContent("listCheck", "Select files in folder")}</button>`
            : ""
        }
        ${
          node.kind === "file"
            ? `<button class="danger" data-file-action="delete-file" data-file-id="${escapeHtml(node.id)}" ${state.fileDeleting ? "disabled" : ""}>${buttonContent("trash", "Delete file")}</button>`
            : ""
        }
      </div>
      <div class="reference-list">
        <div class="template-title">
          <span class="eyebrow">Template references</span>
          <span class="badge">${escapeHtml((node.references || []).length)}</span>
        </div>
        ${references || '<div class="file-meta">No current template references.</div>'}
      </div>
    </div>
  `
}

function renderFiles() {
  if (state.view !== "files") return
  if (state.files) pruneSelectedFiles()
  renderFileSummary()
  renderRootFilters()
  renderFileBulkBar()
  renderFileTree()
  renderFileDetail()
  if (state.fileDeleting) {
    setFilesNotice(fileDeletingMessage(), "")
  } else if (state.filesLoading) {
    setFilesNotice("Scanning model roots and calculating file sizes...")
  } else if (state.files) {
    setFilesNotice(`${state.files.stats.files} files across ${state.files.stats.roots} model roots. ${formatBytes(state.files.stats.totalSize)} total.`)
  }
}

function renderBookmarks() {
  if (state.view !== "bookmarks") return

  if (state.bookmarksLoading) {
    setBookmarksNotice("Loading bookmarks...")
  } else if (!state.catalog) {
    setBookmarksNotice("Connect to ComfyUI to view bookmarked workflows.")
    els.bookmarksGrid.innerHTML = ""
    renderTemplateDetail(els.bookmarksDetail, [], {
      eyebrow: "Bookmarks",
      title: "No workflow selected",
      body: "Connect to ComfyUI, then choose a bookmarked workflow."
    })
    return
  }

  const templates = bookmarkedTemplates()
  const bookmarkCount = state.bookmarks.length
  if (state.selectedId && !templates.some((template) => template.id === state.selectedId)) {
    state.selectedId = ""
  }

  if (!bookmarkCount) {
    setBookmarksNotice("Bookmark workflows from the template detail panel.")
    renderTemplateCards(els.bookmarksGrid, [], "No bookmarks yet.")
  } else if (!templates.length) {
    setBookmarksNotice(`${bookmarkCount} saved bookmark${bookmarkCount === 1 ? "" : "s"} not found in the current template catalog.`, "error")
    renderTemplateCards(els.bookmarksGrid, [], "No bookmarked workflows are available in this catalog.")
  } else {
    setBookmarksNotice(`${templates.length} bookmarked workflow${templates.length === 1 ? "" : "s"} loaded from the local bookmark file.`)
    renderTemplateCards(els.bookmarksGrid, templates, "No bookmarked workflows are available.")
  }

  renderTemplateDetail(els.bookmarksDetail, templates, {
    eyebrow: "Bookmarks",
    title: "No bookmark selected",
    body: "Choose a bookmarked workflow to open it in ComfyUI or manage its required files."
  })
}

function renderJobs() {
  const jobs = Array.from(state.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  els.jobs.hidden = jobs.length === 0
  if (!jobs.length) return
  els.jobsTitle.textContent = `${jobs.length} download${jobs.length === 1 ? "" : "s"}`
  els.jobsList.innerHTML = jobs
    .map((job) => {
      const downloaded = job.items.reduce((sum, item) => sum + Number(item.downloaded || 0), 0)
      const total = job.items.reduce((sum, item) => sum + Number(item.total || 0), 0)
      const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : Math.round((job.completed / job.total) * 100)
      const current = job.items.find((item) => item.status === "downloading") || job.items[job.completed] || job.items.at(-1)
      return `
        <div class="job">
          <div class="template-title">
            <strong>${escapeHtml(job.status)}</strong>
            <span class="file-meta">${job.completed}/${job.total} files</span>
          </div>
          <div class="progress" aria-label="Download progress"><span style="width: ${percent}%"></span></div>
          <div class="file-meta">${escapeHtml(current?.name || "Waiting")} - ${escapeHtml(formatBytes(downloaded))}${total ? ` / ${escapeHtml(formatBytes(total))}` : ""}</div>
          ${current?.destination ? `<div class="path">${escapeHtml(current.destination)}</div>` : ""}
        </div>
      `
    })
    .join("")
}

function renderAll() {
  els.templatesView.hidden = state.view !== "templates"
  els.bookmarksView.hidden = state.view !== "bookmarks"
  els.filesView.hidden = state.view !== "files"
  els.viewTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view)
  })
  renderStats()
  renderNav()
  renderGrid()
  renderDetail()
  renderBookmarks()
  renderFiles()
  renderJobs()
}

async function loadBookmarks() {
  state.bookmarksLoading = true
  if (state.view === "bookmarks") renderBookmarks()
  try {
    const data = await requestJson("/api/bookmarks")
    state.bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : []
  } catch (error) {
    state.bookmarks = []
    setBookmarksNotice(error.message, "error")
  } finally {
    state.bookmarksLoading = false
    renderAll()
  }
}

async function refreshCurrentView() {
  if (state.view === "bookmarks") {
    els.refresh.disabled = true
    try {
      await loadBookmarks()
    } finally {
      els.refresh.disabled = false
    }
    return
  }
  await connect(state.baseUrl || els.baseUrl.value, true)
}

async function loadFiles(force = false) {
  if (!state.baseUrl) return
  state.filesLoading = true
  renderFiles()
  try {
    const files = await requestJson(`/api/files?baseUrl=${encodeURIComponent(state.baseUrl)}${force ? "&refresh=1" : ""}`)
    state.files = files
    pruneSelectedFiles()
    if (state.selectedFileId && !findFileNode(state.selectedFileId, files.nodes)) {
      state.selectedFileId = ""
    }
  } catch (error) {
    state.files = null
    state.selectedFileId = ""
    setFilesNotice(error.message, "error")
  } finally {
    state.filesLoading = false
    renderFiles()
  }
}

async function connect(baseUrl, force = false) {
  const nextBaseUrl = baseUrl.replace(/\/+$/, "")
  if (state.baseUrl !== nextBaseUrl) {
    state.files = null
    state.selectedFileId = ""
    state.selectedFileIds.clear()
  }
  state.baseUrl = nextBaseUrl
  els.baseUrl.value = state.baseUrl
  setNotice("Loading templates and checking installed model folders...")
  if (els.connectionDot) {
    els.connectionDot.dataset.state = "loading"
    els.connectionDot.title = "Checking connection"
  }
  els.refresh.disabled = true
  try {
    const catalog = await requestJson(`/api/templates?baseUrl=${encodeURIComponent(state.baseUrl)}${force ? "&refresh=1" : ""}`)
    state.catalog = catalog
    state.templates = catalog.templates
    if (state.selectedId && !state.templates.some((template) => template.id === state.selectedId)) {
      state.selectedId = ""
    }
    if (!navigationIds().has(state.category)) state.category = "all"
    if (state.view === "files") await loadFiles(force)
    setNotice(`${catalog.stats.total} templates loaded from ${state.baseUrl}. ${catalog.stats.missingFiles} missing file references found.`)
  } catch (error) {
    state.catalog = null
    state.templates = []
    setNotice(error.message, "error")
  } finally {
    els.refresh.disabled = false
    renderAll()
  }
}

async function selectView(view) {
  state.view = view
  if (view === "bookmarks" && state.selectedId) {
    const ids = new Set(bookmarkedTemplates().map((template) => template.id))
    if (!ids.has(state.selectedId)) state.selectedId = ""
  }
  renderAll()
  if (view === "files" && !state.files && state.baseUrl) {
    await loadFiles()
  }
}

async function startDownload(template) {
  const models = template.models.filter((model) => !model.installed && model.downloadable)
  if (!models.length) return
  const job = await requestJson("/api/download", {
    method: "POST",
    body: JSON.stringify({ baseUrl: state.baseUrl, templateId: template.id, models })
  })
  state.jobs.set(job.id, job)
  pollJob(job.id)
  renderJobs()
}

async function toggleBookmark(template) {
  const removing = isBookmarked(template)
  const result = await requestJson("/api/bookmarks", {
    method: removing ? "DELETE" : "POST",
    body: JSON.stringify({
      template: {
        id: template.id,
        name: template.name,
        title: template.title,
        sourceModule: template.sourceModule || "default"
      }
    })
  })
  state.bookmarks = Array.isArray(result.bookmarks) ? result.bookmarks : []
  if (removing && state.view === "bookmarks" && state.selectedId === template.id) {
    state.selectedId = ""
  }
  renderAll()
  const message = removing ? `Removed ${template.title} from bookmarks.` : `Bookmarked ${template.title}.`
  if (state.view === "bookmarks") {
    setBookmarksNotice(message)
  } else {
    setNotice(message)
  }
}

async function deleteModel(template, model) {
  if (!model?.installed) return
  const ok = window.confirm(`Delete ${model.name} from ${model.directory}?`)
  if (!ok) return

  const result = await requestJson("/api/delete", {
    method: "POST",
    body: JSON.stringify({ baseUrl: state.baseUrl, model })
  })
  applyDeletedModel(result)
  renderAll()
  setNotice(result.deleted ? `Deleted ${result.name}.` : `${result.name} was already missing.`)
}

async function deleteFileNode(node) {
  if (!node || node.kind !== "file") return
  const ok = window.confirm(`Delete ${node.name} from ${node.directory}?`)
  if (!ok) return

  let message = ""
  let tone = ""
  state.fileDeleting = {
    count: 1,
    size: Number(node.size || 0),
    name: node.name
  }
  renderFiles()
  await waitForPaint()
  try {
    const result = await requestJson("/api/delete-file", {
      method: "POST",
      body: JSON.stringify({ baseUrl: state.baseUrl, path: node.path })
    })
    state.selectedFileIds.delete(node.id)
    state.selectedFileId = ""
    await connect(state.baseUrl, true)
    message = result.deleted ? `Deleted ${result.name}.` : `${result.name} was already missing.`
  } catch (error) {
    message = error.message
    tone = "error"
  } finally {
    state.fileDeleting = null
    renderFiles()
    if (message) setFilesNotice(message, tone)
  }
}

async function openFileNode(node) {
  if (!node) return
  const result = await requestJson("/api/open-path", {
    method: "POST",
    body: JSON.stringify({ baseUrl: state.baseUrl, path: node.path })
  })
  setFilesNotice(result.directory ? `Opened ${node.name}.` : `Revealed ${node.name}.`)
}

function selectFileNodes(nodes, mode = "add") {
  if (mode === "replace") state.selectedFileIds.clear()
  for (const node of nodes) {
    if (node.kind === "file") state.selectedFileIds.add(node.id)
  }
  renderFiles()
}

function selectFilesByStatus(status) {
  selectFileNodes(collectFileNodes().filter((node) => node.status === status), "replace")
}

function confirmBulkDelete(nodes) {
  const summary = selectedFileSummary(nodes)
  const preview = nodes
    .slice(0, 6)
    .map((node) => `- ${node.directory}/${node.relativePath}`)
    .join("\n")
  const extra = nodes.length > 6 ? `\n- ...and ${nodes.length - 6} more` : ""
  const warning = summary.referenced
    ? `\n${summary.referenced} selected file${summary.referenced === 1 ? " is" : "s are"} referenced by templates.`
    : ""
  return window.confirm(
    `Delete ${summary.count} selected file${summary.count === 1 ? "" : "s"} (${formatBytes(summary.size)})?${warning}\n\nFolders will not be deleted.\n\n${preview}${extra}`
  )
}

async function deleteSelectedFiles() {
  const nodes = selectedFileNodes()
  if (!nodes.length || state.bulkDeleting || state.fileDeleting) return
  if (!confirmBulkDelete(nodes)) return

  const summary = selectedFileSummary(nodes)
  let message = ""
  let tone = ""
  state.bulkDeleting = true
  state.fileDeleting = {
    count: summary.count,
    size: summary.size,
    name: ""
  }
  renderFiles()
  await waitForPaint()
  try {
    const result = await requestJson("/api/delete-files", {
      method: "POST",
      body: JSON.stringify({
        baseUrl: state.baseUrl,
        paths: nodes.map((node) => node.path)
      })
    })
    state.selectedFileIds.clear()
    state.selectedFileId = ""
    await connect(state.baseUrl, true)
    const issueText = result.errors.length ? ` ${result.errors.length} failed.` : ""
    message = `Deleted ${result.deleted} file${result.deleted === 1 ? "" : "s"}.${issueText}`
    tone = result.errors.length ? "error" : ""
  } catch (error) {
    message = error.message
    tone = "error"
  } finally {
    state.bulkDeleting = false
    state.fileDeleting = null
    renderFiles()
    if (message) setFilesNotice(message, tone)
  }
}

function pollJob(id) {
  if (state.polling.has(id)) return
  const timer = setInterval(async () => {
    try {
      const job = await requestJson(`/api/jobs/${id}`)
      state.jobs.set(id, job)
      if (applyCompletedDownloads(job)) {
        renderAll()
      } else {
        renderJobs()
      }
      if (!["queued", "running"].includes(job.status)) {
        clearInterval(timer)
        state.polling.delete(id)
        await connect(state.baseUrl, true)
      }
    } catch {
      clearInterval(timer)
      state.polling.delete(id)
    }
  }, 1000)
  state.polling.set(id, timer)
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault()
  connect(els.baseUrl.value)
})

els.themeLight.addEventListener("click", () => applyTheme("light"))
els.themeDark.addEventListener("click", () => applyTheme("dark"))

els.refresh.addEventListener("click", refreshCurrentView)
els.search.addEventListener("input", (event) => {
  state.search = event.target.value
  renderNav()
  renderGrid()
})

els.viewTabs.forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view))
})

els.nav.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-category]")
  if (!button) return
  state.category = button.dataset.category
  renderAll()
})

els.fileSearch.addEventListener("input", (event) => {
  state.fileSearch = event.target.value
  renderFiles()
})

els.fileRootFilters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-file-root]")
  if (!button) return
  state.fileRoot = button.dataset.fileRoot
  renderFiles()
})

els.fileStatusFilters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-file-filter]")
  if (!button) return
  els.fileStatusFilters.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"))
  button.classList.add("active")
  state.fileFilter = button.dataset.fileFilter
  renderFiles()
})

els.fileBulkBar.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-bulk-action]")
  if (!button) return
  if (state.fileDeleting) return

  if (button.dataset.bulkAction === "select-visible") {
    selectFileNodes(visibleFileItems(), "replace")
  }
  if (button.dataset.bulkAction === "select-unused") {
    selectFilesByStatus("unused")
  }
  if (button.dataset.bulkAction === "select-partial") {
    selectFilesByStatus("partial")
  }
  if (button.dataset.bulkAction === "clear-selection") {
    state.selectedFileIds.clear()
    renderFiles()
  }
  if (button.dataset.bulkAction === "delete-selected") {
    await deleteSelectedFiles()
  }
})

els.fileTree.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[data-file-select]")
  if (!checkbox) return
  if (state.fileDeleting) {
    checkbox.checked = state.selectedFileIds.has(checkbox.dataset.fileSelect)
    return
  }
  const node = findFileNode(checkbox.dataset.fileSelect)
  if (!node || node.kind !== "file") return
  if (checkbox.checked) {
    state.selectedFileIds.add(node.id)
  } else {
    state.selectedFileIds.delete(node.id)
  }
  renderFiles()
})

els.fileTree.addEventListener("click", (event) => {
  if (event.target.closest(".file-select")) return
  const row = event.target.closest(".file-tree-row[data-file-id]")
  if (!row) return
  state.selectedFileId = row.dataset.fileId
  renderFiles()
})

els.fileTree.addEventListener("keydown", (event) => {
  if (event.target.closest(".file-select")) return
  if (!["Enter", " "].includes(event.key)) return
  const row = event.target.closest(".file-tree-row[data-file-id]")
  if (!row) return
  event.preventDefault()
  state.selectedFileId = row.dataset.fileId
  renderFiles()
})

els.fileDetail.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-file-action]")
  if (!button) return
  if (state.fileDeleting) return
  const node = findFileNode(button.dataset.fileId)
  if (!node) return
  if (button.dataset.fileAction === "delete-file") {
    button.disabled = true
    try {
      await deleteFileNode(node)
    } catch (error) {
      setFilesNotice(error.message, "error")
    } finally {
      button.disabled = false
    }
  }
  if (button.dataset.fileAction === "select-descendants") {
    selectFileNodes(collectFileNodes([node]), "replace")
  }
  if (button.dataset.fileAction === "open-path") {
    button.disabled = true
    try {
      await openFileNode(node)
    } catch (error) {
      setFilesNotice(error.message, "error")
    } finally {
      button.disabled = false
    }
  }
})

document.querySelectorAll(".filter[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter[data-filter]").forEach((item) => item.classList.remove("active"))
    button.classList.add("active")
    state.filter = button.dataset.filter
    renderNav()
    renderGrid()
  })
})

document.addEventListener("click", async (event) => {
  const comfyLink = event.target.closest('a[data-action="open-comfyui"]')
  if (comfyLink) {
    event.preventDefault()
    window.open(comfyLink.href, "_blank", "browser")
    return
  }

  const button = event.target.closest("button[data-action]")
  if (!button) {
    const card = event.target.closest(".template-card[data-id]")
    if (!card) return
    const template = state.templates.find((item) => item.id === card.dataset.id)
    if (!template) return
    state.selectedId = template.id
    renderAll()
    return
  }

  const template = state.templates.find((item) => item.id === button.dataset.id)
  if (!template) return
  if (button.dataset.action === "download-template") {
    button.disabled = true
    try {
      await startDownload(template)
    } catch (error) {
      setNotice(error.message, "error")
    } finally {
      button.disabled = false
    }
  }
  if (button.dataset.action === "toggle-bookmark") {
    button.disabled = true
    try {
      await toggleBookmark(template)
    } catch (error) {
      if (state.view === "bookmarks") {
        setBookmarksNotice(error.message, "error")
      } else {
        setNotice(error.message, "error")
      }
    } finally {
      button.disabled = false
    }
  }
  if (button.dataset.action === "delete-model") {
    const model = template.models[Number(button.dataset.modelIndex)]
    if (!model) return
    button.disabled = true
    try {
      await deleteModel(template, model)
    } catch (error) {
      setNotice(error.message, "error")
    } finally {
      button.disabled = false
    }
  }
})

document.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return
  const card = event.target.closest(".template-card[data-id]")
  if (!card) return
  event.preventDefault()
  const template = state.templates.find((item) => item.id === card.dataset.id)
  if (!template) return
  state.selectedId = template.id
  renderAll()
})

applyTheme(state.theme, false)
loadBookmarks()
connect(els.baseUrl.value)
