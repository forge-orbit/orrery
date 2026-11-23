# Orrery web UI

Orrery uses the existing mark on the account pages, in the workspace navigation, and as the
favicon. The [mark](../../assets/orrery-mark.svg) supplies charcoal `#14161B`, cream
`#F6F3EC`, and orange `#F2561D`. The navigation and account illustration use charcoal.
Light mode uses a cream canvas. Dark mode uses charcoal with lighter surfaces for forms,
lists, and issue cards. Orange marks a selected navigation item or a question that needs
attention. Link and action colors adapt to the active mode. A state always has a text label.

The appearance control offers **System**, **Light**, and **Dark**. System follows the device
setting and updates when it changes. The browser saves an explicit choice on that device.

## Page layouts

- **Setup, sign-in, invitations, and password recovery** share the account layout. Use a single
  column for each form and show the error beside the action. Setup asks for the server's setup
  secret and the first administrator's credentials. Email configuration happens after sign-in.
- **Home and workspaces** show the workspaces and projects the current human can access. Group
  member management, invitations, agents, API keys, and runs under their own headings. Keep the
  distinction between installation authority and workspace permissions visible.
- **Projects** show issues and knowledge beneath the project heading. Keep the Board and history
  links at the same level. Show settings and access controls according to the user's project level.
- **Board** uses a simple page heading with workspace and project links in the breadcrumb. Keep
  the six issue statuses in fixed order when filtering for issues that need input or are ready
  to claim. "New issue" opens the dedicated `/projects/$projectId/issues/new` page while the
  session inspector stays in its board drawer. An open question links directly to the Inbox.
  On narrow screens the board scrolls horizontally within the page.
- **Issue detail** places the description and discussion in the main column and the session
  inspector alongside them. On narrow screens the inspector stacks below the issue content so
  the description is immediately visible and destructive actions stay at the bottom of the page.
  Keep session progress, run metadata, and activity distinct from issue comments.
- **Inbox** groups questions into **Needs an answer** and **Resolved**. The question shows its
  issue, the agent when known, the deadline, the proposed fallback, and the recorded resolution.
  The same question in an issue's session inspector leads back to the filtered Inbox.
- **Knowledge, history, and SMTP settings** use the same reading width, heading hierarchy, and
  form controls as project pages. Keep each history page's scope in the heading and retain its
  back link. Group SMTP configuration, test delivery, and verification by purpose.

## Build and update the theme

The Orrery theme extends Astryx Neutral. The installed Astryx CLI supplies the component and
theme references for the version used by the web app. Read the relevant reference before
adopting a control. For example, from the repository root run
`pnpm astryx component TextInput`. Use Astryx for controls and shared
surfaces. Keep native form submission and validation, and use the shared link for client-side
navigation.

Change palette and type tokens in
[`orreryTheme.ts`](../../apps/web/src/themes/orrery/orreryTheme.ts), then run
`pnpm astryx theme build src/themes/orrery/orreryTheme.ts`.
The generated app module selects the built theme. Its CSS, the Astryx reset and component
styles, and the packaged font files ship with the web app.
Use [Astryx's theme guide](https://astryx.atmeta.com/docs/theme) to change how the app loads themes.
