export const VIEW_WORKSPACE_CORE_OPERATION_DESCRIPTIONS = Object.freeze([
  { id: 'presentation.get', path: ['presentation', 'get'], summary: 'Read the selected View document\'s actual pages, active page, panels and appearance.' },
  { id: 'presentation.page.open', path: ['presentation', 'page', 'open'], summary: 'Open a registered View page type and return committed presentation state.' },
  { id: 'presentation.page.select', path: ['presentation', 'page', 'select'], summary: 'Activate one actual View page by its returned page ID.' },
  { id: 'presentation.page.close', path: ['presentation', 'page', 'close'], summary: 'Close one closable View page by its returned page ID.' },
  { id: 'presentation.panel.reveal', path: ['presentation', 'panel', 'reveal'], summary: 'Reveal a registered View panel through its native owner.' },
  { id: 'summary.get', path: ['summary', 'get'], summary: 'Read bounded project, phase and target identities.' },
  { id: 'pages.list', path: ['pages', 'list'], summary: 'Read bounded identities and target summaries for connected View pages.' },
  { id: 'pack.reveal', path: ['pack', 'reveal'], summary: 'Reveal one exact Pack revision in one connected View page and wait for a visible receipt.' },
  { id: 'tabs.get', path: ['tabs', 'get'], summary: 'Read View bindings and Engine target identities.' },
  { id: 'tabs.select', path: ['tabs', 'select'], summary: 'Select a View page.' },
]);
