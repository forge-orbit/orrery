# Orrery

Orrery tracks work by humans and agents. These terms describe the planned identity model.

## Language

**Installation**:
One self-hosted Orrery server and its accounts, workspaces, and data.
_Avoid_: Workspace, organization

**Human**:
A person's account within an installation. A human has a personal workspace and can belong to multiple shared workspaces.
_Avoid_: Workspace, agent

**System administrator**:
A human with authority to manage the installation and its instance settings. This role alone grants no access to workspace projects.
_Avoid_: Workspace owner

**Workspace**:
A container that owns projects. A workspace is either personal or shared.
_Avoid_: Installation, project

**Personal workspace**:
A human's private workspace. Its projects are accessible to that human and their authorized agents.
_Avoid_: Private shared workspace

**Shared workspace**:
A workspace in which invited members collaborate through granted permissions.
_Avoid_: Personal workspace, team

**Workspace owner**:
A member with full authority over a shared workspace and all of its projects. A shared workspace has at least one owner.
_Avoid_: System administrator, project creator

**Member**:
A human who belongs to a shared workspace. Membership alone does not grant access to its projects.
_Avoid_: Owner, collaborator

**Permission manager**:
A member whom the workspace owner authorizes to manage member permissions. A permission manager can delegate only access they hold.
_Avoid_: System administrator, workspace owner

**Project manager**:
A human with Manage access to a project. This grants project authority, not workspace-wide permission management.
_Avoid_: Permission manager, manager

**Project**:
A collection of issues and knowledge owned by one workspace. Its creator manages the project but does not personally own a shared workspace's project.
_Avoid_: Repository, workspace

**Invitation**:
An offer to register on the installation or join a shared workspace. It identifies the recipient and the access being offered.
_Avoid_: Membership, email verification

**Agent**:
A registered worker identity owned by a human. Multiple runs can act as the same agent, regardless of their harness or model.
_Avoid_: Bot, API key, run

**API key**:
A secret credential that authenticates requests as one registered agent within one workspace. All callers that use the same API key act as that agent.
_Avoid_: Agent token, personal access token

**Run**:
A record of a registered agent's conversation within a harness, including resumed execution. Concurrent runs are distinct, and a run can change models.
_Avoid_: Agent, MCP connection, work session

**Harness**:
The software that hosts an agent run, such as Claude Code CLI or Codex CLI.
_Avoid_: Model, agent

**Work session**:
An attempt to work on one issue, coordinated within a run. A work session can include subagents, and an issue has at most one active work session.
_Avoid_: Run, agent

**Assignee**:
The single **Human** accountable for an issue's delivery and review. Never an **Agent**; execution is tracked separately through **Work session**s and **Claim**s.
_Avoid_: Owner, worker, agent assignee

**Claim**:
The temporary reservation of an issue by its active work session.
_Avoid_: Assignment, ownership

**Project key**:
A short, workspace-unique prefix that gives a project's issues readable identifiers such as `ORR-42`.
_Avoid_: Slug, repository name, code

**Subtask**:
An issue nested one level beneath a parent issue in the same project, independently claimable and tracked on the board.
_Avoid_: Checklist item, child epic

**Label**:
A project-scoped tag attached to issues for categorization and filtering.
_Avoid_: Tag, type, category

**Handoff**:
Completing a work session by moving its issue to Review for human inspection rather than closing it directly.
_Avoid_: Close, release

**Trash**:
The 30-day recovery period for soft-deleted items and projects before their content is scrubbed while preserving activity history and identifiers.
_Avoid_: Hard delete, archive

**Notification**:
An in-app alert delivered to a human for a project activity event that needs their attention, tracked with a read state and filtered by live project access.
_Avoid_: Email, inbox item, toast

**Webhook**:
A workspace-scoped HTTP subscription owned by a workspace owner that sends signed event payloads to an external URL when matching project activity occurs.
_Avoid_: Integration, hook, callback

**Attachment**:
A project-scoped uploaded file stored in Orrery and referenced from an issue description, comment, or knowledge entry.
_Avoid_: Asset, blob, upload

**Runner host**:
An enrolled machine owned by one human that authenticates to an installation and can be revoked as a unit.
_Avoid_: Device, machine, node

**Runner**:
A live `orrery-runner` process on a runner host, bound to one project and local repository checkout.
_Avoid_: Worker, daemon, runner instance

**Dispatch**:
A server-issued instruction targeting an issue to a specific runner, optionally carrying behavioral instructions, harness, model, and reasoning effort, linked to the resulting work session once accepted without mutating the issue's assignee.
_Avoid_: Job, execution, task

**Harness catalog**:
The list of harnesses, models, and supported reasoning effort levels that a live runner discovers locally and advertises to Orrery for delegation.
_Avoid_: Capabilities, provider list, model registry

**Dispatch token**:
A short-lived credential minted when a runner accepts a dispatch, scoped strictly to one work session and invalidated when that session ends or the runner host is revoked.
_Avoid_: Session key, temporary API key
