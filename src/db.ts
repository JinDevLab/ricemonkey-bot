export interface SplitRow {
  id: string
  guild_id: string
  channel_id: string
  distributor_id: string
  total_sale: number
  sale_fee_percent: 3 | 5
  net_sale: number
  distributor_percent_hundredths: number | null
  distributor_final: number
  status: 'active' | 'completed' | 'canceled'
  created_at: string
  completed_at: string | null
  canceled_at: string | null
}

export interface MemberRow {
  split_id: string
  user_id: string
  display_name: string
  position: number
  percent_hundredths: number | null
  listing_amount: number
  expected_receipt: number
  status: 'pending' | 'uploaded' | 'purchased' | 'excluded'
  item_name: string | null
  uploaded_at: string | null
  purchased_at: string | null
}

export interface StoredSplit {
  split: SplitRow
  members: MemberRow[]
}

export async function createSplit(db: D1Database, { split, members }: StoredSplit) {
  await db.batch([
    db.prepare(`INSERT INTO splits
      (id, guild_id, channel_id, distributor_id, total_sale, sale_fee_percent, net_sale,
       distributor_percent_hundredths, distributor_final, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      split.id, split.guild_id, split.channel_id, split.distributor_id, split.total_sale,
      split.sale_fee_percent, split.net_sale, split.distributor_percent_hundredths,
      split.distributor_final, split.status, split.created_at,
    ),
    ...members.map((m) => db.prepare(`INSERT INTO split_members
      (split_id, user_id, display_name, position, percent_hundredths, listing_amount, expected_receipt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      m.split_id, m.user_id, m.display_name, m.position, m.percent_hundredths,
      m.listing_amount, m.expected_receipt, m.status,
    )),
  ])
}

export async function purgeExpired(db: D1Database, now: Date) {
  const cutoff = new Date(now)
  const day = cutoff.getUTCDate()
  cutoff.setUTCDate(1)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3)
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()
  cutoff.setUTCDate(Math.min(day, lastDay))
  const before = cutoff.toISOString()
  const [members, splits] = await db.batch([
    db.prepare('DELETE FROM split_members WHERE split_id IN (SELECT id FROM splits WHERE created_at < ?)').bind(before),
    db.prepare('DELETE FROM splits WHERE created_at < ?').bind(before),
  ])
  return { members: members.meta.changes, splits: splits.meta.changes }
}

export async function getSplit(db: D1Database, id: string, guild: string): Promise<StoredSplit | null> {
  // One batch provides a consistent snapshot of the parent and child rows.
  const [splits, members] = await db.batch([
    db.prepare('SELECT * FROM splits WHERE id = ? AND guild_id = ?').bind(id, guild),
    db.prepare(`SELECT m.* FROM split_members m JOIN splits s ON s.id = m.split_id
      WHERE m.split_id = ? AND s.guild_id = ? ORDER BY m.position`).bind(id, guild),
  ])
  const split = splits.results[0] as unknown as SplitRow | undefined
  return split ? { split, members: members.results as unknown as MemberRow[] } : null
}

export async function savePercent(db: D1Database, { split, members }: StoredSplit, guild: string, distributor: string) {
  const guard = `EXISTS (SELECT 1 FROM splits s WHERE s.id = ? AND s.guild_id = ?
    AND s.distributor_id = ? AND s.status = 'active')
    AND NOT EXISTS (SELECT 1 FROM split_members WHERE split_id = ? AND status IN ('uploaded', 'purchased'))`
  const [result] = await db.batch([
    db.prepare(`UPDATE splits SET distributor_percent_hundredths = ?, distributor_final = ?
      WHERE id = ? AND ${guard}`).bind(split.distributor_percent_hundredths, split.distributor_final,
      split.id, split.id, guild, distributor, split.id),
    ...members.map((m) => db.prepare(`UPDATE split_members
      SET percent_hundredths = ?, listing_amount = ?, expected_receipt = ?, status = ?
      WHERE split_id = ? AND user_id = ? AND status IN ('pending', 'excluded') AND ${guard}`)
      .bind(m.percent_hundredths, m.listing_amount, m.expected_receipt, m.status,
        split.id, m.user_id, split.id, guild, distributor, split.id)),
  ])
  return result.meta.changes > 0
}

export async function markUploaded(db: D1Database, id: string, guild: string, user: string, itemName: string, amount: number) {
  const result = await db.prepare(`UPDATE split_members SET status = 'uploaded', item_name = ?, uploaded_at = COALESCE(uploaded_at, ?)
    WHERE split_id = ? AND user_id = ? AND status IN ('pending', 'uploaded') AND listing_amount = ?
    AND EXISTS (SELECT 1 FROM splits WHERE id = ? AND guild_id = ? AND status = 'active')`)
    .bind(itemName, new Date().toISOString(), id, user, amount, id, guild).run()
  return result.meta.changes > 0
}

export async function markPurchased(db: D1Database, id: string, guild: string, distributor: string, user: string) {
  const now = new Date().toISOString()
  const [member, completed] = await db.batch([
    db.prepare(`UPDATE split_members SET status = 'purchased', purchased_at = ?
      WHERE split_id = ? AND user_id = ? AND status = 'uploaded'
      AND EXISTS (SELECT 1 FROM splits WHERE id = ? AND guild_id = ?
        AND distributor_id = ? AND status = 'active')`).bind(now, id, user, id, guild, distributor),
    db.prepare(`UPDATE splits SET status = 'completed', completed_at = ?
      WHERE id = ? AND guild_id = ? AND distributor_id = ? AND status = 'active'
      AND NOT EXISTS (SELECT 1 FROM split_members WHERE split_id = ? AND status IN ('pending', 'uploaded'))`)
      .bind(now, id, guild, distributor, id),
  ])
  return { changed: member.meta.changes > 0, completed: completed.meta.changes > 0 }
}

export async function cancelSplit(db: D1Database, id: string, guild: string, distributor: string) {
  const result = await db.prepare(`UPDATE splits SET status = 'canceled', canceled_at = ?
    WHERE id = ? AND guild_id = ? AND distributor_id = ? AND status = 'active'`)
    .bind(new Date().toISOString(), id, guild, distributor).run()
  return result.meta.changes > 0
}

export interface PendingRow {
  id: string
  user_id: string
  listing_amount: number
  item_name: string | null
  status: MemberRow['status']
  distributor_id: string
  channel_id: string
  created_at: string
}

export async function unfinished(db: D1Database, guild: string, user: string) {
  // Bound the response as well as the number of returned rows; no Discord message can grow unbounded.
  const [upload, purchase] = await db.batch([
    db.prepare(`SELECT s.id, m.user_id, m.listing_amount, m.item_name, m.status, s.distributor_id, s.channel_id, s.created_at
      FROM split_members m JOIN splits s ON s.id = m.split_id
      WHERE m.user_id = ? AND m.status = 'pending' AND s.guild_id = ? AND s.status = 'active'
      ORDER BY s.created_at ASC, s.id ASC LIMIT 11`).bind(user, guild),
    db.prepare(`SELECT s.id, m.user_id, m.listing_amount, m.item_name, m.status, s.distributor_id, s.channel_id, s.created_at
      FROM splits s JOIN split_members m ON m.split_id = s.id
      WHERE s.guild_id = ? AND s.distributor_id = ? AND s.status = 'active'
      AND m.status IN ('pending', 'uploaded') ORDER BY s.created_at ASC, s.id ASC, m.position LIMIT 11`)
      .bind(guild, user),
  ])
  return { upload: upload.results as unknown as PendingRow[], purchase: purchase.results as unknown as PendingRow[] }
}

export interface HistoryRow extends SplitRow { my_share: number }

export async function history(db: D1Database, guild: string, user: string) {
  // UNION uses the distributor and member indexes instead of scanning all guild history for an OR.
  const rows = await db.prepare(`SELECT * FROM (
    SELECT s.*, s.distributor_final AS my_share FROM splits s
      WHERE s.guild_id = ? AND s.distributor_id = ? AND s.status != 'canceled'
    UNION ALL
    SELECT s.*, m.expected_receipt AS my_share FROM split_members m
      JOIN splits s ON s.id = m.split_id WHERE m.user_id = ? AND s.guild_id = ? AND s.status != 'canceled'
    ) ORDER BY created_at DESC, id DESC LIMIT 10`).bind(guild, user, user, guild).all<HistoryRow>()
  return rows.results
}
