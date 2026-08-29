/**
 * Durable routing policy for chat messages addressed to named agents.
 *
 * `null` means the normal room broadcast. A non-empty array means only
 * those agent ids receive the message in their inbox. The visible chat
 * history is unchanged: every conversation member can still read it.
 */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function hasExactMention(body: string, participantId: string): boolean {
  const mention = new RegExp(`(^|[^\\w@])@${escapeRegex(participantId)}(?![\\w-])`, 'i')
  return mention.test(body)
}

/**
 * Resolve the agent delivery audience from serialized RichInput text.
 * RichInput persists a mention chip as `@<participant-id>`, so ids are
 * stable even if the display name later changes.
 *
 * Direct/email conversations and `@all` keep broadcast semantics. In a
 * group, one or more exact agent mentions narrow delivery to those agents.
 * Human-only mentions intentionally do not change agent routing yet.
 */
export function resolveAgentRecipientIds(args: {
  body: string
  conversationKind: string
  agentMemberIds: readonly string[]
}): string[] | null {
  if (args.conversationKind !== 'group') return null
  if (hasExactMention(args.body, 'all')) return null

  const mentioned = args.agentMemberIds.filter((id) => hasExactMention(args.body, id))
  return mentioned.length > 0 ? [...new Set(mentioned)] : null
}

