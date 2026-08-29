import { test, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { WebSocket, type WebSocketServer } from 'ws'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { createWsTicket } from '../auth.js'
import { attachWebSocket } from '../ws.js'
import { broadcastRecipients } from '../ws-audience.js'
import { publish, CH_MESSAGE_DELTA, CH_STATUS, sub } from '../redis.js'

const ids = ['owner', 'admin', 'colleague', 'newcomer', 'second-newcomer'] as const
type User = typeof ids[number]
const servers = new Map<User, Server>()
const urls = new Map<User, string>()
const initialLimit = env.WORKSPACE_HUMAN_LIMIT
let wss: WebSocketServer

before(async () => {
  await ensureSchemaOnce()
  for (const id of ids) {
    const server = createServer(await buildApiTestApp(id))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    servers.set(id, server)
    urls.set(id, `http://127.0.0.1:${address.port}`)
  }
  wss = attachWebSocket(servers.get('owner')!)
  await sub.subscribe(CH_STATUS)
})

beforeEach(async () => {
  env.WORKSPACE_HUMAN_LIMIT = 50
  await resetAllTables()
  for (const id of ids) {
    await pool.query("INSERT INTO users (id,email,display_name,tier) VALUES ($1,$2,$1,'free')", [id, `${id}@test.local`])
  }
  await pool.query("INSERT INTO companies (id,name,slug,owner_user_id) VALUES ('co-main','Personal','main','owner'),('co-other','Other','other','owner')")
  for (const id of ['owner', 'admin', 'colleague']) {
    await seedUserMembership(id, 'co-main')
    await pool.query('UPDATE company_members SET role=$3 WHERE company_id=$1 AND user_id=$2', ['co-main',id,id==='colleague'?'member':id])
  }
  await seedUserMembership('owner','co-other')
  await seedUserMembership('colleague','co-other')
  for (const [id, company, members] of [
    ['g-easyar','co-main',['owner','admin']],
    ['g-everyone','co-main',['owner','admin','colleague']],
    ['g-private','co-main',['owner']],
    ['g-other','co-other',['owner','colleague']],
  ] as const) {
    await pool.query("INSERT INTO conversations (id,kind,title,company_id,members) VALUES ($1,'group',$2,$3,$4::jsonb)",
      [id, id === 'g-easyar' ? 'EASYAR' : id, company, JSON.stringify(members)])
  }
  await pool.query("UPDATE companies SET all_hands_conversation_id='g-everyone', all_hands_seeded_at=NOW() WHERE id='co-main'")
})

afterEach(() => { env.WORKSPACE_HUMAN_LIMIT = initialLimit })
after(async () => {
  for (const socket of wss.clients) socket.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  for (const server of servers.values()) await new Promise<void>((resolve) => server.close(() => resolve()))
  await teardownAll()
})

function request(user: User, path: string, method = 'GET', body?: object) {
  return fetch(`${urls.get(user)}/api${path}`, { method,
    headers: { 'content-type': 'application/json', 'x-company-id': 'co-main' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function invite(input: object = {}, user: User = 'owner') {
  const response = await request(user, '/companies/co-main/invitations','POST', { conversationId:'g-easyar', multiUse:true, ...input })
  assert.equal(response.status,201,await response.clone().text())
  return await response.json() as { id:string; token:string; url:string; maxUses:number; conversation:{id:string;title:string} }
}

async function countMembers() {
  return (await pool.query<{ count:number }>("SELECT COUNT(*)::int AS count FROM company_members WHERE company_id='co-main'")).rows[0].count
}

async function invitationStatus(user: User, token: string): Promise<string> {
  return ((await (await request(user, `/invitations/${token}`)).json()) as { status: string }).status
}

test('[integration] admin removes a colleague only from this workspace, preserving account and history', async () => {
  await pool.query("INSERT INTO messages (id,company_id,conversation_id,author_id,kind,body,sequence) VALUES ('old-message','co-main','g-everyone','colleague','text','kept history',1)")
  await pool.query("UPDATE company_members SET role='admin' WHERE company_id='co-main' AND user_id='colleague'")
  const issued = await invite({conversationId:'g-everyone'},'colleague')
  const response = await request('admin','/companies/co-main/members/colleague','DELETE')
  assert.equal(response.status,200)
  assert.equal(await countMembers(),2)
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id='colleague'")).rowCount,1)
  assert.equal((await pool.query("SELECT body FROM messages WHERE id='old-message'")).rows[0].body,'kept history')
  assert.equal((await pool.query("SELECT 1 FROM company_members WHERE company_id='co-other' AND user_id='colleague'")).rowCount,1)
  assert.ok((await pool.query("SELECT departed_at FROM participants WHERE company_id='co-main' AND id='colleague'")).rows[0].departed_at)
  assert.equal((await pool.query("SELECT 1 FROM conversations WHERE company_id='co-main' AND members @> '[\"colleague\"]'::jsonb")).rowCount,0)
  assert.equal((await request('colleague','/conversations')).status,403)
  assert.equal((await request('owner','/conversations/g-easyar/members','POST',{id:'colleague'})).status,400)
  assert.equal(await invitationStatus('newcomer',issued.token),'revoked')
  assert.equal((await broadcastRecipients('co-main')).has('colleague'),false)
})

test('[integration] owners, self, unrelated workspaces and ordinary-member permissions are protected', async () => {
  assert.equal((await request('admin','/companies/co-main/members/owner','DELETE')).status,403)
  assert.equal((await request('admin','/companies/co-main/members/admin','DELETE')).status,400)
  assert.equal((await request('colleague','/companies/co-main/members/admin','DELETE')).status,403)
  assert.equal((await request('admin','/companies/co-other/members/colleague','DELETE')).status,403)
  assert.equal((await request('colleague','/companies/co-main/members')).status,403)
  const members=await (await request('admin','/companies/co-main/members')).json() as Array<{id:string;isOwner:boolean}>
  assert.equal(members.find((member)=>member.id==='owner')?.isOwner,true)
  assert.equal(await countMembers(),3)
})

test('[integration] a new invitee joins the workspace and target group, never Everyone or other groups', async () => {
  const created=await invite()
  assert.deepEqual(created.conversation,{id:'g-easyar',title:'EASYAR'})
  const preview=await (await request('newcomer',`/invitations/${created.token}`)).json() as {
    invitation: { company: { name: string }; conversation: { title: string } }
  }
  assert.equal(preview.invitation.company.name,'Personal')
  assert.equal(preview.invitation.conversation.title,'EASYAR')
  const accepted=await request('newcomer',`/invitations/${created.token}/accept`,'POST')
  assert.equal(accepted.status,200,await accepted.clone().text())
  assert.equal(((await accepted.json()) as { conversation: { id: string } }).conversation.id,'g-easyar')
  assert.equal(await countMembers(),4)
  const groups=await (await request('newcomer','/conversations')).json() as Array<{id:string}>
  assert.deepEqual(groups.map((group)=>group.id),['g-easyar'])
  const directory=await (await request('newcomer','/participants')).json() as Array<{id:string}>
  assert.ok(directory.some((p)=>p.id==='colleague'))
  assert.equal((await request('newcomer','/conversations/g-private/messages')).status,404)
  const search=await (await request('newcomer','/search?q=private')).json() as { groups: unknown[] }
  assert.deepEqual(search.groups,[])
  assert.equal((await broadcastRecipients('co-main','g-private')).has('newcomer'),false)
  assert.equal((await broadcastRecipients('co-main','g-easyar')).has('newcomer'),true)
})

test('[integration] ordinary members can view and chat with agents but only admins can edit them', async () => {
  await pool.query(`INSERT INTO participants (id,company_id,kind,name,role,initial,avatar_bg,status,system_prompt)
    VALUES ('editable-agent','co-main','agent','Original agent','tester','A','#abcdef','avail','Original instructions')`)
  const directory = await (await request('colleague','/participants')).json() as Array<{id:string}>
  assert.ok(directory.some((person) => person.id === 'editable-agent'))
  assert.equal((await request('colleague','/conversations/direct','POST',{otherId:'editable-agent'})).status,201)
  const mutations = [
    ['POST','/agents'], ['PUT','/agents/editable-agent'], ['DELETE','/agents/editable-agent'],
    ['POST','/agents/editable-agent/rehire'], ['POST','/agents/editable-agent/avatar/generate'],
    ['POST','/agents/editable-agent/computer'],
  ] as const
  for (const [method,path] of mutations) {
    assert.equal((await request('colleague',path,method,{name:'Unauthorized change',systemPrompt:'Unauthorized instructions',computerId:'missing'})).status,403,path)
  }
  const unchanged = (await pool.query("SELECT name,system_prompt,departed_at FROM participants WHERE id='editable-agent' AND company_id='co-main'")).rows[0]
  assert.deepEqual(unchanged,{name:'Original agent',system_prompt:'Original instructions',departed_at:null})
  for (const user of ['owner','admin'] as const) {
    assert.equal((await request(user,'/agents/editable-agent','PUT',{name:`Updated by ${user}`})).status,200)
    assert.equal((await pool.query("SELECT name FROM participants WHERE id='editable-agent' AND company_id='co-main'")).rows[0].name,`Updated by ${user}`)
  }
})

test('[integration] existing colleagues can use a group invite at the workspace limit without a new seat or role escalation', async () => {
  env.WORKSPACE_HUMAN_LIMIT=3
  const created=await invite({email:'colleague@test.local',role:'admin'})
  assert.equal(await invitationStatus('colleague',created.token),'valid')
  assert.equal((await request('colleague',`/invitations/${created.token}/accept`,'POST')).status,200)
  assert.equal(await countMembers(),3)
  assert.equal((await pool.query("SELECT role FROM company_members WHERE company_id='co-main' AND user_id='colleague'")).rows[0].role,'member')
  const again=await (await request('colleague',`/invitations/${created.token}/accept`,'POST')).json() as { alreadyMember: boolean }
  assert.equal(again.alreadyMember,true)
  assert.equal((await pool.query('SELECT use_count FROM company_invitations WHERE token_hash=$1',[created.id])).rows[0].use_count,1)
})

test('[integration] removal followed by a new group invite restores only the requested membership', async () => {
  assert.equal((await request('admin','/companies/co-main/members/colleague','DELETE')).status,200)
  const created=await invite()
  assert.equal((await request('colleague',`/invitations/${created.token}/accept`,'POST')).status,200)
  const groups=await (await request('colleague','/conversations')).json() as Array<{id:string}>
  assert.deepEqual(groups.map((group)=>group.id),['g-easyar'])
  assert.equal((await pool.query("SELECT departed_at FROM participants WHERE company_id='co-main' AND id='colleague'")).rows[0].departed_at,null)
})

test('[integration] legacy workspace links remain usable without automatically joining Everyone', async () => {
  const created=await invite({conversationId:null})
  const response=await request('newcomer',`/invitations/${created.token}/accept`,'POST')
  assert.equal(response.status,200)
  const accepted=await response.json() as { conversation: unknown }
  assert.equal(accepted.conversation,null)
  assert.equal(await countMembers(),4)
  assert.deepEqual(await (await request('newcomer','/conversations')).json(),[])
  const directory=await (await request('newcomer','/participants')).json() as Array<{id:string}>
  assert.ok(directory.some((person)=>person.id==='colleague'))
})

test('[integration] group invitation creation rejects cross-workspace, inaccessible, direct and non-admin targets', async () => {
  await pool.query("INSERT INTO conversations (id,kind,title,company_id,members) VALUES ('dm','direct','DM','co-main','[\"owner\",\"admin\"]')")
  for(const conversationId of ['g-other','dm','missing']) {
    assert.equal((await request('owner','/companies/co-main/invitations','POST',{conversationId})).status,404)
  }
  assert.equal((await request('admin','/companies/co-main/invitations','POST',{conversationId:'g-private'})).status,404)
  assert.equal((await request('colleague','/companies/co-main/invitations','POST',{conversationId:'g-everyone'})).status,403)
})

test('[integration] group links enforce email, revocation and expiry and cannot outlive a deleted group', async () => {
  const locked=await invite({email:'newcomer@test.local'})
  assert.equal((await request('second-newcomer',`/invitations/${locked.token}/accept`,'POST')).status,403)
  await request('owner',`/companies/co-main/invitations/${locked.id}`,'DELETE')
  assert.equal((await request('newcomer',`/invitations/${locked.token}/accept`,'POST')).status,410)
  const expired=await invite()
  await pool.query("UPDATE company_invitations SET expires_at=NOW()-INTERVAL '1 day' WHERE token_hash=$1",[expired.id])
  assert.equal((await request('newcomer',`/invitations/${expired.token}/accept`,'POST')).status,410)
  const deleted=await invite()
  await pool.query("DELETE FROM conversations WHERE id='g-easyar'")
  assert.equal(await invitationStatus('newcomer',deleted.token),'not_found')
  assert.equal((await request('newcomer',`/invitations/${deleted.token}/accept`,'POST')).status,404)
})

test('[integration] invitations are listed and replaced per target group', async () => {
  const first=await invite({email:'newcomer@test.local'})
  const other=await invite({email:'newcomer@test.local',conversationId:'g-private'})
  await invite({email:'newcomer@test.local'})
  assert.equal(await invitationStatus('newcomer',first.token),'revoked')
  assert.equal(await invitationStatus('newcomer',other.token),'valid')
  const list=await (await request('owner','/companies/co-main/invitations?conversationId=g-private')).json() as Array<{id:string}>
  assert.deepEqual(list.map((row)=>row.id),[other.id])
  const adminList=await (await request('admin','/companies/co-main/invitations')).json() as Array<{id:string}>
  assert.equal(adminList.some((row)=>row.id===other.id),false)
})

test('[integration] active invitation URLs can be re-copied without storing plaintext tokens', async () => {
  const created = await invite()
  const list = await (await request('owner','/companies/co-main/invitations?conversationId=g-easyar')).json() as Array<{id:string;url:string|null}>
  assert.equal(list.find((row) => row.id === created.id)?.url, created.url)
  const stored = (await pool.query<{ token_ciphertext:string|null }>(
    'SELECT token_ciphertext FROM company_invitations WHERE token_hash=$1', [created.id],
  )).rows[0]?.token_ciphertext
  assert.ok(stored)
  assert.equal(stored.includes(created.token), false)
  assert.equal((await request('colleague','/companies/co-main/invitations?conversationId=g-easyar')).status,403)
})

test('[integration] a legacy invitation can be explicitly rotated into a re-copyable link', async () => {
  const created = await invite()
  await pool.query('UPDATE company_invitations SET token_ciphertext=NULL WHERE token_hash=$1', [created.id])
  const before = await (await request('owner','/companies/co-main/invitations?conversationId=g-easyar')).json() as Array<{id:string;url:string|null}>
  assert.equal(before.find((row) => row.id === created.id)?.url, null)

  assert.equal((await request('colleague',`/companies/co-main/invitations/${created.id}/rotate-link`,'POST')).status,403)
  const rotatedResponse = await request('owner',`/companies/co-main/invitations/${created.id}/rotate-link`,'POST')
  assert.equal(rotatedResponse.status,200,await rotatedResponse.clone().text())
  const rotated = await rotatedResponse.json() as {id:string;token:string;url:string}
  assert.notEqual(rotated.id, created.id)
  assert.notEqual(rotated.token, created.token)
  assert.equal(await invitationStatus('newcomer',created.token),'not_found')
  assert.equal(await invitationStatus('newcomer',rotated.token),'valid')

  const after = await (await request('owner','/companies/co-main/invitations?conversationId=g-easyar')).json() as Array<{id:string;url:string|null}>
  assert.equal(after.find((row) => row.id === rotated.id)?.url, rotated.url)
})

test('[integration] concurrent group invitations cannot exceed the workspace seat limit', async () => {
  env.WORKSPACE_HUMAN_LIMIT=4
  const first=await invite()
  const second=await invite()
  const responses=await Promise.all([
    request('newcomer',`/invitations/${first.token}/accept`,'POST'),
    request('second-newcomer',`/invitations/${second.token}/accept`,'POST'),
  ])
  assert.deepEqual(responses.map((response)=>response.status).sort(),[200,403])
  assert.equal(await countMembers(),4)
})

test('[integration] concurrent repeated acceptance joins once and consumes one use', async () => {
  const created=await invite({maxUses:1})
  const responses=await Promise.all([0,1].map(()=>request('newcomer',`/invitations/${created.token}/accept`,'POST')))
  assert.deepEqual(responses.map((response)=>response.status),[200,200])
  assert.equal(await countMembers(),4)
  assert.equal((await pool.query('SELECT use_count FROM company_invitations WHERE token_hash=$1',[created.id])).rows[0].use_count,1)
})

async function connect(user:User) {
    const {ticket}=await createWsTicket(user)
    const socket=new WebSocket(`${urls.get('owner')!.replace('http','ws')}/ws?t=${ticket}`)
    const events:Array<{type:string;participantId?:string;conversationId?:string}>=[]
    socket.on('message',(raw)=>events.push(JSON.parse(raw.toString())))
    await once(socket,'open')
    return {socket,events}
}
async function until(check:()=>boolean) {
    const end=Date.now()+4000
    while(!check()) {
      if(Date.now()>end) throw new Error('Timed out waiting for WebSocket event')
      await new Promise((resolve)=>setTimeout(resolve,10))
    }
}

test('[integration] private live events stay in the group and removed colleagues lose their socket access', async () => {
  const owner=await connect('owner')
  const colleague=await connect('colleague')
  try {
    await until(()=>owner.events.some((e)=>e.type==='hello') && colleague.events.some((e)=>e.type==='hello'))
    await publish(CH_MESSAGE_DELTA,{type:'message.delta',companyId:'co-main',conversationId:'g-easyar',messageId:'private-stream',authorId:'owner',delta:'private text',sequence:1,done:true})
    await publish(CH_STATUS,{type:'participants.status',companyId:'co-main',participantId:'privacy-barrier',status:'avail'})
    await until(()=>colleague.events.some((e)=>e.participantId==='privacy-barrier'))
    assert.equal(owner.events.some((e)=>e.type==='message.delta'),true)
    assert.equal(colleague.events.some((e)=>e.type==='message.delta'),false)
    const closed=once(colleague.socket,'close')
    assert.equal((await request('admin','/companies/co-main/members/colleague','DELETE')).status,200)
    const [code]=await closed
    assert.equal(code,4403)
    assert.ok(colleague.events.some((e)=>e.type==='workspace.member_removed'))
  } finally {
    for(const {socket} of [owner,colleague]) {
      if(socket.readyState!==WebSocket.CLOSED) { const closed=once(socket,'close'); socket.close(); await closed }
    }
  }
})

test('[integration] an admin dissolves a group, invalidating links and history but preserving colleagues and other groups', async () => {
  const link = await invite()
  await pool.query("INSERT INTO messages (id,company_id,conversation_id,author_id,kind,body,sequence) VALUES ('group-history','co-main','g-easyar','owner','text','group history',1)")
  await pool.query("INSERT INTO conversation_counters (conversation_id,next_sequence) VALUES ('g-easyar',2)")
  await pool.query("INSERT INTO conversation_reads (user_id,conversation_id) VALUES ('owner','g-easyar')")
  await pool.query("INSERT INTO conversation_mutes (user_id,conversation_id) VALUES ('admin','g-easyar')")
  await pool.query(`INSERT INTO calendar_events (id,company_id,created_by,kind,title,target_conversation_id,start_at,status)
    VALUES ('group-task','co-main','owner','agent_task','Pending task','g-easyar',NOW()+INTERVAL '1 day','active'),
           ('other-task','co-main','owner','agent_task','Other task','g-private',NOW()+INTERVAL '1 day','active')`)
  const result = await request('admin','/conversations/g-easyar','DELETE')
  assert.equal(result.status,200,await result.clone().text())
  assert.equal(await countMembers(),3)
  assert.equal((await pool.query("SELECT 1 FROM participants WHERE company_id='co-main'")).rowCount,3)
  assert.equal((await pool.query("SELECT 1 FROM conversations WHERE id='g-easyar'")).rowCount,0)
  for (const table of ['messages','conversation_counters','conversation_reads','conversation_mutes','company_invitations']) {
    assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE conversation_id='g-easyar'`)).rowCount,0,table)
  }
  assert.equal((await request('newcomer',`/invitations/${link.token}/accept`,'POST')).status,404)
  assert.equal((await request('owner','/conversations/g-easyar/messages')).status,404)
  assert.equal((await request('owner','/conversations/g-easyar/members','POST',{id:'colleague'})).status,404)
  assert.equal((await request('owner','/conversations/g-easyar','DELETE')).status,404)
  const groups = await (await request('owner','/conversations')).json() as Array<{id:string}>
  assert.equal(groups.some((g) => g.id === 'g-easyar'),false)
  assert.ok(groups.some((g) => g.id === 'g-private'))
  assert.equal((await pool.query("SELECT 1 FROM conversations WHERE id='g-other'")).rowCount,1)
  assert.deepEqual((await pool.query("SELECT status,target_conversation_id FROM calendar_events WHERE id='group-task'")).rows[0],{status:'cancelled',target_conversation_id:null})
  assert.equal((await pool.query("SELECT status FROM calendar_events WHERE id='other-task'")).rows[0].status,'active')
})

test('[integration] dissolution rejects ordinary members, private/cross-workspace groups, DMs and whispers', async () => {
  assert.equal((await request('colleague','/conversations/g-everyone','DELETE')).status,403)
  assert.equal((await request('admin','/conversations/g-private','DELETE')).status,404)
  assert.equal((await request('owner','/conversations/g-other','DELETE')).status,404)
  assert.equal((await request('owner','/conversations/missing','DELETE')).status,404)
  for (const kind of ['direct','whisper']) {
    await pool.query('INSERT INTO conversations (id,company_id,kind,title,members) VALUES ($1,$2,$1,$1,$3::jsonb)',[kind,'co-main',JSON.stringify(['owner','admin'])])
    assert.equal((await request('owner',`/conversations/${kind}`,'DELETE')).status,400)
  }
  assert.equal((await pool.query('SELECT 1 FROM conversations')).rowCount,6)
})

test('[integration] an owner may dissolve Everyone without removing colleagues or reseeding the group', async () => {
  assert.equal((await request('owner','/conversations/g-everyone','DELETE')).status,200)
  const company = (await pool.query("SELECT all_hands_conversation_id,all_hands_seeded_at FROM companies WHERE id='co-main'")).rows[0]
  assert.equal(company.all_hands_conversation_id,null)
  assert.ok(company.all_hands_seeded_at)
  assert.equal(await countMembers(),3)
})

test('[integration] concurrent invitation acceptance cannot revive a dissolved group', async () => {
  const link = await invite()
  const [removed,accepted] = await Promise.all([
    request('admin','/conversations/g-easyar','DELETE'),
    request('newcomer',`/invitations/${link.token}/accept`,'POST'),
  ])
  assert.equal(removed.status,200,await removed.clone().text())
  assert.ok([200,404].includes(accepted.status),await accepted.clone().text())
  assert.equal((await pool.query("SELECT 1 FROM conversations WHERE id='g-easyar'")).rowCount,0)
  assert.equal((await pool.query('SELECT 1 FROM company_invitations WHERE token_hash=$1',[link.id])).rowCount,0)
})

test('[integration] dissolution reaches only former group members and later group traffic is dropped', async () => {
  const owner = await connect('owner')
  const admin = await connect('admin')
  const colleague = await connect('colleague')
  try {
    await until(() => [owner,admin,colleague].every((client) => client.events.some((e) => e.type === 'hello')))
    assert.equal((await request('admin','/conversations/g-easyar','DELETE')).status,200)
    await publish(CH_MESSAGE_DELTA,{type:'message.delta',companyId:'co-main',conversationId:'g-easyar',messageId:'late-stream',authorId:'owner',delta:'late text',sequence:1,done:true})
    await publish(CH_STATUS,{type:'participants.status',companyId:'co-main',participantId:'dissolution-barrier',status:'avail'})
    await until(() => [owner,admin,colleague].every((client) => client.events.some((e) => e.participantId === 'dissolution-barrier')))
    for (const client of [owner,admin]) {
      const event = client.events.find((e) => e.type === 'conversation.dissolved')
      assert.deepEqual(event,{type:'conversation.dissolved',companyId:'co-main',conversationId:'g-easyar'})
      assert.equal(client.events.some((e) => e.type === 'message.delta'),false)
    }
    assert.equal(colleague.events.some((e) => e.type === 'conversation.dissolved'),false)
  } finally {
    for (const {socket} of [owner,admin,colleague]) {
      if (socket.readyState !== WebSocket.CLOSED) { const closed=once(socket,'close'); socket.close(); await closed }
    }
  }
})
