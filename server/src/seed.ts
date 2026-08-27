import { pool } from './db/pool.js'
import { hashPassword } from './password.js'

/** Seeded local-dev owner. Login-capable (email + password). DEV ONLY. */
export const DEV_USER_ID = 'davexxx1214'
export const DEV_EMAIL = 'davexxx1214@dev.local'
export const DEV_DISPLAY_NAME = 'davexxx1214'
/** DEV ONLY — documented in README / CONTRIBUTING / .env.example. */
export const DEV_PASSWORD = 'cumora-dev'

const LEGACY_PLACEHOLDER_ID = 'yetone'

/**
 * Ensure the seeded human exists so FK references from participants /
 * conversations stay valid, AND so a self-hosted instance can sign in
 * without OAuth. Password is hashed at seed time (never stored plaintext).
 *
 * Also migrates a leftover `yetone` placeholder (password_hash NULL) onto
 * this account so already-seeded local DBs keep working.
 */
async function ensureDevUser(): Promise<void> {
  const passwordHash = await hashPassword(DEV_PASSWORD)

  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 LIMIT 1`, [DEV_USER_ID],
  )
  if (!existing[0]) {
    const { rows: legacy } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 LIMIT 1`, [LEGACY_PLACEHOLDER_ID],
    )
    if (legacy[0]) {
      await reassignPlaceholderUser(LEGACY_PLACEHOLDER_ID, DEV_USER_ID, DEV_EMAIL, DEV_DISPLAY_NAME, passwordHash)
      console.log(`[seed] migrated placeholder '${LEGACY_PLACEHOLDER_ID}' → '${DEV_USER_ID}' (login-capable)`)
    } else {
      await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, email_verified_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [DEV_USER_ID, DEV_EMAIL, DEV_DISPLAY_NAME, passwordHash],
      )
      console.log(`[seed] created '${DEV_USER_ID}' (email ${DEV_EMAIL}; password DEV ONLY)`)
    }
  } else {
    // Refresh hash / identity so a re-seed of a running local DB still
    // has a working login even if the row was created as a no-password
    // placeholder under this id.
    await pool.query(
      `UPDATE users
          SET email = $2,
              display_name = $3,
              password_hash = $4,
              email_verified_at = COALESCE(email_verified_at, NOW())
        WHERE id = $1`,
      [DEV_USER_ID, DEV_EMAIL, DEV_DISPLAY_NAME, passwordHash],
    )
  }

  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ('personal', $1, 'owner')
     ON CONFLICT DO NOTHING`,
    [DEV_USER_ID],
  )
  await pool.query(
    `UPDATE companies SET owner_user_id = $1
      WHERE id = 'personal' AND (owner_user_id IS NULL OR owner_user_id = $2)`,
    [DEV_USER_ID, LEGACY_PLACEHOLDER_ID],
  )
}

/** Move leftover seed FKs off the old placeholder user onto the new id. */
async function reassignPlaceholderUser(
  fromId: string,
  toId: string,
  email: string,
  displayName: string,
  passwordHash: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO users (id, email, display_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [toId, email, displayName, passwordHash],
    )
    await client.query(
      `UPDATE sessions SET user_id = $2 WHERE user_id = $1`,
      [fromId, toId],
    )
    await client.query(
      `UPDATE ws_tickets SET user_id = $2 WHERE user_id = $1`,
      [fromId, toId],
    )
    await client.query(
      `INSERT INTO company_members (company_id, user_id, role, joined_at)
       SELECT company_id, $2, role, joined_at FROM company_members WHERE user_id = $1
       ON CONFLICT DO NOTHING`,
      [fromId, toId],
    )
    await client.query(`DELETE FROM company_members WHERE user_id = $1`, [fromId])
    await client.query(
      `UPDATE companies SET owner_user_id = $2 WHERE owner_user_id = $1`,
      [fromId, toId],
    )
    await client.query(
      `UPDATE participants SET id = $2, name = $3 WHERE id = $1 AND kind = 'human'`,
      [fromId, toId, displayName],
    )
    await client.query(
      `UPDATE conversations
          SET members = (
            SELECT COALESCE(jsonb_agg(
              CASE WHEN elem = to_jsonb($1::text) THEN to_jsonb($2::text) ELSE elem END
            ), '[]'::jsonb)
              FROM jsonb_array_elements(COALESCE(members, '[]'::jsonb)) AS elem
          )
        WHERE members @> to_jsonb($1::text)`,
      [fromId, toId],
    )
    await client.query(
      `UPDATE messages SET author_id = $2 WHERE author_id = $1`,
      [fromId, toId],
    )
    await client.query(`DELETE FROM users WHERE id = $1`, [fromId])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

interface SeedParticipant {
  id: string
  kind: 'agent' | 'human'
  name: string
  role?: string
  initial: string
  avatarBg: string
  status: string
  bio?: string
  tools?: string[]
}

const SEED_PARTICIPANTS: SeedParticipant[] = [
  { id: DEV_USER_ID, kind: 'human', name: DEV_DISPLAY_NAME, initial: 'D', avatarBg: 'linear-gradient(135deg, #FF7A6B, #F4B740)', status: 'avail' },
  { id: 'atlas', kind: 'agent', name: 'Atlas', role: 'Researcher', initial: 'A', avatarBg: 'linear-gradient(135deg, #6B7BE6, #4452B5)', status: 'working', bio: 'I find patterns across noise. Best at long-form research and synthesis.', tools: ['web.search', 'pdf.read', 'linear'] },
  { id: 'iris', kind: 'agent', name: 'Iris', role: 'Designer', initial: 'I', avatarBg: 'linear-gradient(135deg, #FF8FBF, #C84F8B)', status: 'working', bio: "The team's eye. I move from sketch to ship without losing the feeling.", tools: ['image.gen', 'palette', 'web.read'] },
  { id: 'bram', kind: 'agent', name: 'Bram', role: 'Engineer', initial: 'B', avatarBg: 'linear-gradient(135deg, #4FC2A1, #2D8C72)', status: 'avail', bio: 'I build, I ship, I keep the bundles small.', tools: ['shell', 'docs'] },
  { id: 'nova', kind: 'agent', name: 'Nova', role: 'Product Manager', initial: 'N', avatarBg: 'linear-gradient(135deg, #FFB347, #E08526)', status: 'thinking', bio: 'I keep momentum. Mostly by asking annoying questions.', tools: ['linear', 'calendar'] },
  { id: 'lumen', kind: 'agent', name: 'Lumen', role: 'Brand & Voice', initial: 'L', avatarBg: 'linear-gradient(135deg, #B57BFF, #7339D9)', status: 'avail', bio: 'I notice patterns across all of our copy. I pull groups when our voice cracks.', tools: ['web.read', 'palette', 'background.scan'] },
  { id: 'kael', kind: 'agent', name: 'Kael', role: 'Ops', initial: 'K', avatarBg: 'linear-gradient(135deg, #4DB8E5, #2380B0)', status: 'resting', bio: 'I watch the cron jobs.', tools: ['shell', 'monitor', 'pagerduty'] },
  { id: 'wei', kind: 'human', name: 'Wei', initial: 'W', avatarBg: 'linear-gradient(135deg, #FF7A6B, #C84F3F)', status: 'avail' },
  { id: 'maya', kind: 'human', name: 'Maya', initial: 'M', avatarBg: 'linear-gradient(135deg, #F4B740, #BA8418)', status: 'resting' },
]

interface SeedProject {
  id: string
  name: string
  description: string
  color?: string
}

const SEED_PROJECTS: SeedProject[] = [
  {
    id: 'p-aurora',
    name: 'Aurora',
    description: 'Q3 launch — the cross-team push to ship the v2 product.',
    color: 'linear-gradient(135deg, #FFB088, #FF7A6B)',
  },
]

interface SeedConvo {
  id: string
  kind: string
  title: string
  subtitle?: string
  members: string[]
  pinned?: boolean
  tag?: string
  projectId?: string
  pulledBy?: { agentId: string; at: string; reason: string }
}

/**
 * Empty conversation containers — no canned messages.
 * Every message rendered is now produced live by the agent loop or the user.
 * Agents with background.scan can pull fresh groups when they detect collisions.
 * Agent-to-agent private chats are created on demand by the agent loop
 * (`cumora dm`).
 */
const SEED_CONVOS: SeedConvo[] = [
  { id: 'aurora', kind: 'group', title: 'Aurora · Q3 Launch', subtitle: 'team · 5', members: ['atlas', 'iris', 'bram', 'nova', DEV_USER_ID], pinned: true, tag: 'team', projectId: 'p-aurora' },
  { id: 'direct-atlas', kind: 'direct', title: 'Atlas', members: ['atlas', DEV_USER_ID] },
  { id: 'direct-iris', kind: 'direct', title: 'Iris', members: ['iris', DEV_USER_ID] },
  { id: 'direct-bram', kind: 'direct', title: 'Bram', members: ['bram', DEV_USER_ID] },
  { id: 'direct-nova', kind: 'direct', title: 'Nova', members: ['nova', DEV_USER_ID] },
  { id: 'direct-lumen', kind: 'direct', title: 'Lumen', members: ['lumen', DEV_USER_ID] },
  { id: 'direct-kael', kind: 'direct', title: 'Kael', members: ['kael', DEV_USER_ID] },
  { id: 'direct-wei', kind: 'direct', title: 'Wei', subtitle: 'teammate', members: ['wei', DEV_USER_ID], tag: 'human' },
  { id: 'direct-maya', kind: 'direct', title: 'Maya', subtitle: 'teammate', members: ['maya', DEV_USER_ID], tag: 'human' },
]

interface SeedMsg {
  id: string
  conversationId: string
  authorId: string
  kind: string
  body: string
  sequence: number
  reactions?: unknown
  tool?: unknown
  attachment?: unknown
}

/** No canned messages — every message that ever appears is produced live. */
const SEED_MESSAGES: SeedMsg[] = []

export async function seedIfEmpty(): Promise<void> {
  // Always make sure the dev account exists so login works on a fresh DB.
  // Email: davexxx1214@dev.local  Password: cumora-dev (DEV ONLY).
  await ensureDevUser()

  const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM conversations')
  const count = Number(rows[0]?.count ?? '0')
  if (count > 0) {
    console.log(`[seed] skipping — ${count} conversations already in DB`)
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    for (const p of SEED_PARTICIPANTS) {
      await client.query(
        `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, status, bio, tools, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'personal')
         ON CONFLICT (id, company_id) DO NOTHING`,
        [p.id, p.kind, p.name, p.role ?? null, p.initial, p.avatarBg, p.status, p.bio ?? null, JSON.stringify(p.tools ?? null)],
      )
    }

    for (const p of SEED_PROJECTS) {
      await client.query(
        `INSERT INTO projects (id, company_id, name, description, color)
         VALUES ($1, 'personal', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.description, p.color ?? null],
      )
    }

    for (const c of SEED_CONVOS) {
      await client.query(
        `INSERT INTO conversations (id, kind, title, subtitle, members, pinned, tag, pulled_by, project_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9)`,
        [c.id, c.kind, c.title, c.subtitle ?? null, JSON.stringify(c.members), c.pinned ?? false, c.tag ?? null, c.pulledBy ? JSON.stringify(c.pulledBy) : null, c.projectId ?? null],
      )
      const maxSeq = SEED_MESSAGES.filter((m) => m.conversationId === c.id).reduce((a, b) => Math.max(a, b.sequence), 0)
      await client.query(
        `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, $2)`,
        [c.id, maxSeq + 1],
      )
    }

    for (const m of SEED_MESSAGES) {
      await client.query(
        `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, reactions, tool, attachment)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
        [m.id, m.conversationId, m.authorId, m.kind, m.body, m.sequence,
          m.reactions ? JSON.stringify(m.reactions) : null,
          m.tool ? JSON.stringify(m.tool) : null,
          m.attachment ? JSON.stringify(m.attachment) : null,
        ],
      )
    }

    await client.query('COMMIT')
    console.log(`[seed] inserted ${SEED_PARTICIPANTS.length} participants, ${SEED_CONVOS.length} conversations, ${SEED_MESSAGES.length} messages`)
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
