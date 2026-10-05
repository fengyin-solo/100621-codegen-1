/** 观测时段归一化：同一时段重复报送只认最后一次，所以先把时间统一对齐到整点。 */

/**
 * 接受 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm / YYYY-MM-DD HH:mm 等写法，
 * 输出 YYYY-MM-DD HH:00；无法解析时返回 null（由调用方拒收）。
 */
export function normalizeSlot(raw: string): string | null {
  const text = raw.trim().replace('T', ' ')
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (!match) {
    return null
  }
  const [, date, hour = '00'] = match
  return `${date} ${hour}:00`
}

/** 导出明细里只显示到小时，避免与时段主键不一致。 */
export function slotLabel(slot: string): string {
  return slot
}

/** 按观测时间整体回填时使用的时间顺序比较（升序）。 */
export function compareByTime(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
