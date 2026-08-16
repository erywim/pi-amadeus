import toast from 'react-hot-toast'
import { BRAIN_URL } from './api'
import { useSessionStore } from '@renderer/stores/sessionStore'

/**
 * 视觉输入：摄像头开启后按固定间隔采集帧（base64 JPEG），
 * 上传 /api/frames——服务端每用户保留最近 2 帧，语音回合时附加到 LLM 请求。
 * 采集用离屏 video + canvas，不上屏（v1 无视频窗口 UI）。
 */

const FRAME_INTERVAL_MS = 1200
const MAX_WIDTH = 640

let stream: MediaStream | null = null
let videoEl: HTMLVideoElement | null = null
let timer: number | null = null

function captureJpeg(): string | null {
  const video = videoEl
  if (!video || video.readyState < 2) return null
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return null
  const scale = Math.min(1, MAX_WIDTH / w)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.6).split(',')[1] ?? null
}

async function uploadFrame(userId: string): Promise<void> {
  const jpeg = captureJpeg()
  if (!jpeg) return
  try {
    await fetch(`${BRAIN_URL}/api/frames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, frame: jpeg })
    })
  } catch {
    // 帧上传失败静默（大脑短暂不可用等）：下一帧自动重试
  }
}

export async function startCamera(): Promise<void> {
  if (stream) return
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } }
    })
    stream = media
    const video = document.createElement('video')
    video.srcObject = media
    video.muted = true
    await video.play()
    videoEl = video
    const userId = useSessionStore.getState().userId
    timer = window.setInterval(() => {
      const id = useSessionStore.getState().userId ?? userId
      if (id) void uploadFrame(id)
    }, FRAME_INTERVAL_MS)
  } catch (error) {
    console.warn('[camera] 摄像头开启失败：', error)
    toast.error('摄像头不可用，检查系统权限')
    throw error
  }
}

export function stopCamera(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
  if (videoEl) {
    videoEl.srcObject = null
    videoEl = null
  }
}

export function isCameraActive(): boolean {
  return stream !== null
}
