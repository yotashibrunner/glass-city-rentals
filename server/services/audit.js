'use strict';

// Read side of the audit log. Joins the acting operator's name and resolves the
// affected entity to a human label (booking ref / trailer name / account email).
// Newest first, paginated, with optional date / operator / action filters.

const { query } = require('../db');

const MAX_LIMIT = 200;

async function listAudit({ from, to, userId, action, limit, offset } = {}) {
  const where = [];
  const params = [];
  if (from) { params.push(from); where.push(`a.created_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`a.created_at < $${params.length}`); }
  if (userId) { params.push(userId); where.push(`COALESCE(a.action_by, a.admin_user_id) = $${params.length}`); }
  if (action) { params.push(action); where.push(`a.action = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const lim = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || 50));
  const off = Math.max(0, parseInt(offset, 10) || 0);

  const total = (await query(`SELECT count(*)::int AS n FROM audit_log a ${whereSql}`, params)).rows[0].n;

  const pageParams = params.slice();
  pageParams.push(lim); const limIdx = pageParams.length;
  pageParams.push(off); const offIdx = pageParams.length;

  const { rows } = await query(
    `SELECT a.id, a.created_at, a.action, a.entity_type, a.entity_id, a.details,
            u.name AS actor_name, u.email AS actor_email,
            bk.ref_code AS booking_ref, tr.name AS trailer_name, tu.email AS target_email
       FROM audit_log a
       LEFT JOIN admin_users u ON u.id = COALESCE(a.action_by, a.admin_user_id)
       LEFT JOIN bookings bk ON a.entity_type = 'booking' AND bk.id = a.entity_id
       LEFT JOIN trailers tr ON a.entity_type = 'trailer' AND tr.id = a.entity_id
       LEFT JOIN admin_users tu ON a.entity_type = 'admin_user' AND tu.id = a.entity_id
       ${whereSql}
      ORDER BY a.created_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    pageParams
  );

  const items = rows.map((r) => ({
    id: r.id,
    at: r.created_at,
    action: r.action,
    operator: r.actor_name || r.actor_email || 'system',
    entity_type: r.entity_type || null,
    entity: r.booking_ref || r.trailer_name || r.target_email || (r.entity_type || ''),
    detail: r.details || {},
  }));

  return { items, total, limit: lim, offset: off };
}

// Distinct action types present (for the filter dropdown).
async function actionTypes() {
  const { rows } = await query('SELECT DISTINCT action FROM audit_log ORDER BY action');
  return rows.map((r) => r.action);
}

module.exports = { listAudit, actionTypes };
