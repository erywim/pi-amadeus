import { create } from 'zustand'

/** 当前预览的工件（来自助手消息里的围栏代码块） */
export interface ArtifactPreview {
  /** html / svg / mermaid（小写） */
  lang: string
  code: string
  /** 代码块前面最近的一行文字，用作标题（可为空） */
  title?: string
}

interface ArtifactState {
  artifact: ArtifactPreview | null
  show: (artifact: ArtifactPreview) => void
  close: () => void
}

export const useArtifactStore = create<ArtifactState>()((set) => ({
  artifact: null,
  show: (artifact) => set({ artifact }),
  close: () => set({ artifact: null })
}))
