/**
 * Durable routing policy for chat messages addressed to named agents.
 *
 * `null` means the normal room broadcast. An array is an explicit Agent
 * audience: a non-empty array names the recipients and an empty array wakes
 * no Agents. The visible chat history is unchanged for human members.
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

/**
 * A reply to a message that was explicitly routed to one Agent stays quiet
 * for its peers unless the replying Agent names a new audience. This stops a
 * directed human request from turning into a second-hop room broadcast when
 * the selected Agent posts its result.
 *
 * Callers retain `@all` broadcast semantics by skipping this inheritance for
 * bodies that contain an exact `@all` mention.
 */
export function inheritTargetedReplyAudience(args: {
  resolvedAudience: string[] | null
  incomingAudience: readonly string[] | null
  replyingAgentId: string
}): string[] | null {
  if (args.resolvedAudience !== null) return args.resolvedAudience
  return args.incomingAudience?.includes(args.replyingAgentId) ? [] : null
}
