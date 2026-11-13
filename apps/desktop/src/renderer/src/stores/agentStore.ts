import { create } from 'zustand'
import type { AgentOverview, AgentProfile, AgentProfileInput, AgentTask, AgentTaskInput } from '@pi-amadeus/shared'
import {
  AgentApiError,
  createAgentTask,
  deleteAgentProfile,
  fetchAgentOverview,
  fetchAgentTask,
  runAgentTaskAction,
  saveAgentProfile,
  subscribeAgentEvents,
  updateAgentTaskPosition,
  type AgentTaskActionInput
} from '@renderer/lib/agentApi'

type Connection = 'offline' | 'connecting' | 'live' | 'reconnecting'
interface AgentState extends AgentOverview {
  userId: string | null
  loading: boolean
  loaded: boolean
  error: string | null
  connection: Connection
  cursor: number
  selectedId: string | null
  busyTasks: Record<string, boolean>
  connect: (userId: string) => () => void
  refresh: () => Promise<void>
  selectTask: (id: string | null) => void
  createTask: (input: AgentTaskInput) => Promise<AgentTask>
  taskAction: (id: string, action: 'stop' | 'resume' | 'approve', input: AgentTaskActionInput) => Promise<AgentTask>
  moveTask: (task: AgentTask, position: AgentTask['position']) => Promise<void>
  saveProfile: (input: AgentProfileInput, id?: string) => Promise<AgentProfile>
  removeProfile: (id: string) => Promise<void>
}

const emptyOverview: AgentOverview = { profiles: [], discovered: [], tasks: [], maxConcurrent: 0 }
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** 所有任务数据来自持久化快照；UI 卸载只断开观察，不改变执行状态。 */
export const useAgentStore = create<AgentState>()((set, get) => {
  let generation = 0
  let cleanup: (() => void) | null = null
  let refreshFlight: { generation: number; promise: Promise<void> } | null = null

  function upsertTask(task: AgentTask): void {
    if (task.userId !== get().userId) return
    set((state) => {
      const previous = state.tasks.find((item) => item.id === task.id)
      if (previous && previous.revision > task.revision) return state
      return { tasks: previous ? state.tasks.map((item) => item.id === task.id ? task : item) : [...state.tasks, task] }
    })
  }

  async function withTask<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (get().busyTasks[id]) throw new Error('Task operation already in progress')
    const activeGeneration = generation
    set((state) => ({ busyTasks: { ...state.busyTasks, [id]: true } }))
    try {
      return await operation()
    } finally {
      if (activeGeneration === generation) set((state) => {
        const busyTasks = { ...state.busyTasks }
        delete busyTasks[id]
        return { busyTasks }
      })
    }
  }

  return {
    ...emptyOverview,
    userId: null,
    loading: false,
    loaded: false,
    error: null,
    connection: 'offline',
    cursor: 0,
    selectedId: null,
    busyTasks: {},

    refresh: () => {
      const { userId } = get()
      if (!userId) return Promise.resolve()
      if (refreshFlight?.generation === generation) return refreshFlight.promise
      const activeGeneration = generation
      set({ loading: true })
      const promise = (async () => {
        try {
          const overview = await fetchAgentOverview(userId)
          if (activeGeneration !== generation) return
          set((state) => {
            const current = new Map(state.tasks.map((task) => [task.id, task]))
            return {
              ...overview,
              // 请求开始后可能已有动作回执；较旧快照不能把新 revision 覆盖回去。
              tasks: overview.tasks.map((task) => {
                const prior = current.get(task.id)
                return prior && prior.revision > task.revision ? prior : task
              }),
              loaded: true,
              error: null
            }
          })
        } catch (error) {
          if (activeGeneration === generation) set({ error: errorMessage(error) })
          throw error
        } finally {
          if (activeGeneration === generation) {
            set({ loading: false })
            refreshFlight = null
          }
        }
      })()
      refreshFlight = { generation: activeGeneration, promise }
      return promise
    },

    connect: (userId) => {
      cleanup?.()
      const activeGeneration = ++generation
      const changedUser = get().userId !== userId
      // 换身份先清空旧任务，防止新用户在首个快照到达前看到别人的日志。
      set({
        ...(changedUser ? { ...emptyOverview, loaded: false, cursor: 0, selectedId: null } : {}),
        userId,
        error: null,
        busyTasks: {},
        connection: 'connecting'
      })
      let disposed = false
      let closeStream: (() => void) | null = null
      let reloadTimer: ReturnType<typeof setTimeout> | null = null
      let retryTimer: ReturnType<typeof setTimeout> | null = null
      let backoff = 1000
      let dirty = false
      const active = (): boolean => !disposed && generation === activeGeneration

      function scheduleReload(): void {
        dirty = true
        if (reloadTimer || !active()) return
        reloadTimer = setTimeout(() => {
          reloadTimer = null
          if (!active() || !dirty) return
          dirty = false
          // 连续 token 最多每秒合并一次请求；在途请求由 refresh 自身去重。
          void get().refresh().catch(() => undefined).finally(() => { if (dirty) scheduleReload() })
        }, 1000)
      }

      function reconnect(): void {
        if (!active() || retryTimer) return
        closeStream?.()
        closeStream = null
        // 断线只进入重连态；任务属于服务端，不能因为页面网络波动被取消。
        set({ connection: 'reconnecting' })
        retryTimer = setTimeout(() => {
          retryTimer = null
          void start()
        }, backoff)
        backoff = Math.min(backoff * 2, 15000)
      }

      async function start(): Promise<void> {
        try {
          // 首连和重连都先恢复持久化快照，再从已处理游标补读，避免断线漏终态。
          await get().refresh()
          if (!active()) return
          closeStream = subscribeAgentEvents(userId, get().cursor, (event) => {
            if (!active()) return
            if (event.data.resync === true && Array.isArray(event.data.tasks)) {
              // 服务端游标被压缩或重置时，resync 快照优先于去重，即使 seq 为 0。
              set({ tasks: event.data.tasks as AgentTask[], cursor: event.seq })
              return
            }
            if (event.seq <= get().cursor) return
            set({ cursor: event.seq })
            scheduleReload()
          }, () => {
            if (!active()) return
            backoff = 1000
            if (get().connection !== 'live') set({ connection: 'live' })
          }, reconnect)
        } catch {
          reconnect()
        }
      }
      void start()
      const dispose = (): void => {
        if (disposed) return
        disposed = true
        closeStream?.()
        if (reloadTimer) clearTimeout(reloadTimer)
        if (retryTimer) clearTimeout(retryTimer)
        if (generation === activeGeneration) {
          // 离页后失效所有在途响应；保留快照可回看，不触碰任务进程。
          generation++
          refreshFlight = null
          set({ connection: 'offline', loading: false })
        }
      }
      cleanup = dispose
      return dispose
    },

    selectTask: (id) => {
      set({ selectedId: id })
      const { userId } = get()
      if (!id || !userId) return
      const activeGeneration = generation
      void fetchAgentTask(id, userId).then((task) => {
        if (activeGeneration === generation) upsertTask(task)
      }).catch((error: unknown) => {
        if (activeGeneration === generation) set({ error: errorMessage(error) })
      })
    },

    createTask: async (input) => {
      const activeGeneration = generation
      const task = await createAgentTask(input)
      if (activeGeneration === generation) {
        upsertTask(task)
        // 服务端接受后才选中新任务，网络失败不制造幽灵卡片。
        set({ selectedId: task.id })
      }
      return task
    },

    taskAction: (id, action, input) => withTask(id, async () => {
      const activeGeneration = generation
      const task = await runAgentTaskAction(id, action, input)
      if (activeGeneration === generation) {
        upsertTask(task)
        if (action === 'resume') set({ selectedId: task.id })
      }
      return task
    }),

    moveTask: (task, position) => withTask(task.id, async () => {
      const activeGeneration = generation
      try {
        const updated = await updateAgentTaskPosition(task, position)
        if (activeGeneration === generation) upsertTask(updated)
      } catch (error) {
        if (activeGeneration === generation && error instanceof AgentApiError && error.status === 409) {
          // 并发移动冲突必须重读服务端位置，不能盲重试覆盖另一台设备的修改。
          await get().refresh().catch(() => undefined)
        }
        throw error
      }
    }),

    saveProfile: async (input, id) => {
      const activeGeneration = generation
      const profile = await saveAgentProfile(input, id)
      if (activeGeneration === generation) set((state) => ({
        profiles: id ? state.profiles.map((item) => item.id === id ? profile : item) : [...state.profiles, profile]
      }))
      return profile
    },

    removeProfile: async (id) => {
      const activeGeneration = generation
      await deleteAgentProfile(id)
      if (activeGeneration === generation) set((state) => ({ profiles: state.profiles.filter((item) => item.id !== id) }))
    }
  }
})
