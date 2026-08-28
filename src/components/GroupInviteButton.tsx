import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '@/stores/auth'
import { useT } from '@/lib/i18n'
import { InvitePeopleModal } from './InvitePeopleModal'

export function GroupInviteButton({ conversationId, conversationName }: {
  conversationId: string; conversationName: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const company = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId))
  if (!company || (company.role !== 'owner' && company.role !== 'admin')) return null
  return <>
    <button type="button" onClick={() => setOpen(true)}
      className="shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-skype-deep hover:bg-sky2-50"
      title={t('invite.title', { name: conversationName })}>{t('invite.groupButton')}</button>
    {open && createPortal(<InvitePeopleModal companyId={company.id} companyName={company.name}
      conversation={{ id: conversationId, title: conversationName }} onClose={() => setOpen(false)} />, document.body)}
  </>
}
