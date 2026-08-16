import * as React from 'react'
import { useState } from 'react'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Channel } from '@pi-amadeus/shared'
import { Input } from '@renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { HistorySessionList } from './HistorySessionList'
import { StatsStrip } from './StatsStrip'

type ChannelFilter = 'all' | Channel

/** 会话历史页：统计条 + 搜索 + 渠道筛选 + 按天分组列表 */
export default function HistoryPage(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const [query, setQuery] = useState('')
  const [channel, setChannel] = useState<ChannelFilter>('all')

  const keyword = query.trim().toLowerCase()
  const filtered = sessions.filter(
    (s) => (channel === 'all' || s.channel === channel) && s.title.toLowerCase().includes(keyword)
  )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-5">
        <h1 className="text-sm font-semibold">{t('history.title')}</h1>
      </header>
      <div className="shrink-0 px-5 pt-5">
        <StatsStrip />
      </div>
      <div className="flex shrink-0 items-center gap-3 px-5 pb-4 pt-4">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('history.searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <Select value={channel} onValueChange={(v) => setChannel(v as ChannelFilter)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('history.filterAll')}</SelectItem>
            <SelectItem value="desktop">{t('channels.desktop')}</SelectItem>
            <SelectItem value="feishu">{t('channels.feishu')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <HistorySessionList sessions={filtered} />
      </div>
    </div>
  )
}
