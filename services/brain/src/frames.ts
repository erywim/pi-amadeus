/**
 * 视觉帧的共享校验。
 *
 * 两个入口收同一类数据：摄像头帧（`POST /api/frames`，每用户保留最近 2 帧）
 * 与主动问候的桌面截图（`POST /api/proactive`，用完即弃）。校验规则必须一致——
 * 大小上限、严格 base64 形态，任何一处放宽都会让另一处变成灌水入口。
 */

/**
 * 单帧解码后字节数上限。桌面端帧为 640~1280px 宽、质量 0.6~0.7 的 JPEG
 * （实测约 30~300KB），上限取 4MB（≥13 倍余量），挡住灌水帧，
 * 同时不拒分辨率/画质上调后的合法帧。
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** 严格 base64 字符集/填充形态（配合"长度为 4 的倍数"构成完整校验；用扁平字符类，避免长串上嵌套量词回溯溢出） */
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** N 字节二进制对应的 base64 最大长度（含填充余量） */
const MAX_FRAME_BASE64_LENGTH = Math.ceil(MAX_FRAME_BYTES / 3) * 4 + 4

export type FrameCheck = { ok: true; bytes: number } | { ok: false; error: string }

/** 校验一帧 base64 JPEG：先按编码长度挡超大帧（避免无谓解码），再查形态与解码后长度 */
export function checkFrame(frame: string): FrameCheck {
  if (frame.length > MAX_FRAME_BASE64_LENGTH) return { ok: false, error: 'frame 超出大小上限' }
  if (!STRICT_BASE64_RE.test(frame) || frame.length % 4 !== 0) {
    return { ok: false, error: 'frame 不是合法 base64' }
  }
  const bytes = Buffer.from(frame, 'base64').length
  if (bytes > MAX_FRAME_BYTES) return { ok: false, error: 'frame 超出大小上限' }
  return { ok: true, bytes }
}
