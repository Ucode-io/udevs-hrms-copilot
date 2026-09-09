# HRMS Copilot

A conversational admin assistant for udevs HRMS. It answers questions about HR data
and performs changes on the user's behalf, by calling tools against the ucode backend
that already stores that data.

## Language

### The conversation

**Conversation**:
One continuous exchange between a person and the Copilot, owned by that person alone.
_Avoid_: Session, chat, thread

**Thread**:
The raw message history of a Conversation exactly as the model sees it, including its
tool calls and their results.
_Avoid_: History, transcript, log

**Turn**:
One request to the model and everything it produces in reply — text plus at most one
tool call.
_Avoid_: Iteration, step, round

### Acting on data

**Tool**:
A named capability the model can invoke. Every Tool is table-agnostic: it takes the
table to act on as an argument rather than existing per table.
_Avoid_: Function, action, skill, command

**Risk**:
The class of a Tool that decides whether it runs on its own. `read` runs silently,
`write` runs and reports, `destructive` never runs without a person approving it.
_Avoid_: Severity, level, permission

**Pending Action**:
A destructive Tool call the model asked for, held unexecuted until the person approves
or rejects it. A Conversation has at most one at a time.
_Avoid_: Proposal, request, draft, queued action

**Claim**:
Taking exclusive ownership of a Pending Action so it can be executed exactly once,
even if the approval arrives twice.
_Avoid_: Lock, reserve, acquire

### What comes back

**Artifact**:
Something rendered for the person that the model never sees — a chart or a deep link.
Its numbers come from the query result, so they cannot be misremembered.
_Avoid_: Widget, visualization, output

**Summary**:
The short sentence a Tool returns describing what it found or changed. It is what the
model reads and what the person sees on a result chip.
_Avoid_: Message, description, label

**Attachment**:
A file the person sends with a Turn's message — a spreadsheet, a CSV, a PDF, a photo
of a list. It travels the opposite way to an Artifact: the model reads it and the
person already has it.
_Avoid_: Upload, document, file input

### Who is asking

**Caller**:
The HRMS user whose credentials the Copilot acts under. It never has authority the
Caller lacks.
_Avoid_: Client, requester, principal

**Company**:
The tenant every piece of HRMS data belongs to. It is derived from the Caller and is
never accepted as an argument, from the model or from the browser.
_Avoid_: Organization, tenant, account, workspace

**Employee**:
A person employed by a Company. Stored among general users, and distinguished from
them only by their role.
_Avoid_: User, staff, worker, member

### Knowing the data

**Allowlist**:
The set of tables the Copilot may touch at all, decided by us rather than by the
Caller's permissions. It narrows what ucode would otherwise permit; it never widens it.
_Avoid_: Whitelist, scope, catalog

**Hint**:
Curated knowledge about a table that its schema does not reveal — that a field holds an
array, that two spellings of a column coexist, that a filter is mandatory.
_Avoid_: Metadata, annotation, note, doc
