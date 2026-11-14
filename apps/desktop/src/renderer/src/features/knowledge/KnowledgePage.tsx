import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  Database,
  FileText,
  Link2,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { cn } from '@renderer/lib/utils'
import { useKnowledgeStore } from '@renderer/stores/knowledgeStore'
import { useSessionStore } from '@renderer/stores/sessionStore'

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' })

/**
 * 知识库页：左侧知识库列表，右侧导入与检索。
 * 数据全部来自服务端 SQLite 的真实导入文档；检索结果是原文片段。
 */
export default function KnowledgePage(): React.JSX.Element {
  const { t } = useTranslation()
  const userId = useSessionStore((s) => s.userId)
  const bases = useKnowledgeStore((s) => s.bases)
  const totals = useKnowledgeStore((s) => s.totals)
  const activeId = useKnowledgeStore((s) => s.activeId)
  const docs = useKnowledgeStore((s) => s.docs)
  const hits = useKnowledgeStore((s) => s.hits)
  const loading = useKnowledgeStore((s) => s.loading)
  const load = useKnowledgeStore((s) => s.load)
  const select = useKnowledgeStore((s) => s.select)
  const create = useKnowledgeStore((s) => s.create)
  const remove = useKnowledgeStore((s) => s.remove)
  const importText = useKnowledgeStore((s) => s.importText)
  const importFile = useKnowledgeStore((s) => s.importFile)
  const importUrl = useKnowledgeStore((s) => s.importUrl)
  const removeDoc = useKnowledgeStore((s) => s.removeDoc)
  const search = useKnowledgeStore((s) => s.search)
  const clearHits = useKnowledgeStore((s) => s.clearHits)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [importMode, setImportMode] = useState<'text' | 'url' | null>(null)
  const [docName, setDocName] = useState('')
  const [docContent, setDocContent] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [confirmBaseId, setConfirmBaseId] = useState<string | null>(null)
  const [confirmDocId, setConfirmDocId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!userId) return
    void load(userId)
  }, [userId, load])

  // 搜索 350ms 防抖：输入过程中不逐字请求
  useEffect(() => {
    if (!userId || !activeId) return
    const timer = window.setTimeout(() => {
      void search(userId, activeId, query)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [query, userId, activeId, search])

  const active = bases.find((base) => base.id === activeId) ?? null

  if (!userId) {
    return (
      <div className="grid h-full place-items-center">
        <p className="text-[13px] text-muted-foreground">{t('knowledge.loginRequired')}</p>
      </div>
    )
  }

  async function handleCreate(): Promise<void> {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      await create(userId!, name, newDesc.trim())
      setNewName('')
      setNewDesc('')
      setCreating(false)
      toast.success(t('knowledge.create'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleDeleteBase(id: string): Promise<void> {
    if (confirmBaseId !== id) {
      setConfirmBaseId(id)
      window.setTimeout(() => setConfirmBaseId((current) => (current === id ? null : current)), 3000)
      return
    }
    setBusy(true)
    try {
      await remove(userId!, id)
      setConfirmBaseId(null)
      toast.success(t('knowledge.deleted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleImportText(): Promise<void> {
    if (!activeId || !docContent.trim()) return
    setBusy(true)
    try {
      await importText(userId!, activeId, docName.trim() || t('knowledge.docName'), docContent)
      setDocName('')
      setDocContent('')
      setImportMode(null)
      toast.success(t('knowledge.imported'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleImportUrl(): Promise<void> {
    if (!activeId || !url.trim()) return
    setBusy(true)
    try {
      await importUrl(userId!, activeId, url.trim())
      setUrl('')
      setImportMode(null)
      toast.success(t('knowledge.imported'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleFile(file: File | undefined): Promise<void> {
    if (!activeId || !file) return
    setBusy(true)
    try {
      await importFile(userId!, activeId, file)
      toast.success(t('knowledge.imported'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleDeleteDoc(docId: string): Promise<void> {
    if (!activeId) return
    if (confirmDocId !== docId) {
      setConfirmDocId(docId)
      window.setTimeout(() => setConfirmDocId((current) => (current === docId ? null : current)), 3000)
      return
    }
    setBusy(true)
    try {
      await removeDoc(userId!, activeId, docId)
      setConfirmDocId(null)
      toast.success(t('knowledge.deleted'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1240px] px-6 py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
              <BookOpen className="size-5 text-primary" strokeWidth={1.8} />
              {t('knowledge.title')}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
              {t('knowledge.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <FileText className="size-3.5" />
              {t('knowledge.docCount', { count: totals.docs })}
            </span>
            <span className="inline-flex items-center gap-1">
              <Database className="size-3.5" />
              {t('knowledge.chunkCount', { count: totals.chunks })}
            </span>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* 左：知识库列表 + 新建 */}
          <section className="rounded-xl border border-border bg-surface p-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-[12.5px] font-medium text-muted-foreground">
                {t('knowledge.bases')}
              </span>
              <Button
                data-testid="kb-new"
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => setCreating((value) => !value)}
              >
                <Plus className="size-3.5" />
                {t('knowledge.create')}
              </Button>
            </div>

            {creating && (
              <div className="mt-2 space-y-2 rounded-[10px] border border-border bg-surface-soft p-2.5">
                <Input
                  data-testid="kb-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('knowledge.namePlaceholder')}
                  className="h-8 text-[13px]"
                />
                <Input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder={t('knowledge.descPlaceholder')}
                  className="h-8 text-[13px]"
                />
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    data-testid="kb-create"
                    size="sm"
                    disabled={busy || !newName.trim()}
                    onClick={() => void handleCreate()}
                  >
                    {t('knowledge.create')}
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-2 space-y-1">
              {bases.map((base) => (
                <div
                  key={base.id}
                  data-testid="kb-item"
                  onClick={() => void select(userId, base.id)}
                  className={cn(
                    'group cursor-pointer rounded-[10px] border px-3 py-2 transition-colors',
                    base.id === activeId
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-transparent hover:bg-surface-soft'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                      {base.name}
                    </span>
                    <button
                      type="button"
                      title={t('knowledge.deleteBase')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDeleteBase(base.id)
                      }}
                      className={cn(
                        'shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive',
                        confirmBaseId === base.id
                          ? 'text-destructive'
                          : 'hidden group-hover:inline-flex'
                      )}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    <span>{t('knowledge.docCount', { count: base.docCount })}</span>
                    <span>·</span>
                    <span>{t('knowledge.chunkCount', { count: base.chunkCount })}</span>
                  </div>
                  {base.description && (
                    <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
                      {base.description}
                    </p>
                  )}
                </div>
              ))}
              {bases.length === 0 && !loading && (
                <div className="px-2 py-8 text-center">
                  <p className="text-[13px] text-muted-foreground">{t('knowledge.empty')}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                    {t('knowledge.emptyHint')}
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* 右：当前知识库 */}
          <section className="min-w-0 rounded-xl border border-border bg-surface p-4">
            {!active ? (
              <div className="grid h-[320px] place-items-center">
                <p className="text-[13px] text-muted-foreground">{t('knowledge.emptyHint')}</p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[16px] font-semibold">{active.name}</h2>
                  <Badge variant="outline" className="text-[10.5px]">
                    {t('knowledge.docCount', { count: active.docCount })}
                  </Badge>
                  <span className="flex-1" />
                  <div className="flex items-center gap-1.5">
                    <Button
                      data-testid="kb-import-text"
                      size="sm"
                      variant="outline"
                      onClick={() => setImportMode(importMode === 'text' ? null : 'text')}
                    >
                      <FileText className="size-3.5" />
                      {t('knowledge.importText')}
                    </Button>
                    <Button
                      data-testid="kb-import-file"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => fileRef.current?.click()}
                    >
                      <Upload className="size-3.5" />
                      {t('knowledge.importFile')}
                    </Button>
                    <Button
                      data-testid="kb-import-url"
                      size="sm"
                      variant="outline"
                      onClick={() => setImportMode(importMode === 'url' ? null : 'url')}
                    >
                      <Link2 className="size-3.5" />
                      {t('knowledge.importUrl')}
                    </Button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".txt,.md,.markdown,.json,.csv,.log,.yaml,.yml,text/*"
                      className="hidden"
                      onChange={(e) => void handleFile(e.target.files?.[0])}
                    />
                  </div>
                </div>

                {importMode === 'text' && (
                  <div className="mt-3 space-y-2 rounded-[10px] border border-border bg-surface-soft p-3">
                    <Input
                      value={docName}
                      onChange={(e) => setDocName(e.target.value)}
                      placeholder={t('knowledge.docNamePlaceholder')}
                      className="h-8 text-[13px]"
                    />
                    <Textarea
                      data-testid="kb-doc-content"
                      rows={8}
                      value={docContent}
                      onChange={(e) => setDocContent(e.target.value)}
                      placeholder={t('knowledge.docContentPlaceholder')}
                      className="min-h-[140px] resize-y text-[13px]"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-[11.5px] text-muted-foreground">
                        {t('knowledge.uploadHint')}
                      </span>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setImportMode(null)}>
                          {t('common.cancel')}
                        </Button>
                        <Button
                          data-testid="kb-doc-import"
                          size="sm"
                          disabled={busy || !docContent.trim()}
                          onClick={() => void handleImportText()}
                        >
                          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                          {t('knowledge.import')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {importMode === 'url' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface-soft p-3">
                    <Input
                      data-testid="kb-url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder={t('knowledge.urlPlaceholder')}
                      className="h-8 min-w-[240px] flex-1 text-[13px]"
                    />
                    <Button
                      data-testid="kb-url-import"
                      size="sm"
                      disabled={busy || !url.trim()}
                      onClick={() => void handleImportUrl()}
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      {t('knowledge.import')}
                    </Button>
                  </div>
                )}

                {/* 检索 */}
                <div className="mt-4 flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 focus-within:border-primary">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" />
                  <Input
                    data-testid="kb-search"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      if (!e.target.value) clearHits()
                    }}
                    placeholder={t('knowledge.searchPlaceholder')}
                    className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] shadow-none focus-visible:ring-0"
                  />
                  {query && (
                    <button
                      type="button"
                      aria-label={t('common.cancel')}
                      onClick={() => {
                        setQuery('')
                        clearHits()
                      }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>

                {query.trim() ? (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                      <span>{t('knowledge.searchResults')}</span>
                      <span>·</span>
                      <span>{t('knowledge.searchHint')}</span>
                    </div>
                    {hits.map((hit) => (
                      <article
                        key={hit.chunkId}
                        data-testid="kb-hit"
                        className="rounded-[10px] border border-border bg-surface-soft p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                          <Badge variant="outline" className="text-[10.5px]">
                            {hit.docName}
                          </Badge>
                          <span>score {hit.score}</span>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                          {hit.content}
                        </p>
                      </article>
                    ))}
                    {hits.length === 0 && (
                      <p className="py-6 text-center text-[12.5px] text-muted-foreground">
                        {t('knowledge.searchEmpty')}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mt-3">
                    {docs.length === 0 ? (
                      <p className="py-10 text-center text-[13px] text-muted-foreground">
                        {t('knowledge.noDocs')}
                      </p>
                    ) : (
                      <div className="overflow-hidden rounded-[10px] border border-border">
                        {docs.map((doc) => (
                          <div
                            key={doc.id}
                            data-testid="kb-doc"
                            className="group flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                          >
                            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-[13px]">{doc.name}</span>
                            <span className="shrink-0 text-[11.5px] text-muted-foreground">
                              {t('knowledge.docChars', { count: doc.chars })} ·{' '}
                              {t('knowledge.docChunks', { count: doc.chunks })}
                            </span>
                            <span className="hidden shrink-0 text-[11px] text-muted-foreground lg:inline">
                              {dateFormatter.format(doc.createdAt)}
                            </span>
                            <button
                              type="button"
                              title={t('common.delete')}
                              onClick={() => void handleDeleteDoc(doc.id)}
                              className={cn(
                                'shrink-0 rounded p-1 text-muted-foreground hover:text-destructive',
                                confirmDocId === doc.id
                                  ? 'text-destructive'
                                  : 'hidden group-hover:inline-flex'
                              )}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
