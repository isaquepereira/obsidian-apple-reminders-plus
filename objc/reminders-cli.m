#import <Foundation/Foundation.h>
#import <EventKit/EventKit.h>
#import <AppKit/AppKit.h>

// MARK: - Globals
static EKEventStore *store;

// MARK: - Helpers

static void requestAccess(void) {
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block BOOL granted = NO;

    if (@available(macOS 14.0, *)) {
        [store requestFullAccessToRemindersWithCompletion:^(BOOL g, NSError *err) {
            granted = g;
            dispatch_semaphore_signal(sem);
        }];
    } else {
        [store requestAccessToEntityType:EKEntityTypeReminder completion:^(BOOL g, NSError *err) {
            granted = g;
            dispatch_semaphore_signal(sem);
        }];
    }

    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

    if (!granted) {
        fprintf(stderr, "{\"error\":\"Reminders access denied. Grant access in System Settings > Privacy & Security > Reminders.\"}\n");
        exit(1);
    }
}

static NSString *isoDate(NSDateComponents *comps) {
    if (!comps) return nil;
    NSCalendar *cal = [NSCalendar currentCalendar];
    NSDate *date = [cal dateFromComponents:comps];
    if (!date) return nil;
    NSDateFormatter *fmt = [[NSDateFormatter alloc] init];
    fmt.dateFormat = @"yyyy-MM-dd";
    fmt.timeZone = [NSTimeZone localTimeZone];
    return [fmt stringFromDate:date];
}

static int priorityValue(NSInteger ekPriority) {
    // EKReminder priority: 0=none, 1-4=high, 5=medium, 6-9=low
    // Map to: 0=none, 9=high, 5=medium, 1=low
    if (ekPriority >= 1 && ekPriority <= 4) return 9;
    if (ekPriority == 5) return 5;
    if (ekPriority >= 6 && ekPriority <= 9) return 1;
    return 0;
}

static NSDictionary *reminderDict(EKReminder *r) {
    NSMutableDictionary *dict = [NSMutableDictionary dictionary];
    dict[@"id"] = r.calendarItemIdentifier ?: @"";
    dict[@"name"] = r.title ?: @"";
    dict[@"completed"] = @(r.completed);
    dict[@"priority"] = @(priorityValue(r.priority));
    dict[@"body"] = r.notes ?: @"";

    NSString *due = isoDate(r.dueDateComponents);
    dict[@"dueDate"] = due ?: [NSNull null];

    return dict;
}

static NSString *toJSON(id obj) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static EKCalendar *findCalendar(NSString *name) {
    NSArray<EKCalendar *> *cals = [store calendarsForEntityType:EKEntityTypeReminder];
    for (EKCalendar *cal in cals) {
        if ([cal.title isEqualToString:name]) return cal;
    }
    return nil;
}

static EKReminder *findReminder(NSString *identifier) {
    NSPredicate *pred = [store predicateForRemindersInCalendars:nil];
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block EKReminder *found = nil;

    [store fetchRemindersMatchingPredicate:pred completion:^(NSArray<EKReminder *> *reminders) {
        for (EKReminder *r in reminders) {
            if ([r.calendarItemIdentifier isEqualToString:identifier]) {
                found = r;
                break;
            }
        }
        dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
    return found;
}

// MARK: - Commands

static void cmdLists(void) {
    NSArray<EKCalendar *> *cals = [store calendarsForEntityType:EKEntityTypeReminder];
    NSMutableArray *names = [NSMutableArray array];
    for (EKCalendar *cal in cals) {
        [names addObject:cal.title];
    }
    printf("%s\n", [toJSON(names) UTF8String]);
}

static void cmdFetch(NSString *listName, BOOL completed) {
    EKCalendar *calendar = findCalendar(listName);
    if (!calendar) {
        printf("[]\n");
        return;
    }

    NSPredicate *pred;
    if (completed) {
        pred = [store predicateForCompletedRemindersWithCompletionDateStarting:nil
                                                                       ending:nil
                                                                    calendars:@[calendar]];
    } else {
        pred = [store predicateForIncompleteRemindersWithDueDateStarting:nil
                                                                 ending:nil
                                                              calendars:@[calendar]];
    }

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSArray<EKReminder *> *results = @[];

    [store fetchRemindersMatchingPredicate:pred completion:^(NSArray<EKReminder *> *reminders) {
        results = reminders ?: @[];
        dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

    NSMutableArray *dicts = [NSMutableArray array];
    for (EKReminder *r in results) {
        [dicts addObject:reminderDict(r)];
    }
    printf("%s\n", [toJSON(dicts) UTF8String]);
}

static void cmdCreate(NSString *listName, NSString *title) {
    EKCalendar *calendar = findCalendar(listName);
    if (!calendar) {
        fprintf(stderr, "{\"error\":\"List not found: %s\"}\n", [listName UTF8String]);
        exit(1);
    }

    EKReminder *reminder = [EKReminder reminderWithEventStore:store];
    reminder.title = title;
    reminder.calendar = calendar;

    NSError *error = nil;
    [store saveReminder:reminder commit:YES error:&error];
    if (error) {
        fprintf(stderr, "{\"error\":\"%s\"}\n", [error.localizedDescription UTF8String]);
        exit(1);
    }
    printf("%s\n", [toJSON(reminderDict(reminder)) UTF8String]);
}

static void cmdDelete(NSString *identifier) {
    EKReminder *reminder = findReminder(identifier);
    if (!reminder) {
        fprintf(stderr, "{\"error\":\"Reminder not found: %s\"}\n", [identifier UTF8String]);
        exit(1);
    }

    NSError *error = nil;
    [store removeReminder:reminder commit:YES error:&error];
    if (error) {
        fprintf(stderr, "{\"error\":\"%s\"}\n", [error.localizedDescription UTF8String]);
        exit(1);
    }
    printf("{\"ok\":true}\n");
}

static void cmdComplete(NSString *identifier, BOOL value) {
    EKReminder *reminder = findReminder(identifier);
    if (!reminder) {
        fprintf(stderr, "{\"error\":\"Reminder not found: %s\"}\n", [identifier UTF8String]);
        exit(1);
    }

    reminder.completed = value;
    if (value) {
        reminder.completionDate = [NSDate date];
    } else {
        reminder.completionDate = nil;
    }

    NSError *error = nil;
    [store saveReminder:reminder commit:YES error:&error];
    if (error) {
        fprintf(stderr, "{\"error\":\"%s\"}\n", [error.localizedDescription UTF8String]);
        exit(1);
    }
    printf("{\"ok\":true}\n");
}

static void cmdClearCompleted(NSString *listName) {
    EKCalendar *calendar = findCalendar(listName);
    if (!calendar) {
        fprintf(stderr, "{\"error\":\"List not found: %s\"}\n", [listName UTF8String]);
        exit(1);
    }

    NSPredicate *pred = [store predicateForCompletedRemindersWithCompletionDateStarting:nil
                                                                                ending:nil
                                                                             calendars:@[calendar]];

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSArray<EKReminder *> *results = @[];

    [store fetchRemindersMatchingPredicate:pred completion:^(NSArray<EKReminder *> *reminders) {
        results = reminders ?: @[];
        dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

    int count = 0;
    NSError *error = nil;
    for (EKReminder *r in results) {
        if ([store removeReminder:r commit:NO error:&error]) {
            count++;
        }
    }

    [store commit:&error];
    if (error) {
        fprintf(stderr, "{\"error\":\"%s\"}\n", [error.localizedDescription UTF8String]);
        exit(1);
    }
    printf("{\"deleted\":%d}\n", count);
}

static void cmdOpen(void) {
    NSURL *url = [NSURL URLWithString:@"x-apple-reminderkit://"];
    if (url) {
        [[NSWorkspace sharedWorkspace] openURL:url];
    }
    printf("{\"ok\":true}\n");
}

// MARK: - Argument parsing

static NSString *getArg(int argc, const char *argv[], const char *flag) {
    for (int i = 0; i < argc - 1; i++) {
        if (strcmp(argv[i], flag) == 0) {
            return [NSString stringWithUTF8String:argv[i + 1]];
        }
    }
    return nil;
}

static void printUsage(void) {
    fprintf(stderr,
        "Usage: reminders-cli <command> [options]\n\n"
        "Commands:\n"
        "  lists                                  List all reminder lists\n"
        "  fetch   --list <name> --completed <bool>  Fetch reminders from a list\n"
        "  create  --list <name> --title <text>      Create a new reminder\n"
        "  delete  --id <identifier>                 Delete a reminder\n"
        "  complete --id <identifier> --value <bool>  Set completion status\n"
        "  clear-completed --list <name>             Delete all completed reminders\n"
        "  open                                      Open Reminders.app\n");
    exit(1);
}

// MARK: - Main

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) printUsage();

        store = [[EKEventStore alloc] init];
        NSString *command = [NSString stringWithUTF8String:argv[1]];

        requestAccess();

        if ([command isEqualToString:@"lists"]) {
            cmdLists();
        } else if ([command isEqualToString:@"fetch"]) {
            NSString *listName = getArg(argc, argv, "--list");
            if (!listName) { fprintf(stderr, "{\"error\":\"--list is required\"}\n"); exit(1); }
            NSString *completedStr = getArg(argc, argv, "--completed") ?: @"false";
            BOOL completed = [completedStr isEqualToString:@"true"];
            cmdFetch(listName, completed);
        } else if ([command isEqualToString:@"create"]) {
            NSString *listName = getArg(argc, argv, "--list");
            NSString *title = getArg(argc, argv, "--title");
            if (!listName || !title) { fprintf(stderr, "{\"error\":\"--list and --title are required\"}\n"); exit(1); }
            cmdCreate(listName, title);
        } else if ([command isEqualToString:@"delete"]) {
            NSString *ident = getArg(argc, argv, "--id");
            if (!ident) { fprintf(stderr, "{\"error\":\"--id is required\"}\n"); exit(1); }
            cmdDelete(ident);
        } else if ([command isEqualToString:@"complete"]) {
            NSString *ident = getArg(argc, argv, "--id");
            if (!ident) { fprintf(stderr, "{\"error\":\"--id is required\"}\n"); exit(1); }
            NSString *valueStr = getArg(argc, argv, "--value") ?: @"true";
            BOOL value = [valueStr isEqualToString:@"true"];
            cmdComplete(ident, value);
        } else if ([command isEqualToString:@"clear-completed"]) {
            NSString *listName = getArg(argc, argv, "--list");
            if (!listName) { fprintf(stderr, "{\"error\":\"--list is required\"}\n"); exit(1); }
            cmdClearCompleted(listName);
        } else if ([command isEqualToString:@"open"]) {
            cmdOpen();
        } else {
            printUsage();
        }
    }
    return 0;
}
