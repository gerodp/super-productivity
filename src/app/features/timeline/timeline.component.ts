import { ChangeDetectionStrategy, Component, OnDestroy } from '@angular/core';
import { TimelineCalendarMapEntry, TimelineViewEntry } from './timeline.model';
import {
  debounceTime,
  distinctUntilChanged,
  map,
  startWith,
  switchMap,
  tap,
} from 'rxjs/operators';
import { TaskService } from '../tasks/task.service';
import { combineLatest, forkJoin, Observable, of } from 'rxjs';
import { mapToTimelineViewEntries } from './map-timeline-data/map-to-timeline-view-entries';
import { T } from 'src/app/t.const';
import { standardListAnimation } from '../../ui/animations/standard-list.ani';
import { getTomorrow } from '../../util/get-tomorrow';
import { TimelineViewEntryType } from './timeline.const';
import { GlobalConfigService } from '../config/global-config.service';
import { MatDialog } from '@angular/material/dialog';
import { LS } from '../../core/persistence/storage-keys.const';
import { DialogTimelineSetupComponent } from './dialog-timeline-setup/dialog-timeline-setup.component';
import { WorkContextService } from '../work-context/work-context.service';
import { TaskRepeatCfgService } from '../task-repeat-cfg/task-repeat-cfg.service';
import { Task } from '../tasks/task.model';
import { DialogAddTaskReminderComponent } from '../tasks/dialog-add-task-reminder/dialog-add-task-reminder.component';
import { AddTaskReminderInterface } from '../tasks/dialog-add-task-reminder/add-task-reminder-interface';
import { loadFromRealLs, saveToRealLs } from '../../core/persistence/local-storage';
import { Store } from '@ngrx/store';
import { selectCalendarProviders } from '../config/store/global-config.reducer';
import { CalendarIntegrationService } from '../calendar-integration/calendar-integration.service';
import { selectAllCalendarTaskEventIds } from '../tasks/store/task.selectors';
import { CalendarIntegrationEvent } from '../calendar-integration/calendar-integration.model';
import { distinctUntilChangedObject } from '../../util/distinct-until-changed-object';

@Component({
  selector: 'timeline',
  templateUrl: './timeline.component.html',
  styleUrls: ['./timeline.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [standardListAnimation],
})
export class TimelineComponent implements OnDestroy {
  T: typeof T = T;
  TimelineViewEntryType: typeof TimelineViewEntryType = TimelineViewEntryType;
  icalEvents$: Observable<TimelineCalendarMapEntry[]> = this._store
    .select(selectCalendarProviders)
    .pipe(
      switchMap((calendarProviders) =>
        this._store.select(selectAllCalendarTaskEventIds).pipe(
          map((allCalendarTaskEventIds) => ({
            allCalendarTaskEventIds,
            calendarProviders,
          })),
        ),
      ),
      distinctUntilChanged(distinctUntilChangedObject),
      switchMap(({ allCalendarTaskEventIds, calendarProviders }) => {
        return calendarProviders && calendarProviders.length
          ? forkJoin(
              calendarProviders
                .filter((calProvider) => calProvider.isEnabled)
                .map((calProvider) =>
                  this._calendarIntegrationService
                    .requestEventsForTimeline(calProvider)
                    .pipe(
                      // filter out items already added as tasks
                      map((calEvs) =>
                        calEvs.filter(
                          (calEv) => !allCalendarTaskEventIds.includes(calEv.id),
                        ),
                      ),
                      map((items: CalendarIntegrationEvent[]) => ({
                        items,
                        icon: calProvider.icon || null,
                      })),
                    ),
                ),
            ).pipe(
              tap((val) => {
                saveToRealLs(LS.TIMELINE_CACHE, val);
              }),
            )
          : of([] as any);
      }),
      startWith(this._getCalProviderFromCache()),
    );

  timelineEntries$: Observable<TimelineViewEntry[]> = combineLatest([
    this._workContextService.timelineTasks$,
    this._taskRepeatCfgService.taskRepeatCfgsWithStartTime$,
    this.taskService.currentTaskId$,
    this._globalConfigService.timelineCfg$,
    this.icalEvents$,
  ]).pipe(
    debounceTime(50),
    map(([{ planned, unPlanned }, taskRepeatCfgs, currentId, timelineCfg, icalEvents]) =>
      mapToTimelineViewEntries(
        unPlanned,
        planned,
        taskRepeatCfgs,
        icalEvents,
        currentId,
        timelineCfg?.isWorkStartEndEnabled
          ? {
              startTime: timelineCfg.workStart,
              endTime: timelineCfg.workEnd,
            }
          : undefined,
        timelineCfg?.isLunchBreakEnabled
          ? {
              startTime: timelineCfg.lunchBreakStart,
              endTime: timelineCfg.lunchBreakEnd,
            }
          : undefined,
      ),
    ),

    // NOTE: this doesn't require cd.detect changes because view is already re-checked with obs
    tap(() => (this.now = Date.now())),
  );
  now: number = Date.now();
  tomorrow: number = getTomorrow(0).getTime();

  private _moveUpTimeout?: number;
  private _moveDownTimeout?: number;

  constructor(
    public taskService: TaskService,
    private _taskRepeatCfgService: TaskRepeatCfgService,
    private _workContextService: WorkContextService,
    private _globalConfigService: GlobalConfigService,
    private _matDialog: MatDialog,
    private _store: Store,
    private _calendarIntegrationService: CalendarIntegrationService,
  ) {
    if (!localStorage.getItem(LS.WAS_TIMELINE_INITIAL_DIALOG_SHOWN)) {
      this._matDialog.open(DialogTimelineSetupComponent, {
        data: { isInfoShownInitially: true },
      });
    }
  }

  ngOnDestroy(): void {
    window.clearTimeout(this._moveUpTimeout);
    window.clearTimeout(this._moveDownTimeout);
  }

  trackByFn(i: number, item: any): string {
    return item.id;
  }

  async moveUp(task: Task): Promise<void> {
    // if (task.parentId) {
    //   const parentTask = await this.taskService.getByIdOnce$(task.parentId).toPromise();
    //   if (parentTask.subTaskIds[0] === task.id) {
    //     this.taskService.moveUp(task.parentId, undefined, false);
    //     window.clearTimeout(this._moveUpTimeout);
    //     window.setTimeout(() => this.taskService.focusTask(task.id), 50);
    //     return;
    //   }
    // }
    this.taskService.moveUp(task.id, task.parentId, false);
    window.clearTimeout(this._moveUpTimeout);
    window.setTimeout(() => this.taskService.focusTask(task.id), 50);
  }

  async moveDown(task: Task): Promise<void> {
    // if (task.parentId) {
    //   const parentTask = await this.taskService.getByIdOnce$(task.parentId).toPromise();
    //   if (parentTask.subTaskIds[parentTask.subTaskIds.length - 1] === task.id) {
    //     this.taskService.moveDown(task.parentId, undefined, false);
    //     window.clearTimeout(this._moveDownTimeout);
    //     window.setTimeout(() => this.taskService.focusTask(task.id), 50);
    //     return;
    //   }
    // }

    this.taskService.moveDown(task.id, task.parentId, false);
    window.clearTimeout(this._moveDownTimeout);
    window.setTimeout(() => this.taskService.focusTask(task.id), 50);
  }

  editTaskReminder(task: Task): void {
    // NOTE: this also might schedule an unscheduled sub task of a scheduled parent
    this._matDialog.open(DialogAddTaskReminderComponent, {
      data: { task } as AddTaskReminderInterface,
    });
  }

  private _getCalProviderFromCache(): TimelineCalendarMapEntry[] {
    const now = Date.now();
    return (
      ((loadFromRealLs(LS.TIMELINE_CACHE) as TimelineCalendarMapEntry[]) || [])
        // filter out cached past entries
        .map((provider) => ({
          ...provider,
          items: provider.items.filter((item) => item.start + item.duration >= now),
        }))
    );
  }
}
