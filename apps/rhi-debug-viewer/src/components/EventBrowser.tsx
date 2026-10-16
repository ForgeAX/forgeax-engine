import { EmptyState, Switch } from '@forgeax/view-components';
import { ChevronDown, ChevronRight, List, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSelection } from '../selection-context';
import { commandRowAnchor, eventBrowserAnchor, passAnchor, selectedAnchor } from '../selectors';
import { useViewModel } from '../viewer-context';

interface PanelProps {
  readonly className?: string;
}

export function EventBrowser(_props?: PanelProps) {
  const model = useViewModel();
  const { selectedWorkIndex, selectCommand, selectWork } = useSelection();
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [mode, setMode] = useState<'works-only' | 'all-commands'>('works-only');

  const passes = model?.passes ?? [];
  const works = model?.works ?? [];
  const commands = model?.commands ?? [];
  const workByPass = useMemo(() => {
    const result = new Map<number, (typeof works)[number][]>();
    for (const work of works) {
      const list = result.get(work.passIndex) ?? [];
      list.push(work);
      result.set(work.passIndex, list);
    }
    return result;
  }, [works]);
  const commandsByPass = useMemo(() => {
    const result = new Map<number, (typeof commands)[number][]>();
    for (const command of commands) {
      const list = result.get(command.passIndex) ?? [];
      list.push(command);
      result.set(command.passIndex, list);
    }
    return result;
  }, [commands]);

  if (!model) {
    return (
      <div className="forgeax-panel flex">
        <EmptyState title="No tape loaded" description="Import or drop a .rhitape file" />
      </div>
    );
  }

  const toggle = (passIndex: number) => {
    const next = new Set(collapsed);
    if (next.has(passIndex)) next.delete(passIndex);
    else next.add(passIndex);
    setCollapsed(next);
  };

  return (
    <section className="forgeax-panel flex flex-col" {...{ [eventBrowserAnchor()]: mode }}>
      <div className="forgeax-panel-toolbar">
        <Switch
          label="All commands"
          checked={mode === 'all-commands'}
          onCheckedChange={(checked) => setMode(checked ? 'all-commands' : 'works-only')}
        />
      </div>
      <div className="flex-1 overflow-auto p-fx-6">
        {passes.map((pass) => {
          const passWorks = workByPass.get(pass.passIndex) ?? [];
          const isCollapsed = collapsed.has(pass.passIndex);
          return (
            <div key={pass.passIndex}>
              <button
                type="button"
                className="flex w-full items-center gap-fx-6 rounded px-fx-8 py-fx-6 text-left text-compact font-medium text-foreground transition-colors hover:bg-muted"
                onClick={() => toggle(pass.passIndex)}
                {...{ [passAnchor()]: String(pass.passIndex) }}
              >
                {isCollapsed ? (
                  <ChevronRight className="fx-icon" />
                ) : (
                  <ChevronDown className="fx-icon" />
                )}
                <List className="fx-icon" />
                <span>
                  {pass.kind === 'render' ? 'Render' : 'Compute'} pass #{pass.passIndex}
                </span>
                <span className="text-muted-foreground">
                  (
                  {mode === 'works-only'
                    ? passWorks.length
                    : (commandsByPass.get(pass.passIndex)?.length ?? 0)}
                  )
                </span>
              </button>
              {!isCollapsed && (
                <div className="ml-fx-12 border-l border-border/80 pl-fx-6">
                  {(mode === 'works-only'
                    ? passWorks.map((work) => ({
                        kind: 'work' as const,
                        work,
                        command: commands[work.commandIndex],
                      }))
                    : (commandsByPass.get(pass.passIndex) ?? []).map((command) => ({
                        kind: 'command' as const,
                        command,
                        work: works.find(
                          (candidate) => candidate.eventIndex === command.eventIndex,
                        ),
                      }))
                  ).map((entry) => {
                    const work = entry.work;
                    const command = entry.command;
                    const selected = work !== undefined && selectedWorkIndex === work.workIndex;
                    return (
                      <button
                        type="button"
                        key={command?.eventIndex ?? work?.workIndex}
                        className={
                          selected
                            ? 'flex w-full min-w-0 items-center gap-fx-6 rounded bg-muted px-fx-8 py-fx-6 text-left text-compact text-foreground'
                            : 'flex w-full min-w-0 items-center gap-fx-6 rounded px-fx-8 py-fx-6 text-left text-compact text-foreground transition-colors hover:bg-muted'
                        }
                        onClick={() => {
                          if (work !== undefined)
                            selectWork(work.workIndex, work.eventIndex, work.passIndex);
                          else if (command !== undefined)
                            selectCommand(command.eventIndex, command.passIndex);
                        }}
                        title={command === undefined ? undefined : JSON.stringify(command.params)}
                        {...{
                          [commandRowAnchor()]: String(
                            command?.eventIndex ?? work?.eventIndex ?? -1,
                          ),
                          ...(work === undefined
                            ? {}
                            : {
                                'data-forgeax-work-index': String(work.workIndex),
                                ...(selected ? { [selectedAnchor()]: 'true' } : {}),
                              }),
                        }}
                      >
                        {work === undefined ? (
                          <List className="fx-icon" />
                        ) : (
                          <Play className="fx-icon" />
                        )}
                        <span className="shrink-0 font-medium">
                          {work === undefined
                            ? `event ${command?.eventIndex ?? -1}`
                            : `#${work.workIndex} ${work.kind}`}
                        </span>
                        {command?.kind !== work?.kind && (
                          <span className="shrink-0 text-muted-foreground">
                            {command?.kind ?? 'work'}
                          </span>
                        )}
                        {command !== undefined && command.group.length > 0 && (
                          <span className="truncate">{command.group.join(' / ')}</span>
                        )}
                        {command?.marker !== undefined && (
                          <span className="truncate">{command.marker}</span>
                        )}
                      </button>
                    );
                  })}
                  {(mode === 'works-only'
                    ? passWorks.length
                    : (commandsByPass.get(pass.passIndex)?.length ?? 0)) === 0 && (
                    <p className="px-fx-8 py-fx-4 text-caption text-muted-foreground">
                      No commands
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {passes.length === 0 && (
          <p className="p-fx-8 text-caption text-muted-foreground">No events in tape</p>
        )}
        {commands.length > 0 && (
          <button
            type="button"
            className="sr-only"
            onClick={() => selectCommand(commands[0]?.eventIndex ?? 0)}
            {...{ [commandRowAnchor()]: '0' }}
          >
            command
          </button>
        )}
      </div>
    </section>
  );
}
